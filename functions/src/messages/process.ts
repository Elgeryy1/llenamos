import { assertMarketingConsent } from '../fase6-privacy/index'
import { randomUUID } from 'node:crypto'
import { FieldValue, Timestamp, type DocumentReference } from 'firebase-admin/firestore'
import { onDocumentCreated } from 'firebase-functions/v2/firestore'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { onCall, HttpsError } from '../identity-call'
import { CALLABLES, CALLABLE_SCHEMAS, MessageSchema, can, hasModule } from '@llenamos/core'
import { db, membership, options, parse, safe, uidOf } from '../shared'
import { expireOffers } from './lifecycle'
import { sendMessage } from '../providers/send'
export async function processMessage(ref: DocumentReference, now = Date.now()) {
 const claim = randomUUID()
 const message = await db.runTransaction(async tx => {
  const snap = await tx.get(ref)
  if (!snap.exists) return null
  const m = parse(MessageSchema, snap.data())
  if (m.status !== 'queued' || m.sendAt > now || (snap.get('leaseUntil')?.toMillis() ?? 0) > now) return null
  if (m.purpose) {
   const restaurant = (await tx.get(db.doc(`restaurants/${ref.path.split('/')[1]!}`))).data()
   if (!restaurant || !hasModule(restaurant, 'marketing')) return null
   try {
    if (!m.customerId) throw new HttpsError('failed-precondition', 'Falta el cliente del mensaje de marketing.')
    await assertMarketingConsent(tx, ref.path.split('/')[1]!, m.customerId, m.purpose)
   } catch (error) {
    if (!(error instanceof HttpsError) || error.code !== 'failed-precondition') throw error
    tx.update(ref, { status: 'cancelled', lastError: error.message, updatedAt: FieldValue.serverTimestamp() })
    return null
   }
  }
  tx.update(ref, { leaseUntil: Timestamp.fromMillis(now + 60000), claim, attempts: m.attempts + 1 })
  return m
 })
 if (!message) return null
 let result
 try { result = { ...await sendMessage(message, ref.path), lastError: null } }
 catch (e) { result = { status: 'failed' as const, lastError: e instanceof Error ? e.message.slice(0,1000) : 'No se ha podido enviar el mensaje.' } }
 await db.runTransaction(async tx => {
  const snap = await tx.get(ref)
  if (snap.get('claim') !== claim) return
  if (snap.get('status') === 'queued') tx.update(ref, { ...result, leaseUntil: FieldValue.delete(), claim: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() })
  else if (snap.get('status') === 'cancelled') tx.update(ref, { leaseUntil: FieldValue.delete(), claim: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() })
 })
 return result.status
}
export async function processPending(rid?: string, limit = 100) {
 await expireOffers()
 const query = rid ? db.collection(`restaurants/${rid}/messages`) : db.collectionGroup('messages')
 const docs = await query.where('status', '==', 'queued').get()
 const counts = { processed: 0, sent: 0, captured: 0, notConfigured: 0, failed: 0 }
 for (const doc of docs.docs) {
  if (counts.processed >= limit) break
  const status = await processMessage(doc.ref)
  if (status) { counts.processed++; if (status === 'not_configured') counts.notConfigured++; else counts[status]++ }
 }
 return counts
}
export const procesarMensajesPendientes = onCall({ ...options, secrets: ['PLATFORM_API_MASTER_KEY'] }, request => safe(async () => {
 const uid = uidOf(request)
 const data = parse(CALLABLE_SCHEMAS[CALLABLES.procesarMensajesPendientes].input, request.data)
 if (request.auth?.token.logiqd !== true) {
  if (!data.restaurantId) throw new HttpsError('permission-denied', 'Selecciona un restaurante.')
  const actor = await db.runTransaction(tx => membership(tx, data.restaurantId!, uid))
  if (!actor.active || !can(actor.role, 'mensajes.ver')) throw new HttpsError('permission-denied', 'No tienes permiso para ver mensajes.')
 }
 return processPending(data.restaurantId, data.limit)
}))
export const mensajeCreado = onDocumentCreated({ ...options, secrets: ['PLATFORM_API_MASTER_KEY'], document: 'restaurants/{rid}/messages/{mid}' }, async event => { if (event.data) await processMessage(event.data.ref) })
export const mensajesProgramados = onSchedule({ ...options, secrets: ['PLATFORM_API_MASTER_KEY'], schedule: 'every 5 minutes' }, async () => { await processPending() })
