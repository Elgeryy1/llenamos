import { HttpsError } from 'firebase-functions/v2/https'
import { FieldPath, Timestamp } from 'firebase-admin/firestore'
import * as core from '@llenamos/core'
import { auth, db } from '../shared'
import { completeOnboarding, saveOnboarding } from './onboarding'
import { dedup, evaluate, hash, meta, project, readPlan } from './context'
import { seal } from '../fase6-api/security'
import { issueAccountInvitation } from '../account-invitations'
import { prepareIntegrationPatch } from '../providers/tenant'

/** Solo configuración validada del servidor. Nunca se devuelve el enlace de recuperación. */
export function invitationConfiguration() {
  const origin = process.env.PUBLIC_APP_URL
  if (!origin || !process.env.RESEND_API_KEY || !process.env.EMAIL_FROM)
    throw new HttpsError('failed-precondition', 'Configura el dominio de acceso y el correo antes de dar de alta un restaurante.')
  const parsed = new URL(origin)
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash)
    throw new HttpsError('failed-precondition', 'El dominio de acceso debe ser un origen HTTPS válido.')
  seal({ check: true }, 'administrative-invitation-configuration')
  return { origin: parsed.origin, token: process.env.RESEND_API_KEY, sender: process.env.EMAIL_FROM }
}

export async function administrativeCreate(actor: string, input: core.CallableInput<'altaRestauranteLogiqd'>) {
  // La falta de correo de plataforma no impide registrar un restaurante sin integraciones.
  const configuration = process.env.PLATFORM_EMAIL_ENABLED === '1' ? invitationConfiguration() : null
  const email = input.ownerEmail.trim().toLowerCase(), id = hash([actor, input.requestId])
  const ref = db.doc(`platformProvisioning/${id}`), fingerprint = hash({ ...input, ownerEmail: email })
  const previous = await ref.get()
  if (previous.exists && previous.get('identityFlowVersion') !== 2) throw new HttpsError('failed-precondition', 'Esta alta antigua requiere revisar la identidad antes de continuar.')
  if (previous.exists && previous.get('fingerprint') !== fingerprint)
    throw new HttpsError('already-exists', 'Este identificador ya se usó con otros datos.')
  if (previous.get('response') && (previous.get('status') === 'sent' || !configuration)) return core.AltaRestauranteLogiqdOutputSchema.parse(previous.get('response'))
  // El identificador estable permite retomar una creación de Auth interrumpida sin crear otra cuenta.
  let owner
  try { owner = await auth.getUserByEmail(email) }
  catch (error) {
    if ((error as { code?: string }).code !== 'auth/user-not-found') throw error
    try { owner = await auth.createUser({ uid: `owner_${hash(email).slice(0, 40)}`, email, displayName: input.ownerName }) }
    catch (created) {
      if (!['auth/email-already-exists', 'auth/uid-already-exists'].includes((created as { code?: string }).code ?? '')) throw created
      owner = await auth.getUserByEmail(email)
    }
  }
  if (owner.customClaims?.logiqd === true || owner.disabled)
    throw new HttpsError('failed-precondition', 'La cuenta del propietario no puede ser una cuenta de plataforma o desactivada.')
  await db.runTransaction(async tx => {
    const old = await tx.get(ref)
    if (old.exists && old.get('fingerprint') !== fingerprint) throw new HttpsError('already-exists', 'La petición ya se usó con otros datos.')
    if (!old.exists) tx.create(ref, { fingerprint, ownerUid: owner.uid, actorUid: actor, identityFlowVersion: 2, status: 'pending', createdAt: Timestamp.now() })
  })
  const requestId = `admin_${id}`, draft: core.OnboardingDraft = {
    name: input.name, slug: input.slug, location: { name: input.locationName, address: '', city: '', phone: '' },
    settings: { ...core.defaultReservationSettings(), publicBooking: false }, planId: input.planId, planVersion: input.planVersion,
    // Marca administrativa, no aceptación de términos en nombre del destinatario.
    acceptedTermsVersion: 'administrative-provisioning-v1',
  }
  const saved = await saveOnboarding(owner.uid, { requestId, onboardingId: null, expectedRevision: null, step: 'review', draft }, true)
  const result = await completeOnboarding(owner.uid, { requestId, onboardingId: saved.onboardingId, expectedRevision: saved.onboarding.revision }, true, actor)
  const row: core.AdministrativeRestaurant = { restaurantId: result.restaurantId, name: input.name, slug: input.slug, ownerEmail: email,
    planId: result.subscription.planId, planVersion: result.subscription.planVersion, status: result.subscription.status,
    activeModules: result.entitlements.activeModules, moduleOverrides: result.entitlements.moduleOverrides, revision: result.entitlements.version }
  await db.doc(`platformRestaurants/${result.restaurantId}`).set({ ...row, administrativeProvisioned: true, ...meta(actor, Date.now()) }, { merge: true })
  await db.runTransaction(async tx => {
    const prepared = await prepareIntegrationPatch(tx, result.restaurantId, input.integrations)
    prepared.commit()
    tx.update(db.doc(`platformRestaurants/${result.restaurantId}`), { integrationStatus: prepared.status })
  })
  const invitationStatus = await issueAccountInvitation({ restaurantId: result.restaurantId, uid: owner.uid, email, displayName: input.ownerName, role: 'owner', invitedBy: actor, kind: 'owner' })
  const output = { restaurantId: result.restaurantId, locationId: result.locationId, invitationStatus }
  await ref.update({ status: invitationStatus === 'sent' ? 'sent' : 'pending_invitation', response: output, updatedAt: Timestamp.now() })
  return output
}

export async function administrativeList(input: core.CallableInput<'listarRestaurantesAdministracion'>) {
  const limit = input.limit ?? 25
  let query = db.collection('platformRestaurants').where('administrativeProvisioned', '==', true).orderBy(FieldPath.documentId()).limit(limit + 1)
  if (input.cursor) query = query.startAfter(core.DocIdSchema.parse(input.cursor))
  const rows = await query.get(), shown = rows.docs.slice(0, limit)
  return { restaurants: shown.map(row => core.AdministrativeRestaurantSchema.parse(row.data())), nextCursor: rows.size > limit ? shown.at(-1)!.id : null }
}

export async function administrativeConfigure(actor: string, input: core.CallableInput<'configurarRestauranteLogiqd'>) {
  return db.runTransaction(async tx => {
    const receipt = await dedup(tx, actor, 'configurarRestauranteLogiqd', input)
    if (receipt.response !== undefined) return core.ConfigurarRestauranteLogiqdOutputSchema.parse(receipt.response)
    const ref = db.doc(`platformRestaurants/${input.restaurantId}`), row = await tx.get(ref)
    if (!row.exists) throw new HttpsError('failed-precondition', 'Falta el registro administrativo. Requiere una migración revisada.')
    const previous = core.AdministrativeRestaurantSchema.parse(row.data())
    const root = db.doc(`restaurants/${input.restaurantId}`)
    const sub = await tx.get(root.collection('platform').doc('subscription'))
    const subscription = core.SubscriptionSchema.parse(sub.data())
    if (subscription.revision !== input.expectedRevision) throw new HttpsError('aborted', 'La configuración ha cambiado. Actualiza el listado.')
    // Nunca sobrescribir el contrato facturado: un webhook posterior podría revertir el acceso.
    if (subscription.stripeSubscriptionId) throw new HttpsError('failed-precondition', 'La suscripción está vinculada a Stripe. Revisa y actualiza el contrato antes de cambiar sus permisos.')
    const plan = await readPlan(tx, input.planId, input.planVersion)
    if (!plan.enabled) throw new HttpsError('failed-precondition', 'El plan no está disponible.')
    const usage = await tx.get(root.collection('platform').doc('usage'))
    if (!usage.exists || core.planOverages(plan.limits, usage.data() as Record<keyof core.PlanLimits, number>).length)
      throw new HttpsError('failed-precondition', 'El restaurante supera los límites del nuevo plan.')
    const now = Date.now()
    const integrations = await prepareIntegrationPatch(tx, input.restaurantId, input.integrations, input.removeIntegrations)
    if (input.serviceUntil !== undefined) {
      if (input.serviceUntil <= now || input.serviceUntil > now + 366 * 86_400_000)
        throw new HttpsError('invalid-argument', 'La fecha debe ser futura y no superar 366 días.')
      subscription.status = 'active'; subscription.periodEndsAt = input.serviceUntil; subscription.cancelAtPeriodEnd = false
    }
    subscription.planId = plan.id; subscription.planVersion = plan.version; subscription.revision++
    const entitlements = evaluate(plan, subscription, input.moduleOverrides, now)
    const restaurant: core.AdministrativeRestaurant = { ...previous, planId: plan.id, planVersion: plan.version, status: subscription.status,
      activeModules: entitlements.activeModules, moduleOverrides: entitlements.moduleOverrides, revision: subscription.revision, integrationStatus: integrations.status }
    integrations.commit()
    project(tx, input.restaurantId, plan, subscription, entitlements, now, actor)
    tx.set(ref, { ...restaurant, administrativeProvisioned: true, ...meta(actor, now) }, { merge: true })
    tx.create(db.collection('platformAdministrationActivity').doc(), { actorUid: actor, restaurantId: input.restaurantId,
      action: 'restaurant.configured', reason: input.reason, planId: plan.id, planVersion: plan.version, revision: subscription.revision, createdAt: Timestamp.now() })
    receipt.save({ restaurant })
    return { restaurant }
  })
}
