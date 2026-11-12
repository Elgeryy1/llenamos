import { HttpsError } from 'firebase-functions/v2/https'
import { Timestamp } from 'firebase-admin/firestore'
import * as core from '@llenamos/core'
import { auth, db } from '../shared'
import { audit, dedup, evaluate, fail, hash, meta, project, readPlan } from './context'

type SaveInput = core.CallableInput<'guardarAlta'>
type CompleteInput = core.CallableInput<'completarAlta'>
export function assertLocalOnboarding() {
  if (process.env.GCLOUD_PROJECT !== 'demo-llenamos' || !process.env.FIRESTORE_EMULATOR_HOST)
    throw new HttpsError('permission-denied', 'El alta de restaurantes la realiza el equipo de LogiQD.')
}
export async function saveOnboarding(uid: string, input: SaveInput, administrative = false) {
  if (!administrative) assertLocalOnboarding()
  return db.runTransaction(async tx => {
    const receipt = await dedup(tx, uid, 'guardarAlta', input)
    if (receipt.response !== undefined) return core.GuardarAltaOutputSchema.parse(receipt.response)
    const ref = db.doc(`onboardings/${input.onboardingId ?? hash([uid, input.requestId])}`)
    const snap = await tx.get(ref), old = snap.exists ? core.OnboardingSchema.parse(snap.data()) : null
    if (old && old.ownerUid !== uid) throw new HttpsError('permission-denied', 'Este borrador pertenece a otra persona.')
    if (input.onboardingId && !old) throw new HttpsError('not-found', 'No se encuentra el borrador.')
    if (old && (old.revision !== input.expectedRevision || !['draft','failed'].includes(old.status))) throw new HttpsError('aborted', 'El borrador ha cambiado. Recupera la última revisión.')
    const draft = core.OnboardingDraftSchema.partial().parse({ ...snap.get('draft'), ...input.draft })
    const onboarding: core.Onboarding = { ownerUid: uid, restaurantId: null, status: 'draft', step: input.step, revision: (old?.revision ?? 0) + 1, requestId: input.requestId, error: null, trialUsed: false }
    const now = Date.now()
    tx.set(ref, { ...onboarding, draft, ...(old ? {} : { createdAt: Timestamp.fromMillis(now) }), ...meta(uid, now) })
    const response = { onboardingId: ref.id, onboarding }
    receipt.save(response)
    return response
  })
}
export async function completeOnboarding(uid: string, input: CompleteInput, administrative = false, platformActor = uid) {
  if (!administrative) assertLocalOnboarding()
  const user = await auth.getUser(uid)
  if (!user.email) fail('Necesitas un correo de acceso para crear el restaurante.')
  return db.runTransaction(async tx => {
    const receipt = await dedup(tx, uid, 'completarAlta', input)
    if (receipt.response !== undefined) return core.CompletarAltaOutputSchema.parse(receipt.response)
    const ref = db.doc(`onboardings/${input.onboardingId}`), snap = await tx.get(ref)
    if (!snap.exists) throw new HttpsError('not-found', 'No se encuentra el borrador.')
    const onboarding = core.OnboardingSchema.parse(snap.data())
    if (onboarding.ownerUid !== uid) throw new HttpsError('permission-denied', 'Este borrador pertenece a otra persona.')
    if (onboarding.revision !== input.expectedRevision || !['draft', 'failed'].includes(onboarding.status)) throw new HttpsError('aborted', 'El borrador ha cambiado o ya está terminado.')
    const draft = core.OnboardingDraftSchema.parse(snap.get('draft'))
    if (!administrative && draft.acceptedTermsVersion !== 'alta-provisional-v1') fail('Revisa y acepta las condiciones de la prueba local.')
    const plan = await readPlan(tx, draft.planId, draft.planVersion)
    if (!plan.enabled) fail('El plan ya no está disponible para nuevas altas.')
    if (!core.checkPlanLimit(plan.limits, 'locations', 0).ok || !core.checkPlanLimit(plan.limits, 'members', 0).ok) fail('El plan no permite abrir un restaurante.')
    const key = db.doc(`onboardingKeys/${hash(administrative ? ['administrative-owner', uid, draft.slug] : ['owner', uid])}`), slug = db.doc(`restaurantSlugs/${draft.slug}`)
    const profile = db.doc(`users/${uid}`)
    const [previous, reserved, legacy, profileSnap] = await Promise.all([
      tx.get(key), tx.get(slug), tx.get(db.collection('restaurants').where('slug', '==', draft.slug).limit(1)), tx.get(profile),
    ])
    if (previous.exists) fail('Esta cuenta ya ha utilizado el alta y la prueba. Revisa su restaurante existente.')
    if (reserved.exists || !legacy.empty) throw new HttpsError('already-exists', `La dirección ${draft.slug} está ocupada. Prueba con ${draft.slug.slice(0, 50)}-local.`)
    const rid = `alta_${hash([uid, input.onboardingId]).slice(0, 32)}`, lid = 'principal'
    const root = db.doc(`restaurants/${rid}`), local = root.collection('locations').doc(lid)
    const actor = administrative ? platformActor : uid
    const now = Date.now(), stamp = { createdAt: Timestamp.fromMillis(now), ...meta(actor, now) }
    const subscription: core.Subscription = { planId: plan.id, planVersion: plan.version, status: 'trialing', interval: 'month', trialEndsAt: now + plan.trialDays * 86_400_000, periodEndsAt: null, graceEndsAt: null, cancelAtPeriodEnd: false, stripeCustomerId: null, stripeSubscriptionId: null, revision: 1 }
    const entitlements = evaluate(plan, subscription, {}, now)
    tx.create(root, { name: draft.name, slug: draft.slug, brandColor: '#f0a35e', currency: 'EUR', timezone: 'Europe/Madrid', locale: 'es', isDemo: process.env.GCLOUD_PROJECT === 'demo-llenamos', changeId: `onboarding_${ref.id}`, ...stamp })
    tx.create(local, { ...draft.location, slug: core.slugify(draft.location.name) || lid, ...stamp })
    tx.create(root.collection('members').doc(uid), { changeId: `onboarding_${ref.id}`, uid, displayName: (user.displayName || user.email || 'Propietario').slice(0,80), email: user.email, role: 'owner', locationIds: [], active: !administrative, invitationPending: administrative, ...stamp })
    tx.set(profile, { displayName: (user.displayName || user.email || 'Propietario').slice(0,80), email: user.email, ...(!administrative ? { restaurants: { [rid]: { name: draft.name, role: 'owner' } } } : {}), ...(profileSnap.exists ? {} : { createdAt: Timestamp.fromMillis(now) }), ...meta(uid, now) }, { merge: true })
    tx.create(slug, { restaurantId: rid, ...stamp })
    tx.create(key, { uid, restaurantId: rid, requestId: input.requestId, trialUsed: true, ...stamp })
    tx.set(db.doc(`platformPlans/${plan.id}/versions/${plan.version}`), plan)
    tx.create(root.collection('platform').doc('usage'), { locations: 1, members: 1, apiKeys: 0, webhooks: 0, revision: 1, ...stamp })
    tx.create(local.collection('settings').doc('reservations'), { ...draft.settings, ...stamp })
    tx.create(local.collection('settings').doc('floor'), { ...core.defaultFloorSettings(), defaultStationId: 'cocina', ...stamp })
    tx.create(local.collection('stations').doc('cocina'), { ...core.StationSchema.parse({ name: 'Cocina', kind: 'kitchen', sortOrder: 0, active: true, targetMinutes: 15, pickup: true }), ...stamp })
    const floor = draft.floor ?? { areaName: 'Sala', tableCount: 6, seats: 4 }
    tx.create(local.collection('areas').doc('sala'), { name: floor.areaName, sortOrder: 0, ...stamp })
    for (let i = 0; i < floor.tableCount; i++) {
      const columns = Math.min(4, floor.tableCount), rows = Math.ceil(floor.tableCount / columns)
      const table = core.TableSchema.parse({ name: `Mesa ${i+1}`, areaId: 'sala', seats: floor.seats, shape: i % 2 ? 'round' : 'rect', x: 8 + (i % columns) * (84 / columns), y: 10 + Math.floor(i / columns) * (80 / rows), w: Math.min(16, 65 / columns), h: Math.min(16, 60 / rows), joinableWith: [], enabled: true })
      tx.create(local.collection('tables').doc(`mesa_${i+1}`), { ...table, ...stamp })
    }
    if (draft.menu?.length) {
      tx.create(local.collection('menuCategories').doc('carta'), { ...core.MenuCategorySchema.parse({ name: { es: 'Nuestra carta' }, description: {}, sortOrder: 0, active: true }), ...stamp })
      draft.menu.forEach((item, i) => {
        const dish = core.MenuItemSchema.parse({ categoryId: 'carta', name: { es: item.name }, description: {}, sortOrder: i, priceCents: item.priceCents, course: 'first', stationId: 'cocina', soldOut: false, version: 1, allergensReviewed: false, selfOrder: false, takeaway: false, updatedBy: uid })
        tx.create(local.collection('menuItems').doc(`plato_${i+1}`), { ...dish, ...stamp })
      })
    }
    project(tx, rid, plan, subscription, entitlements, now, actor)
    audit(tx, rid, `onboarding_${ref.id}`, actor, subscription.status, now)
    tx.update(ref, { status: 'ready', step: 'done', restaurantId: rid, trialUsed: true, revision: onboarding.revision+1, ...meta(uid, now) })
    const response = { restaurantId: rid, locationId: lid, subscription, entitlements }
    receipt.save(response)
    return response
  })
}
/** La entrada anterior conserva su firma, pero comparte unicidad, cuotas y prueba. */
export async function legacyCreate(uid: string, name: string, locationName: string) {
  const requestId = `legacy_${hash([uid, name, locationName])}`
  const saved = await saveOnboarding(uid, { requestId, onboardingId: null, expectedRevision: null, step: 'review', draft: {
    name, slug: core.slugify(name), location: { name: locationName, address: '', city: '', phone: '' }, settings: { ...core.defaultReservationSettings(), publicBooking: true }, planId: 'sala', planVersion: 1, acceptedTermsVersion: 'alta-provisional-v1',
  } })
  const result = await completeOnboarding(uid, { requestId, onboardingId: saved.onboardingId, expectedRevision: saved.onboarding.revision })
  return { restaurantId: result.restaurantId, locationId: result.locationId }
}
