import { getApp } from 'firebase-admin/app'
import { getFirestore, Timestamp, type DocumentData } from 'firebase-admin/firestore'
import * as core from '@llenamos/core'
import { db } from '../shared'
import { validRelations } from './validate'
import { audit, assertBackupCaptureAllowed, bucket, collectionOf, decode, digest, encode, encrypt, decrypt, idOf, localOnly, metadata, readTree, rootOf, type Row } from '../fase6-privacy/infra'
import { isRestricted, redactedData } from '../fase6-privacy/inventory'

const excluded = new Set(['backups','restoreDrills','backupHealth','privacyDownloads','privacyHealth','providerStatus'])
/**
 * Credenciales recuperables: nunca entran en la copia. Tras restaurar hay que rotar los secretos de webhook,
 * volver a registrar los avisos push de cada dispositivo y fijar de nuevo los PIN de fichaje.
 */
export const secretCollections = new Set(['webhookSecrets','pushSubscriptions','staffPins','integrationSecrets'])
for (const name of secretCollections) excluded.add(name)
const objectives:core.RecoveryObjectives = { provisional:true,rpoMs:86_400_000,rtoMs:14_400_000,maxDrillAgeMs:30*86_400_000 }
type Snapshot = { version:1;restaurantId:string;rows:Row[];files:{ path:string;data:string;sha256:string }[] }
const stable = (rows:Row[]) => JSON.stringify(encode(rows.filter(r => !excluded.has(collectionOf(r))).sort((a,b) => a.path.localeCompare(b.path))))
async function globals(tx: FirebaseFirestore.Transaction,rid:string, rows:Row[]) {
  const result:Row[] = []
  for (const name of ['publicRestaurants','publicMenus','restaurantSlugs','fiscalInstallations','platformRequests']) {
    const docs = await tx.get(db.collection(name).where('restaurantId','==',rid))
    for (const d of docs.docs) result.push({ path:d.ref.path,data:d.data() })
  }
  for (const member of rows.filter(r => collectionOf(r) === 'members')) {
    const ref = db.doc(`users/${idOf(member)}`), doc = await tx.get(ref)
    if (doc.exists && doc.get(`restaurants.${rid}`)) result.push({ path:ref.path,data:{ restaurants:{ [rid]:doc.get(`restaurants.${rid}`) } } })
  }
  return result
}
async function sourceFiles(rid:string) {
  const files = (await Promise.all([`restaurants/${rid}/`,`platform/${rid}/exports/`].map(async prefix => (await bucket().getFiles({ prefix }))[0]))).flat()
  return Promise.all(files.map(async file => { const [m] = await file.getMetadata(); return { path:file.name,generation:m.generation! } }))
}
export async function captureRestaurant(rid:string):Promise<Snapshot & { snapshotAt:number }> {
  assertBackupCaptureAllowed()
  const before = await sourceFiles(rid)
  let snapshotAt = 0
  const rows = await db.runTransaction(async tx => {
    const root = rootOf(rid), cut = await tx.get(root)
    if (!cut.exists) throw new Error('Restaurante ausente')
    snapshotAt = cut.readTime.toMillis()
    const tree = (await readTree(tx,root)).filter(r => !excluded.has(collectionOf(r)))
    const extra = await globals(tx,rid,tree)
    return [...tree,...extra].sort((a,b) => a.path.localeCompare(b.path))
  },{ readOnly:true })
  const files = await Promise.all(before.map(async f => {
    const bytes = (await bucket().file(f.path,{ generation:f.generation }).download())[0]
    return { path:f.path,data:bytes.toString('base64'),sha256:digest(bytes) }
  }))
  const after = await sourceFiles(rid)
  if (JSON.stringify(before.sort((a,b) => a.path.localeCompare(b.path))) !== JSON.stringify(after.sort((a,b) => a.path.localeCompare(b.path)))) throw new Error('Los archivos cambiaron durante el corte.')
  // Detecta cambios de topología durante el descubrimiento de subcolecciones.
  const verification = await db.runTransaction(async tx => { const tree = await readTree(tx,rootOf(rid)); return [...tree.filter(r => !excluded.has(collectionOf(r))),...await globals(tx,rid,tree)] },{ readOnly:true })
  if (stable(rows) !== stable(verification)) throw new Error('El restaurante cambió durante la captura. Reintenta en una ventana estable.')
  return { version:1,restaurantId:rid,rows,files,snapshotAt }
}
export async function processBackup(rid:string,backupId:string) {
  localOnly()
  const root = rootOf(rid), ref = root.collection('backups').doc(backupId)
  const claimed = await db.runTransaction(async tx => {
    const row = await tx.get(ref)
    if (!row.exists || row.get('status') !== 'running' || row.get('leaseUntil')?.toMillis() > Date.now()) return false
    tx.update(ref,{ leaseUntil:Timestamp.fromMillis(Date.now()+300_000),...metadata() }); return true
  })
  if (!claimed) return
  try {
    const snapshot = await captureRestaurant(rid), path = `platform/${rid}/backups/${backupId}/snapshot.enc`
    const bytes = encrypt(Buffer.from(JSON.stringify(encode(snapshot))),path)
    await bucket().file(path).save(bytes,{ resumable:false,metadata:{ contentType:'application/octet-stream' } })
    const persisted = (await bucket().file(path).download())[0]
    if (!persisted.equals(bytes)) throw new Error('La verificación del archivo no coincide.')
    const manifest:core.BackupManifest = { restaurantId:rid,schemaVersion:1,snapshotAt:snapshot.snapshotAt,status:'verified',files:[{ path,sha256:digest(bytes),bytes:bytes.length,records:snapshot.rows.length }],encrypted:true,keyVersion:'v1',expiresAt:snapshot.snapshotAt+core.provisionalRetentionPolicy().backupDays*86_400_000 }
    await ref.set({ ...core.backupManifestForWrite(manifest,Timestamp.fromMillis),leaseUntil:null,storageFiles:snapshot.files.length,...metadata() },{ merge:true })
  } catch (error) {
    await ref.update({ status:'failed',error:error instanceof Error ? error.message.slice(0,200) : 'No se ha verificado la copia.',leaseUntil:null,...metadata() })
  }
}
function tenantAllowed(row:Row,rid:string) {
  const p = row.path.split('/')
  if (p[0] === 'restaurants') return p[1] === rid
  if (p[0] === 'users') return Object.keys(row.data.restaurants ?? {}).length === 1 && Object.hasOwn(row.data.restaurants ?? {},rid)
  return ['publicRestaurants','publicMenus','restaurantSlugs','fiscalInstallations','platformRequests'].includes(p[0]!) && row.data.restaurantId === rid
}
function validFiscal(rows:Row[]) {
  try {
    const records = rows.filter(r => collectionOf(r) === 'fiscalRecords').map(r => core.FiscalStoredRecordSchema.parse(r.data))
    const chains = rows.filter(r => collectionOf(r) === 'fiscalChains')
    if (records.some(r => !chains.some(c => idOf(c) === r.input.chainId))) return false
    for (const chain of chains) {
      const parsed = core.FiscalChainSchema.parse(chain.data), own = records.filter(r => r.input.chainId === idOf(chain)).sort((a,b) => a.input.chainSequence-b.input.chainSequence), last = own.at(-1)
      if (!core.verifyFiscalChain(own)) return false
      const head = last ? { ...core.fiscalIdentity(last.input),recordId:last.input.recordId,hash:last.hash,sequence:last.input.chainSequence } : null
      if (JSON.stringify(parsed.head) !== JSON.stringify(head)) return false
    }
    // Reutiliza los totales y no asigna números ni reconstruye cadenas.
    for (const row of rows.filter(r => collectionOf(r) === 'invoices')) {
      const invoice = core.InvoiceSchema.parse(row.data), totals = core.invoiceTotals(invoice.lines)
      if (['totalCents','taxCents'].some(k => row.data[k] !== (totals as Record<string,unknown>)[k])) return false
    }
    return true
  } catch { return false }
}
const effects:Record<string,'message'|'webhook'|'payment'|'fiscal'|'print'> = { messages:'message',pushDeliveries:'message',webhookDeliveries:'webhook',mobileCheckouts:'payment',paymentReservations:'payment',fiscalOutbox:'fiscal',printRequests:'print',printJobs:'print' }
export async function processDrill(rid:string,drillId:string) {
  localOnly()
  const root = rootOf(rid), ref = root.collection('restoreDrills').doc(drillId), startedAt = Date.now()
  const claimed = await db.runTransaction(async tx => {
    const d = await tx.get(ref)
    if (!d.exists || !['requested','restoring','validating'].includes(d.get('status')) || d.get('leaseUntil')?.toMillis() > Date.now()) return null
    tx.update(ref,{ status:'restoring',startedAt:Timestamp.fromMillis(startedAt),leaseUntil:Timestamp.fromMillis(startedAt+300_000),...metadata() }); return d.get('backupId') as string
  })
  if (!claimed) return
  const targetName = `restore-${digest(`${rid}:${drillId}`).slice(0,24)}`, target = db
  const isolatedPath = `restoreSandbox/${targetName}`
  const targetDoc = (path:string) => target.doc(`${isolatedPath}/${path}`)
  const targetPrefix = `restore-drills/${targetName}/`
  const checks:core.RestoreDrill['checks'] = { hashes:false,counts:false,fiscalChains:false,tenantIsolation:false,privacyTombstones:false,outboxes:false }
  let measuredRpoMs:number|null = null
  try {
    const manifest = core.BackupManifestSchema.parse((await root.collection('backups').doc(claimed).get()).data())
    if (manifest.restaurantId !== rid || manifest.schemaVersion !== 1 || manifest.expiresAt <= startedAt || manifest.files.length !== 1) throw new Error('Manifiesto inválido o caducado.')
    const descriptor = manifest.files[0]!
    if (descriptor.path !== `platform/${rid}/backups/${claimed}/snapshot.enc`) throw new Error('Ruta de copia ajena.')
    const bytes = (await bucket().file(descriptor.path).download())[0]
    const raw = decode(JSON.parse(decrypt(bytes,descriptor.path).toString())) as Snapshot
    if (raw.version !== 1 || raw.restaurantId !== rid || !Array.isArray(raw.rows) || !Array.isArray(raw.files)) throw new Error('Esquema inválido.')
    checks.hashes = core.checkBackupFiles(manifest,[{ path:descriptor.path,sha256:digest(bytes),bytes:bytes.length,records:raw.rows.length }]) && raw.files.every(f => digest(Buffer.from(f.data,'base64')) === f.sha256)
    checks.tenantIsolation = raw.rows.every(r => tenantAllowed(r,rid)) && new Set(raw.rows.map(r => r.path)).size === raw.rows.length && raw.files.every(f => f.path.startsWith(`restaurants/${rid}/`) || f.path.startsWith(`platform/${rid}/exports/`))
    if (!validRelations(raw.rows)) throw new Error('Hay referencias operativas o de caja sin resolver.')
    if (!checks.hashes || !checks.tenantIsolation) throw new Error('Integridad o aislamiento inválidos.')
    checks.fiscalChains = validFiscal(raw.rows)
    if (!checks.fiscalChains) throw new Error('La cadena o los totales fiscales no coinciden.')
    const tombstones = (await root.collection('privacyTombstones').get()).docs
    // Usa el inventario exacto del snapshot, nunca coincidencias de nombre.
    const { inventory } = await import('../fase6-privacy/inventory')
    const erased = new Map<string,string>(), expiredJobs = new Set<string>()
    for (const t of tombstones) {
      if (t.get('state') !== 'completed') throw new Error('Hay un borrado en curso. No se expone la restauración.')
      for (const customer of raw.rows.filter(r => collectionOf(r) === 'customers' && digest(`${rid}:${idOf(r)}`) === t.id)) {
        const inv = inventory(raw.rows,rid,idOf(customer))
        if (inv.ambiguous.length) throw new Error('Tombstone con relaciones ambiguas.')
        for (const row of inv.rows) if (!isRestricted(row)) { erased.set(row.path,t.id); if (collectionOf(row) === 'privacyJobs') expiredJobs.add(idOf(row)) }
      }
    }
    const outboxes:{ path:string;disposition:string }[] = []
    await target.recursiveDelete(target.doc(isolatedPath))
    await bucket().deleteFiles({ prefix:targetPrefix })
    let written = 0
    for (const row of raw.rows) {
      let data:DocumentData = row.data
      if (erased.has(row.path)) data = redactedData(row,erased.get(row.path)!)
      if (['privacyJobs'].includes(collectionOf(row))) data = { ...data,status:'blocked',artifactPath:null,planPath:null,error:'Restauración aislada. Revisar identidad y datos actuales antes de procesar.',leaseUntil:null }
      if (collectionOf(row) === 'apiKeys') data = { ...data,revokedAt:Timestamp.now(),restoreQuarantine:true }
      // Sin secreto de firma no puede salir ningún evento: el destino queda suspendido hasta rotarlo.
      if (collectionOf(row) === 'webhookEndpoints') data = { ...data,status:data.status === 'revoked' ? 'revoked' : 'suspended',restoreQuarantine:true }
      if (['tableTokens','takeawaySecrets'].includes(collectionOf(row))) data = { ...redactedData(row,digest(`restore:${row.path}`)),outboundDisabled:true }
      const effect = effects[collectionOf(row)]
      if (effect) {
        const confirmed = ['sent','captured','delivered','succeeded','accepted','printed','cancelled'].includes(data.status)
        const disposition = core.restoredOutboxDisposition(effect,confirmed)
        outboxes.push({ path:row.path,disposition })
        // Prefijo privado sin triggers y estado imposible de reclamar por los emisores.
        data = { ...data,preRestoreStatus:data.status,status:'restore_quarantine',outboundDisabled:true,restoreDisposition:disposition,leaseUntil:null }
      }
      await targetDoc(row.path).set(data); written++
    }
    for (const file of raw.files) {
      // Las exportaciones antiguas jamás se vuelven a publicar.
      if (file.path.startsWith(`platform/${rid}/exports/`)) continue
      await bucket().file(`${targetPrefix}${file.path}`).save(Buffer.from(file.data,'base64'),{ resumable:false })
    }
    for (const t of tombstones) await targetDoc(`${root.path}/privacyTombstones/${t.id}`).set(t.data())
    await ref.update({ status:'validating',...metadata() })
    const restored = await target.getAll(...raw.rows.map(r => targetDoc(r.path)))
    checks.counts = written === raw.rows.length && restored.every(d => d.exists) && (await bucket().getFiles({ prefix:targetPrefix }))[0].length === raw.files.filter(f => !f.path.startsWith(`platform/${rid}/exports/`)).length
    checks.outboxes = outboxes.every(o => restored.find(d => d.ref.path === `${isolatedPath}/${o.path}`)?.get('status') === 'restore_quarantine')
    checks.privacyTombstones = [...erased.keys()].every(path => restored.find(d => d.ref.path === `${isolatedPath}/${path}`)?.get('privacyRedacted') === true)
    const completedAt = Date.now(); measuredRpoMs = Math.max(0,startedAt-manifest.snapshotAt)
    const drill:core.RestoreDrill = { restaurantId:rid,backupId:claimed,status:'passed',startedAt,completedAt,isolatedTarget:isolatedPath,outboundDisabled:true,checks,measuredRpoMs,measuredRtoMs:completedAt-startedAt,error:null }
    if (!core.restoreDrillPasses(drill,objectives)) throw new Error('No se han superado todos los controles u objetivos provisionales.')
    await ref.set({ ...core.restoreDrillForWrite(drill,Timestamp.fromMillis),leaseUntil:null,outboxReview:outboxes,skippedExports:raw.files.filter(f => f.path.startsWith(`platform/${rid}/exports/`)).length,discardedExportJobs:[...expiredJobs],...metadata() },{ merge:true })
    await db.runTransaction(async tx => audit(tx,rid,drillId,'backup.drillPassed',null))
  } catch (error) {
    await ref.update({ status:'failed',checks,completedAt:Timestamp.now(),measuredRpoMs,measuredRtoMs:Date.now()-startedAt,error:error instanceof Error ? error.message.slice(0,250) : 'Simulacro fallido.',leaseUntil:null,...metadata() })
  }
}
export async function runContinuity(rid:string,now = Date.now()) {
  localOnly()
  const root = rootOf(rid), backups = await root.collection('backups').get(), drills = await root.collection('restoreDrills').get()
  for (const row of backups.docs) {
    if (row.get('status') === 'running') await processBackup(rid,row.id)
    if (row.get('status') !== 'running' && core.TimestampSchema.parse(row.get('expiresAt')) <= now) {
      for (const f of row.get('files') ?? []) await bucket().file(f.path).delete({ ignoreNotFound:true })
      await row.ref.update({ status:'expired',...metadata() })
    }
  }
  const verified = (await root.collection('backups').get()).docs.filter(d => d.get('status') === 'verified').sort((a,b) => core.TimestampSchema.parse(b.get('snapshotAt'))-core.TimestampSchema.parse(a.get('snapshotAt')))
  if (!verified.length || now-core.TimestampSchema.parse(verified[0]!.get('snapshotAt')) >= objectives.rpoMs) {
    const id = digest(`daily:${rid}:${Math.floor(now/86_400_000)}`)
    if (!(await root.collection('backups').doc(id).get()).exists) {
      const manifest:core.BackupManifest = { restaurantId:rid,schemaVersion:1,snapshotAt:now,status:'running',files:[],encrypted:true,keyVersion:'v1',expiresAt:now+30*86_400_000 }
      await root.collection('backups').doc(id).set({ ...core.backupManifestForWrite(manifest,Timestamp.fromMillis),...metadata() })
      await processBackup(rid,id)
    }
  }
  const latest = (await root.collection('backups').get()).docs.filter(d => d.get('status') === 'verified').sort((a,b) => core.TimestampSchema.parse(b.get('snapshotAt'))-core.TimestampSchema.parse(a.get('snapshotAt')))[0]
  const last = Math.max(...drills.docs.filter(d => d.get('status') === 'passed').map(d => core.TimestampSchema.parse(d.get('completedAt'))),0)
  if (latest && core.restoreDrillDue(last || null,now)) {
    const id = digest(`monthly:${rid}:${Math.floor(now/(30*86_400_000))}`), ref = root.collection('restoreDrills').doc(id)
    if (!(await ref.get()).exists) await ref.set({ ...core.restoreDrillForWrite(initialDrill(rid,latest.id,now),Timestamp.fromMillis),...metadata() })
  }
  for (const d of (await root.collection('restoreDrills').get()).docs) if (['requested','restoring','validating'].includes(d.get('status'))) await processDrill(rid,d.id)
  await root.collection('backupHealth').doc('worker').set({ lastRunAt:Timestamp.fromMillis(now),objectives,...metadata() })
}
export function initialDrill(rid:string,backupId:string,now:number):core.RestoreDrill {
  return { restaurantId:rid,backupId,status:'requested',startedAt:now,completedAt:null,isolatedTarget:'pending-isolated-demo-database',outboundDisabled:true,checks:{ hashes:false,counts:false,fiscalChains:false,tenantIsolation:false,privacyTombstones:false,outboxes:false },measuredRpoMs:null,measuredRtoMs:null,error:null }
}
