import type { DocumentReference, Transaction } from 'firebase-admin/firestore'
import { ROLE_LABEL, type Member, type Role } from '@llenamos/core'
import { stamp } from './shared'

// Mismos nombres de rol que la interfaz, en minúscula para ir dentro de la frase.
const roles = (role: Role) => ROLE_LABEL[role].toLowerCase()
export function memberActivity(actor: Pick<Member, 'uid' | 'displayName'>, target: Pick<Member, 'uid' | 'displayName'>, action: 'invited' | 'reactivated' | 'roleChanged' | 'deactivated', role: Role) {
  const descriptions = {
    invited: `ha invitado a ${target.displayName} con el rol de ${roles(role)}`,
    reactivated: `ha reactivado a ${target.displayName} con el rol de ${roles(role)}`,
    roleChanged: `ha cambiado el rol de ${target.displayName} a ${roles(role)}`,
    deactivated: `ha desactivado a ${target.displayName}`,
  }
  return { action: `member.${action}`, summary: `${actor.displayName} ${descriptions[action]}`, actorUid: actor.uid, actorName: actor.displayName, entity: { type: 'member', id: target.uid } }
}
export function recordActivity(tx: Transaction, ref: DocumentReference, data: ReturnType<typeof memberActivity>) {
  tx.create(ref, { ...data, ...stamp() })
}
