import { randomBytes } from 'node:crypto'
import { FieldPath, Timestamp, type Transaction, type DocumentData } from 'firebase-admin/firestore'
import { HttpsError, onCall, onRequest, type CallableRequest } from '../identity-call'
import * as core from '@llenamos/core'
import { auth, db, options, parse, safe } from '../shared'
import { audit, authorize, collectionOf, cursorId, decrypt, digest, encrypt, key, localOnly, metadata, readPrivate, rootOf, signedCursor } from './infra'

const names = ['registrarConsentimiento','solicitarPrivacidad','verificarSolicitudPrivacidad','descargarExportacionPrivacidad','listarSolicitudesPrivacidad'] as const
export type Name = typeof names[number]
async function evidence(tx: Transaction, rid: string, id: string, cid: string) {
  const row = await tx.get(rootOf(rid).collection('privacyEvidence').doc(id))
  if (!row.exists || row.get('customerId') !== cid || row.get('verified') !== true || !['in_person','verified_channel'].includes(row.get('method')) || core.TimestampSchema.parse(row.get('expiresAt')) <= Date.now()) throw new HttpsError('failed-precondition','Falta una comprobación de identidad vigente para esta persona. Registra la evidencia por el procedimiento interno.')
}
export async function execute(name: Name, input: unknown, request: CallableRequest<unknown>): Promise<unknown> {
  localOnly(); key()
  const schema = core.CALLABLE_SCHEMAS_FASE6[name]
  const parsed = schema.input.safeParse(input)
  if (!parsed.success) throw new HttpsError('invalid-argument','Revisa los datos enviados.')
  const d = parsed.data as core.CallableParsedInput<Name>
  return db.runTransaction(async tx => {
    const uid = await authorize(tx,d.restaurantId,request), root = rootOf(d.restaurantId)
    if (!(await tx.get(root)).exists) throw new HttpsError('not-found','No se encuentra el restaurante.')
    if (name === 'listarSolicitudesPrivacidad') {
      const q = d as core.CallableParsedInput<'listarSolicitudesPrivacidad'>
      const after = cursorId(`${name}:${d.restaurantId}:${uid}`,q.cursor)
      let query = root.collection('privacyJobs').orderBy(FieldPath.documentId()).limit(q.limit + 1)
      if (after) query = query.startAfter(after)
      const docs = (await tx.get(query)).docs, page = docs.slice(0,q.limit)
      return { jobs:page.map(row => { const { artifactPath:_p,cursor:_c,...job } = core.PrivacyJobSchema.parse(row.data()); return { ...job,id:row.id } }),nextCursor:docs.length > q.limit ? signedCursor(`${name}:${d.restaurantId}:${uid}`,page.at(-1)!.id) : null }
    }
    if (name === 'descargarExportacionPrivacidad') {
      const q = d as core.CallableParsedInput<'descargarExportacionPrivacidad'>
      const ref = root.collection('privacyJobs').doc(q.jobId), snap = await tx.get(ref)
      if (!snap.exists) throw new HttpsError('not-found','No se encuentra la solicitud.')
      const job = core.PrivacyJobSchema.parse(snap.data()), now = Date.now()
      if (job.kind !== 'export' || job.status !== 'completed' || !job.artifactPath || !job.expiresAt || job.expiresAt <= now) throw new HttpsError('failed-precondition','La exportación aún no está lista o ha caducado.')
      const ticket = randomBytes(32).toString('base64url'), expiresAt = Math.min(now + 900_000,job.expiresAt)
      tx.create(root.collection('privacyDownloads').doc(digest(ticket)), { jobId:q.jobId,uid,expiresAt:Timestamp.fromMillis(expiresAt),used:false,...metadata(uid) })
      return { url:`${process.env.PRIVACY_DOWNLOAD_ORIGIN ?? 'http://127.0.0.1:5001'}/demo-llenamos/europe-west1/privacyDownload?restaurantId=${encodeURIComponent(d.restaurantId)}&ticket=${ticket}`,expiresAt }
    }
    const m = d as core.CallableParsedInput<'solicitarPrivacidad'>
    const scope = digest(core.canonicalJson([uid,d.restaurantId,name,m.requestId])), req = root.collection('privacyRequests').doc(scope), old = await tx.get(req)
    const fingerprint = digest(core.canonicalJson(d))
    if (old.exists) {
      if (old.get('privacyRedacted')) throw new HttpsError('failed-precondition','Esta respuesta fue suprimida. La operación no se volverá a ejecutar.')
      if (old.get('fingerprint') !== fingerprint) throw new HttpsError('already-exists','Esta petición ya se usó con otros datos.')
      return JSON.parse(decrypt(Buffer.from(old.get('response'),'base64'),scope).toString()) as unknown
    }
    let result: unknown
    if (name === 'solicitarPrivacidad') {
      const q = d as core.CallableParsedInput<'solicitarPrivacidad'>
      const customer = await tx.get(root.collection('customers').doc(q.customerId))
      if (!customer.exists) throw new HttpsError('not-found','No se encuentra la ficha de esta persona.')
      const job: core.PrivacyJob = { customerId:q.customerId,kind:q.kind,status:'requested',requestedBy:uid,verifiedBy:null,requestedAt:Date.now(),completedAt:null,artifactPath:null,expiresAt:null,cursor:null,processed:0,error:null }
      tx.create(root.collection('privacyJobs').doc(scope), { ...core.privacyJobForWrite(job,Timestamp.fromMillis),reason:q.reason,...metadata(uid) })
      result = { jobId:scope,job }
    } else if (name === 'verificarSolicitudPrivacidad') {
      const q = d as core.CallableParsedInput<'verificarSolicitudPrivacidad'>, ref = root.collection('privacyJobs').doc(q.jobId), snap = await tx.get(ref)
      if (!snap.exists) throw new HttpsError('not-found','No se encuentra la solicitud.')
      const job = core.PrivacyJobSchema.parse(snap.data())
      if (!['requested','blocked'].includes(job.status)) throw new HttpsError('failed-precondition','La solicitud ya está verificada o terminada.')
      await evidence(tx,d.restaurantId,q.evidenceId,job.customerId)
      tx.update(ref,{ status:'verified',verifiedBy:uid,evidenceId:q.evidenceId,error:null,...metadata(uid) })
      result = { ok:true }
    } else {
      const q = d as core.CallableParsedInput<'registrarConsentimiento'>
      await evidence(tx,d.restaurantId,q.evidenceId,q.customerId)
      if (!(await tx.get(root.collection('customers').doc(q.customerId))).exists) throw new HttpsError('not-found','No se encuentra el cliente.')
      const pending = q.status === 'withdrawn' ? await tx.get(root.collection('messages').where('customerId','==',q.customerId)) : null
      const consent:core.Consent = { customerId:q.customerId,purpose:q.purpose,status:q.status,policyVersion:q.policyVersion,at:Date.now(),source:'staff',evidenceId:q.evidenceId }
      tx.create(root.collection('consents').doc(scope), { ...core.consentForWrite(consent,Timestamp.fromMillis),...metadata(uid) })
      for (const msg of pending?.docs ?? []) if (msg.get('purpose') === q.purpose && msg.get('status') === 'queued') tx.update(msg.ref,{ status:'cancelled',...metadata(uid) })
      result = { consentId:scope }
    }
    const output = schema.output.parse(result)
    tx.create(req,{ customerId:'customerId' in d ? d.customerId : null,jobId:'jobId' in d ? d.jobId : null,fingerprint,response:encrypt(Buffer.from(JSON.stringify(output)),scope).toString('base64'),...metadata(uid) })
    audit(tx,d.restaurantId,scope,`privacy.${name}`,uid)
    return output
  })
}
const custodyOptions = { ...options, secrets:['PLATFORM_DATA_KEY_V1'] }
const callable = (name: Name) => onCall(custodyOptions,request => safe(() => execute(name,request.data,request)))
export const registrarConsentimiento = callable('registrarConsentimiento')
export const solicitarPrivacidad = callable('solicitarPrivacidad')
export const verificarSolicitudPrivacidad = callable('verificarSolicitudPrivacidad')
export const descargarExportacionPrivacidad = callable('descargarExportacionPrivacidad')
export const listarSolicitudesPrivacidad = callable('listarSolicitudesPrivacidad')

/** Ticket opaco, de un uso y 15 minutos como máximo. Nunca se emite un token público de Storage. */
export const privacyDownload = onRequest(custodyOptions,async (req,res) => {
  res.set('Cache-Control','no-store, private'); res.set('Referrer-Policy','no-referrer')
  try {
    localOnly()
    if (req.method !== 'GET') { res.sendStatus(405); return }
    const rid = core.DocIdSchema.parse(req.query.restaurantId), ticket = String(req.query.ticket ?? '')
    if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw new Error()
    const path = await db.runTransaction(async tx => {
      const root = rootOf(rid), ref = root.collection('privacyDownloads').doc(digest(ticket)), row = await tx.get(ref)
      if (!row.exists || row.get('used') || core.TimestampSchema.parse(row.get('expiresAt')) <= Date.now()) throw new Error()
      const account = await auth.getUser(row.get('uid'))
      if (account.disabled || account.customClaims?.logiqd === true) throw new Error()
      const member = await tx.get(root.collection('members').doc(row.get('uid'))), parsed = core.MemberSchema.parse(member.data())
      if (!parsed.active || parsed.locationIds.length || !core.can(parsed.role,'privacidad.gestionar')) throw new Error()
      const job = core.PrivacyJobSchema.parse((await tx.get(root.collection('privacyJobs').doc(row.get('jobId')))).data())
      if (job.status !== 'completed' || !job.artifactPath || !job.expiresAt || job.expiresAt <= Date.now()) throw new Error()
      tx.update(ref,{ used:true,...metadata(row.get('uid')) })
      return job.artifactPath
    })
    const bytes = await readPrivate(path)
    res.set('Content-Type','application/json; charset=utf-8'); res.set('Content-Disposition','attachment; filename="datos-personales.json"'); res.status(200).send(bytes)
  } catch { res.status(403).send('El enlace ha caducado, ya se usó o no está autorizado.') }
})

/** Integración requerida en los productores de marketing, al encolar y al enviar. */
export async function assertMarketingConsent(tx: Transaction, rid: string, cid: string, purpose: core.Consent['purpose']) {
  const events = (await tx.get(rootOf(rid).collection('consents').where('customerId','==',cid))).docs.map(d => core.ConsentSchema.parse(d.data()))
  if (!core.hasCurrentConsent(events,cid,purpose,Date.now())) throw new HttpsError('failed-precondition','No hay consentimiento vigente para este envío.')
}
export const isPrivacyRedacted = (data: DocumentData | undefined) => data?.privacyRedacted === true
export { processPrivacyJobs, runRetention } from './worker'
