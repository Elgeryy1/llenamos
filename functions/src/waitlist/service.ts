import { writeReservationMarketing } from '../fase5/reservation-integration'
import { providerAvailability } from '../providers/tenant'
import { configuredAppOrigin } from '../public-app-url'
import { randomBytes } from 'node:crypto'
import { Timestamp, type Transaction } from 'firebase-admin/firestore'
import { onCall, HttpsError } from '../identity-call'
import { enqueueReservationEvent } from '../fase6-api/events'
import { CALLABLES, CALLABLE_SCHEMAS, WaitlistEntrySchema, waitlistEntryForWrite, customerIdFor, sha256Hex, ReservationSchema, reservationForWrite, reservationReference, ReservationSettingsSchema, RestaurantSchema, hasModule, TableSchema, tableToMesa, settingsToConfiguracion, calcularDisponibilidad, depositAmountFor, horaAMinutos, horaLocal, sumarDias, type ReservationSettings } from '@llenamos/core'
import { db, options, parse, safe, stamp, reservationLock } from '../shared'
import { publicContext, settings, token, queue, throttle } from '../messages/support'

import { offeredOccupancy } from './occupancy'
import { readServiceSessions, serviceOccupancy } from '../fase2/occupancy'
export { offeredOccupancy } from './occupancy'
async function inventory(tx: Transaction, path: string, s: ReservationSettings, now: number, exclude?: string) {
 const [tables, reservations, waiting, sessions] = await Promise.all([tx.get(db.collection(`${path}/tables`)), tx.get(db.collection(`${path}/reservations`)), tx.get(db.collection(`${path}/waitlist`)), readServiceSessions(tx, path)])
 return { tables: tables.docs.map(d => tableToMesa(d.id, parse(TableSchema, d.data()))), reservations: [...serviceOccupancy(reservations.docs.map(d => ({ id: d.id, ...parse(ReservationSchema, d.data()) })), sessions, s, now), ...waiting.docs.filter(d => d.id !== exclude).flatMap(d => offeredOccupancy(d.id, parse(WaitlistEntrySchema, d.data()), s, now))], waiting }
}
export const apuntarseListaEspera = onCall(options, request => safe(async () => {
 const data = parse(CALLABLE_SCHEMAS[CALLABLES.apuntarseListaEspera].input, request.data)
 const { rid, pub } = await publicContext(data.slug)
 if (!pub.locations.some(l => l.id === data.locationId)) throw new HttpsError('not-found', 'No se encuentra el local.')
 const path = `restaurants/${rid}/locations/${data.locationId}`
 const s = await settings(path)
 if (data.partySize < s.minPartySize || data.partySize > s.maxPartySize || data.date < horaLocal(Date.now(),s.timezone).fecha || data.date > sumarDias(horaLocal(Date.now(),s.timezone).fecha,s.maxAdvanceDays)) throw new HttpsError('invalid-argument', 'La fecha o el tamaño del grupo están fuera del plazo de reservas.')
 if (!s.waitlist.enabled) throw new HttpsError('failed-precondition', 'La lista de espera está desactivada.')
 const customerId = customerIdFor(rid, data.phone)
 const ref = db.collection(`${path}/waitlist`).doc()
 await db.runTransaction(async tx => {
  const rate = await throttle(tx, rid, customerId, Date.now())
  const entry = parse(WaitlistEntrySchema, { ...data, customerId, status: 'waiting', offer: null })
  rate(); tx.create(ref, { ...waitlistEntryForWrite(entry, Timestamp.fromMillis), ...stamp() })
 })
 return { waitlistId: ref.id, status: 'waiting' as const }
}))
export async function offerWaitlist(rid: string, lid: string) {
 const path = `restaurants/${rid}/locations/${lid}`
 await db.runTransaction(async tx => {
  const incrementLock = await reservationLock(tx, path)
  const [settingsDoc, restaurantDoc] = await Promise.all([tx.get(db.doc(`${path}/settings/reservations`)), tx.get(db.doc(`restaurants/${rid}`))])
  if (!settingsDoc.exists) return
  const s = parse(ReservationSettingsSchema, settingsDoc.data())
  const restaurant = parse(RestaurantSchema, restaurantDoc.data())
  if (!s.waitlist.enabled || !s.publicBooking || !hasModule(restaurant, 'reservations')) return
  const now = Date.now(), inv = await inventory(tx, path, s, now)
  const candidates = inv.waiting.docs.filter(d => d.get('status') === 'waiting').sort((a,b) => (a.get('createdAt')?.toMillis() ?? 0) - (b.get('createdAt')?.toMillis() ?? 0) || a.id.localeCompare(b.id))
  for (const doc of candidates) {
   const entry = parse(WaitlistEntrySchema, doc.data())
   const available = calcularDisponibilidad({ config: settingsToConfiguracion(s), fecha: entry.date, comensales: entry.partySize, mesas: inv.tables, reservas: inv.reservations, ahora: now })
   const from = horaAMinutos(entry.from), to = horaAMinutos(entry.to)
   const slot = available.franjas.find(f => f.disponible && (from <= to ? horaAMinutos(f.hora) >= from && horaAMinutos(f.hora) <= to : horaAMinutos(f.hora) >= from || horaAMinutos(f.hora) <= to))
   if (!slot) continue
   const raw = token(), expiresAt = now + s.waitlist.offerMinutes * 60000
   incrementLock()
   tx.update(doc.ref, { status: 'offered', offer: { startAt: Timestamp.fromMillis(slot.inicio), expiresAt: Timestamp.fromMillis(expiresAt), tokenHash: sha256Hex(raw) }, updatedAt: Timestamp.now() })
   const offerUrl = new URL(`/r/${restaurant.slug}/lista-espera/${doc.id}?t=${raw}`, configuredAppOrigin()).href
   for (const channel of ['email','whatsapp'] as const) {
    const to = channel === 'email' ? entry.email : entry.phone
    if (to) queue(tx, rid, { channel, to, template: 'waitlist_offer', language: entry.language, data: { guestName: entry.guestName, restaurantName: restaurant.name, partySize: entry.partySize, startAt: slot.inicio, timezone: s.timezone, offerUrl, expiresAt }, reservationId: null, waitlistId: doc.id, sendAt: now }, `offer_${doc.id}_${channel}`)
   }
   break
  }
 })
}
export const aceptarOfertaListaEspera = onCall(options, request => safe(async () => {
 const data = parse(CALLABLE_SCHEMAS[CALLABLES.aceptarOfertaListaEspera].input, request.data)
 const { rid, pub } = await publicContext(data.slug)
 for (const location of pub.locations) {
  const path = `restaurants/${rid}/locations/${location.id}`, ref = db.doc(`${path}/waitlist/${data.waitlistId}`)
  if (!(await ref.get()).exists) continue
  return db.runTransaction(async tx => {
   const incrementLock = await reservationLock(tx, path)
   const [entryDoc, settingsDoc] = await Promise.all([tx.get(ref), tx.get(db.doc(`${path}/settings/reservations`))])
   const entry = parse(WaitlistEntrySchema, entryDoc.data()), s = parse(ReservationSettingsSchema, settingsDoc.data()), now = Date.now()
   if (entry.status !== 'offered' || !entry.offer || entry.offer.tokenHash !== sha256Hex(data.token) || entry.offer.expiresAt <= now) throw new HttpsError('failed-precondition', 'La oferta ha caducado o el enlace no es válido.')
   const rate = await throttle(tx, rid, entry.customerId, now)
   const inv = await inventory(tx, path, s, now, ref.id)
   const available = calcularDisponibilidad({ config: settingsToConfiguracion(s), fecha: entry.date, comensales: entry.partySize, mesas: inv.tables, reservas: inv.reservations, ahora: now })
   if (!available.franjas.some(f => f.inicio === entry.offer!.startAt && f.disponible)) throw new HttpsError('failed-precondition', 'El hueco ya no está disponible.')
   const reference = reservationReference(randomBytes(16)), manageToken = token()
   const referenceRef = db.doc(`restaurants/${rid}/reservationReferences/${reference}`)
   if ((await tx.get(referenceRef)).exists) throw new HttpsError('aborted', 'Vuelve a aceptar la oferta.')
   const amountCents = depositAmountFor(s.deposit, entry.partySize)
   const providers = await providerAvailability(tx, rid)
   const deposit = { status: amountCents ? providers.stripe ? 'required' as const : 'not_configured' as const : 'none' as const, amountCents, checkoutSessionId: null }
   const reservation = parse(ReservationSchema, { ...entry, startAt: entry.offer.startAt, durationMinutes: available.duracionMinutos, status: s.autoConfirm && !amountCents ? 'confirmed' : 'pending', source: 'waitlist', tableIds: [], suggestedTableIds: [], suggestionReason: null, notes: '', guestNotes: '', reference, manageTokenHash: sha256Hex(manageToken), deposit, history: [], createdBy: null })
   const reservationRef = db.collection(`${path}/reservations`).doc()
   writeReservationMarketing(tx, rid, location.id, reservationRef.id, reservation, entry.date, now)
   incrementLock(); tx.create(referenceRef, { locationId: location.id, reservationId: reservationRef.id })
   rate(); tx.create(reservationRef, { ...reservationForWrite(reservation, Timestamp.fromMillis), ...stamp() }); tx.update(ref, { status: 'booked', updatedAt: Timestamp.now() })
   enqueueReservationEvent(tx, { restaurantId: rid, locationId: location.id, type: 'reservation.created', reservationId: reservationRef.id, status: reservation.status, decision: 'created', at: now })
   const manageUrl = new URL(`/r/${data.slug}/reserva/${reference}?t=${manageToken}`, configuredAppOrigin()).href
   for (const channel of ['email','whatsapp'] as const) {
    const to = channel === 'email' ? entry.email : entry.phone
    if (to) queue(tx, rid, { channel, to, template: deposit.status === 'required' ? 'deposit_request' : reservation.status === 'confirmed' ? 'confirmation' : 'pending', language: entry.language, data: { guestName: entry.guestName, restaurantName: pub.name, partySize: entry.partySize, startAt: reservation.startAt, timezone: s.timezone, reference, manageUrl }, reservationId: reservationRef.id, waitlistId: ref.id, sendAt: now })
   }
   return { reference, status: reservation.status, manageToken, startAt: reservation.startAt, deposit }
  })
 }
 throw new HttpsError('not-found', 'No se encuentra la oferta.')
}))
