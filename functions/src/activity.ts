import { createHash } from 'node:crypto'
import type { FirestoreAuthEvent, DocumentSnapshot } from 'firebase-functions/v2/firestore'
import type { Change } from 'firebase-functions'
import { db, stamp } from './shared'

export async function writeActivity(event: FirestoreAuthEvent<Change<DocumentSnapshot> | undefined, Record<string, string>>, type: string, entityId: string): Promise<void> {
  if (!event.data) return
  const before = event.data.before.data()
  const after = event.data.after.data()
  // La callable ya ha registrado esta operación en la misma transacción.
  if (['restaurant', 'member'].includes(type) && after?.changeId && after.changeId !== before?.changeId) return
  const meaningful = (data: typeof before) => JSON.stringify(Object.fromEntries(Object.entries(data ?? {}).filter(([key]) => !['createdAt', 'updatedAt', 'changeId', 'updatedBy'].includes(key)).sort(([a], [b]) => a.localeCompare(b))))
  if (meaningful(before) === meaningful(after)) return
  const action = !before ? 'created' : !after ? 'deleted' : 'updated'
  // El emulador puede omitir el contexto; las reglas verifican el uid del cliente.
  const updatedBy: unknown = (after ?? before)?.updatedBy
  const actorUid = (event.authType === 'api_key' && event.authId ? event.authId : null)
    ?? (typeof updatedBy === 'string' && updatedBy.length > 0 && !updatedBy.includes('/') ? updatedBy : null)
  const actor = actorUid ? await db.doc(`users/${actorUid}`).get() : null
  const labels: Record<string, string> = { restaurant: 'Restaurante', member: 'Miembro', area: 'Zona', table: 'Mesa' }
  // Zona y mesa son femeninas: «Mesa creada», no «Mesa creado».
  const feminine = ['area', 'table'].includes(type)
  const verbs: Record<string, string> = { created: 'creado', deleted: 'eliminado', updated: 'actualizado' }
  const verb = feminine ? verbs[action]!.replace(/o$/, 'a') : verbs[action]
  const ref = db.doc(`restaurants/${event.params.rid}/activity/${createHash('sha256').update(event.id).digest('hex')}`)
  // El id del evento evita duplicar actividad si Firestore vuelve a entregarlo.
  await db.runTransaction(async tx => {
    if ((await tx.get(ref)).exists) return
    tx.create(ref, { action: `${type}.${action}`, summary: `${labels[type]} ${verb}: ${after?.name ?? after?.displayName ?? before?.name ?? before?.displayName ?? entityId}`, actorUid, actorName: actor?.data()?.displayName ?? null, entity: { type, id: entityId }, ...stamp() })
  })
}
