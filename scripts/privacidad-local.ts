/** Trabajador explícito y registro humano de evidencia en los emuladores de la fila 1. */
import { Timestamp } from 'firebase-admin/firestore'
import { db } from '../functions/src/shared'
import { processPrivacyJobs,runRetention } from '../functions/src/fase6-privacy/worker'
import { localOnly,metadata,rootOf } from '../functions/src/fase6-privacy/infra'
import { can,MemberSchema,DocIdSchema } from '../packages/core/src/index'
async function main() {
localOnly()
const [action,ridArg,cid,id,uid,method] = process.argv.slice(2), rid = DocIdSchema.parse(ridArg ?? 'demo-lumbre')
try {
  if (action === 'todo') { const { privacyMaintenanceWork } = await import('../functions/src/fase6-privacy/process'); await privacyMaintenanceWork();console.log('Mantenimiento de privacidad terminado.') }
  else if (action === 'evidencia') {
    if (!cid || !id || !uid || !['in_person','verified_channel'].includes(method ?? '')) throw new Error('Uso: evidencia restaurante cliente evidencia uid in_person|verified_channel. Solo tras comprobar a la persona por ese canal.')
    const actor = MemberSchema.parse((await rootOf(rid).collection('members').doc(uid).get()).data())
    if (!actor.active || actor.locationIds.length || !can(actor.role,'privacidad.gestionar')) throw new Error('Actor no autorizado')
    await rootOf(rid).collection('privacyEvidence').doc(DocIdSchema.parse(id)).create({ customerId:DocIdSchema.parse(cid),method,verified:true,recordedBy:uid,expiresAt:Timestamp.fromMillis(Date.now()+86_400_000),createdAt:Timestamp.now(),...metadata(uid) })
    console.log('Atestación humana registrada. No acredita por sí sola la identidad ni el consentimiento.')
  } else if (action === 'retencion') console.log(await runRetention(rid))
  else console.log(await processPrivacyJobs(rid))
} finally { await db.terminate() }

}
main().catch(error => { console.error(error);process.exitCode=1 })
