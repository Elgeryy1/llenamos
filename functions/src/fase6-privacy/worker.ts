import { randomUUID } from 'node:crypto'
import { Timestamp } from 'firebase-admin/firestore'
import * as core from '@llenamos/core'
import { db } from '../shared'
import { audit, collectionOf, decode, deletePrivate, digest, encode, idOf, localOnly, metadata, readPrivate, readTree, readPersonalTree, rootOf, savePrivate, type Row } from './infra'
import { deleteCollections, exportInventory, inventory, isLive, isRestricted, millis, redactedData } from './inventory'

const PAGE_SIZE = 40
const msDay = 86_400_000
async function markBlocked(rid:string, jobId:string, message:string) {
  await rootOf(rid).collection('privacyJobs').doc(jobId).update({ status:'blocked',error:message,leaseUntil:null,...metadata() })
}
export async function processPrivacyJobs(rid:string, maxPages = 100) {
  localOnly()
  const root = rootOf(rid), docs = await root.collection('privacyJobs').get()
  let completed = 0, blocked = 0
  for (const snap of docs.docs) {
    if (!['verified','running','failed'].includes(snap.get('status'))) continue
    const owner = randomUUID(), jobId = snap.id
    const claim = await db.runTransaction(async tx => {
      const current = await tx.get(snap.ref)
      if (!['verified','running','failed'].includes(current.get('status')) || millis(current.get('leaseUntil')) > Date.now()) return false
      tx.update(snap.ref,{ status:'running',leaseOwner:owner,leaseUntil:Timestamp.fromMillis(Date.now()+120_000),...metadata() }); return true
    })
    if (!claim) continue
    try {
      let job = core.PrivacyJobSchema.parse((await snap.ref.get()).data())
      let planPath = (await snap.ref.get()).get('planPath') as string | undefined
      if (!planPath) {
        const rows = await db.runTransaction(tx => readPersonalTree(tx,rid),{ readOnly:true })
        const inv = inventory(rows,rid,job.customerId)
        if (inv.ambiguous.length || job.kind === 'erase' && inv.live.length) {
          await markBlocked(rid,jobId,inv.ambiguous.length ? 'Hay copias ambiguas o sin adaptador. Requieren revisión del inventario.' : 'Hay servicio o envíos en curso. Cierra o reconcilia la operación antes de reintentar.'); blocked++; continue
        }
        if (job.kind === 'export') {
          const path = `platform/${rid}/exports/${jobId}/datos.enc`, now = Date.now()
          await savePrivate(path,Buffer.from(JSON.stringify(encode(exportInventory(inv,now)))))
          await db.runTransaction(async tx => {
            const latest = await tx.get(snap.ref)
            if (latest.get('leaseOwner') !== owner) throw new Error('Lease perdido')
            tx.update(snap.ref,{ status:'completed',completedAt:Timestamp.now(),artifactPath:path,expiresAt:Timestamp.fromMillis(now+core.provisionalRetentionPolicy().exportHours*3_600_000),processed:inv.rows.length,leaseUntil:null,error:null,...metadata() })
            audit(tx,rid,jobId,'privacy.completed',job.verifiedBy)
            privacyEvent(tx,rid,jobId,now)
          })
          completed++; continue
        }
        planPath = `platform/${rid}/exports/${jobId}/plan.enc`
        // El plan cifrado mantiene enlaces aunque una página anterior ya haya sido suprimida.
        await savePrivate(planPath,Buffer.from(JSON.stringify(encode(inv.rows))))
        await db.runTransaction(async tx => {
          const latest = await tx.get(snap.ref)
          if (latest.get('leaseOwner') !== owner) throw new Error('Lease perdido')
          tx.update(snap.ref,{ planPath,...metadata() })
        })
      }
      const plan = decode(JSON.parse((await readPrivate(planPath)).toString())) as Row[]
      const tombstoneId = digest(`${rid}:${job.customerId}`)
      // Revoca primero las descargas previas y elimina sus artefactos antes de terminar el borrado.
      for (const prior of plan.filter(r => collectionOf(r) === 'privacyJobs' && idOf(r) !== jobId && typeof r.data.artifactPath === 'string')) {
        await db.doc(prior.path).update({ artifactPath:null,expiresAt:Timestamp.now(),...metadata() })
        await deletePrivate(prior.data.artifactPath)
      }
      for (let page = 0; page < maxPages; page++) {
        const result = await db.runTransaction(async tx => {
          const latest = await tx.get(snap.ref)
          if (latest.get('leaseOwner') !== owner) throw new Error('Lease perdido')
          job = core.PrivacyJobSchema.parse(latest.data())
          const rows = await readPersonalTree(tx,rid), actual = new Map(rows.map(r => [r.path,r]))
          const inv = inventory([...rows,...plan.filter(r => !actual.has(r.path))],rid,job.customerId)
          if (inv.ambiguous.length || inv.live.length || inv.rows.some(r => !plan.some(p => p.path === r.path) && !['privacyJobs','privacyRequests'].includes(collectionOf(r)))) {
            tx.update(snap.ref,{ status:'blocked',error:'El servicio o el inventario han cambiado. Revisa y vuelve a verificar la solicitud.',leaseUntil:null,...metadata() }); return 'blocked'
          }
          // Se conserva el destino remoto en la operación antes de eliminar el enlace.
          // La misma transacción y el id estable permiten retomar páginas sin duplicar el borrado.
          const card = plan.find(r => collectionOf(r) === 'repiteCards')
          const removeRef = root.collection('repiteOutbox').doc(core.repiteOperationId.remove(tombstoneId.slice(0,20)))
          const removal = card ? await tx.get(removeRef) : null
          if (card && !removal?.exists) {
            const operation: core.RepiteOperation = { kind:'remove_card',customerId:tombstoneId.slice(0,20),merchantId:card.data.merchantId,visitKey:null,trigger:null,occurredAt:Date.now(),status:'queued',attempts:0,nextAttemptAt:Date.now(),leaseUntil:null,lastError:null,result:{ cardId:card.data.cardId,merchantId:card.data.merchantId } }
            tx.create(removeRef,{ ...operation,occurredAt:Timestamp.now(),nextAttemptAt:Timestamp.now(),...metadata(job.verifiedBy) })
          }
          // El cursor recorre el orden del plan, también con ids que mezclan mayúsculas y minúsculas.
          const previousIndex = job.cursor ? plan.findIndex(r => r.path === job.cursor) : -1
          if (job.cursor && previousIndex < 0) throw new Error('El cursor no pertenece al plan de supresión.')
          const candidates = plan.slice(previousIndex+1,previousIndex+1+PAGE_SIZE)
          for (const planned of candidates) {
            const row = actual.get(planned.path)
            if (!row || collectionOf(row) === 'privacyJobs') continue
            if (isRestricted(row)) {
              if (collectionOf(row) === 'invoices') tx.set(db.doc(`${row.path.split('/invoices/')[0]}/privacyRestrictedInvoices/${idOf(row)}`),{ reason:'Conservación fiscal restringida tras supresión',tombstoneId,...metadata(job.verifiedBy) })
              continue
            }
            if (isLive(row)) throw new Error('Servicio vivo')
            const ref = db.doc(row.path)
            if (deleteCollections.has(collectionOf(row))) tx.delete(ref)
            else {
              tx.set(ref,{ ...redactedData(row,tombstoneId),...metadata(job.verifiedBy) })
              if (collectionOf(row) === 'activity') audit(tx,rid,`redact:${jobId}:${row.path}`,'privacy.activityRedacted',job.verifiedBy)
            }
          }
          const last = candidates.at(-1)?.path ?? job.cursor, done = candidates.length < PAGE_SIZE
          const customer = plan.find(r => collectionOf(r) === 'customers')
          tx.set(root.collection('privacyTombstones').doc(tombstoneId),{ customerHash:digest(`${rid}:${job.customerId}`),identityHashes:[customer?.data.phone,customer?.data.email].filter((x):x is string => typeof x === 'string' && !!x).map(x => digest(`${rid}:${x.trim().toLowerCase()}`)),at:Timestamp.now(),state:done ? 'completed' : 'running',...metadata(job.verifiedBy) },{ merge:true })
          tx.update(snap.ref,{ cursor:last,processed:job.processed+candidates.length,status:done ? 'completed' : 'running',completedAt:done ? Timestamp.now() : null,leaseUntil:done ? null : Timestamp.fromMillis(Date.now()+120_000),error:null,restricted:plan.filter(r => isRestricted(r)).length,...metadata(job.verifiedBy) })
          if (done) { audit(tx,rid,jobId,'privacy.completed',job.verifiedBy); privacyEvent(tx,rid,jobId,Date.now()) }
          return done ? 'completed' : 'running'
        })
        if (result === 'completed') { await deletePrivate(planPath); await snap.ref.update({ planPath:null }); completed++; break }
        if (result === 'blocked') { blocked++; break }
      }
      // Otra invocación puede retomar el checkpoint sin esperar el vencimiento del lease.
      await db.runTransaction(async tx => { const current = await tx.get(snap.ref); if (current.get('leaseOwner') === owner) tx.update(snap.ref,{ leaseUntil:null,...metadata() }) })
    } catch (error) {
      console.error('Trabajo de privacidad fallido',error instanceof Error ? error.name : 'Error')
      await db.runTransaction(async tx => {
        const current = await tx.get(snap.ref)
        if (current.get('leaseOwner') === owner) tx.update(snap.ref,{ status:'failed',error:'No se ha completado el trabajo. Revisa el registro técnico local y reintenta el mismo identificador.',leaseUntil:null,...metadata() })
      })
    }
  }
  const state = { lastRunAt:Timestamp.now(),completed,blocked,...metadata() }
  await root.collection('privacyHealth').doc('worker').set(state)
  return { completed,blocked }
}
function privacyEvent(tx: FirebaseFirestore.Transaction,rid:string,jobId:string,at:number) {
  const id = digest(`privacy.completed:${rid}:${jobId}`)
  // Evento mínimo transaccional; el coordinador conecta el fanout de la fila API.
  tx.set(rootOf(rid).collection('platformEvents').doc(id),{ id,type:'privacy.completed',version:1,restaurantId:rid,locationId:null,occurredAt:Timestamp.fromMillis(at),data:{ entityId:jobId,status:'completed' },...metadata() })
}

/** Política técnica provisional. No purga fiscal, retenciones justificadas ni servicio vivo. */
export async function runRetention(rid:string, now = Date.now()) {
  localOnly()
  const root = rootOf(rid), configuration = await root.collection('platform').doc('retention').get()
  const policy = configuration.exists ? core.RetentionPolicySchema.parse(configuration.data()) : core.provisionalRetentionPolicy()
  let messages = 0, customers = 0, artifacts = 0
  const docs = await root.collection('messages').get()
  for (const row of docs.docs) await db.runTransaction(async tx => {
    const current = await tx.get(row.ref), d = current.data()
    if (!d || d.legalHold || isLive({ path:row.ref.path,data:d }) || !['sent','captured','failed','cancelled','not_configured'].includes(d.status)) return
    const at = millis(d.updatedAt ?? d.createdAt)
    if (!at || now < at + policy.messageDays*msDay) return
    tx.set(row.ref,{ ...redactedData({ path:row.ref.path,data:d },digest(`retention:${rid}:${row.id}`)),...metadata() }); messages++
  })
  // La caducidad de contactos y alergias usa el mismo borrado integral, no solo la ficha.
  const rows = await db.runTransaction(tx => readPersonalTree(tx,rid),{ readOnly:true })
  for (const row of rows.filter(r => collectionOf(r) === 'customers')) {
    const inv = inventory(rows,rid,idOf(row)), last = Math.max(...inv.rows.filter(r => ['customers','reservations','tableSessions','takeaways','orders','orderLines','floorTasks','messages','payments'].includes(collectionOf(r))).map(r => millis(r.data.updatedAt ?? r.data.createdAt ?? r.data.startAt)),0)
    if (!last || now < last+policy.operationalDays*msDay || inv.live.length || inv.ambiguous.length || row.data.legalHold) continue
    const id = digest(`retention:${rid}:${idOf(row)}:${last}`), ref = root.collection('privacyJobs').doc(id)
    await db.runTransaction(async tx => {
      if ((await tx.get(ref)).exists) return
      const job:core.PrivacyJob = { customerId:idOf(row),kind:'erase',status:'verified',requestedBy:'retention-worker',verifiedBy:'retention-worker',requestedAt:now,completedAt:null,artifactPath:null,expiresAt:null,cursor:null,processed:0,error:null }
      tx.create(ref,{ ...core.privacyJobForWrite(job,Timestamp.fromMillis),source:'retention',policy,...metadata() })
    }); customers++
  }
  const jobs = await root.collection('privacyJobs').get()
  for (const job of jobs.docs) {
    if (job.get('artifactPath') && millis(job.get('expiresAt')) <= now) {
      await deletePrivate(job.get('artifactPath')); await job.ref.update({ artifactPath:null,...metadata() }); artifacts++
    }
    if (['completed','blocked'].includes(job.get('status')) && job.get('planPath') && millis(job.get('updatedAt')) + policy.exportHours*3_600_000 <= now) {
      await deletePrivate(job.get('planPath')); await job.ref.update({ planPath:null,cursor:null,processed:0,...metadata() })
    }
  }
  await root.collection('privacyHealth').doc('retention').set({ lastRunAt:Timestamp.fromMillis(now),policy,messages,customers,artifacts,...metadata() })
  return { messages,customers,artifacts,policy }
}
