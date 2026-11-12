import { randomBytes, timingSafeEqual } from 'node:crypto'
import { FieldValue, Timestamp, type Transaction } from 'firebase-admin/firestore'
import { HttpsError } from 'firebase-functions/v2/https'
import { MemberSchema, RoleSchema, sha256Hex, type Role } from '@llenamos/core'
import { z } from 'zod'
import { auth, authorize, db, membership, parse, stamp } from './shared'
import { seal, unseal } from './fase6-api/security'

type Invitation = { restaurantId: string; uid: string; email: string; displayName: string; role: Role; invitedBy: string; kind: 'owner' | 'member' }
const pendingError = () => new HttpsError('failed-precondition', 'La invitación ha caducado, ya se ha usado o no es válida. Solicita otra.')
export function invitationMailConfiguration() {
  if (process.env.PLATFORM_EMAIL_ENABLED !== '1') return null
  const origin = new URL(process.env.PUBLIC_APP_URL ?? '')
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || !process.env.RESEND_API_KEY || !process.env.EMAIL_FROM)
    throw new HttpsError('failed-precondition', 'Falta configurar el correo de invitaciones de la plataforma.')
  return { origin: origin.origin, apiKey: process.env.RESEND_API_KEY, from: process.env.EMAIL_FROM }
}
export const invitationSecrets = () => process.env.PLATFORM_EMAIL_ENABLED === '1' ? ['PLATFORM_API_MASTER_KEY', 'RESEND_API_KEY'] : ['PLATFORM_API_MASTER_KEY']

/** No devuelve nunca un token ni permite usar el correo controlado por otro restaurante. */
export async function issueAccountInvitation(input: Invitation): Promise<'sent' | 'pending'> {
  const ref = db.doc(`accountInvitations/${sha256Hex(`${input.restaurantId}:${input.uid}`)}`)
  await db.runTransaction(async tx => {
    const current = await tx.get(ref)
    if (current.get('state') === 'accepting' && Number(current.get('leaseUntil')) > Date.now()) throw new HttpsError('aborted', 'El destinatario está aceptando su invitación.')
    if (!current.exists) tx.create(ref, { ...input, state: 'pending', createdAt: Timestamp.now(), updatedAt: Timestamp.now() })
    else if (['accepted', 'accepting', 'cancelled'].includes(current.get('state'))) tx.set(ref, { ...input, state: 'pending', createdAt: Timestamp.now(), updatedAt: Timestamp.now() })
    else if (current.get('role') !== input.role || current.get('invitedBy') !== input.invitedBy)
      tx.set(ref, { ...input, state: 'pending', createdAt: Timestamp.now(), updatedAt: Timestamp.now() })
  })
  const configuration = invitationMailConfiguration()
  if (!configuration) return 'pending'
  const token = await db.runTransaction(async tx => {
    const current = await tx.get(ref)
    if (!['pending', 'sent'].includes(current.get('state'))) throw pendingError()
    if (current.get('tokenCiphertext') && Number(current.get('expiresAt')) > Date.now())
      return (unseal(current.get('tokenCiphertext'), ref.path) as { token: string }).token
    const generated = randomBytes(32).toString('base64url')
    tx.update(ref, { tokenHash: sha256Hex(generated), tokenCiphertext: seal({ token: generated }, ref.path), expiresAt: Date.now() + 24 * 60 * 60_000, state: 'pending', updatedAt: Timestamp.now() })
    return generated
  })
  const link = new URL('/aceptar-invitacion', configuration.origin)
  link.hash = new URLSearchParams({ i: ref.id, t: token }).toString()
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${configuration.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `account-invitation-${ref.id}-${sha256Hex(token).slice(0, 16)}` },
    body: JSON.stringify({ from: configuration.from, to: [input.email], subject: 'Tu invitación a Llenamos', text: `Te han invitado al equipo de un restaurante en Llenamos. Acepta y elige una contraseña que solo conozcas tú:\n${link}\n\nEl enlace caduca en 24 horas. Al aceptarlo cambiará la contraseña de tu cuenta Llenamos y se cerrarán sus sesiones anteriores. Si no esperabas esta invitación, ignórala.` }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new HttpsError('unavailable', 'La invitación está pendiente y no se pudo entregar por correo. Reintenta más tarde.')
  const delivered = await response.json() as { id?: string }
  if (!delivered.id) throw new HttpsError('unavailable', 'El correo no ha confirmado la entrega de la invitación.')
  await db.runTransaction(async tx => {
    const current = await tx.get(ref)
    if (current.get('state') === 'pending' && current.get('tokenHash') === sha256Hex(token)) tx.update(ref, { state: 'sent', sentAt: Timestamp.now() })
  })
  return 'sent'
}

export const AcceptInvitationInput = z.object({ invitationId: z.string().regex(/^[a-f0-9]{64}$/), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), password: z.string().min(12).max(128) }).strict()
function validToken(stored: unknown, token: string) {
  const actual = Buffer.from(sha256Hex(token), 'hex')
  const expected = typeof stored === 'string' && /^[a-f0-9]{64}$/.test(stored) ? Buffer.from(stored, 'hex') : Buffer.alloc(32)
  return timingSafeEqual(actual, expected) && typeof stored === 'string'
}
async function authorizedInviter(tx: Transaction, invitation: Invitation) {
  if (invitation.kind === 'member') {
    const actor = await membership(tx, invitation.restaurantId, invitation.invitedBy)
    authorize(actor, undefined, invitation.role)
  }
}

/** El token solo llega al buzón del titular; elegir contraseña y cerrar sesiones es consentimiento explícito. */
export async function acceptAccountInvitation(data: unknown) {
  const input = parse(AcceptInvitationInput, data), ref = db.doc(`accountInvitations/${input.invitationId}`)
  const leaseId = randomBytes(16).toString('hex'), version = randomBytes(16).toString('hex')
  const invited = await db.runTransaction(async tx => {
    const current = await tx.get(ref)
    if (!current.exists || !validToken(current.get('tokenHash'), input.token) || Number(current.get('expiresAt')) <= Date.now()
      || !['pending', 'sent', 'accepting'].includes(current.get('state'))
      || (current.get('state') === 'accepting' && Number(current.get('leaseUntil')) > Date.now())) throw pendingError()
    const invitation = current.data() as Invitation
    RoleSchema.parse(invitation.role)
    const target = await tx.get(db.doc(`restaurants/${invitation.restaurantId}/members/${invitation.uid}`))
    const identityRef = db.doc(`identitySecurity/${invitation.uid}`), identity = await tx.get(identityRef)
    if (identity.get('locked') && Number(identity.get('leaseUntil')) > Date.now()) throw new HttpsError('aborted', 'Otra invitación de esta cuenta se está aceptando. Reintenta en unos minutos.')
    if (!target.exists || target.get('active') || target.get('invitationPending') !== true || target.get('role') !== invitation.role) throw pendingError()
    await authorizedInviter(tx, invitation)
    tx.update(ref, { state: 'accepting', leaseId, leaseUntil: Date.now() + 2 * 60_000 })
    tx.set(identityRef, { version, locked: true, leaseId, leaseUntil: Date.now() + 2 * 60_000, updatedAt: Timestamp.now() })
    return invitation
  })
  const user = await auth.getUser(invited.uid)
  if (user.disabled || user.customClaims?.logiqd === true || user.email?.toLowerCase() !== invited.email) throw pendingError()
  // Esta escritura solo ocurre después de probar el token privado enviado al buzón del titular.
  await auth.updateUser(user.uid, { password: input.password, emailVerified: true })
  await auth.setCustomUserClaims(user.uid, { ...user.customClaims, sessionVersion: version })
  await auth.revokeRefreshTokens(user.uid)
  await db.runTransaction(async tx => {
    const current = await tx.get(ref)
    const memberRef = db.doc(`restaurants/${invited.restaurantId}/members/${invited.uid}`)
    const identityRef = db.doc(`identitySecurity/${invited.uid}`)
    const [target, restaurant, profile, identity] = await Promise.all([tx.get(memberRef), tx.get(db.doc(`restaurants/${invited.restaurantId}`)), tx.get(db.doc(`users/${invited.uid}`)), tx.get(identityRef)])
    if (current.get('leaseId') !== leaseId || current.get('state') !== 'accepting' || target.get('active') || target.get('invitationPending') !== true || target.get('role') !== invited.role) throw pendingError()
    if (identity.get('version') !== version || identity.get('leaseId') !== leaseId || !identity.get('locked')) throw pendingError()
    await authorizedInviter(tx, invited)
    const member = MemberSchema.parse(target.data())
    tx.update(memberRef, { active: true, invitationPending: false, updatedAt: Timestamp.now() })
    tx.set(profile.ref, { displayName: profile.get('displayName') ?? invited.displayName, email: invited.email, restaurants: { [invited.restaurantId]: { name: restaurant.get('name'), role: member.role } }, ...(profile.exists ? {} : { createdAt: Timestamp.now() }), updatedAt: Timestamp.now() }, { merge: true })
    tx.set(identityRef, { version, locked: false, updatedAt: Timestamp.now() })
    tx.update(ref, { state: 'accepted', acceptedAt: Timestamp.now(), tokenHash: FieldValue.delete(), tokenCiphertext: FieldValue.delete(), leaseId: FieldValue.delete(), leaseUntil: FieldValue.delete() })
    tx.create(db.collection(`restaurants/${invited.restaurantId}/activity`).doc(), { action: 'member.accepted', summary: `${invited.displayName} ha aceptado su invitación`, actorUid: invited.uid, actorName: invited.displayName, entity: { type: 'member', id: invited.uid }, ...stamp() })
  })
  return { ok: true, email: invited.email }
}
