import { enqueueMessage } from './enqueue'
import { randomBytes } from 'node:crypto'
import { type Transaction } from 'firebase-admin/firestore'
import { hasModule, RestaurantSchema, PublicRestaurantSchema, ReservationSchema, ReservationSettingsSchema, defaultReservationSettings, linkToken, type MessageRequest } from '@llenamos/core'
import { HttpsError } from 'firebase-functions/v2/https'
import { db, parse } from '../shared'
export const token = () => linkToken(randomBytes(32))
export function queue(tx: Transaction, rid: string, request: MessageRequest, key?: string) {
 return enqueueMessage(tx, rid, request, key)
}
export async function publicContext(slug: string) {
 const pub = parse(PublicRestaurantSchema, (await db.doc(`publicRestaurants/${slug}`).get()).data())
 const restaurant = parse(RestaurantSchema, (await db.doc(`restaurants/${pub.restaurantId}`).get()).data())
 if (!hasModule(restaurant, 'reservations') || !pub.bookingEnabled) throw new HttpsError('failed-precondition', 'Las reservas públicas están desactivadas.')
 return { pub, restaurant, rid: pub.restaurantId }
}
export async function settings(path: string) {
 const snap = await db.doc(`${path}/settings/reservations`).get()
 return snap.exists ? parse(ReservationSettingsSchema, snap.data()) : defaultReservationSettings()
}
export async function linkedReservation(rid: string, reference: string, hash: string) {
 const index = (await db.doc(`restaurants/${rid}/reservationReferences/${reference}`).get()).data()
 if (index) {
  const doc = await db.doc(`restaurants/${rid}/locations/${index.locationId}/reservations/${index.reservationId}`).get()
  if (doc.exists) {
   const r = parse(ReservationSchema, doc.data())
   if (r.manageTokenHash === hash) return { ref: doc.ref, reservation: r }
  }
 }
 throw new HttpsError('not-found', 'No se encuentra la reserva o el enlace no es válido.')
}
/** Límite persistente por teléfono, también al reintentar con otro proceso. */
export async function throttle(tx: Transaction, rid: string, customerId: string, now: number) {
 const ref = db.doc(`restaurants/${rid}/r2RateLimits/${customerId}`)
 const old = (await tx.get(ref)).data()
 const count = old && now - old.since < 3600000 ? Number(old.count) : 0
 if (count >= 10) throw new HttpsError('resource-exhausted', 'Demasiados intentos. Vuelve a intentarlo más tarde.')
 return () => tx.set(ref, { since: count ? old!.since : now, count: count + 1 })
}
