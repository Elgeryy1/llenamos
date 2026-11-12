import { prepareReservationNotices } from '../reservations'
import { onCall, onRequest, HttpsError } from '../identity-call'
import { Timestamp } from 'firebase-admin/firestore'
import { z } from 'zod'
import { enqueueReservationEvent } from '../fase6-api/events'
import { CALLABLES, CALLABLE_SCHEMAS, ReservationSchema, sha256Hex, applyStatusChange, reservationForWrite } from '@llenamos/core'
import { db, options, parse, reservationLock, safe } from '../shared'
import { publicContext, linkedReservation } from '../messages/support'
import { verifyStripe } from '../webhooks/signatures'
import { tenantProviderEnv } from '../providers/tenant'
const tenantOptions = { ...options, secrets: ['PLATFORM_API_MASTER_KEY'] }
export const iniciarPagoSenal = onCall(tenantOptions, request => safe(async () => {
 const data = parse(CALLABLE_SCHEMAS[CALLABLES.iniciarPagoSenal].input, request.data)
 const { rid } = await publicContext(data.slug)
 const env = await tenantProviderEnv(rid)
 const { ref, reservation: r } = await linkedReservation(rid, data.reference, sha256Hex(data.token))
 if (r.deposit.status === 'paid') return { status: 'already_paid' as const }
 if (!r.deposit.amountCents || r.deposit.status === 'none') return { status: 'not_required' as const }
 if (!['pending','confirmed'].includes(r.status)) throw new HttpsError('failed-precondition', 'Esta reserva ya no admite el pago de la señal.')
 if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) return { status: 'not_configured' as const, message: 'Los pagos de señal no están configurados. Contacta con el restaurante.' }
 const base = process.env.PUBLIC_APP_URL
 if (!base || !/^https:\/\//.test(base)) throw new HttpsError('failed-precondition', 'Falta configurar la dirección pública de reservas.')
 const url = `${base}/r/${data.slug}/reserva/${r.reference}?t=${data.token}`
 const form = new URLSearchParams({ mode: 'payment', success_url: url, cancel_url: url, 'line_items[0][price_data][currency]': 'eur', 'line_items[0][price_data][unit_amount]': String(r.deposit.amountCents), 'line_items[0][price_data][product_data][name]': `Señal de reserva ${r.reference}`, 'line_items[0][quantity]': '1', 'metadata[reservationPath]': ref.path })
 const response = await fetch('https://api.stripe.com/v1/checkout/sessions', { method: 'POST', headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': `deposit_${sha256Hex(ref.path)}_${r.deposit.amountCents}` }, body: form.toString(), signal: AbortSignal.timeout(15000) })
 if (!response.ok) throw new HttpsError('unavailable', 'No se ha podido iniciar el pago de la señal.')
 const session = z.object({ id: z.string(), url: z.string().regex(/^https:\/\//) }).parse(await response.json())
 await db.runTransaction(async tx => {
  const current = parse(ReservationSchema, (await tx.get(ref)).data())
  if (current.deposit.status === 'paid') return
  if (current.deposit.amountCents !== r.deposit.amountCents || !['pending','confirmed'].includes(current.status)) throw new HttpsError('aborted', 'La reserva ha cambiado. Vuelve a intentarlo.')
  tx.update(ref, { deposit: { ...current.deposit, status: 'required', checkoutSessionId: session.id }, updatedAt: Timestamp.now() })
 })
 return { status: 'redirect' as const, url: session.url }
}))
const eventSchema = z.object({ id: z.string(), type: z.string(), data: z.object({ object: z.object({ id: z.string(), metadata: z.object({ reservationPath: z.string() }).optional(), payment_status: z.string().optional(), amount_total: z.number().optional(), currency: z.string().optional() }) }) })
export async function handleStripe(body: unknown, restaurantId?: string) {
 const event = eventSchema.parse(body), session = event.data.object
 if (event.type !== 'checkout.session.completed' || session.payment_status !== 'paid') return
 const path = session.metadata?.reservationPath
 if (!path || !/^restaurants\/[^/]+\/locations\/[^/]+\/reservations\/[^/]+$/.test(path)) return
 if (restaurantId && path.split('/')[1] !== restaurantId) throw new Error('El evento no corresponde al restaurante receptor.')
 await db.runTransaction(async tx => {
  const ref = db.doc(path), snap = await tx.get(ref)
  if (!snap.exists) return
  const r = parse(ReservationSchema, snap.data())
  if (r.deposit.status === 'paid') return
  if (r.deposit.checkoutSessionId !== session.id || r.deposit.amountCents !== session.amount_total || session.currency !== 'eur') throw new Error('El pago no corresponde a la señal.')
  // Un pago tardío se registra sin resucitar una reserva cancelada.
  const change = r.status === 'pending' ? applyStatusChange(r, 'confirmed', { nowMs: Date.now(), reason: 'Señal pagada' }) : null
  const incrementLock = await reservationLock(tx, ref.parent.parent!.path)
  const next = { ...(change?.ok ? change.reservation : r), deposit: { ...r.deposit, status: 'paid' as const } }
  const notices = change?.ok ? await prepareReservationNotices(tx, path.split('/')[1]!, path.split('/')[3]!, ref.id, next) : null
  incrementLock(); notices?.()
  tx.update(ref, { ...reservationForWrite(change?.ok ? change.reservation : r, Timestamp.fromMillis), deposit: { ...r.deposit, status: 'paid' }, updatedAt: Timestamp.now() })
  if (change?.ok) enqueueReservationEvent(tx, { restaurantId: path.split('/')[1]!, locationId: path.split('/')[3]!, type: 'reservation.statusChanged', reservationId: ref.id, status: 'confirmed', decision: change.reservation.history.length, at: Date.now() })
 })
}
export const stripeWebhook = onRequest(tenantOptions, async (req,res) => {
 if (req.method !== 'POST') { res.status(405).send('Método no permitido.'); return }
 const rid = z.string().min(1).max(128).regex(/^[^/]+$/).safeParse(req.query.restaurantId)
 const demo = process.env.GCLOUD_PROJECT === 'demo-llenamos' && !!process.env.FIRESTORE_EMULATOR_HOST
 if (!rid.success && !demo) { res.status(400).send('Falta identificar el restaurante.'); return }
 try {
  const env = rid.success ? await tenantProviderEnv(rid.data) : process.env
  if (req.rawBody.length > 256000 || !verifyStripe(req.rawBody, req.get('Stripe-Signature') ?? '', env.STRIPE_WEBHOOK_SECRET ?? '')) { res.status(401).send('Firma incorrecta.'); return }
  await handleStripe(req.body, rid.success ? rid.data : undefined); res.status(200).send('OK')
 }
 catch { res.status(500).send('No se ha podido procesar el pago.') }
})
