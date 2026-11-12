import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { FieldValue, type Transaction } from 'firebase-admin/firestore'
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https'
import * as core from '@llenamos/core'
import { db, membership, uidOf } from '../shared'

export type Scope = { restaurantId: string; locationId: string }
export const hash = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex')
export const token = () => randomBytes(32).toString('base64url')
export const fail = (message: string): never => { throw new HttpsError('failed-precondition', message) }
export const deny = (): never => { throw new HttpsError('permission-denied', 'No tienes acceso a esta impresora o puente en este local.') }
export const equal = (a: unknown, b: string) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
export function local(s: Scope) { return db.doc(`restaurants/${s.restaurantId}/locations/${s.locationId}`) }
export async function scope(tx: Transaction, s: Scope) {
  const ref = local(s)
  const [r, l] = await Promise.all([tx.get(ref.parent.parent!), tx.get(ref)])
  if (!r.exists || !l.exists) throw new HttpsError('not-found', 'No se encuentra el restaurante o el local.')
  if (!core.hasModule(r.data()!, 'pos')) fail('El módulo de caja está desactivado.')
  return { ref, restaurant: r.data()!, location: l.data()! }
}
export async function staff(tx: Transaction, s: Scope, request: CallableRequest<unknown>, permission: core.Permission) {
  const ctx = await scope(tx, s), uid = uidOf(request), member = await membership(tx, s.restaurantId, uid)
  if (!member.active || !core.can(member.role, permission) || (member.locationIds.length && !member.locationIds.includes(s.locationId))) deny()
  return { ...ctx, uid, member }
}
export async function bridge(tx: Transaction, s: Scope & { bridgeId: string; token: string }) {
  const ctx = await scope(tx, s)
  const auth = await tx.get(ctx.ref.collection('printBridges').doc(s.bridgeId))
  if (!auth.exists || auth.get('revoked') || !equal(auth.get('tokenHash'), hash(s.token))) deny()
  return { ...ctx, bridge: auth }
}
export const metadata = (uid: string | null, fresh = false) => ({ updatedAt: FieldValue.serverTimestamp(), updatedBy: uid, ...(fresh ? { createdAt: FieldValue.serverTimestamp() } : {}) })
export function activity(tx: Transaction, s: Scope, uid: string, name: string, action: string, summary: string) {
  tx.create(db.collection(`restaurants/${s.restaurantId}/activity`).doc(), { action, summary, actorUid: uid, actorName: name, entity: { type: 'location', id: s.locationId }, ...metadata(uid, true) })
}
