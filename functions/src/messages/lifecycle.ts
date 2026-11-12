import { onDocumentUpdated } from 'firebase-functions/v2/firestore'
import { Timestamp } from 'firebase-admin/firestore'
import { ReservationSchema, ReservationSettingsSchema, horaLocal, sumarDias, instanteDeHoraLocal } from '@llenamos/core'
import { db, options, parse, reservationLock } from '../shared'
import { queue } from './support'
import { offerWaitlist } from '../waitlist/service'
export const mensajesReservaActualizada = onDocumentUpdated({ ...options, document: 'restaurants/{rid}/locations/{lid}/reservations/{reservationId}' }, async event => {
 if (!event.data) return
 const before = parse(ReservationSchema, event.data.before.data()), after = parse(ReservationSchema, event.data.after.data())
 if (before.status === after.status && before.startAt === after.startAt) return
 const { rid, lid, reservationId } = event.params
 const path = `restaurants/${rid}/locations/${lid}`
 await db.runTransaction(async tx => {
  const [currentDoc, settingsDoc, pending] = await Promise.all([tx.get(event.data!.after.ref), tx.get(db.doc(`${path}/settings/reservations`)), tx.get(db.collection(`restaurants/${rid}/messages`).where('reservationId','==',reservationId))])
  // Un evento atrasado puede llegar después del borrado del restaurante o la reserva.
  if (!currentDoc.exists) return
  const current = parse(ReservationSchema, currentDoc.data())
  const settings = settingsDoc.exists ? parse(ReservationSettingsSchema, settingsDoc.data()) : null
  if (before.status !== 'finished' && after.status === 'finished' && current.status === 'finished' && settings?.reviews.enabled && settings.reviews.googleReviewUrl) {
   const sendAt = instanteDeHoraLocal(sumarDias(horaLocal(current.startAt,settings.timezone).fecha,1),720,settings.timezone)!
   for (const channel of ['email','whatsapp'] as const) {
    const to = channel === 'email' ? current.email : current.phone
    const key = `review_${reservationId}_${channel}`
    // La escritura determinista se hace solo al entrar en finished; la entrega repetida
    // del evento no reemplaza mensajes ya enviados (comprobación previa abajo).
    if (to && !pending.docs.some(d => d.id === key)) queue(tx,rid,{ channel,to,template:'review_request',language:current.language,data:{guestName:current.guestName,googleReviewUrl:settings.reviews.googleReviewUrl},reservationId,waitlistId:null,sendAt },key)
   }
  }
 })
 if (['cancelled','no_show'].includes(after.status) && before.status !== after.status) await offerWaitlist(rid,lid)
})
export async function expireOffers() {
 const entries = await db.collectionGroup('waitlist').where('status','==','offered').get()
 const locations = new Set<string>()
 for (const doc of entries.docs) await db.runTransaction(async tx => {
  const incrementLock = await reservationLock(tx, doc.ref.parent.parent!.path)
  const entry = (await tx.get(doc.ref)).data()
  if (entry?.status === 'offered' && entry.offer?.expiresAt.toMillis() <= Date.now()) { incrementLock(); tx.update(doc.ref,{ status:'expired',updatedAt:Timestamp.now() }); locations.add(doc.ref.parent.parent!.path) }
 })
 for (const path of locations) { const parts=path.split('/'); await offerWaitlist(parts[1]!,parts[3]!) }
}
