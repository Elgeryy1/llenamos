import { createHash } from 'node:crypto'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { Timestamp } from 'firebase-admin/firestore'
import * as core from '@llenamos/core'
import { db, stamp, options } from './shared'

export const reservationChanged = onDocumentWritten({ ...options, document: 'restaurants/{rid}/locations/{lid}/reservations/{id}' }, async event => {
  if (!event.data) return
  const after = event.data.after.data(), before = event.data.before.data()
  // Una reserva anonimizada o borrada por privacidad no debe recrear la ficha del cliente.
  if (after?.privacyRedacted === true || before?.privacyRedacted === true) return
  const data = after ?? before
  if (!data) return
  const r = core.ReservationSchema.parse(data)
  const root = db.doc(`restaurants/${event.params.rid}`)
  const eventRef = root.collection('activity').doc(createHash('sha256').update(event.id).digest('hex'))
  await db.runTransaction(async tx => {
    if ((await tx.get(eventRef)).exists) return
    // Un disparador atrasado trae la foto de antes del borrado: manda el estado actual.
    const current = await tx.get(event.data!.after.ref)
    if (current.data()?.privacyRedacted === true) return
    const actorUid = 'updatedBy' in data ? data.updatedBy as string | null : r.history.at(-1)?.by ?? r.createdBy
    const actor = actorUid ? (await tx.get(db.doc(`users/${actorUid}`))).data() : undefined
    const customerRef = root.collection('customers').doc(r.customerId)
    const old = await tx.get(customerRef)
    const locations = await tx.get(root.collection('locations'))
    const reservations: core.Reservation[] = []
    for (const local of locations.docs) {
      const rows = await tx.get(local.ref.collection('reservations').where('customerId', '==', r.customerId))
      if (rows.docs.some(d => d.get('privacyRedacted') === true)) return
      reservations.push(...rows.docs.map(d => core.ReservationSchema.parse(d.data())))
    }
    const visits = reservations.filter(r => ['seated', 'finished'].includes(r.status))
    const customer = core.CustomerSchema.parse({ name: r.guestName, phone: r.phone, email: r.email, language: r.language, notes: '', allergies: '', tags: [], ...old.data(), visits: visits.length, noShows: reservations.filter(r => r.status === 'no_show').length, cancellations: reservations.filter(r => r.status === 'cancelled').length, lastVisitAt: visits.length ? Math.max(...visits.map(r => r.startAt)) : null })
    tx.set(customerRef, { ...core.customerForWrite(customer, Timestamp.fromMillis), ...(!old.exists ? stamp() : { updatedAt: Timestamp.now() }) }, { merge: true })
    const action = !before ? 'created' : !after ? 'deleted' : before.status !== after.status ? 'statusChanged' : before.startAt?.toMillis() !== after.startAt?.toMillis() ? 'moved' : 'tablesChanged'
    tx.create(eventRef, { action: `reservation.${action}`, summary: `Reserva ${r.reference}: ${core.RESERVATION_STATUS_LABEL[r.status]}`, actorUid, actorName: actor?.displayName ?? null, entity: { type: 'reservation', id: event.params.id }, ...stamp() })
  })
})

export async function syncPublicRestaurant(rid: string, previousSlug?: string) {
  await db.runTransaction(async tx => {
    const root = db.doc(`restaurants/${rid}`)
    const restaurant = (await tx.get(root)).data()
    const locations = await tx.get(root.collection('locations'))
    const publicLocations: core.PublicLocation[] = []
    let first: core.ReservationSettings | undefined
    for (const local of locations.docs) {
      const raw = await tx.get(local.ref.collection('settings').doc('reservations'))
      const settings = raw.exists ? core.ReservationSettingsSchema.parse(raw.data()) : core.defaultReservationSettings(restaurant?.timezone)
      first ??= settings
      if (settings.publicBooking) publicLocations.push(core.PublicLocationSchema.parse({ id: local.id, ...local.data() }))
    }
    if (previousSlug && previousSlug !== restaurant?.slug) tx.delete(db.doc(`publicRestaurants/${previousSlug}`))
    if (!restaurant) return
    const settings = first ?? core.defaultReservationSettings(restaurant.timezone)
    const enabled = core.hasModule(restaurant, 'reservations')
    const data = core.PublicRestaurantSchema.parse({ restaurantId: rid, ...restaurant, bookingEnabled: enabled && publicLocations.length > 0, bookingDisabledReason: !enabled ? 'module_off' : publicLocations.length ? null : 'public_booking_off', locations: publicLocations, minPartySize: settings.minPartySize, maxPartySize: settings.maxPartySize, maxAdvanceDays: settings.maxAdvanceDays, deposit: settings.deposit, cancellationFreeUntilHours: settings.cancellation.freeUntilHours })
    tx.set(db.doc(`publicRestaurants/${restaurant.slug}`), { ...data, ...stamp() })
  })
}
export const publicRestaurantChanged = onDocumentWritten({ ...options, document: 'restaurants/{rid}' }, event => syncPublicRestaurant(event.params.rid, event.data?.before.data()?.slug))
export const publicLocationChanged = onDocumentWritten({ ...options, document: 'restaurants/{rid}/locations/{lid}' }, event => {
  // Los campos privados no afectan a la proyección pública.
  const before = event.data?.before.data(), after = event.data?.after.data()
  if (before && after && ['name', 'address', 'city', 'phone', 'slug'].every(k => before[k] === after[k])) return
  return syncPublicRestaurant(event.params.rid)
})
export const publicSettingsChanged = onDocumentWritten({ ...options, document: 'restaurants/{rid}/locations/{lid}/settings/reservations' }, event => syncPublicRestaurant(event.params.rid))
