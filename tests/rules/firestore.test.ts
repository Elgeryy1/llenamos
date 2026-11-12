import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest'
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { deleteDoc, doc, getDoc, setDoc, updateDoc, serverTimestamp, Timestamp } from 'firebase/firestore'

let env: RulesTestEnvironment
const rid = 'restaurants/uno'
const lid = `${rid}/locations/centro`
const timestamp = Timestamp.fromMillis(1000)
const dates = { createdAt: timestamp, updatedAt: timestamp }
const area = { name: 'Sala', sortOrder: 0 }
const location = { name: 'Centro', slug: 'centro', address: '', city: '', phone: '' }
const table = { name: 'S1', areaId: 'sala', seats: 4, shape: 'rect', x: 10, y: 10, w: 10, h: 10, joinableWith: [], enabled: true }
const roles = ['owner','manager','waiter','kitchen','bar'] as const
const client = (uid?: string) => uid ? env.authenticatedContext(uid).firestore() : env.unauthenticatedContext().firestore()
it('rechaza tokens previos al relevo de identidad aunque conserven la membresía activa', async () => {
  await env.withSecurityRulesDisabled(async context => { await setDoc(doc(context.firestore(), 'identitySecurity/owner'), { version: 'new-session', locked: false }) })
  await assertFails(getDoc(doc(client('owner'), rid)))
  await assertFails(getDoc(doc(client('owner'), 'users/owner')))
  const fresh = env.authenticatedContext('owner', { sessionVersion: 'new-session' }).firestore()
  await assertSucceeds(getDoc(doc(fresh, rid)))
  await env.withSecurityRulesDisabled(async context => { await setDoc(doc(context.firestore(), 'identitySecurity/owner'), { version: 'new-session', locked: true }) })
  await assertFails(getDoc(doc(fresh, rid)))
})
it('ningún cliente puede leer ni alterar credenciales o su estado técnico, incluidos propietario y LogiQD', async () => {
  await env.withSecurityRulesDisabled(async context => {
    for (const name of ['integrationSecrets', 'providerStatus'])
      await setDoc(doc(context.firestore(), `${rid}/${name}/providers`), { ciphertext: 'fixture-cifrado' })
  })
  const clients = [client(), ...roles.map(role => client(role)), env.authenticatedContext('owner', { logiqd: true }).firestore()]
  for (const db of clients) for (const name of ['integrationSecrets', 'providerStatus']) {
    const ref = doc(db, `${rid}/${name}/providers`)
    await assertFails(getDoc(ref))
    await assertFails(setDoc(ref, { ciphertext: 'cambio' }))
    await assertFails(deleteDoc(ref))
  }
})
it('LogiQD no entra al restaurante aunque conserve una membresía de propietario', async () => {
  const db = env.authenticatedContext('owner', { logiqd: true }).firestore()
  await assertFails(getDoc(doc(db, rid)))
  await assertFails(getDoc(doc(db, `${rid}/members/owner`)))
  await assertFails(getDoc(doc(db, lid)))
  await assertFails(updateDoc(doc(db, lid), { phone: '600000000', updatedBy: 'owner', updatedAt: serverTimestamp() }))
})
beforeAll(async () => {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8085').split(':')
  env = await initializeTestEnvironment({ projectId: 'demo-llenamos', firestore: { host, port: Number(port), rules: readFileSync(new URL('../../firebase/firestore.rules', import.meta.url), 'utf8') } })
})
beforeEach(async () => {
  await env.clearFirestore()
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore()
    await setDoc(doc(db, rid), { changeId: 'outbox-alta', name: 'Restaurante', slug: 'restaurante', brandColor: '#f0a35e', currency: 'EUR', timezone: 'Europe/Madrid', locale: 'es', isDemo: false, ...dates })
    for (const role of roles) await setDoc(doc(db, `${rid}/members/${role}`), { uid: role, role, active: true, locationIds: [] })
    await setDoc(doc(db, `${rid}/members/inactivo`), { role: 'owner', active: false, locationIds: [] })
    await setDoc(doc(db, `${rid}/members/limitado`), { role: 'manager', active: true, locationIds: ['centro'] })
    await setDoc(doc(db, 'restaurants/otro/members/ajeno'), { role: 'owner', active: true, locationIds: [] })
    await setDoc(doc(db, 'users/owner'), { restaurants: {} })
    await setDoc(doc(db, lid), { ...location, ...dates })
    await setDoc(doc(db, `${lid}/areas/sala`), { ...area, ...dates })
    await setDoc(doc(db, `${lid}/tables/s1`), { ...table, ...dates })
    await setDoc(doc(db, `${rid}/activity/a`), { action: 'test', ...dates })
    await setDoc(doc(db, `${rid}/locations/otro`), { ...location, ...dates })
  })
})
afterAll(async () => { await env?.cleanup() })

describe('Aislamiento y lectura', () => {
  for (const uid of [undefined,'inactivo','ajeno']) it(`${uid ?? 'sin sesión'} no accede al restaurante`, async () => {
    for (const path of [rid, `${rid}/members/owner`, lid, `${lid}/areas/sala`, `${lid}/tables/s1`, `${rid}/activity/a`]) {
      await assertFails(getDoc(doc(client(uid), path)))
      await assertFails(setDoc(doc(client(uid), path), {}))
    }
  })
  for (const role of roles) it(`${role} lee su restaurante, equipo y local`, async () => {
    const db = client(role)
    for (const path of [rid, `${rid}/members/owner`, lid, `${lid}/areas/sala`, `${lid}/tables/s1`]) await assertSucceeds(getDoc(doc(db, path)))
    await (['owner','manager'].includes(role) ? assertSucceeds : assertFails)(getDoc(doc(db, `${rid}/activity/a`)))
    for (const path of [`${rid}/members/owner`, `${rid}/activity/a`, `users/${role}`]) {
      await assertFails(setDoc(doc(db, path), {}))
      await assertFails(deleteDoc(doc(db, path)))
    }
  })
  it('limita locales por locationIds', async () => {
    await assertSucceeds(getDoc(doc(client('limitado'), lid)))
    await assertFails(getDoc(doc(client('limitado'), `${rid}/locations/otro`)))
    await assertFails(setDoc(doc(client('limitado'), `${rid}/locations/otro/areas/nueva`), { ...area, createdAt: serverTimestamp(), updatedBy: 'limitado', updatedAt: serverTimestamp() }))
    await assertSucceeds(getDoc(doc(client('owner'), `${rid}/locations/otro`)))
  })
  it('solo la propia persona lee su perfil; nadie lo escribe', async () => {
    await assertSucceeds(getDoc(doc(client('owner'), 'users/owner')))
    for (const uid of [undefined, 'manager']) await assertFails(getDoc(doc(client(uid), 'users/owner')))
    await assertFails(setDoc(doc(client('owner'), 'users/owner'), { restaurants: {} }))
  })
})
describe('Escritura y validación', () => {
  for (const updatedBy of [undefined, 'manager']) {
    it(`rechaza autor ${updatedBy ?? 'ausente'} en ajustes, altas y cambios de documentos`, async () => {
      const db = client('owner')
      const author = updatedBy === undefined ? {} : { updatedBy }
      await assertFails(updateDoc(doc(db, rid), { name: 'Cambio', ...author, updatedAt: serverTimestamp() }))
      for (const [path, data] of [[lid, location], [`${lid}/areas/sala`, area], [`${lid}/tables/s1`, table]] as const) {
        await assertFails(updateDoc(doc(db, path), { name: 'Cambio', ...author, updatedAt: serverTimestamp() }))
        await assertFails(setDoc(doc(db, `${path}-nuevo`), { ...data, ...author, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }))
      }
    })
  }
  for (const role of roles) it(`${role}: ajustes y altas, cambios, bajas de locales, zonas y mesas`, async () => {
    const db = client(role)
    const check = ['owner','manager'].includes(role) ? assertSucceeds : assertFails
    await check(updateDoc(doc(db, rid), { name: 'Nuevo nombre', brandColor: '#abcdef', locale: 'ca', updatedBy: role, updatedAt: serverTimestamp() }))
    for (const [path, data] of [[`${rid}/locations/nuevo`, location], [`${lid}/areas/nueva`, area], [`${lid}/tables/nueva`, table]] as const) {
      await check(setDoc(doc(db, path), { ...data, createdAt: serverTimestamp(), updatedBy: role, updatedAt: serverTimestamp() }))
      await check(updateDoc(doc(db, path), { name: 'Cambio', updatedBy: role, updatedAt: serverTimestamp() }))
      await check(deleteDoc(doc(db, path)))
    }
  })
  it('cierra creación/borrado del restaurante, membresías, actividad y rutas desconocidas', async () => {
    const db = client('owner')
    await assertFails(deleteDoc(doc(db, rid)))
    await assertFails(setDoc(doc(db, 'restaurants/nuevo'), {}))
    for (const path of [`${rid}/members/nuevo`, `${rid}/activity/nuevo`, `${rid}/privado/x`, 'desconocido/x']) {
      await assertFails(setDoc(doc(db, path), {}))
      await assertFails(deleteDoc(doc(db, path)))
    }
    await assertFails(getDoc(doc(db, `${rid}/privado/x`)))
  })
  for (const [field, value] of [['changeId','falsificado'], ['slug','otro'], ['currency','USD'], ['isDemo',true], ['name',1], ['brandColor','rojo'], ['locale','fr'], ['updatedAt',timestamp]]) it(`rechaza ajuste ${field} inválido`, async () => {
    await assertFails(updateDoc(doc(client('owner'), rid), { updatedBy: 'owner', [field as string]: value, ...(field === 'updatedAt' ? {} : { updatedAt: serverTimestamp() }) }))
  })
  for (const [suffix, base, invalid] of [
    ['areas', area, { sortOrder: 1.5 }], ['areas', area, { name: '' }],
    ['locations', location, { phone: 3 }], ['locations', location, { slug: 'Con espacios' }],
    ['tables', table, { seats: 0 }], ['tables', table, { seats: 1.5 }], ['tables', table, { shape: 'oval' }],
    ['tables', table, { x: -1 }], ['tables', table, { w: 1 }], ['tables', table, { enabled: 'sí' }],
    ['tables', table, { areaId: 'inexistente' }], ['tables', table, { joinableWith: 's1' }],
    ['tables', table, { joinableWith: [123] }], ['tables', table, { joinableWith: [{}] }],
    ['tables', table, { joinableWith: ['s1', true] }],
  ] as const) it(`rechaza tipos/campos incorrectos en ${suffix}: ${JSON.stringify(invalid)}`, async () => {
    const path = suffix === 'locations' ? `${rid}/locations/nuevo` : `${lid}/${suffix}/nuevo`
    await assertFails(setDoc(doc(client('owner'), path), { ...base, ...invalid, createdAt: serverTimestamp(), updatedBy: 'owner', updatedAt: serverTimestamp() }))
  })
  it('acepta ids de mesas unibles como lista de cadenas', async () => {
    await assertSucceeds(updateDoc(doc(client('owner'), `${lid}/tables/s1`), { joinableWith: ['s2', 's3'], updatedBy: 'owner', updatedAt: serverTimestamp() }))
  })
  for (const [path, data] of [[lid, location], [`${lid}/areas/sala`, area], [`${lid}/tables/s1`, table]] as const) it(`rechaza campos adicionales y fechas falsificadas: ${path}`, async () => {
    await assertFails(updateDoc(doc(client('owner'), path), { extra: true, updatedBy: 'owner', updatedAt: serverTimestamp() }))
    await assertFails(setDoc(doc(client('owner'), path), { ...data, createdAt: serverTimestamp(), updatedBy: 'owner', updatedAt: serverTimestamp() }))
    await assertFails(updateDoc(doc(client('owner'), path), { updatedBy: 'owner', updatedAt: timestamp }))
  })
})

describe('Contrato de reservas', () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async context => {
      const db = context.firestore()
      for (const path of [`${lid}/reservations/r`, `${lid}/waitlist/w`, `${lid}/settings/reservations`, `${rid}/messages/m`, 'publicRestaurants/restaurante']) await setDoc(doc(db, path), { example: true })
      await setDoc(doc(db, `${rid}/customers/c`), { name: 'Ana', notes: '', allergies: '', tags: [], visits: 1, ...dates })
    })
  })
  for (const uid of [undefined, 'inactivo', 'ajeno', ...roles]) it(`lecturas de reservas por ${uid ?? 'anónimo'}`, async () => {
    const staff = uid && ['owner', 'manager', 'waiter'].includes(uid)
    for (const path of [`${lid}/reservations/r`, `${lid}/waitlist/w`, `${lid}/settings/reservations`, `${rid}/customers/c`]) {
      await (staff ? assertSucceeds : assertFails)(getDoc(doc(client(uid), path)))
      await assertFails(setDoc(doc(client(uid), path), {}))
      await assertFails(deleteDoc(doc(client(uid), path)))
    }
    await (uid && ['owner', 'manager'].includes(uid) ? assertSucceeds : assertFails)(getDoc(doc(client(uid), `${rid}/messages/m`)))
    await assertFails(setDoc(doc(client(uid), `${rid}/messages/m`), {}))
    await assertSucceeds(getDoc(doc(client(uid), 'publicRestaurants/restaurante')))
    await assertFails(setDoc(doc(client(uid), 'publicRestaurants/restaurante'), {}))
  })
  it('protege estadísticas y permite notas con autor y fecha', async () => {
    const ref = doc(client('waiter'), `${rid}/customers/c`)
    await assertSucceeds(updateDoc(ref, { notes: 'Ventana', allergies: 'Nueces', tags: ['habitual', 'comida/cena'], updatedBy: 'waiter', updatedAt: serverTimestamp() }))
    for (const extra of [{ visits: 5 }, { updatedBy: 'owner' }, { tags: [1] }, { tags: ['x'.repeat(31)] }]) await assertFails(updateDoc(ref, { updatedBy: 'waiter', updatedAt: serverTimestamp(), ...extra }))
  })
  it('respeta locales y el interruptor del módulo; protege los campos del plan', async () => {
    await assertSucceeds(getDoc(doc(client('limitado'), `${lid}/reservations/r`)))
    await assertFails(getDoc(doc(client('limitado'), `${rid}/locations/otro/reservations/r`)))
    await assertFails(updateDoc(doc(client('owner'), rid), { plan: 'completo', activeModules: ['reservations'], updatedBy: 'owner', updatedAt: serverTimestamp() }))
    await env.withSecurityRulesDisabled(async context => updateDoc(doc(context.firestore(), rid), { plan: 'sala', activeModules: [] }))
    for (const path of [`${lid}/reservations/r`, `${lid}/waitlist/w`, `${rid}/customers/c`, `${rid}/messages/m`]) await assertFails(getDoc(doc(client('owner'), path)))
  })
  it('el equipo LogiQD ya no lee restaurantes por el SDK: el panel usa callables con su claim', async () => {
    const db = env.authenticatedContext('equipo', { logiqd: true }).firestore()
    await assertFails(getDoc(doc(db, rid)))
    await assertFails(getDoc(doc(db, `${lid}/reservations/r`)))
    await assertFails(updateDoc(doc(db, rid), { plan: 'sala' }))
  })
})

describe('Contrato de sala y cocina', () => {
  const paths = ['menuCategories/c', 'menuItems/i', 'dailyMenus/m', 'settings/floor', 'stations/k', 'tableSessions/s', 'orders/o', 'takeaways/t', 'floorTasks/t', 'orderLines/k', 'orderLines/b', 'orderLines/p']
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async context => {
      const db = context.firestore()
      for (const path of paths) await setDoc(doc(db, `${lid}/${path}`), { stationId: 'cocina', stationKind: path.endsWith('/b') ? 'bar' : 'kitchen', status: path.endsWith('/p') ? 'pending' : 'fired', placedAt: timestamp })
      await setDoc(doc(db, 'publicMenus/menu'), { restaurantId: 'uno', locationId: 'centro' })
    })
  })
  for (const role of roles) it(`${role}: lecturas según el rol y ninguna escritura directa`, async () => {
    const db = client(role)
    for (const path of paths) {
      const stationRole = role === 'kitchen' || role === 'bar'
      const allowed = !stationRole || ['menuCategories/c','menuItems/i','dailyMenus/m','settings/floor','stations/k'].includes(path) || path === `orderLines/${role === 'kitchen' ? 'k' : 'b'}`
      await (allowed ? assertSucceeds : assertFails)(getDoc(doc(db, `${lid}/${path}`)))
      await assertFails(setDoc(doc(db, `${lid}/${path}`), { updatedBy: role }))
      await assertFails(deleteDoc(doc(db, `${lid}/${path}`)))
    }
  })
  for (const uid of [undefined, 'ajeno', 'inactivo']) it(`${uid ?? 'público'} no lee el servicio`, async () => {
    for (const path of paths) await assertFails(getDoc(doc(client(uid), `${lid}/${path}`)))
  })
  it('respeta local, módulos y plan sin activeModules', async () => {
    await assertSucceeds(getDoc(doc(client('limitado'), `${lid}/orders/o`)))
    await assertFails(getDoc(doc(client('limitado'), `${rid}/locations/otro/orders/o`)))
    await env.withSecurityRulesDisabled(async context => {
      await updateDoc(doc(context.firestore(), rid), { plan: 'reservas', activeModules: ['reservations'] })
    })
    for (const role of roles) for (const path of paths) await assertFails(getDoc(doc(client(role), `${lid}/${path}`)))
    await env.withSecurityRulesDisabled(async context => {
      await setDoc(doc(context.firestore(), rid), { plan: 'reservas', moduleOverrides: { floor: true } })
    })
    await assertSucceeds(getDoc(doc(client('waiter'), `${lid}/menuItems/i`)))
    await assertFails(getDoc(doc(client('kitchen'), `${lid}/menuItems/i`)))
    await env.withSecurityRulesDisabled(async context => {
      await setDoc(doc(context.firestore(), rid), { plan: 'sala', activeModules: ['kitchen'] })
    })
    await assertSucceeds(getDoc(doc(client('owner'), `${lid}/stations/k`)))
    await assertFails(getDoc(doc(client('waiter'), `${lid}/stations/k`)))
  })
  it('protege tokens, bloqueos, índices, contadores y gasto', async () => {
    for (const role of roles) for (const path of ['tableTokens/x', 'takeawaySecrets/x', 'serviceLocks/x', 'reservationSessions/x', 'taskKeys/x', 'spendContributions/x']) {
      await assertFails(getDoc(doc(client(role), `${lid}/${path}`)))
      await assertFails(setDoc(doc(client(role), `${lid}/${path}`), { updatedBy: role }))
    }
    for (const path of [`${rid}/takeawayReferences/x`, `${rid}/floorRateLimits/x`]) await assertFails(getDoc(doc(client('owner'), path)))
    await env.withSecurityRulesDisabled(async context => { await setDoc(doc(context.firestore(), `${rid}/customers/gasto`), { spentCents: 100, notes: '', allergies: '', tags: [] }) })
    await assertFails(updateDoc(doc(client('owner'), `${rid}/customers/gasto`), { spentCents: 999, updatedBy: 'owner', updatedAt: serverTimestamp() }))
    await assertSucceeds(updateDoc(doc(client('owner'), `${rid}/customers/gasto`), { notes: 'Nota', updatedBy: 'owner', updatedAt: serverTimestamp() }))
  })
  it('permite el get público de una carta y deniega el listado', async () => {
    const { getDocs, collection } = await import('firebase/firestore')
    await assertSucceeds(getDoc(doc(client(), 'publicMenus/menu')))
    await assertFails(getDocs(collection(client(), 'publicMenus')))
    await assertFails(setDoc(doc(client('owner'), 'publicMenus/menu'), {}))
  })
  it('cocina consulta su estación y estados, sin pedidos pendientes ni otra estación', async () => {
    const { collection, getDocs, query, where, orderBy } = await import('firebase/firestore')
    const db = client('kitchen'), lines = collection(db, `${lid}/orderLines`)
    await assertSucceeds(getDocs(query(lines, where('stationId', '==', 'cocina'), where('stationKind', '==', 'kitchen'), where('status', 'in', ['held','fired','preparing','ready','served','cancelled']), orderBy('placedAt'))))
    await assertFails(getDocs(lines))
    await assertFails(getDocs(query(lines, where('stationKind', '==', 'bar'))))
    await assertFails(getDocs(query(lines, where('stationKind', '==', 'kitchen'), where('status', '==', 'pending'))))
  })
})
