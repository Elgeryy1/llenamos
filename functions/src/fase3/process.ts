import { randomUUID } from 'node:crypto'
import { Timestamp } from 'firebase-admin/firestore'
import * as core from '@llenamos/core'
import { db } from '../shared'
import { localOnly } from './context'

/** Remisión explícita local, por cadena y con lease. El proveedor de prueba no hace red. */
export async function processFiscalOutbox(restaurantId: string, provider: core.FiscalProvider = core.createTestFiscalProvider(), now = Date.now()) {
  localOnly()
  const root = db.doc(`restaurants/${restaurantId}`), chains = await root.collection('fiscalChains').get()
  let processed = 0
  for (const chainDoc of chains.docs) {
    const claim = randomUUID()
    const job = await db.runTransaction(async tx => {
      const chain = await tx.get(chainDoc.ref)
      if (Number(chain.get('sendLeaseUntil')?.toMillis?.() ?? 0) > now) return null
      const snapshot = await tx.get(root.collection('fiscalOutbox').where('chainId','==',chainDoc.id))
      const jobs = snapshot.docs.map(d => ({ doc:d,value:core.FiscalOutboxSchema.parse(d.data()) })).filter(({doc,value}) => !['accepted','accepted_with_errors','not_configured'].includes(value.status) && !doc.get('supersededByRecordId'))
      const records = await tx.get(root.collection('fiscalRecords').where('input.chainId','==',chainDoc.id).orderBy('input.chainSequence'))
      const next = records.docs.find(r => jobs.some(j => j.doc.id === r.id))
      const entry = jobs.find(j => j.doc.id === next?.id)
      if (!entry || entry.value.status === 'rejected' || entry.value.nextAttemptAt > now || (entry.value.leaseUntil ?? 0) > now) return null
      const parsed = records.docs.map(r => core.FiscalStoredRecordSchema.safeParse(r.data()))
      const stored = parsed.filter(r => r.success).map(r => r.data!)
      const last = stored.at(-1)
      const expected = last ? { ...core.fiscalIdentity(last.input),recordId:last.input.recordId,hash:last.hash,sequence:last.input.chainSequence } : null
      const parsedChain = core.FiscalChainSchema.safeParse(chain.data())
      if (!parsedChain.success || parsed.some(r => !r.success) || !core.verifyFiscalChain(stored) || JSON.stringify(parsedChain.data.head) !== JSON.stringify(expected)) {
        const incident = root.collection('fiscalIncidents').doc(`remision_${chainDoc.id}`)
        tx.set(incident,{ message:'La integridad de la cadena fiscal impide remitir el registro.',chainId:chainDoc.id,updatedBy:null,updatedAt:Timestamp.fromMillis(now) },{ merge:true })
        return null
      }
      if (!provider.regimes.includes(next!.get('regime')) || provider.id !== 'local_test') throw new Error('El procesador local solo admite el proveedor de prueba autorizado.')
      tx.update(chainDoc.ref,{ sendLeaseOwner:claim,sendLeaseUntil:Timestamp.fromMillis(now + 60_000),updatedBy:null,updatedAt:Timestamp.fromMillis(now) })
      tx.update(entry.doc.ref,{ leaseOwner:claim,leaseUntil:Timestamp.fromMillis(now + 60_000),attempts:entry.value.attempts + 1,updatedBy:null,updatedAt:Timestamp.fromMillis(now) })
      return { entry,record:next!.data() }
    })
    if (!job) continue
    const stored = core.FiscalStoredRecordSchema.parse(job.record)
    const artifact: core.FiscalArtifact = { record:stored,regime:job.record.regime,xml:stored.xml,qrUrl:job.record.qrUrl,legend:job.record.legend,warning:job.record.warning,validForTaxAuthority:false,ticketbai:job.record.ticketbai }
    let response: core.FiscalSubmission
    try { response = core.FiscalSubmissionSchema.parse(await provider.submit(artifact,stored.input.recordId)) }
    catch { response = { status:'retry',provider:provider.id,externalId:null,csv:null,errorCode:'timeout',message:'No se pudo confirmar el envío. Se conserva el mismo registro para reintentar.',retryAfterSeconds:60 } }
    await db.runTransaction(async tx => {
      const [chain,entry] = await Promise.all([tx.get(chainDoc.ref),tx.get(job.entry.doc.ref)])
      if (chain.get('sendLeaseOwner') !== claim || entry.get('leaseOwner') !== claim) return
      tx.create(root.collection('fiscalResponses').doc(`${stored.input.recordId}_${entry.get('attempts')}`),{ ...core.fiscalResponseForWrite({ recordId:stored.input.recordId,at:now,response },Timestamp.fromMillis),updatedBy:null,createdAt:Timestamp.fromMillis(now),updatedAt:Timestamp.fromMillis(now) })
      tx.update(job.entry.doc.ref,{ status:response.status,leaseOwner:null,leaseUntil:null,nextAttemptAt:Timestamp.fromMillis(now + (response.retryAfterSeconds ?? 60) * 1000),updatedBy:null,updatedAt:Timestamp.fromMillis(now) })
      tx.update(chainDoc.ref,{ sendLeaseOwner:null,sendLeaseUntil:null,updatedBy:null,updatedAt:Timestamp.fromMillis(now) })
      tx.create(root.collection('activity').doc(),{ action:'fiscal.submitted',summary:response.status === 'not_configured' ? 'Proveedor de prueba: no válido para Hacienda.' : 'Respuesta fiscal registrada.',actorUid:null,entity:{ type:'fiscalRecord',id:stored.input.recordId },createdAt:Timestamp.fromMillis(now),updatedAt:Timestamp.fromMillis(now) })
    })
    processed++
  }
  return { processed }
}
