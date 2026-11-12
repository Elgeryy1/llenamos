import { FieldPath, Timestamp } from 'firebase-admin/firestore'
import { HttpsError, onCall, type CallableRequest } from '../identity-call'
import * as core from '@llenamos/core'
import { db, options, parse, safe } from '../shared'
import { assertBackupCaptureAllowed, audit, authorize, cursorId, digest, key, localOnly, metadata, rootOf, signedCursor } from '../fase6-privacy/infra'
import { initialDrill } from './worker'
export type Name = 'crearCopiaSeguridad'|'simularRestauracion'|'verContinuidad'
export async function execute(name:Name,input:unknown,request:CallableRequest<unknown>) {
  localOnly(); key()
  const parsed = core.CALLABLE_SCHEMAS_FASE6[name].input.safeParse(input)
  if (!parsed.success) throw new HttpsError('invalid-argument','Revisa los datos enviados.')
  const d = parsed.data as core.CallableParsedInput<Name>
  if (name === 'crearCopiaSeguridad') assertBackupCaptureAllowed()
  return db.runTransaction(async tx => {
    const uid = await authorize(tx,d.restaurantId,request,true), root = rootOf(d.restaurantId)
    if (!(await tx.get(root)).exists) throw new Error('Restaurante ausente')
    if (name === 'verContinuidad') {
      const q = d as core.CallableParsedInput<'verContinuidad'>, scope = `${name}:${d.restaurantId}:${uid}`, last = cursorId(scope,q.cursor)
      const page = async (collection:string) => {
        let query = root.collection(collection).orderBy(FieldPath.documentId()).limit(q.limit+1)
        if (last) query = query.startAfter(last)
        return (await tx.get(query)).docs
      }
      const [backups,drills] = await Promise.all([page('backups'),page('restoreDrills')])
      // Un cursor conjunto avanza por el menor límite para no perder filas de ninguna colección.
      const boundary = [backups[q.limit-1]?.id,drills[q.limit-1]?.id].filter((x):x is string => !!x).sort()[0]
      const more = backups.length > q.limit || drills.length > q.limit
      return { backups:backups.filter(b => !more || b.id <= boundary!).map(row => { const { files:_f,keyVersion:_k,...m } = core.BackupManifestSchema.parse(row.data()); return { ...m,id:row.id } }),drills:drills.filter(b => !more || b.id <= boundary!).map(row => { const { isolatedTarget:_t,...drill } = core.RestoreDrillSchema.parse(row.data()); return { ...drill,id:row.id } }),nextCursor:more ? signedCursor(scope,boundary!) : null }
    }
    const m = d as core.CallableParsedInput<'crearCopiaSeguridad'>, id = digest(core.canonicalJson([uid,d.restaurantId,name,m.requestId])), ref = root.collection('backupRequests').doc(id), old = await tx.get(ref), fingerprint = digest(core.canonicalJson(d))
    if (old.exists) {
      if (old.get('fingerprint') !== fingerprint) throw new Error('La petición ya tiene otro contenido.')
      return old.get('response') as unknown
    }
    const now = Date.now()
    let response:unknown
    if (name === 'crearCopiaSeguridad') {
      const manifest:core.BackupManifest = { restaurantId:d.restaurantId,schemaVersion:1,snapshotAt:now,status:'running',files:[],encrypted:true,keyVersion:'v1',expiresAt:now+core.provisionalRetentionPolicy().backupDays*86_400_000 }
      tx.create(root.collection('backups').doc(id),{ ...core.backupManifestForWrite(manifest,Timestamp.fromMillis),...metadata(uid) })
      response = { backupId:id,manifest }
    } else {
      const q = d as core.CallableParsedInput<'simularRestauracion'>, b = await tx.get(root.collection('backups').doc(q.backupId))
      if (!b.exists || b.get('status') !== 'verified' || core.TimestampSchema.parse(b.get('expiresAt')) <= now) throw new Error('No hay una copia verificada vigente.')
      const drill = initialDrill(d.restaurantId,q.backupId,now)
      tx.create(root.collection('restoreDrills').doc(id),{ ...core.restoreDrillForWrite(drill,Timestamp.fromMillis),...metadata(uid) })
      response = { drillId:id,drill }
    }
    tx.create(ref,{ fingerprint,response,...metadata(uid) }); audit(tx,d.restaurantId,id,`backup.${name}`,uid)
    return core.CALLABLE_SCHEMAS_FASE6[name].output.parse(response)
  })
}
const custodyOptions = { ...options, secrets:['PLATFORM_DATA_KEY_V1'] }
export const crearCopiaSeguridad = onCall(custodyOptions,r => safe(() => execute('crearCopiaSeguridad',r.data,r)))
export const simularRestauracion = onCall(custodyOptions,r => safe(() => execute('simularRestauracion',r.data,r)))
export const verContinuidad = onCall(custodyOptions,r => safe(() => execute('verContinuidad',r.data,r)))
export { runContinuity, processBackup, processDrill } from './worker'
