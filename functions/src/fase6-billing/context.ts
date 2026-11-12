import { HttpsError } from 'firebase-functions/v2/https'
import { Timestamp, type Transaction } from 'firebase-admin/firestore'
import * as core from '@llenamos/core'
import { db, membership } from '../shared'
import { enqueuePlatformEvent } from '../fase6-api/events'

export const NOT_CONFIGURED = 'La facturación de la suscripción no está configurada. No se ha realizado ningún cargo.'
export const fail = (message: string): never => { throw new HttpsError('failed-precondition', message) }
export const hash = (value: unknown) => core.sha256Hex(core.canonicalJson(value))
export const meta = (uid: string | null, now: number) => ({ updatedBy: uid, updatedAt: Timestamp.fromMillis(now) })
export const publicPlan = (plan: core.PlanDefinition) => core.PublicPlanDefinitionSchema.parse(plan)

export async function authorize(tx: Transaction, rid: string, uid: string, manage = false) {
  const member = await membership(tx, rid, uid)
  if (!member.active || !core.can(member.role, manage ? 'planes.gestionar' : 'planes.ver')) throw new HttpsError('permission-denied', 'No tienes permiso para gestionar esta suscripción.')
  return member
}
export async function readPlan(tx: Transaction, id: string, version: number): Promise<core.PlanDefinition> {
  const doc = await tx.get(db.doc(`platformPlans/${id}/versions/${version}`))
  const fallback = core.provisionalPlanCatalog().find(p => p.id === id && p.version === version)
  if (!doc.exists && !fallback) throw new HttpsError('not-found', 'No se encuentra esa versión del plan.')
  return core.PlanDefinitionSchema.parse(doc.data() ?? fallback)
}
export async function dedup(tx: Transaction, actor: string, name: string, input: { requestId: string; restaurantId?: string }) {
  const ref = db.doc(`platformRequests/${hash([actor, input.restaurantId ?? '', name, input.requestId])}`)
  const previous = await tx.get(ref), fingerprint = hash(input)
  if (previous.exists && previous.get('fingerprint') !== fingerprint) throw new HttpsError('already-exists', 'Este identificador ya se usó con otros datos.')
  return { response: previous.exists ? previous.get('response') as unknown : undefined,
    save: (response: unknown) => tx.create(ref, { actorUid: actor, fingerprint, response, createdAt: Timestamp.now() }) }
}
export function audit(tx: Transaction, rid: string, changeId: string, uid: string | null, status: string, now: number) {
  tx.create(db.doc(`restaurants/${rid}/activity/${changeId}`), {
    action: 'subscription.changed', summary: 'Se ha actualizado el acceso de la suscripción', actorUid: uid, actorName: null,
    entity: { type: 'subscription', id: 'subscription' }, changeId, createdAt: Timestamp.fromMillis(now), ...meta(uid, now),
  })
  // El evento sale por la cola común (con `distributed: false`) para que el worker de webhooks lo reparta.
  enqueuePlatformEvent(tx, {
    id: changeId, type: 'subscription.changed', version: 1, restaurantId: rid, locationId: null,
    occurredAt: now, data: { entityId: 'subscription', status },
  })
}
export function evaluate(plan: core.PlanDefinition, subscription: core.Subscription, overrides: core.ModuleOverrides, now: number): core.Entitlements {
  const enabled = core.subscriptionAllowsService(subscription, now)
  const deadline = subscription.status === 'trialing' ? subscription.trialEndsAt : subscription.status === 'past_due' ? subscription.graceEndsAt : subscription.status === 'active' ? subscription.periodEndsAt : null
  const reason = enabled ? null : subscription.status === 'trialing' ? 'trial_expired' : subscription.status === 'past_due' ? 'payment_required' : subscription.status === 'active' ? (subscription.cancelAtPeriodEnd ? 'cancelled' : 'payment_required') : subscription.status
  return core.EntitlementsSchema.parse({ version: subscription.revision, planId: plan.id, planVersion: plan.version, activeModules: core.platformModules(plan, subscription, overrides, now), moduleOverrides: overrides, limits: plan.limits, serviceEnabled: enabled, reason, evaluatedAt: now, nextEvaluationAt: enabled ? deadline : null })
}
export function project(tx: Transaction, rid: string, plan: core.PlanDefinition, subscription: core.Subscription, entitlements: core.Entitlements, now: number, uid: string | null) {
  const root = db.doc(`restaurants/${rid}`)
  tx.set(db.doc(`platformRestaurants/${rid}`), { planId: plan.id, planVersion: plan.version, status: subscription.status,
    activeModules: entitlements.activeModules, moduleOverrides: entitlements.moduleOverrides, revision: subscription.revision, ...meta(uid, now) }, { merge: true })
  tx.set(root.collection('platform').doc('subscription'), { ...core.subscriptionForWrite(subscription, Timestamp.fromMillis), ...meta(uid, now) }, { merge: true })
  tx.set(root.collection('platform').doc('entitlements'), { ...core.entitlementsForWrite(entitlements, Timestamp.fromMillis), ...meta(uid, now) })
  tx.update(root, { changeId: `platform_${subscription.revision}`, plan: plan.legacyPlan, commercialPlanId: plan.id, commercialPlanVersion: plan.version, entitlementVersion: entitlements.version, moduleOverrides: entitlements.moduleOverrides, activeModules: entitlements.activeModules, accessValidUntil: Timestamp.fromMillis(entitlements.nextEvaluationAt ?? now), ...meta(uid, now) })
}
/** Lee primero. El llamador ejecuta commit tras sus demás lecturas, dentro de la misma transacción. */
export async function refreshPlatformAccess(tx: Transaction, restaurantId: string, now: number) {
  const root = await tx.get(db.doc(`restaurants/${restaurantId}`))
  if (!root.exists) throw new HttpsError('not-found', 'No se encuentra el restaurante.')
  if (!root.get('entitlementVersion')) return null
  const subscription = core.SubscriptionSchema.parse((await tx.get(root.ref.collection('platform').doc('subscription'))).data())
  const plan = await readPlan(tx, subscription.planId, subscription.planVersion)
  const overrides = core.ModuleOverridesSchema.parse(root.get('moduleOverrides') ?? {})
  const oldStatus = subscription.status
  const expired = !core.subscriptionAllowsService(subscription, now)
  if (expired && ['active', 'trialing', 'past_due'].includes(subscription.status)) {
    subscription.status = subscription.cancelAtPeriodEnd ? 'cancelled' : 'suspended'
    subscription.revision++
  }
  const entitlements = evaluate(plan, subscription, overrides, now)
  return { plan, subscription, entitlements, commit: () => {
    project(tx, restaurantId, plan, subscription, entitlements, now, null)
    if (oldStatus !== subscription.status) audit(tx, restaurantId, `expiry_${subscription.revision}`, null, subscription.status, now)
  } }
}
/** Reserva contadores autoritativos con las escrituras del llamador. Nunca usar la proyección de uso. */
export async function assertPlatformCapacity(tx: Transaction, restaurantId: string, resource: keyof core.PlanLimits, additional: number, now: number) {
  const access = await refreshPlatformAccess(tx, restaurantId, now)
  if (!access) return { commit: () => {} }
  if (!access.entitlements.serviceEnabled) fail('La suscripción no permite nuevas altas. Revisa el plan.')
  const ref = db.doc(`restaurants/${restaurantId}/platform/usage`), snap = await tx.get(ref)
  if (!snap.exists) fail('Faltan los contadores de capacidad. Revisa el restaurante.')
  const used = snap.get(resource)
  if (!Number.isSafeInteger(used) || used < 0) fail('El contador de capacidad no es válido.')
  const result = core.checkPlanLimit(access.plan.limits, resource, used as number, additional)
  if (!result.ok) throw new HttpsError('resource-exhausted', result.reason!)
  return { commit: () => { access.commit(); tx.update(ref, { [resource]: (used as number) + additional, revision: (snap.get('revision') as number) + 1, ...meta(null, now) }) } }
}
/** Libera contadores al desactivar o borrar. Lee primero; el llamador ejecuta commit tras sus demás lecturas. Nunca baja de cero. */
export async function releasePlatformCapacity(tx: Transaction, restaurantId: string, resource: keyof core.PlanLimits, amount: number, now: number) {
  const root = await tx.get(db.doc(`restaurants/${restaurantId}`))
  if (!root.exists || !root.get('entitlementVersion')) return { commit: () => {} }
  const ref = root.ref.collection('platform').doc('usage'), snap = await tx.get(ref)
  if (!snap.exists) fail('Faltan los contadores de capacidad. Revisa el restaurante.')
  const used = snap.get(resource)
  if (!Number.isSafeInteger(used) || used < 0) fail('El contador de capacidad no es válido.')
  return { commit: () => { tx.update(ref, { [resource]: Math.max(0, (used as number) - amount), revision: (snap.get('revision') as number) + 1, ...meta(null, now) }) } }
}
