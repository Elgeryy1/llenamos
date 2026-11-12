import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { addDoc, collection, deleteDoc, doc, getDoc, getDocs, query, setDoc, updateDoc, where } from 'firebase/firestore'

let env: RulesTestEnvironment
const root = 'restaurants/f4', local = `${root}/locations/centro`
const ROLES = ['owner', 'manager', 'waiter', 'kitchen', 'bar'] as const
const client = (uid?: string) => (uid ? env.authenticatedContext(uid).firestore() : env.unauthenticatedContext().firestore())
const setup = async (restaurant: object = { plan: 'completo', activeModules: ['staff', 'inventory'] }) => {
  await env.clearFirestore()
  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    await setDoc(doc(db, root), restaurant)
    for (const uid of [...ROLES, 'inactive', 'limited']) {
      await setDoc(doc(db, `${root}/members/${uid}`), { role: ['inactive', 'limited'].includes(uid) ? 'owner' : uid, active: uid !== 'inactive', locationIds: uid === 'limited' ? ['otro'] : [] })
    }
    for (const c of managerPersonal) await setDoc(doc(db, c.path), { x: 1 })
    for (const c of readerInventory) await setDoc(doc(db, c.path), { x: 1 })
    for (const c of managerInventory) await setDoc(doc(db, c.path), { x: 1 })
    for (const path of priv) await setDoc(doc(db, path), { x: 1 })
    await setDoc(doc(db, `${local}/timeEntries/mine`), { uid: 'waiter', status: 'closed' })
    await setDoc(doc(db, `${local}/timeEntries/other`), { uid: 'ghost', status: 'closed' })
    await setDoc(doc(db, `${local}/shifts/pub`), { uid: 'waiter', status: 'published' })
    await setDoc(doc(db, `${local}/shifts/draft`), { uid: 'waiter', status: 'draft' })
  })
}
// Lectura solo para encargado: ajustes, auditoría de fichajes, costes, compras y recuentos.
const managerPersonal = [`${local}/settings/staff`, `${local}/timeEntryEvents/e1`].map((path) => ({ path }))
const managerInventory = [
  `${local}/settings/inventory`, `${local}/ingredientCosts/i1`, `${local}/stockMovements/m1`, `${local}/recipes/r1`, `${local}/recipes/r1/versions/1`,
  `${local}/lineCosts/l1`, `${local}/stockCounts/c1`, `${local}/suppliers/s1`, `${local}/supplierItems/f1`, `${local}/purchaseOrders/p1`, `${local}/goodsReceipts/g1`,
].map((path) => ({ path }))
const readerInventory = [`${local}/ingredients/i1`, `${local}/stockAlerts/i1`].map((path) => ({ path }))
const priv = [`${root}/staffClockLocks/waiter`, `${local}/staffPins/waiter`, `${local}/staffRequests/h1`, `${local}/purchaseReferences/ABC123`, `${local}/inventoryRequests/h1`]
const everything = [...managerPersonal, ...managerInventory, ...readerInventory].map((c) => c.path).concat(priv, [`${local}/timeEntries/mine`, `${local}/shifts/pub`])

beforeAll(async () => {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8098').split(':')
  env = await initializeTestEnvironment({ projectId: 'demo-llenamos', firestore: { host, port: Number(port), rules: readFileSync(new URL('../../firebase/firestore.rules', import.meta.url), 'utf8') } })
})
beforeEach(() => setup())
afterAll(async () => { await env?.cleanup() })

describe('Fase 4 · reglas de personal', () => {
  for (const role of ROLES) {
    it(`${role} lee solo sus fichajes y el cuadrante publicado, y gestiona solo si es encargado`, async () => {
      const db = client(role), manager = role === 'owner' || role === 'manager'
      await (manager ? assertSucceeds : assertFails)(getDoc(doc(db, `${local}/timeEntries/other`)))
      await (manager || role === 'waiter' ? assertSucceeds : assertFails)(getDoc(doc(db, `${local}/timeEntries/mine`)))
      // Una consulta sin filtro no pasa; con el filtro de su uid, sí.
      await (manager ? assertSucceeds : assertFails)(getDocs(collection(db, `${local}/timeEntries`)))
      await assertSucceeds(getDocs(query(collection(db, `${local}/timeEntries`), where('uid', '==', role))))
      await (manager ? assertSucceeds : assertFails)(getDoc(doc(db, `${local}/shifts/draft`)))
      await assertSucceeds(getDoc(doc(db, `${local}/shifts/pub`)))
      await (manager ? assertSucceeds : assertFails)(getDocs(collection(db, `${local}/shifts`)))
      await assertSucceeds(getDocs(query(collection(db, `${local}/shifts`), where('status', '==', 'published'))))
      for (const { path } of managerPersonal) await (manager ? assertSucceeds : assertFails)(getDoc(doc(db, path)))
    })
  }
})

describe('Fase 4 · reglas de inventario', () => {
  for (const role of ROLES) {
    it(`${role}: cocina y barra ven existencias y avisos pero nunca costes; el camarero no entra`, async () => {
      const db = client(role), manager = role === 'owner' || role === 'manager', reader = manager || role === 'kitchen' || role === 'bar'
      for (const { path } of readerInventory) {
        await (reader ? assertSucceeds : assertFails)(getDoc(doc(db, path)))
        await (reader ? assertSucceeds : assertFails)(getDocs(collection(db, path.split('/').slice(0, -1).join('/'))))
      }
      for (const { path } of managerInventory) {
        await (manager ? assertSucceeds : assertFails)(getDoc(doc(db, path)))
        // Los ajustes se leen de uno en uno: una colección de ajustes no se lista.
        if (!path.includes('/settings/')) await (manager ? assertSucceeds : assertFails)(getDocs(collection(db, path.split('/').slice(0, -1).join('/'))))
      }
    })
  }
  it('la cocina no puede leer costes en ninguna colección con valor', async () => {
    const db = client('kitchen')
    for (const name of ['ingredientCosts', 'stockMovements', 'recipes', 'lineCosts', 'suppliers', 'supplierItems', 'purchaseOrders', 'goodsReceipts', 'stockCounts']) {
      await assertFails(getDocs(collection(db, `${local}/${name}`)))
    }
    await assertFails(getDocs(collection(db, `${local}/recipes/r1/versions`)))
  })
})

describe('Fase 4 · lo privado y la escritura', () => {
  it('ni siquiera el propietario lee bloqueos, PIN, claves de idempotencia ni referencias', async () => {
    for (const uid of ['owner', 'manager', 'waiter', undefined]) {
      const db = client(uid)
      for (const path of priv) await assertFails(getDoc(doc(db, path)))
      for (const name of ['staffPins', 'staffRequests', 'purchaseReferences', 'inventoryRequests']) await assertFails(getDocs(collection(db, `${local}/${name}`)))
      await assertFails(getDocs(collection(db, `${root}/staffClockLocks`)))
    }
  })
  for (const role of ROLES) {
    it(`${role} no escribe en ningún documento de la fase`, async () => {
      const db = client(role)
      for (const path of everything) {
        await assertFails(setDoc(doc(db, path), { updatedBy: role }))
        await assertFails(updateDoc(doc(db, path), { updatedBy: role }))
        await assertFails(deleteDoc(doc(db, path)))
      }
      for (const name of ['timeEntries', 'timeEntryEvents', 'shifts', 'ingredients', 'stockMovements', 'recipes', 'lineCosts', 'stockCounts', 'stockAlerts', 'suppliers', 'purchaseOrders', 'goodsReceipts']) {
        await assertFails(addDoc(collection(db, `${local}/${name}`), { uid: role, status: 'published', updatedBy: role }))
      }
    })
  }
})

describe('Fase 4 · local, sesión y módulos', () => {
  for (const uid of [undefined, 'inactive', 'limited', 'foreign']) {
    it(`${uid ?? 'sin sesión'} no lee nada de la fase`, async () => {
      const db = client(uid)
      for (const path of everything) await assertFails(getDoc(doc(db, path)))
    })
  }
  it('apagar staff oculta fichajes y cuadrante sin borrar nada; inventory hace lo mismo con el almacén', async () => {
    await env.withSecurityRulesDisabled((c) => updateDoc(doc(c.firestore(), root), { activeModules: ['inventory'] }))
    for (const uid of ['owner', 'waiter']) {
      for (const path of [`${local}/timeEntries/mine`, `${local}/shifts/pub`, ...managerPersonal.map((p) => p.path)]) await assertFails(getDoc(doc(client(uid), path)))
    }
    await assertSucceeds(getDoc(doc(client('kitchen'), `${local}/ingredients/i1`)))
    await env.withSecurityRulesDisabled((c) => updateDoc(doc(c.firestore(), root), { activeModules: ['staff'] }))
    await assertFails(getDoc(doc(client('kitchen'), `${local}/ingredients/i1`)))
    await assertFails(getDoc(doc(client('owner'), `${local}/ingredientCosts/i1`)))
    await assertSucceeds(getDoc(doc(client('waiter'), `${local}/timeEntries/mine`)))
    await env.withSecurityRulesDisabled(async (c) => { await setDoc(doc(c.firestore(), root), { plan: 'completo', activeModules: [] }) })
    await assertFails(getDoc(doc(client('owner'), `${local}/timeEntries/mine`)))
  })
  it('los planes sala y reservas no incluyen los módulos; un override los enciende; el plan completo antiguo sin proyección sí los incluye', async () => {
    for (const plan of ['sala', 'reservas']) {
      await setup({ plan })
      await assertFails(getDoc(doc(client('owner'), `${local}/timeEntries/mine`)))
      await assertFails(getDoc(doc(client('owner'), `${local}/ingredientCosts/i1`)))
    }
    await setup({ plan: 'sala', moduleOverrides: { staff: true, inventory: true } })
    await assertSucceeds(getDoc(doc(client('owner'), `${local}/timeEntries/mine`)))
    await assertSucceeds(getDoc(doc(client('owner'), `${local}/ingredientCosts/i1`)))
    await setup({ plan: 'completo' })
    await assertSucceeds(getDoc(doc(client('owner'), `${local}/ingredientCosts/i1`)))
    await setup({ plan: 'completo', moduleOverrides: { staff: false } })
    await assertFails(getDoc(doc(client('owner'), `${local}/timeEntries/mine`)))
  })
  it('el acceso por local se respeta con varios locales', async () => {
    await env.withSecurityRulesDisabled((c) => setDoc(doc(c.firestore(), `${root}/locations/otro/ingredients/i1`), { x: 1 }))
    await assertSucceeds(getDoc(doc(client('limited'), `${root}/locations/otro/ingredients/i1`)))
    await assertFails(getDoc(doc(client('limited'), `${local}/ingredients/i1`)))
    expect(true).toBe(true)
  })
})
