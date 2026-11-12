import { Timestamp, type DocumentReference } from 'firebase-admin/firestore'
import { z } from 'zod'
import * as core from '@llenamos/core'
import { db } from '../shared'
import { verifyStripe } from '../webhooks/signatures'
import { cajaServices } from './backend'
import { checkoutUrl, StripeSession, stripeClient, type Env, type Session } from './stripe'
import { receiptForInvoice, syncReceiptDelivery } from './receipts'
import { fresh, hash, meta } from './support'
import { tenantProviderEnv } from '../providers/tenant'

const Event = z.object({ id: z.string().regex(/^evt_[A-Za-z0-9_]+$/), type: z.string(), created: z.number().int(),
  account: z.string().optional(), data: z.object({ object: StripeSession }) })
const supported = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'checkout.session.expired'])
const Metadata = z.object({ restaurantId: core.DocIdSchema, locationId: core.DocIdSchema, checkoutId: core.DocIdSchema })

async function incident(ref: DocumentReference, code: string, externalId: string) {
  await db.runTransaction(async tx => {
    const row = await tx.get(ref), task = ref.parent.parent!.collection('mobileIncidents').doc(hash([ref.id, code, externalId]))
    const previous = await tx.get(task)
    if (row.exists && row.get('status') !== 'paid') tx.update(ref, { status: 'reconciliation_required', needsReconciliation: false, ...meta() })
    if (!previous.exists) tx.create(task, { checkoutId: ref.id, externalId, code, status: 'open',
      summary: 'Revisar un pago móvil con el proveedor antes de liberar el saldo o devolverlo.', ...fresh() })
  })
}
/** Solo recibe datos verificados por HMAC o consultados al proveedor desde el worker. */
export async function applySession(ref: DocumentReference, session: Session, account: string | null, occurredAt: number, env: Env = process.env) {
  const doc = await ref.get()
  if (!doc.exists) { await incident(ref, 'unknown_checkout', session.id); return }
  const v = core.MobileCheckoutSchema.parse(doc.data()), raw = doc.data()!
  const identity = session.metadata
  const local = ref.parent.parent!, root = local.parent.parent!
  const correct = v.stripeSessionId === session.id && raw.routing?.account === account &&
    identity.restaurantId === root.id && identity.locationId === local.id && identity.checkoutId === ref.id &&
    identity.amountCents === String(v.amountCents) && identity.tipCents === String(v.tipCents) &&
    session.amount_total === v.amountCents + v.tipCents && session.currency === 'eur' && session.livemode === raw.livemode
  if (!correct) { await incident(ref, 'provider_mismatch', session.id); return }
  if (v.status === 'paid') { await finishInvoice(ref, env); return }
  if (session.status === 'expired' && session.payment_status === 'unpaid') {
    await db.runTransaction(async tx => {
      const now = await tx.get(ref), reserve = local.collection('paymentReservations').doc(v.partId), current = await tx.get(reserve)
      if (now.get('status') === 'pending') {
        tx.update(ref, { status: 'expired', needsReconciliation: false, ...meta() })
        if (current.get('checkoutId') === ref.id) tx.delete(reserve)
      }
    })
    return
  }
  if (session.status !== 'complete' || session.payment_status !== 'paid') return
  if (v.status !== 'pending' || occurredAt > v.expiresAt) { await incident(ref, 'late_payment', session.id); return }
  try {
    await cajaServices().confirmExternalPayment({ restaurantId: root.id, locationId: local.id, billId: v.billId, partId: v.partId,
      cashSessionId: raw.cashSessionId, expectedRevision: v.revision, requestId: `mobile_${hash([ref.path, session.id])}`,
      checkoutId: ref.id, externalId: session.id, currency: 'EUR', amountCents: v.amountCents, tipCents: v.tipCents })
  } catch (error) {
    // Los fallos transitorios quedan pendientes y se reintentan con el mismo externalId.
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unavailable'
    if (['failed-precondition', 'permission-denied', 'already-exists', 'invalid-argument'].includes(code)) await incident(ref, 'ledger_conflict', session.id)
    else await ref.update({ reconciliationPending: true, lastError: 'Cobro externo pendiente de registrar en caja.', ...meta() })
    return
  }
  // El backend confirma idempotentemente. Un reinicio aquí vuelve a consultarlo sin otro cobro.
  await ref.update({ status: 'paid', invoicePending: true, reconciliationPending: false, paidAt: Timestamp.fromMillis(occurredAt), ...meta() })
  await finishInvoice(ref, env)
}
export async function finishInvoice(ref: DocumentReference, env: Env = process.env) {
  const doc = await ref.get(), raw = doc.data()!
  if (raw.status !== 'paid') return
  const local = ref.parent.parent!, root = local.parent.parent!
  try {
    const issued = await cajaServices().issuePartInvoice({ restaurantId: root.id, locationId: local.id,
      billId: raw.billId, partId: raw.partId, expectedRevision: raw.revision, requestId: `mi_${hash(ref.path)}`,
      type: raw.recipient ? 'F1' : 'F2', recipient: raw.recipient ?? null, qualifiedSimplified: false }, null)
    const receipt = await receiptForInvoice({ restaurantId: root.id, locationId: local.id, invoiceId: issued.invoiceId,
      requestId: `mr_${hash(ref.path)}`, email: raw.email ?? null, acceptDigitalReceipt: raw.acceptDigitalReceipt === true },
      undefined, raw.language ?? 'es', env, true)
    await ref.update({ invoiceId: issued.invoiceId, invoicePending: false, receiptId: receipt.receiptId, receiptPath: receipt.path,
      delivery: receipt.delivery, needsReconciliation: receipt.delivery === 'queued', lastError: null, ...meta() })
    await syncReceiptDelivery(ref)
  } catch {
    await ref.update({ invoicePending: true, lastError: 'El cobro está confirmado. La factura o el recibo siguen pendientes.', ...meta() })
  }
}

export async function ingestWebhook(raw: Buffer, signature: string, env: Env = process.env, now = Date.now(), expectedRestaurantId?: string) {
  if (!env.STRIPE_MOBILE_WEBHOOK_SECRET) return 503
  if (raw.length > 256000 || !verifyStripe(raw, signature, env.STRIPE_MOBILE_WEBHOOK_SECRET, now)) return 400
  let json: unknown
  try { json = JSON.parse(raw.toString('utf8')) } catch { return 400 }
  const header = z.object({ type: z.string() }).safeParse(json)
  if (!header.success) return 400
  if (!supported.has(header.data.type)) return 200
  const event = Event.safeParse(json)
  if (!event.success) return 400
  const e = event.data, identity = Metadata.safeParse(e.data.object.metadata)
  if (!identity.success) return 200 // No pertenece al flujo de caja, por ejemplo una señal.
  const { restaurantId: rid, locationId: lid, checkoutId: id } = identity.data
  if (expectedRestaurantId && rid !== expectedRestaurantId) return 400
  const local = db.doc(`restaurants/${rid}/locations/${lid}`), ref = local.collection('mobileCheckouts').doc(id)
  const eventRef = local.collection('mobileStripeEvents').doc(hash([e.account ?? null, e.id]))
  const fingerprint = hash(e)
  const state = await db.runTransaction(async tx => {
    const existing = await tx.get(eventRef)
    if (existing.exists) return existing.get('fingerprint') === fingerprint ? existing.get('status') : 'conflict'
    tx.create(eventRef, { fingerprint, session: e.data.object, account: e.account ?? null, type: e.type,
      occurredAt: e.created * 1000, checkoutId: id, status: 'queued', ...fresh() })
    return 'queued'
  })
  if (state === 'conflict') return 400
  if (state === 'done') return 200
  const checkout = await ref.get()
  // El evento puede adelantarse a la respuesta de creación. Se conserva para el worker.
  if (checkout.exists && !checkout.get('stripeSessionId') && checkout.get('startRequest')) return 200
  await applySession(ref, e.data.object, e.account ?? null, e.created * 1000, env)
  const result = await ref.get()
  if (result.get('status') !== 'pending' || e.data.object.payment_status !== 'paid') await eventRef.update({ status: 'done', ...meta() })
  return 200
}

/** Repetible y local: recupera creaciones inciertas, consulta sesiones y termina facturas. */
export async function reconcileMobile(env: Env = process.env, transport?: typeof fetch, limit = 100, locationPath?: string) {
  const perRestaurant = env === process.env
  let processed = 0
  const checkouts = locationPath ? db.collection(`${locationPath}/mobileCheckouts`) : db.collectionGroup('mobileCheckouts')
  const docs = await checkouts.where('needsReconciliation', '==', true).limit(limit).get()
  for (const doc of docs.docs) {
    if (processed >= limit) break
    let raw = doc.data(), v = core.MobileCheckoutSchema.parse(raw)
    if (v.status === 'paid') { if (raw.invoicePending) await finishInvoice(doc.ref, env); await syncReceiptDelivery(doc.ref); processed++; continue }
    if (v.status !== 'pending') continue
    const local = doc.ref.parent.parent!, root = local.parent.parent!
    if (!raw.startRequest) {
      if (v.expiresAt <= Date.now()) await doc.ref.update({ status: 'expired', ...meta() })
      continue
    }
    try {
      const tenantEnv = perRestaurant ? await tenantProviderEnv(root.id) : env
      const provider = stripeClient(tenantEnv, transport)
      if (!provider.configured) continue
      if (!v.stripeSessionId) {
        // Recuperar por POST idéntico es la consulta idempotente de una creación incierta.
        // La clave Stripe vive 24 horas; después requiere revisión manual, nunca otro POST.
        if (Date.now() - raw.startedAt.toMillis() > 23 * 3600000) { await incident(doc.ref, 'creation_unknown', 'unknown'); continue }
        // Recuperación de servidor sin necesitar el secreto del enlace del cliente.
        const session = await provider.create({ rid: root.id, lid: local.id, id: doc.id, amount: v.amountCents,
          tip: v.tipCents, name: raw.stripeName, origin: raw.stripeOrigin, route: raw.routing,
          key: `mobile_${hash([root.id, local.id, doc.id, raw.startRequest])}`, now: raw.startedAt.toMillis(), lang: raw.language })
        if (session.metadata.checkoutId !== doc.id || session.metadata.restaurantId !== root.id || session.metadata.locationId !== local.id ||
          session.amount_total !== v.amountCents + v.tipCents || session.currency !== 'eur' || session.livemode !== raw.livemode) {
          await incident(doc.ref, 'provider_mismatch', session.id); continue
        }
        await db.runTransaction(async tx => {
          const current = await tx.get(doc.ref)
          if (current.get('stripeSessionId') && current.get('stripeSessionId') !== session.id) throw new Error('La sesión de pago ha cambiado.')
          tx.update(doc.ref, { stripeSessionId: session.id, stripeUrl: session.url ? checkoutUrl(session.url) : null,
            stripeExpiresAt: Timestamp.fromMillis(session.expires_at * 1000), ...meta() })
        })
        raw = (await doc.ref.get()).data()!; v = core.MobileCheckoutSchema.parse(raw)
      }
      if (!v.stripeSessionId) continue
      let session = await provider.retrieve(v.stripeSessionId, raw.routing)
      if (session.status === 'open' && v.expiresAt <= Date.now()) session = await provider.expire(session.id, raw.routing, `expire_${hash(doc.ref.path)}`)
      await applySession(doc.ref, session, raw.routing.account, Date.now(), tenantEnv)
      processed++
    } catch { await doc.ref.update({ lastError: 'Pendiente de consultar el estado del pago con Stripe.', ...meta() }) }
  }
  const eventCollection = locationPath ? db.collection(`${locationPath}/mobileStripeEvents`) : db.collectionGroup('mobileStripeEvents')
  const events = await eventCollection.where('status', '==', 'queued').limit(limit).get()
  for (const event of events.docs) {
    const raw = event.data(), local = event.ref.parent.parent!, ref = local.collection('mobileCheckouts').doc(raw.checkoutId)
    const c = await ref.get()
    if (!c.exists || c.get('stripeSessionId')) {
      try {
        const tenantEnv = perRestaurant ? await tenantProviderEnv(local.parent.parent!.id) : env
        await applySession(ref, StripeSession.parse(raw.session), raw.account, raw.occurredAt, tenantEnv)
        const after = await ref.get()
        if (after.get('status') !== 'pending' || raw.session.payment_status !== 'paid') await event.ref.update({ status: 'done', ...meta() })
      } catch { await event.ref.update({ lastError: 'Pendiente de revisar la configuración del restaurante.', ...meta() }) }
    }
  }
  return { processed }
}
