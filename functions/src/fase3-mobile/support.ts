import { randomBytes, timingSafeEqual } from 'node:crypto'
import { FieldValue, Timestamp, type Transaction, type DocumentReference } from 'firebase-admin/firestore'
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https'
import { BillSchema, BillPartSchema, can, hasModule, linkToken, sha256Hex, type Permission } from '@llenamos/core'
import { db, membership, uidOf } from '../shared'

export const token = () => linkToken(randomBytes(32))
export const hash = (v: unknown) => sha256Hex(JSON.stringify(v))
export const meta = (uid: string | null = null) => ({ updatedBy: uid, updatedAt: FieldValue.serverTimestamp() })
export const fresh = (uid: string | null = null) => ({ ...meta(uid), createdAt: FieldValue.serverTimestamp() })
export const fail = (message: string): never => { throw new HttpsError('failed-precondition', message) }
export function checkToken(saved: unknown, raw: string) {
  const actual = sha256Hex(raw)
  if (typeof saved !== 'string' || saved.length !== actual.length || !timingSafeEqual(Buffer.from(saved), Buffer.from(actual)))
    throw new HttpsError('permission-denied', 'El enlace no es válido o ha caducado.')
}
export async function resolveSlug(slug: string) {
  const rows = await db.collection('restaurants').where('slug', '==', slug).limit(1).get()
  if (rows.empty) throw new HttpsError('not-found', 'No se encuentra el restaurante.')
  return rows.docs[0]!.id
}
export async function scope(tx: Transaction, rid: string, lid: string, request?: CallableRequest<unknown>, floor = true, acquired = false) {
  const root = db.doc(`restaurants/${rid}`), local = root.collection('locations').doc(lid)
  const [r, l, s] = await Promise.all([tx.get(root), tx.get(local), tx.get(local.collection('settings').doc('pos'))])
  if (!r.exists || !l.exists) throw new HttpsError('not-found', 'No se encuentra el local.')
  const restaurant = r.data()!, location = l.data()!
  if (!acquired && (!hasModule(restaurant, 'pos') || (floor && !hasModule(restaurant, 'floor')))) fail('El servicio de caja no está disponible.')
  let uid: string | null = null
  if (request) {
    uid = uidOf(request)
    const actor = await membership(tx, rid, uid)
    if (!actor.active || !can(actor.role, 'caja.cobrar' satisfies Permission) || (actor.locationIds.length && !actor.locationIds.includes(lid)))
      throw new HttpsError('permission-denied', 'No tienes permiso para cobrar en este local.')
  }
  return { rid, lid, root, local, restaurant, location, settings: s.data(), uid }
}
export type Scope = Awaited<ReturnType<typeof scope>>
export async function billPart(tx: Transaction, local: DocumentReference, billId: string, partId: string, revision: number) {
  const [b, p] = await Promise.all([tx.get(local.collection('bills').doc(billId)), tx.get(local.collection('billParts').doc(partId))])
  const bill = BillSchema.parse(b.data()), part = BillPartSchema.parse(p.data())
  if (part.billId !== billId || part.revision !== revision || bill.revision !== revision || bill.status !== 'locked')
    fail('La cuenta ha cambiado. Pide al personal un enlace actualizado.')
  const amount = part.totalCents - part.paidCents
  if (amount <= 0) fail('Esta parte ya está pagada.')
  return { bill, part, amount }
}
/** Se limita también el intento inválido, antes de comprobar su credencial. */
export async function throttle(rid: string, credential: string, ip: string) {
  const now = Date.now()
  await db.runTransaction(async tx => {
    const snapshots = await Promise.all([`ip:${ip}`, `token:${credential}`].map(key => tx.get(db.doc(`restaurants/${rid}/mobileRateLimits/${hash(key)}`))))
    for (const s of snapshots) if (s.exists && now - s.get('since') < 60000 && s.get('count') >= 60)
      throw new HttpsError('resource-exhausted', 'Demasiadas solicitudes. Espera un minuto.')
    for (const s of snapshots) tx.set(s.ref, { since: s.exists && now - s.get('since') < 60000 ? s.get('since') : now,
      count: s.exists && now - s.get('since') < 60000 ? s.get('count') + 1 : 1, expiresAt: Timestamp.fromMillis(now + 3600000), ...meta() })
  })
}
export function activity(tx: Transaction, c: Scope, id: string, action: string, summary: string) {
  tx.create(c.root.collection('activity').doc(id), { action, summary, actorUid: c.uid, actorName: null,
    entity: { type: 'location', id: c.lid }, ...fresh(c.uid) })
}
