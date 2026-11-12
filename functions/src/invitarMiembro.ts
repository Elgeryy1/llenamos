import { HttpsError, onCall } from './identity-call'
import { onCall as onPublicCall } from 'firebase-functions/v2/https'
import { MemberSchema, RoleSchema } from '@llenamos/core'
import { z } from 'zod'
import { assertPlatformCapacity } from './fase6-billing/context'
import { auth, authorize, authorizeInvitation, db, id, membership, options, parse, safe, stamp, uidOf } from './shared'
import { acceptAccountInvitation, invitationSecrets, issueAccountInvitation } from './account-invitations'

import { memberActivity, recordActivity } from './callableActivity'

export const invitarMiembro = onCall({ ...options, secrets: invitationSecrets() }, request => safe(async () => {
  const actorUid = uidOf(request)
  const input = parse(z.object({ restaurantId: id, email: z.string().trim().email().transform(v => v.toLowerCase()), displayName: z.string().trim().min(1).max(80), role: RoleSchema }).strict(), request.data)
  // Se comprueban permisos antes de crear una cuenta y de nuevo dentro de la transacción.
  await db.runTransaction(async tx => {
    authorize(await membership(tx, input.restaurantId, actorUid), undefined, input.role)
    // Solo lee: evita crear una cuenta si el plan no admite más personas. No reserva el hueco.
    const existing = await tx.get(db.collection(`restaurants/${input.restaurantId}/members`).where('email', '==', input.email).limit(1))
    if (!existing.docs[0]?.get('invitationPending')) await assertPlatformCapacity(tx, input.restaurantId, 'members', 1, Date.now())
  })
  const user = await auth.getUserByEmail(input.email).catch((error: unknown) => {
    if ((error as { code?: string }).code !== 'auth/user-not-found') throw error
    return auth.createUser({ email: input.email, displayName: input.displayName })
  })
  if (user.disabled || user.customClaims?.logiqd === true) throw new HttpsError('failed-precondition', 'No se puede invitar esta cuenta al equipo.')
  await db.runTransaction(async tx => {
    const actor = await membership(tx, input.restaurantId, actorUid)
    authorize(actor, undefined, input.role)
    const restaurant = await tx.get(db.doc(`restaurants/${input.restaurantId}`))
    const member = await tx.get(restaurant.ref.collection('members').doc(user.uid))
    if (!restaurant.exists) throw new HttpsError('not-found', 'El restaurante no existe.')
    const target = member.exists ? MemberSchema.parse(member.data()) : undefined
    authorizeInvitation(actor, target, input.role)
    // Nueva persona o reactivación: ocupa un hueco del plan. El contador se reserva en esta misma transacción.
    const capacity = member.get('invitationPending') ? null : await assertPlatformCapacity(tx, input.restaurantId, 'members', 1, Date.now())
    const activity = restaurant.ref.collection('activity').doc()
    capacity?.commit()
    tx.set(member.ref, { changeId: activity.id, uid: user.uid, email: input.email, displayName: input.displayName, role: input.role, locationIds: [], active: false, invitationPending: true, ...stamp(), ...(target ? { createdAt: member.data()!.createdAt, locationIds: target.locationIds } : {}) })
    recordActivity(tx, activity, memberActivity(actor, { uid: user.uid, displayName: input.displayName }, target ? 'reactivated' : 'invited', input.role))
    tx.update(restaurant.ref, { updatedAt: stamp().updatedAt })
  })
  const invitationStatus = await issueAccountInvitation({ restaurantId: input.restaurantId, uid: user.uid, email: input.email, displayName: input.displayName, role: input.role, invitedBy: actorUid, kind: 'member' })
  return { uid: user.uid, invitationStatus }
}))

// La credencial es el token de correo, no una sesión anterior potencialmente revocada.
export const aceptarInvitacion = onPublicCall(options, request => safe(() => acceptAccountInvitation(request.data)))
