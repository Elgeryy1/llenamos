/** Utilidades de las pruebas de integración de la fase 4 (solo contra los emuladores). */
import { randomUUID } from 'node:crypto'
import type { CallableRequest } from 'firebase-functions/v2/https'
import * as core from '@llenamos/core'
import { db } from '../shared'
import { execute } from './index'
import type { Name } from './context'

export const enabled = process.env.TEST_FIREBASE_EMULATORS === '1' && process.env.GCLOUD_PROJECT === 'demo-llenamos' && !!process.env.FIRESTORE_EMULATOR_HOST
export const lid = 'centro'
export const MIN = 60_000
export const HOUR = 60 * MIN
export const req = (data: unknown, uid: string | null = 'owner') => ({ data, ...(uid ? { auth: { uid, token: {} } } : {}) }) as unknown as CallableRequest<unknown>

const roots: string[] = []
export interface Fx { rid: string; path: string; scope: () => { restaurantId: string; locationId: string }; mutation: () => { restaurantId: string; locationId: string; requestId: string } }

export const ROLES = ['owner', 'manager', 'waiter', 'kitchen', 'bar', 'ana', 'berta'] as const

/** Restaurante de prueba con todos los módulos de la fase 4 y un equipo de cada rol. */
export async function createRestaurant(prefix: string, modules: string[] = ['reservations', 'floor', 'kitchen', 'pos', 'staff', 'inventory']): Promise<Fx> {
  const rid = `${prefix}-${randomUUID()}`
  roots.push(rid)
  const path = `restaurants/${rid}/locations/${lid}`
  await db.doc(`restaurants/${rid}`).set({ name: 'Prueba fase 4', slug: rid, brandColor: '#f0a35e', timezone: 'Europe/Madrid', locale: 'es', currency: 'EUR', isDemo: true, plan: 'completo', activeModules: modules })
  await db.doc(path).set({ name: 'Centro', slug: 'centro', address: '', city: '', phone: '' })
  await db.doc(`restaurants/${rid}/locations/otro`).set({ name: 'Otro', slug: 'otro', address: '', city: '', phone: '' })
  for (const uid of ['owner', 'manager', 'waiter', 'kitchen', 'bar', 'ana', 'berta', 'inactive', 'limited', 'otrolocal']) {
    const role = uid === 'ana' || uid === 'berta' ? 'waiter' : ['inactive', 'limited', 'otrolocal'].includes(uid) ? 'owner' : uid
    await db.doc(`restaurants/${rid}/members/${uid}`).set({ uid, displayName: `Persona ${uid}`, email: `${uid}@test.es`, role, active: uid !== 'inactive', locationIds: uid === 'limited' || uid === 'otrolocal' ? ['otro'] : [] })
  }
  return { rid, path, scope: () => ({ restaurantId: rid, locationId: lid }), mutation: () => ({ restaurantId: rid, locationId: lid, requestId: randomUUID() }) }
}

export async function cleanup() {
  for (const id of roots) {
    await db.recursiveDelete(db.doc(`restaurants/${id}`))
    await db.doc(`publicRestaurants/${id}`).delete()
    await db.doc(`publicMenus/${core.publicMenuId(id, lid)}`).delete()
  }
}

export async function call<N extends Name>(name: N, data: unknown, uid: string | null = 'owner', now?: number): Promise<core.CallableOutput<N>> {
  return execute(name, data, req(data, uid), { now })
}

/** Carta de demostración, para pruebas que crean pedidos de verdad con la sala de la fase 2. */
export async function loadMenu(fx: Fx) {
  const demo = core.demoMenu(), rs = core.defaultReservationSettings()
  const shifts = [{ name: 'Servicio', from: '00:00', lastEntry: '23:45' }]
  rs.week = { mon: shifts, tue: shifts, wed: shifts, thu: shifts, fri: shifts, sat: shifts, sun: shifts }
  await db.doc(`${fx.path}/settings/reservations`).set(rs)
  await db.doc(`${fx.path}/settings/floor`).set(demo.settings)
  for (const [collection, rows] of Object.entries({ menuCategories: demo.categories, menuItems: demo.items, dailyMenus: demo.dailyMenus, stations: demo.stations })) {
    const batch = db.batch()
    for (const [id, value] of Object.entries(rows)) batch.set(db.doc(`${fx.path}/${collection}/${id}`), value)
    await batch.commit()
  }
  for (let i = 1; i <= 12; i++) await db.doc(`${fx.path}/tables/t${i}`).set({ name: `S${i}`, areaId: 'sala', seats: 8, enabled: true, joinableWith: [], shape: 'rect', x: 10, y: 10, w: 10, h: 10 })
}
