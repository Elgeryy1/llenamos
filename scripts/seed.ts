import { initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore'
import { activeModulesFor, defaultReservationSettings, horaLocal, sumarDias, instanteDeHoraLocal, customerIdFor, reservationForWrite, ReservationSchema, sha256Hex } from '../packages/core/src/index'
import { isDeepStrictEqual } from 'node:util'
import { seedFase2 } from './seed-fase2'

// Solo permite emuladores, conservando los puertos que facilite quien lo ejecuta.
process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8085'
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099'
initializeApp({ projectId: 'demo-llenamos' })
const db = getFirestore()
const auth = getAuth()
const restaurant = db.doc('restaurants/demo-lumbre')
const location = restaurant.collection('locations').doc('centro')

async function upsert(path: string, data: Record<string, unknown>) {
  const ref = db.doc(path)
  await db.runTransaction(async tx => {
    const old = await tx.get(ref)
    // No reescribe documentos iguales ni altera su fecha de creación.
    if (old.exists && Object.entries(data).every(([key, value]) => isDeepStrictEqual(old.data()?.[key], value))) return
    tx.set(ref, { ...data, ...(old.exists ? {} : { createdAt: FieldValue.serverTimestamp() }), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
  })
}

async function main() {
  await upsert(restaurant.path, { name: 'Taberna Lumbre', slug: 'taberna-lumbre', brandColor: '#f0a35e', currency: 'EUR', timezone: 'Europe/Madrid', locale: 'es', isDemo: true, plan: 'sala', moduleOverrides: {}, activeModules: activeModulesFor('sala') })
  await upsert(location.path, { name: 'Centro', slug: 'centro', address: 'Carrer de la Lumbre 12', city: 'Barcelona', phone: '' })
  const accounts = [
    ['propietario', 'Marta Soler', 'owner'], ['encargada', 'Laura Vidal', 'manager'],
    ['camarero', 'Diego Ríos', 'waiter'], ['camarera', 'Lucía Ferrer', 'waiter'],
    ['cocina', 'Pau Serra', 'kitchen'], ['barra', 'Nora Costa', 'bar'],
  ] as const
  for (const [key, displayName, role] of accounts) {
    const email = `${key}@lumbre.test`
    const user = await auth.getUserByEmail(email).catch((error: unknown) => {
      if ((error as { code?: string }).code !== 'auth/user-not-found') throw error
      return auth.createUser({ uid: `lumbre-${key}`, email, displayName, password: 'Llenamos2026!' })
    })
    await auth.updateUser(user.uid, { displayName, password: 'Llenamos2026!', disabled: false })
    await upsert(`users/${user.uid}`, { displayName, email, restaurants: { 'demo-lumbre': { name: 'Taberna Lumbre', role } } })
    await upsert(`${restaurant.path}/members/${user.uid}`, { uid: user.uid, displayName, email, role, active: true, locationIds: [] })
  }
  for (const [aid, name, count, sortOrder] of [['sala', 'Sala', 10, 0], ['terraza', 'Terraza', 6, 1]] as const) {
    await upsert(`${location.path}/areas/${aid}`, { name, sortOrder })
    for (let i = 0; i < count; i++) {
      await upsert(`${location.path}/tables/${aid}-${i + 1}`, {
        name: `${aid === 'sala' ? 'S' : 'T'}${i + 1}`, areaId: aid, seats: aid === 'sala' && i === 9 ? 8 : [2, 4, 6][i % 3],
        shape: i % 2 ? 'round' : 'rect', x: 5 + (i % 5) * 19, y: 10 + Math.floor(i / 5) * 40,
        w: 14, h: 22,
        joinableWith: i < 2 ? [`${aid}-${2 - i}`] : i >= 5 && i <= 7 && aid === 'sala' ? [5, 6, 7].filter(n => n !== i).map(n => `${aid}-${n + 1}`) : [],
        enabled: !(aid === 'terraza' && i === 5),
      })
    }
  }
  const settings = defaultReservationSettings()
  const shifts = [{ name: 'Comida', from: '13:00', lastEntry: '15:30' }, { name: 'Cena', from: '20:00', lastEntry: '22:30' }]
  settings.week = { mon: [], tue: shifts, wed: shifts, thu: shifts, fri: shifts, sat: shifts, sun: [shifts[0]!] }
  settings.publicBooking = true; settings.autoConfirm = true; settings.reminders.dayBefore = true; settings.waitlist.enabled = true
  await upsert(`${location.path}/settings/reservations`, settings)
  const email = 'equipo@logiqd.test'
  const team = await auth.getUserByEmail(email).catch((error: unknown) => {
    if ((error as { code?: string }).code !== 'auth/user-not-found') throw error
    return auth.createUser({ uid: 'logiqd-equipo', email, displayName: 'Equipo LogiQD', password: 'Llenamos2026!' })
  })
  await auth.setCustomUserClaims(team.uid, { ...team.customClaims, logiqd: true })
  await upsert(`users/${team.uid}`, { displayName: 'Equipo LogiQD', email, restaurants: {} })
  const today = horaLocal(Date.now(), settings.timezone).fecha
  for (const [i, status] of (['pending', 'confirmed', 'seated', 'finished', 'cancelled', 'no_show'] as const).entries()) {
    const day = sumarDias(today, i % 2)
    const phone = `+3460000000${i}`
    const customerId = customerIdFor('demo-lumbre', phone)
    const reference = `DEMA2${i + 2}`
    const r = ReservationSchema.parse({ guestName: ['Ana García', 'Joan Puig', 'María López', 'David Soler', 'Nuria Costa', 'Alex Ríos'][i], phone, email: null, language: 'es', partySize: 2, startAt: instanteDeHoraLocal(day, 13 * 60 + i * 30, settings.timezone), durationMinutes: 90, status, tableIds: [`sala-${i + 1}`], suggestedTableIds: [], suggestionReason: null, source: 'phone', notes: '', guestNotes: '', customerId, reference, manageTokenHash: sha256Hex(`seed-${i}`), deposit: { status: 'none', amountCents: 0, checkoutSessionId: null }, history: [], createdBy: null })
    await upsert(`${location.path}/reservations/demo-${i}`, reservationForWrite(r, Timestamp.fromMillis))
    await upsert(`${restaurant.path}/reservationReferences/${reference}`, { locationId: 'centro', reservationId: `demo-${i}` })
    await upsert(`${restaurant.path}/customers/${customerId}`, { name: r.guestName, phone, email: null, language: 'es', visits: ['seated','finished'].includes(status) ? 1 : 0, cancellations: status === 'cancelled' ? 1 : 0, noShows: status === 'no_show' ? 1 : 0, lastVisitAt: ['seated','finished'].includes(status) ? Timestamp.fromMillis(r.startAt) : null, notes: 'Cliente de demostración', allergies: i === 0 ? 'Frutos secos' : '', tags: ['demo'] })
  }
  await upsert(`${location.path}/waitlist/demo`, { guestName: 'Eva Martín', phone: '+34611111111', email: null, language: 'es', partySize: 4, date: today, from: '13:00', to: '15:00', status: 'waiting', offer: null, customerId: customerIdFor('demo-lumbre', '+34611111111'), source: 'staff' })
  await seedFase2(db)
  console.log('Seed completado: Taberna Lumbre, 7 cuentas, 16 mesas, reservas, clientes y lista de espera.')
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => db.terminate())
