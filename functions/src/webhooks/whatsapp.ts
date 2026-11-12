import { prepareReservationNotices } from '../reservations'
import { onRequest } from 'firebase-functions/v2/https'
import { z } from 'zod'
import { Timestamp } from 'firebase-admin/firestore'
import { enqueueReservationEvent } from '../fase6-api/events'
import { isUnsubscribeReply, consentForWrite, customerIdFor, MessageSchema, ReservationSchema, applyStatusChange, reservationForWrite, sha256Hex } from '@llenamos/core'
import { db, options, parse, reservationLock, stamp } from '../shared'
import { verifyWhatsApp } from './signatures'
import { tenantProviderEnv } from '../providers/tenant'
const payload = z.object({ entry: z.array(z.object({ changes: z.array(z.object({ value: z.object({ messages: z.array(z.object({ id: z.string(), from: z.string(), context: z.object({ id: z.string() }).optional(), interactive: z.object({ button_reply: z.object({ id: z.string() }) }).optional(), button: z.object({ text: z.string(), payload: z.string() }).optional(), text: z.object({ body: z.string() }).optional() })).optional() }) })) })) })
export async function handleWhatsApp(body: unknown, restaurantId?: string) {
 for (const entry of payload.parse(body).entry) for (const change of entry.changes) for (const incoming of change.value.messages ?? []) {
  if (isUnsubscribeReply(incoming.text?.body ?? incoming.button?.text ?? '')) {
   const phone = `+${incoming.from.replace(/^\+/, '')}`
   const customers = await (restaurantId ? db.collection(`restaurants/${restaurantId}/customers`) : db.collectionGroup('customers')).where('phone', '==', phone).get()
   for (const customer of customers.docs) {
    const rid = customer.ref.path.split('/')[1]!
    if (restaurantId && rid !== restaurantId) continue
    if (customer.id !== customerIdFor(rid, phone)) continue
    await db.runTransaction(async tx => {
     const root = db.doc(`restaurants/${rid}`), event = root.collection('r2WebhookEvents').doc(sha256Hex(incoming.id))
     if ((await tx.get(event)).exists) return
     const pending = await tx.get(root.collection('messages').where('customerId', '==', customer.id))
     tx.create(root.collection('consents').doc(`whatsapp.${sha256Hex(incoming.id)}`), { ...consentForWrite({ customerId: customer.id, purpose: 'marketing_whatsapp', status: 'withdrawn', policyVersion: 'whatsapp', at: Date.now(), source: 'public', evidenceId: sha256Hex(incoming.id) }, Timestamp.fromMillis), ...stamp(), updatedBy: null })
     for (const message of pending.docs) if (message.get('purpose') === 'marketing_whatsapp' && message.get('status') === 'queued') tx.update(message.ref, { status: 'cancelled', updatedAt: Timestamp.now() })
     tx.create(event, stamp())
    })
   }
   continue
  }
  const reply = incoming.interactive?.button_reply.id ?? incoming.button?.payload
  let messagePath = reply?.replace(/:(confirm|cancel)$/, '')
  const action = reply?.endsWith(':cancel') ? 'cancelled' : reply?.endsWith(':confirm') ? 'confirmed' : /^(cancelar|cancel·lar|cancel)$/i.test(incoming.text?.body ?? incoming.button?.text ?? '') ? 'cancelled' : /^(confirmo|confirm)$/i.test(incoming.text?.body ?? incoming.button?.text ?? '') ? 'confirmed' : null
  if (!action) continue
  if (!messagePath && incoming.context?.id) {
   const found = await (restaurantId ? db.collection(`restaurants/${restaurantId}/messages`) : db.collectionGroup('messages')).where('providerMessageId','==',incoming.context.id).limit(1).get()
   messagePath = found.docs[0]?.ref.path
  }
  if (!messagePath || !/^restaurants\/[^/]+\/messages\/[^/]+$/.test(messagePath)) continue
  const rid = messagePath.split('/')[1]!
  if (restaurantId && rid !== restaurantId) continue
  const messageDoc = await db.doc(messagePath).get()
  const message = parse(MessageSchema, messageDoc.data())
  if (message.channel !== 'whatsapp' || message.to !== `+${incoming.from}` || !message.reservationId || !['sent','captured'].includes(message.status)) continue
  const locations = await db.collection(`restaurants/${rid}/locations`).get()
  for (const location of locations.docs) {
   const ref = location.ref.collection('reservations').doc(message.reservationId)
   await db.runTransaction(async tx => {
    const dedup = db.doc(`restaurants/${rid}/r2WebhookEvents/${sha256Hex(incoming.id)}`)
    const [seen, snap] = await Promise.all([tx.get(dedup), tx.get(ref)])
    if (seen.exists || !snap.exists) return
    const reservation = parse(ReservationSchema, snap.data())
    if (reservation.phone !== message.to || (action === 'confirmed' && ['required','not_configured','failed'].includes(reservation.deposit.status))) return
    const changed = applyStatusChange(reservation, action, { nowMs: Date.now(), reason: 'Respuesta por WhatsApp' })
    if (!changed.ok) return
    const incrementLock = await reservationLock(tx, location.ref.path)
    const notices = await prepareReservationNotices(tx, rid, location.id, ref.id, changed.reservation)
    incrementLock(); notices()
    tx.update(ref, { ...reservationForWrite(changed.reservation, Timestamp.fromMillis), updatedAt: Timestamp.now() })
    tx.create(dedup, stamp())
    enqueueReservationEvent(tx, { restaurantId: rid, locationId: location.id, type: 'reservation.statusChanged', reservationId: ref.id, status: action, decision: changed.reservation.history.length, at: Date.now() })
   })
  }
 }
}
export const whatsappWebhook = onRequest({ ...options, secrets: ['PLATFORM_API_MASTER_KEY'] }, async (req,res) => {
 const rid = z.string().min(1).max(128).regex(/^[^/]+$/).safeParse(req.query.restaurantId)
 const demo = process.env.GCLOUD_PROJECT === 'demo-llenamos' && !!process.env.FIRESTORE_EMULATOR_HOST
 if (!rid.success && !demo) { res.status(400).send('Falta identificar el restaurante.'); return }
 let env: NodeJS.ProcessEnv
 try { env = rid.success ? await tenantProviderEnv(rid.data) : process.env }
 catch { res.status(503).send('No se ha podido validar la configuración.'); return }
 if (req.method === 'GET') {
  if (env.WHATSAPP_VERIFY_TOKEN && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === env.WHATSAPP_VERIFY_TOKEN) res.status(200).send(req.query['hub.challenge'])
  else res.status(403).send('Verificación incorrecta.')
  return
 }
 if (req.method !== 'POST') { res.status(405).send('Método no permitido.'); return }
 if (req.rawBody.length > 256000 || !verifyWhatsApp(req.rawBody, req.get('X-Hub-Signature-256') ?? '', env.WHATSAPP_APP_SECRET ?? '')) { res.status(401).send('Firma incorrecta.'); return }
 try { await handleWhatsApp(req.body, rid.success ? rid.data : undefined); res.status(200).send('OK') }
 catch { res.status(500).send('No se ha podido procesar el evento.') }
})
