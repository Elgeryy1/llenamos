import { HttpsError, onRequest } from 'firebase-functions/v2/https'
import { z } from 'zod'
import * as core from '@llenamos/core'
import { db, options } from '../shared'
import { verifyStripe } from '../webhooks/signatures'
import { audit, evaluate, fail, hash, meta, project, readPlan } from './context'
import { stripeBillingProvider, type BillingProvider } from './provider'
import { catalogPlans } from './catalog'

const EventSchema = z.object({ id: z.string().min(1).max(200), type: z.string(), created: z.number().int().nonnegative(), livemode: z.boolean(), data: z.object({ object: z.record(z.string(), z.unknown()) }) })
const Id = z.string().min(1).max(200)
const Line = z.object({ quantity: z.literal(1), amount: z.number().int(), currency: z.literal('eur'), period: z.object({ start: z.number().int(), end: z.number().int() }), price: z.object({ id: Id }).optional(), pricing: z.object({ price_details: z.object({ price: Id }) }).optional() })
const Invoice = z.object({ id: Id, customer: Id, subscription: Id.optional(), parent: z.object({ subscription_details: z.object({ subscription: Id }) }).optional(), currency: z.literal('eur'), status: z.string(), paid: z.boolean().optional(), amount_paid: z.number().int(), amount_due: z.number().int(), total: z.number().int(), lines: z.object({ has_more: z.literal(false), data: z.array(Line).length(1) }) })
const SubscriptionObject = z.object({ id: Id, customer: Id, status: z.string(), cancel_at_period_end: z.boolean(), items: z.object({ data: z.array(z.object({ price: z.object({ id: Id }), quantity: z.literal(1), current_period_end: z.number().int().optional() })).length(1) }), current_period_end: z.number().int().optional(), latest_invoice: z.unknown().optional() })
const supported = ['checkout.session.completed', 'invoice.paid', 'invoice.payment_failed', 'customer.subscription.updated', 'customer.subscription.deleted']

/** Se llama solo con bytes ya verificados. No hay red dentro de las transacciones. */
export async function handleBillingEvent(body: unknown, provider: BillingProvider = stripeBillingProvider(), now = Date.now()) {
  let event = EventSchema.parse(body)
  if (!supported.includes(event.type)) return { status: 'ignored' }
  if (event.livemode && (process.env.FIRESTORE_EMULATOR_HOST || process.env.GCLOUD_PROJECT?.startsWith('demo-'))) fail('El entorno local no acepta eventos de producción.')
  const eventRef = db.doc(`billingEvents/${hash(event.id)}`)
  if ((await eventRef.get()).exists) return { status: 'duplicate' }
  const object = event.data.object
  if (event.type === 'checkout.session.completed') {
    const checkout = z.object({ id: Id, mode: z.literal('subscription'), customer: Id, subscription: Id, metadata: z.object({ restaurantId: core.DocIdSchema, intentId: core.DocIdSchema }) }).parse(object)
    return db.runTransaction(async tx => {
      if ((await tx.get(eventRef)).exists) return { status: 'duplicate' }
      const rid = checkout.metadata.restaurantId
      const intentRef = db.doc(`restaurants/${rid}/billingIntents/${checkout.metadata.intentId}`)
      const [intent, currentDoc] = await Promise.all([tx.get(intentRef), tx.get(db.doc(`restaurants/${rid}/platform/subscription`))])
      if (!intent.exists || intent.get('kind') !== 'iniciarSuscripcion' || intent.get('externalId') !== checkout.id || currentDoc.get('pendingIntent') !== intentRef.id) fail('Checkout no corresponde a la intención guardada.')
      const current = core.SubscriptionSchema.parse(currentDoc.data())
      if ((current.stripeCustomerId && current.stripeCustomerId !== checkout.customer) || (current.stripeSubscriptionId && current.stripeSubscriptionId !== checkout.subscription)) fail('El cliente o contrato de Checkout no coincide.')
      // Vincular ids no concede servicio ni convierte la prueba en un pago.
      tx.update(currentDoc.ref, { stripeCustomerId: checkout.customer, stripeSubscriptionId: checkout.subscription, ...meta(null, now) })
      tx.update(intentRef, { boundSubscriptionId: checkout.subscription, ...meta(null, now) })
      tx.create(eventRef, { status: 'bound', eventId: event.id, restaurantId: rid, created: event.created, ...meta(null, now) })
      return { status: 'bound' }
    })
  }
  const invoiceEvent = event.type.startsWith('invoice.')
  const invoice = invoiceEvent ? Invoice.parse(object) : null
  const subObject = invoiceEvent ? null : SubscriptionObject.parse(object)
  const subscriptionId = invoice ? (invoice.subscription ?? invoice.parent?.subscription_details.subscription) : subObject!.id
  const customer = invoice?.customer ?? subObject!.customer
  if (!subscriptionId) fail('Falta el contrato de la factura.')
  const matches = await db.collectionGroup('platform').where('stripeSubscriptionId', '==', subscriptionId).get()
  const docs = matches.docs.filter(d => d.id === 'subscription' && d.get('stripeCustomerId') === customer)
  if (docs.length !== 1) throw new HttpsError('unavailable', 'El contrato todavía no está vinculado. Reintenta el evento.')
  const subscriptionRef = docs[0]!.ref, rid = subscriptionRef.parent.parent!.id
  const observedLast = (docs[0]!.get('lastBillingCreated') as number | undefined) ?? -1
  let reconciled: z.infer<typeof SubscriptionObject> | null = null
  if (event.created <= observedLast) {
    if (!provider.configured) throw new HttpsError('unavailable', 'Evento desordenado. Falta consultar el estado vigente de Stripe; no se cambia el acceso.')
    reconciled = SubscriptionObject.parse(await provider.current(subscriptionId!))
    if (reconciled.id !== subscriptionId || reconciled.customer !== customer) fail('La reconciliación pertenece a otro contrato.')
    if (reconciled.status === 'canceled') event = { ...event, type: 'customer.subscription.deleted', data: { object: reconciled } }
    else {
      const latest = Invoice.parse(reconciled.latest_invoice)
      if ((latest.subscription ?? latest.parent?.subscription_details.subscription) !== subscriptionId || latest.customer !== customer) fail('La factura vigente no corresponde al contrato.')
      event = { ...event, type: latest.status === 'paid' ? 'invoice.paid' : 'invoice.payment_failed', data: { object: latest } }
    }
  }
  return db.runTransaction(async tx => {
    const [seen, currentDoc, root, catalog, usage] = await Promise.all([
      tx.get(eventRef), tx.get(subscriptionRef), tx.get(db.doc(`restaurants/${rid}`)), catalogPlans(tx), tx.get(db.doc(`restaurants/${rid}/platform/usage`)),
    ])
    if (seen.exists) return { status: 'duplicate' }
    if (((currentDoc.get('lastBillingCreated') as number | undefined) ?? -1) !== observedLast) throw new HttpsError('aborted', 'Ha llegado otro evento. Reintenta para reconciliar.')
    const current = core.SubscriptionSchema.parse(currentDoc.data())
    if (current.stripeCustomerId !== customer || current.stripeSubscriptionId !== subscriptionId) fail('La identidad del contrato ha cambiado.')
    const plans = catalog
    const previousStatus = current.status
    if (current.status === 'cancelled' && event.type !== 'customer.subscription.deleted') fail('Un contrato dado de baja no se reactiva con eventos tardíos.')
    let plan = await readPlan(tx, current.planId, current.planVersion)
    let status = 'applied'
    let paidInvoiceId: string | undefined
    if (event.type.startsWith('invoice.')) {
      const inv = Invoice.parse(event.data.object), line = inv.lines.data[0]!
      const priceId = line.price?.id ?? line.pricing?.price_details.price
      const candidates = plans.flatMap(p => [
        ...(p.stripeMonthlyPriceId === priceId ? [{ plan: p, interval: 'month' as const, amount: p.monthlyCents }] : []),
        ...(p.stripeAnnualPriceId === priceId ? [{ plan: p, interval: 'year' as const, amount: p.annualCents }] : []),
      ])
      if (candidates.length !== 1) fail('El precio no corresponde a una versión única del catálogo.')
      const match = candidates[0]!
      if (line.amount !== match.amount || inv.total !== match.amount || inv.amount_due !== match.amount || line.period.end <= line.period.start) fail('El importe o periodo de la factura no coincide con la tarifa.')
      const periodEndsAt = line.period.end * 1000
      if (current.periodEndsAt && periodEndsAt < current.periodEndsAt) fail('La factura es anterior al periodo vigente. Se necesita reconciliar.')
      if (current.status === 'cancelled') fail('Un contrato dado de baja no se reactiva con facturas tardías.')
      if (event.type === 'invoice.paid') {
        if (inv.status !== 'paid' || inv.paid === false || inv.amount_paid !== match.amount || periodEndsAt <= now) fail('La factura no está pagada por completo o su periodo ha vencido.')
        if (!usage.exists || core.planOverages(match.plan.limits, usage.data() as Record<keyof core.PlanLimits,number>).length) {
          current.status = 'suspended'; status = 'blocked_overage'
        } else {
          plan = match.plan; current.planId = plan.id; current.planVersion = plan.version; current.interval = match.interval
          current.status = 'active'; current.periodEndsAt = periodEndsAt; current.graceEndsAt = null
          if (reconciled) current.cancelAtPeriodEnd = reconciled.cancel_at_period_end
          paidInvoiceId = inv.id
        }
      } else {
        if (inv.status === 'paid' || inv.amount_paid !== 0) fail('La factura no representa un impago sin resolver.')
        if (currentDoc.get('lastPaidInvoiceId') === inv.id) fail('Esta factura ya está pagada. Se necesita reconciliar.')
        current.status = previousStatus === 'suspended' ? 'suspended' : 'past_due'
        current.graceEndsAt ??= now + 7 * 86_400_000
        if (now >= current.graceEndsAt) current.status = 'suspended'
      }
    } else {
      const object = SubscriptionObject.parse(event.data.object)
      const price = object.items.data[0]!.price.id
      if (price !== plan.stripeMonthlyPriceId && price !== plan.stripeAnnualPriceId) fail('Cambio del portal pendiente de factura y comprobación de cuotas.')
      if (event.type === 'customer.subscription.deleted') {
        if (object.status !== 'canceled') fail('La baja no está confirmada.')
        current.status = 'cancelled'; current.cancelAtPeriodEnd = false
      } else {
        // Ni status active ni la URL de vuelta sustituyen a una factura pagada.
        current.cancelAtPeriodEnd = object.cancel_at_period_end
        if (object.status === 'unpaid' || object.status === 'paused') current.status = 'suspended'
      }
    }
    if (!core.canSubscriptionTransition(previousStatus, current.status)) fail('El evento no permite esa transición de suscripción.')
    current.revision++
    const entitlements = evaluate(plan, current, root.get('moduleOverrides') ?? {}, now)
    project(tx, rid, plan, current, entitlements, now, null)
    tx.update(subscriptionRef, { lastBillingCreated: Math.max(event.created, observedLast), ...(paidInvoiceId ? { lastPaidInvoiceId: paidInvoiceId } : {}), pendingIntent: null })
    tx.create(eventRef, { eventId: event.id, restaurantId: rid, status, created: event.created, ...meta(null, now) })
    audit(tx, rid, `billing_${hash(event.id)}`, null, current.status, now)
    return { status }
  })
}

export const stripeBillingWebhook = onRequest(options, async (req, res) => {
  if (req.method !== 'POST') { res.status(405).send('Método no permitido.'); return }
  const secret = process.env.STRIPE_BILLING_WEBHOOK_SECRET ?? ''
  if (!secret) { res.status(503).send('La facturación de la suscripción no está configurada. No se ha realizado ningún cargo.'); return }
  if (!verifyStripe(req.rawBody, req.get('Stripe-Signature') ?? '', secret)) { res.status(401).send('Firma incorrecta.'); return }
  try { await handleBillingEvent(JSON.parse(req.rawBody.toString('utf8'))); res.status(200).send('OK') }
  catch (error) { res.status(error instanceof HttpsError && ['unavailable','aborted'].includes(error.code) ? 503 : 400).send('No se ha aplicado el evento. Revisa la facturación y reintenta.'); }
})
