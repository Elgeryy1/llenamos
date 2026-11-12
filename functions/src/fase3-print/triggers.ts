import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { Timestamp } from 'firebase-admin/firestore'
import * as core from '@llenamos/core'
import { db, options } from '../shared'
import { hash, local, metadata, type Scope } from './context'
import { processRequest } from './queue'
import { type KitchenBatch } from './documents'
const root = 'restaurants/{restaurantId}/locations/{locationId}'
export async function processSafely(s: Scope, id: string) {
  try { await processRequest(s, id) } catch {
    // Un documento inválido no bloquea toda la cola y nunca se presenta como impreso.
    await local(s).collection('printRequests').doc(id).update({ status: 'failed', lastError: 'No se pudo preparar el documento. Revisa su origen y el perfil de la impresora.', ...metadata(null) })
  }
}
export const peticionImpresion = onDocumentWritten({ ...options, document: `${root}/printRequests/{requestId}` }, async e => {
  if (e.data?.after.exists && ['queued', 'not_configured'].includes(e.data.after.get('status')) && e.data.before.get('status') !== e.data.after.get('status')) await processSafely(e.params, e.params.requestId)
})
export async function enqueueKitchen(s: Scope, after: unknown, before?: unknown) {
  const line = core.OrderLineSchema.parse(after), old = core.OrderLineSchema.safeParse(before)
  if (line.status !== 'fired' || line.kind === 'menu' || !line.stationId || !line.firedAt || old.success && old.data.firedAt === line.firedAt) return
  const batch: KitchenBatch = { orderId: line.orderId, firedAt: line.firedAt, stationId: line.stationId, course: line.course, sessionId: line.sessionId, takeawayId: line.takeawayId }
  const id = hash(JSON.stringify(['fire', batch])), ref = local(s).collection('printRequests').doc(id)
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists) tx.create(ref, { ...core.printRequestForWrite({ kind: 'kitchen', sourceId: line.orderId, printerId: null, copy: 0, status: 'queued', requestedBy: line.createdBy, requestedAt: line.firedAt! }, Timestamp.fromMillis), kitchenBatch: batch, ...metadata(line.createdBy, true) })
  })
  await processSafely(s, id)
}
export const comandaMarchada = onDocumentWritten({ ...options, document: `${root}/orderLines/{lineId}` }, async e => {
  if (e.data?.after.exists) await enqueueKitchen(e.params, e.data.after.data(), e.data.before.data())
})
export const impresoraActualizada = onDocumentWritten({ ...options, document: `${root}/printers/{printerId}` }, async e => {
  if (!e.data?.after.exists) return
  const requests = await local(e.params).collection('printRequests').where('status', '==', 'not_configured').limit(100).get()
  for (const request of requests.docs) await processSafely(e.params, request.id)
})
