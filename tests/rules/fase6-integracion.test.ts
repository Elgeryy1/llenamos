import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { deleteDoc, doc, getDoc, serverTimestamp, setDoc, Timestamp } from 'firebase/firestore'

// Integración de la fase 6 en las reglas comunes: acceso por fecha, locales de servidor y equipo LogiQD sin lectura directa.
const rules = readFileSync(new URL('../../firebase/firestore.rules', import.meta.url), 'utf8')
let env: RulesTestEnvironment
const vigente = 'restaurants/f6-vigente', vencido = 'restaurants/f6-vencido', antiguo = 'restaurants/f6-antiguo'
const area = (uid: string) => ({ name: 'Sala', sortOrder: 0, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: uid })
describe('Reglas de la integración de la fase 6', () => {
  beforeAll(async () => {
    const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8100').split(':')
    env = await initializeTestEnvironment({ projectId: 'demo-llenamos', firestore: { host, port: Number(port), rules } })
    await env.withSecurityRulesDisabled(async c => {
      const db = c.firestore()
      const base = { name: 'Restaurante', brandColor: '#f0a35e', locale: 'es' }
      await setDoc(doc(db, vigente), { ...base, entitlementVersion: 1, activeModules: ['reservations', 'floor'], accessValidUntil: Timestamp.fromMillis(Date.now() + 3_600_000) })
      await setDoc(doc(db, vencido), { ...base, entitlementVersion: 1, activeModules: ['reservations', 'floor'], accessValidUntil: Timestamp.fromMillis(Date.now() - 1000) })
      await setDoc(doc(db, antiguo), { ...base, plan: 'sala', activeModules: ['reservations', 'floor'] })
      for (const root of [vigente, vencido, antiguo]) {
        await setDoc(doc(db, `${root}/members/owner`), { active: true, role: 'owner', locationIds: [] })
        await setDoc(doc(db, `${root}/members/waiter`), { active: true, role: 'waiter', locationIds: [] })
        await setDoc(doc(db, `${root}/locations/centro`), { name: 'Centro', slug: 'centro', address: '', city: '', phone: '', createdAt: Timestamp.fromMillis(1000), updatedAt: Timestamp.fromMillis(1000) })
        await setDoc(doc(db, `${root}/locations/centro/reservations/uno`), { status: 'confirmed' })
        await setDoc(doc(db, `${root}/platformEvents/e1`), { type: 'reservation.created' })
      }
    })
  })
  afterAll(async () => { await env.cleanup() })

  it('un acceso vigente deja trabajar y uno vencido corta lecturas y cambios de plano, sin tocar al antiguo', async () => {
    const ok = env.authenticatedContext('owner').firestore()
    await assertSucceeds(getDoc(doc(ok, `${vigente}/locations/centro/reservations/uno`)))
    await assertSucceeds(setDoc(doc(ok, `${vigente}/locations/centro/areas/sala`), area('owner')))
    await assertSucceeds(getDoc(doc(ok, `${antiguo}/locations/centro/reservations/uno`)))
    await assertSucceeds(setDoc(doc(ok, `${antiguo}/locations/centro/areas/sala`), area('owner')))
    await assertFails(getDoc(doc(ok, `${vencido}/locations/centro/reservations/uno`)))
    await assertFails(setDoc(doc(ok, `${vencido}/locations/centro/areas/sala`), area('owner')))
    // La administración sigue disponible con el acceso vencido: se ve el restaurante y su equipo para poder renovar.
    await assertSucceeds(getDoc(doc(ok, vencido)))
    await assertSucceeds(getDoc(doc(ok, `${vencido}/members/waiter`)))
  })
  it('los locales de un restaurante con suscripción no se crean ni se borran desde el SDK; los antiguos sí', async () => {
    const db = env.authenticatedContext('owner').firestore()
    const location = { name: 'Otro', slug: 'otro', address: '', city: '', phone: '', createdAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: 'owner' }
    await assertFails(setDoc(doc(db, `${vigente}/locations/otro`), location))
    await assertFails(deleteDoc(doc(db, `${vigente}/locations/centro`)))
    await assertSucceeds(setDoc(doc(db, `${antiguo}/locations/otro`), location))
    await assertSucceeds(deleteDoc(doc(db, `${antiguo}/locations/otro`)))
  })
  it('el equipo LogiQD no lee restaurantes ni su cola de eventos por el SDK, ni siendo miembro sin permiso', async () => {
    const team = env.authenticatedContext('equipo', { logiqd: true }).firestore()
    for (const root of [vigente, vencido, antiguo]) {
      await assertFails(getDoc(doc(team, root)))
      await assertFails(getDoc(doc(team, `${root}/locations/centro/reservations/uno`)))
      await assertFails(getDoc(doc(team, `${root}/platformEvents/e1`)))
    }
    const owner = env.authenticatedContext('owner').firestore()
    await assertFails(getDoc(doc(owner, `${vigente}/platformEvents/e1`)))
    await assertFails(setDoc(doc(owner, `${vigente}/platformEvents/e2`), { type: 'x' }))
  })
  it('un camarero no cambia el plano ni los locales aunque el acceso esté vigente', async () => {
    const waiter = env.authenticatedContext('waiter').firestore()
    await assertSucceeds(getDoc(doc(waiter, `${vigente}/locations/centro/reservations/uno`)))
    await assertFails(setDoc(doc(waiter, `${vigente}/locations/centro/areas/sala`), area('waiter')))
  })
})
