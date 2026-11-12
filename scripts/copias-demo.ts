/** Evidencia cronometrada de un restaurante con cola pendiente y otro inquilino intacto. */
import { writeFileSync } from 'node:fs'
import { Timestamp } from 'firebase-admin/firestore'
import * as core from '../packages/core/src/index'
import { db } from '../functions/src/shared'
import { rootOf,localOnly,metadata } from '../functions/src/fase6-privacy/infra'
import { runContinuity } from '../functions/src/fase6-backup/worker'
async function main() {
  localOnly()
  const root = rootOf('demo-lumbre'),other = rootOf('demo-aislamiento-copias')
  try {
    // Documento de restaurante válido: los disparadores del emulador lo procesan como uno real.
    await other.set({ ...(await root.get()).data(),name:'Aislamiento copias',slug:'demo-aislamiento-copias',sentinel:'Se conserva sin cambios',totalCents:4321 })
    const before = JSON.stringify((await other.get()).data())
    await root.collection('messages').doc('demo-copia-pendiente').set({ ...core.messageForWrite(core.queuedMessage({ channel:'email',to:'restauracion@ejemplo.test',template:'confirmation',language:'es',data:{ guestName:'Demo de restauración' },reservationId:null,waitlistId:null,sendAt:Date.now()+86400000 }),Timestamp.fromMillis),...metadata('logiqd-equipo') })
    await runContinuity('demo-lumbre')
    const backups = (await root.collection('backups').get()).docs,drills = (await root.collection('restoreDrills').get()).docs
    const latest = drills.filter(d => d.get('status') === 'passed').sort((a,b) => b.get('completedAt').toMillis()-a.get('completedAt').toMillis())[0]
    if (!latest) throw new Error(`No hay simulacro superado: ${JSON.stringify(drills.map(d => ({ status:d.get('status'),error:d.get('error') })))}`)
    const drill = core.RestoreDrillSchema.parse(latest.data()), manifest = core.BackupManifestSchema.parse(backups.find(b => b.id === drill.backupId)!.data())
    const restored = await db.doc(`${drill.isolatedTarget}/${root.path}/messages/demo-copia-pendiente`).get()
    if (restored.get('status') !== 'restore_quarantine' || (await root.collection('messages').doc('demo-copia-pendiente').get()).get('status') !== 'queued' || before !== JSON.stringify((await other.get()).data())) throw new Error('La cuarentena o el aislamiento no coinciden.')
    const report = { at:new Date().toISOString(),restaurantId:'demo-lumbre',status:drill.status,checks:drill.checks,records:manifest.files.reduce((n,f) => n+f.records,0),encryptedBytes:manifest.files.reduce((n,f) => n+f.bytes,0),measuredRpoMs:drill.measuredRpoMs,measuredRtoMs:drill.measuredRtoMs,outboundDisabled:true,sourceQueueUnchanged:true,restoredMessageStatus:restored.get('status'),otherTenantUnchanged:true,scope:'Simulacro local aislado. No habilita caja ni demuestra conciliación de proveedores reales.' }
    writeFileSync('docs/operacion/plataforma/simulacro-local.json',JSON.stringify(report,null,2)+'\n');console.log(report)
  } finally { await db.terminate() }
}
main().catch(error => { console.error(error);process.exitCode=1 })
