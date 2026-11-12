import { HttpsError } from 'firebase-functions/v2/https'
import * as core from '@llenamos/core'
import { db } from '../shared'
import { authorize, audit, dedup, evaluate, fail, hash, meta, NOT_CONFIGURED, project, publicPlan, readPlan, refreshPlatformAccess } from './context'
import { stripeBillingProvider, type BillingProvider } from './provider'
import { catalogPlans } from './catalog'

export async function listPlans() {
  const plans = await catalogPlans()
  const merged = new Map(core.provisionalPlanCatalog().map(p => [`${p.id}:${p.version}`, p]))
  for (const plan of plans) merged.set(`${plan.id}:${plan.version}`, plan)
  return { plans: [...merged.values()].filter(p => p.enabled).map(publicPlan) }
}
export async function viewSubscription(uid: string, rid: string) {
  return db.runTransaction(async tx => {
    await authorize(tx, rid, uid)
    const access = await refreshPlatformAccess(tx, rid, Date.now())
    if (!access) fail('Este restaurante conserva su plan anterior. LogiQD debe revisar su migración.')
    access!.commit()
    return { subscription: access!.subscription, entitlements: access!.entitlements, plan: publicPlan(access!.plan) }
  })
}
type Action = 'iniciarSuscripcion' | 'abrirPortalFacturacion' | 'cancelarSuscripcion'
type Inputs = core.CallableInput<Action>
/** La intención durable mantiene el mismo id externo tras un timeout o una respuesta perdida. */
export async function billingAction(uid: string, name: Action, input: Inputs, provider: BillingProvider = stripeBillingProvider()) {
  const key = hash([uid, input.restaurantId, name, input.requestId])
  const ref = db.doc(`restaurants/${input.restaurantId}/billingIntents/${key}`)
  const preparation = await db.runTransaction(async tx => {
    await authorize(tx, input.restaurantId, uid, true)
    const receipt = await dedup(tx, uid, name, input)
    if (receipt.response !== undefined) return { response: receipt.response }
    const root = db.doc(`restaurants/${input.restaurantId}`)
    const subscriptionDoc = await tx.get(root.collection('platform').doc('subscription'))
    if (!subscriptionDoc.exists) fail('Este restaurante necesita una migración revisada por LogiQD.')
    const subscription = core.SubscriptionSchema.parse(subscriptionDoc.data())
    const previous = await tx.get(ref)
    if (previous.exists) {
      if (previous.get('fingerprint') !== hash(input)) throw new HttpsError('already-exists', 'La petición ya se usó con otros datos.')
      if (previous.get('result')) return { response: previous.get('result') as unknown }
    }
    if (!previous.exists && 'expectedRevision' in input && input.expectedRevision !== subscription.revision) throw new HttpsError('aborted', 'La suscripción ha cambiado. Actualiza la pantalla.')
    const pending = subscriptionDoc.get('pendingIntent') as string | undefined
    if (pending && pending !== key && name !== 'abrirPortalFacturacion') fail('Hay un cambio de facturación pendiente. Revisa su resultado antes de iniciar otro.')
    let plan = await readPlan(tx, subscription.planId, subscription.planVersion)
    if ('planId' in input) {
      plan = await readPlan(tx, input.planId, input.planVersion)
      if (!plan.enabled) fail('Este plan ya no admite contrataciones.')
      const usage = (await tx.get(root.collection('platform').doc('usage'))).data()
      if (!usage || core.planOverages(plan.limits, usage as Record<keyof core.PlanLimits,number>).length) fail('Hay recursos por encima del límite. Desactívalos antes de cambiar de plan.')
    }
    const price = 'interval' in input && (input.interval === 'month' ? plan.stripeMonthlyPriceId : plan.stripeAnnualPriceId)
    if (!provider.configured || (name === 'iniciarSuscripcion' && (!price || !price.startsWith('price_'))) || (name !== 'iniciarSuscripcion' && !subscription.stripeCustomerId) || (name === 'cancelarSuscripcion' && !subscription.stripeSubscriptionId)) {
      const response = { status: 'not_configured', message: NOT_CONFIGURED }
      receipt.save(response)
      return { response }
    }
    if (name === 'iniciarSuscripcion' && subscription.status === 'cancelled') fail('La suscripción está dada de baja. LogiQD debe revisar un nuevo contrato.')
    tx.set(ref, { actorUid: uid, kind: name, fingerprint: hash(input), planId: plan.id, planVersion: plan.version, interval: 'interval' in input ? input.interval : subscription.interval, expectedRevision: subscription.revision, status: 'pending', ...meta(uid, Date.now()) }, { merge: true })
    if (name !== 'abrirPortalFacturacion') tx.update(subscriptionDoc.ref, { pendingIntent: key })
    return { subscription, plan }
  })
  if ('response' in preparation) return preparation.response
  const { subscription, plan } = preparation
  const external = name === 'iniciarSuscripcion' ? await provider.start({ restaurantId: input.restaurantId, intentId: key, plan, interval: 'interval' in input ? input.interval : subscription.interval, subscription, key }) : name === 'abrirPortalFacturacion' ? await provider.portal(subscription.stripeCustomerId!, key) : await provider.cancel(subscription.stripeSubscriptionId!, key)
  return db.runTransaction(async tx => {
    await authorize(tx, input.restaurantId, uid, true)
    const receipt = await dedup(tx, uid, name, input)
    if (receipt.response !== undefined) return receipt.response
    const currentDoc = await tx.get(db.doc(`restaurants/${input.restaurantId}/platform/subscription`))
    const current = core.SubscriptionSchema.parse(currentDoc.data())
    const rootDoc = await tx.get(db.doc(`restaurants/${input.restaurantId}`))
    const currentPlan = await readPlan(tx, current.planId, current.planVersion)
    const now = Date.now()
    let response: unknown
    if ('endsAt' in external) {
      if (!Number.isSafeInteger(external.endsAt) || !current.periodEndsAt || external.endsAt !== current.periodEndsAt) fail('El periodo ha cambiado. Es necesario reconciliar la suscripción.')
      current.cancelAtPeriodEnd = true; current.revision++
      project(tx, input.restaurantId, currentPlan, current, evaluate(currentPlan, current, rootDoc.get('moduleOverrides') ?? {}, now), now, uid)
      tx.update(currentDoc.ref, { pendingIntent: null })
      audit(tx, input.restaurantId, `cancel_${key}`, uid, 'cancel_at_period_end', now)
      response = { status: 'scheduled', endsAt: external.endsAt }
    } else response = { status: 'ready', url: external.url }
    tx.set(ref, { status: 'ready', result: response, ...('id' in external ? { externalId: external.id } : {}), ...meta(uid, now) }, { merge: true })
    receipt.save(response)
    return response
  })
}
export async function publishPlan(uid: string, input: core.CallableInput<'guardarPlanPlataforma'>) {
  return db.runTransaction(async tx => {
    const receipt = await dedup(tx, uid, 'guardarPlanPlataforma', input)
    if (receipt.response !== undefined) return { ok: true as const }
    const ref = db.doc(`platformPlans/${input.plan.id}/versions/${input.plan.version}`)
    const existing = await tx.get(ref)
    const builtin = core.provisionalPlanCatalog().find(p => p.id === input.plan.id && p.version === input.plan.version)
    if ((existing.exists && hash(existing.data()) !== hash(input.plan)) || (!existing.exists && builtin && hash(builtin) !== hash(input.plan))) fail('La versión ya existe y es inmutable. Publica una versión nueva.')
    if (!existing.exists) tx.create(ref, input.plan)
    receipt.save({ ok: true })
    return { ok: true as const }
  })
}
export async function changeOverrides(uid: string, input: core.CallableInput<'cambiarExcepcionesPlataforma'>) {
  return db.runTransaction(async tx => {
    const receipt = await dedup(tx, uid, 'cambiarExcepcionesPlataforma', input)
    if (receipt.response !== undefined) return core.CambiarExcepcionesPlataformaOutputSchema.parse(receipt.response)
    const access = await refreshPlatformAccess(tx, input.restaurantId, Date.now())
    if (!access) fail('El restaurante aún no usa planes de plataforma.')
    const { plan, subscription } = access!
    if (input.expectedRevision !== subscription.revision) throw new HttpsError('aborted', 'La suscripción ha cambiado.')
    subscription.revision++
    const now = Date.now(), entitlements = evaluate(plan, subscription, input.moduleOverrides, now)
    project(tx, input.restaurantId, plan, subscription, entitlements, now, uid)
    audit(tx, input.restaurantId, `override_${hash(input)}`, uid, subscription.status, now)
    tx.update(db.doc(`restaurants/${input.restaurantId}/activity/override_${hash(input)}`), { reason: input.reason })
    receipt.save({ entitlements })
    return { entitlements }
  })
}
