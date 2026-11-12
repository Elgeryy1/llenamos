import { getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { FieldValue, getFirestore, type Transaction } from 'firebase-admin/firestore'
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https'
import { can, assignableRoles, MemberSchema, type Member, type Role } from '@llenamos/core'
import { z } from 'zod'

if (!getApps().length) initializeApp()
export const db = getFirestore()
export const auth = getAuth()
export const options = { region: 'europe-west1' } as const
export const id = z.string().min(1).max(128).regex(/^[^/]+$/)
export const stamp = () => ({ createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() })
export function uidOf(request: CallableRequest<unknown>, platform = false): string {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Inicia sesión para continuar.')
  if (request.auth.token?.logiqd === true && !platform) throw new HttpsError('permission-denied', 'El equipo de LogiQD no tiene acceso al interior de los restaurantes.')
  return request.auth.uid
}
export function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data)
  if (!result.success) throw new HttpsError('invalid-argument', 'Revisa los datos enviados.')
  return result.data
}
export async function safe<T>(work: () => Promise<T>): Promise<T> {
  try { return await work() } catch (error) {
    if (error instanceof HttpsError) throw error
    const code = (error as { code?: string }).code
    if (code === 'auth/email-already-exists') throw new HttpsError('already-exists', 'Ese correo ya tiene una cuenta. Vuelve a intentarlo.')
    if (code === 'auth/invalid-password' || code === 'auth/invalid-email') throw new HttpsError('invalid-argument', 'Revisa el correo y la contraseña.')
    throw new HttpsError('internal', 'No se ha podido completar la operación. Inténtalo de nuevo.')
  }
}
export function authorize(actor: Member, target?: Member, role?: Role): void {
  if (!actor.active || !can(actor.role, 'equipo.gestionar')) throw new HttpsError('permission-denied', 'No tienes permiso para gestionar el equipo.')
  if (target?.uid === actor.uid) throw new HttpsError('failed-precondition', 'No puedes cambiar tu propia membresía.')
  if (target?.role === 'owner' && !can(actor.role, 'propietarios.gestionar')) throw new HttpsError('permission-denied', 'Solo un propietario puede gestionar a otro propietario.')
  if (role && !assignableRoles(actor.role).includes(role)) throw new HttpsError('permission-denied', 'No puedes asignar ese rol.')
}
export function ensureOwner(target: Member, nextRole: Role, active: boolean, owners: number): void {
  if (target.active && target.role === 'owner' && (!active || nextRole !== 'owner') && owners <= 1)
    throw new HttpsError('failed-precondition', 'El restaurante debe conservar un propietario activo.')
}
export async function membership(tx: Transaction, rid: string, uid: string): Promise<Member> {
  const doc = await tx.get(db.doc(`restaurants/${rid}/members/${uid}`))
  const result = MemberSchema.safeParse(doc.data())
  if (!result.success) throw new HttpsError('permission-denied', 'No tienes una membresía válida en este restaurante.')
  return result.data
}

// Una invitación existente solo es válida para reactivar una membresía inactiva.
export function authorizeInvitation(actor: Member, target: Member | undefined, role: Role): void {
  authorize(actor, target, role)
  if (target?.active) throw new HttpsError('already-exists', 'Esta persona ya pertenece al restaurante.')
}

/** Lee antes de escribir; la función devuelta incrementa el bloqueo en la misma transacción. */
export async function reservationLock(tx: Transaction, path: string) {
  const ref = db.doc(`${path}/reservationLocks/current`)
  await tx.get(ref)
  return () => tx.set(ref, { revision: FieldValue.increment(1) }, { merge: true })
}
