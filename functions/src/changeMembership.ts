import { FieldValue } from 'firebase-admin/firestore'
import { HttpsError } from 'firebase-functions/v2/https'
import { sha256Hex, type Role } from '@llenamos/core'
import { releasePlatformCapacity } from './fase6-billing/context'
import { authorize, db, ensureOwner, membership, stamp } from './shared'

import { memberActivity, recordActivity } from './callableActivity'

export async function changeMembership(rid: string, actorUid: string, uid: string, role?: Role): Promise<{ ok: true }> {
  await db.runTransaction(async tx => {
    const actor = await membership(tx, rid, actorUid)
    const target = await membership(tx, rid, uid)
    authorize(actor, target, role)
    const restaurant = await tx.get(db.doc(`restaurants/${rid}`))
    const owners = await tx.get(restaurant.ref.collection('members').where('role', '==', 'owner').where('active', '==', true))
    const profile = await tx.get(db.doc(`users/${uid}`))
    const targetDocument = await tx.get(restaurant.ref.collection('members').doc(uid))
    if (!restaurant.exists) throw new HttpsError('not-found', 'El restaurante no existe.')
    const nextRole = role ?? target.role
    const active = role ? target.active : false
    ensureOwner(target, nextRole, active, owners.size)
    // Desactivar o cancelar una invitación pendiente libera su hueco reservado del plan.
    const release = (target.active || targetDocument.get('invitationPending')) && !active && !role ? await releasePlatformCapacity(tx, rid, 'members', 1, Date.now()) : null
    release?.commit()
    const activity = restaurant.ref.collection('activity').doc()
    recordActivity(tx, activity, memberActivity(actor, target, role ? 'roleChanged' : 'deactivated', nextRole))
    tx.update(restaurant.ref.collection('members').doc(uid), { changeId: activity.id, role: nextRole, active, ...(!role ? { invitationPending: false } : {}), updatedAt: stamp().updatedAt })
    if (!role) tx.set(db.doc(`accountInvitations/${sha256Hex(`${rid}:${uid}`)}`), { state: 'cancelled', tokenHash: FieldValue.delete(), tokenCiphertext: FieldValue.delete(), updatedAt: stamp().updatedAt }, { merge: true })
    tx.set(profile.ref, { ...(profile.exists ? {} : { displayName: target.displayName, email: target.email, createdAt: stamp().createdAt }), restaurants: { [rid]: active ? { name: restaurant.data()!.name, role: nextRole } : FieldValue.delete() }, updatedAt: stamp().updatedAt }, { merge: true })
    // Serializa cambios concurrentes de propietarios y cambios del nombre del negocio.
    tx.update(restaurant.ref, { updatedAt: stamp().updatedAt })
  })
  return { ok: true }
}
