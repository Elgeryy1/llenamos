import { randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { onRequest } from 'firebase-functions/v2/https'
import * as core from '@llenamos/core'
import { db, options } from '../../shared'
import { type Ctx, type Input, fail, repiteSettings, raw, ts, context } from '../context'
import { adapter, repiteConfigured } from './http'

export async function vincularRepite(c: Ctx, d: Input<'vincularRepite'>) {
  const old = await repiteSettings(c)
  const cards = await c.list('repiteCards',core.RepiteCardLinkSchema)
  if (old.merchantId !== d.merchantId && cards.some(x => x.status === 'active')) fail('Retira las tarjetas actuales antes de cambiar de comercio.')
  c.stage('settings/repite',{ ...old,merchantId:d.merchantId })
  c.audit('repite.linked','Conexión de Repite cambiada',{ reason:d.reason })
  return { ok:true }
}
export async function guardarAjustesRepite(c: Ctx, d: Input<'guardarAjustesRepite'>) {
  const old = await repiteSettings(c)
  c.stage('settings/repite',{ ...d.settings,merchantId:old.merchantId }); return { ok:true,connected:!!old.merchantId && repiteConfigured() }
}
export function operation(c: Ctx, id: string, customerId: string, merchantId: string, kind: core.RepiteOperation['kind'], visitKey: string | null = null, trigger: core.RepiteOperation['trigger'] = null) {
  const value: core.RepiteOperation = { kind,customerId,merchantId,visitKey,trigger,occurredAt:c.now,status:'queued',attempts:0,nextAttemptAt:c.now,leaseUntil:null,lastError:null,result:null }
  c.stage(`repiteOutbox/${id}`,{ ...value,occurredAt:ts(c.now),nextAttemptAt:ts(c.now) },'create')
}
export async function crearTarjetaRepite(c: Ctx, d: Input<'crearTarjetaRepite'>) {
  const settings = await repiteSettings(c)
  if (!settings.enabled || !settings.merchantId || !repiteConfigured()) return { status:'not_configured',message:'Repite no está conectado en este restaurante.' }
  const customer = await c.get(`customers/${d.customerId}`,raw)
  if (customer.privacyRedacted === true || (await c.tx.get(c.ref(`privacyTombstones/${core.sha256Hex(`${c.rid}:${d.customerId}`)}`))).exists) fail('Los datos del cliente se han suprimido.')
  const link = await c.maybe(`repiteCards/${d.customerId}`,core.RepiteCardLinkSchema)
  if (link?.status === 'active') {
    const created = await c.maybe(`repiteOutbox/${core.repiteOperationId.card(d.customerId)}`,core.RepiteOperationSchema)
    return { status:'ready',cardId:link.cardId,saveUrl:typeof created?.result?.saveUrl === 'string' ? created.result.saveUrl : null }
  }
  const id = core.repiteOperationId.card(d.customerId)
  if (!(await c.tx.get(c.ref(`repiteOutbox/${id}`))).exists) operation(c,id,d.customerId,settings.merchantId,'create_card')
  return { status:'queued' }
}
export async function verTarjetaRepite(c: Ctx, d: Input<'verTarjetaRepite'>) {
  const settings = await repiteSettings(c)
  if (!settings.enabled || !settings.merchantId) return { status:'not_configured',message:'Repite no está conectado en este restaurante.' }
  const link = await c.maybe(`repiteCards/${d.customerId}`,core.RepiteCardLinkSchema)
  if (!link || link.status !== 'active') return { status:'no_card' }
  const result = await adapter().getCard(link)
  return result.ok ? { status:'ready',card:result.value,fetchedAt:c.now } : { status:result.error.code,message:result.error.message }
}
export async function darSelloRepite(c: Ctx, d: Input<'darSelloRepite'>) {
  // La visita y su cliente se comprueban: el personal no puede sellar una referencia inventada.
  const p = `locations/${c.lid}`
  const visit = await c.get(`${p}/${d.reservationId ? 'reservations' : 'tableSessions'}/${d.reservationId ?? d.sessionId}`,raw)
  if (visit.customerId !== d.customerId) fail('La visita no corresponde a este cliente.')
  const key = core.repiteVisitKey({ restaurantId:c.rid,reservationId:d.reservationId,sessionId:d.sessionId })
  return queueStamp(c,d.customerId,key,'manual',true)
}
export async function queueStamp(c: Ctx, customerId: string, key: string, trigger: 'seated' | 'paid' | 'manual', retry = false) {
  const settings = await repiteSettings(c), id = core.repiteOperationId.stamp(key)
  if (!settings.enabled || !settings.merchantId) return { operationId:id,status:'not_configured' }
  const old = await c.maybe(`repiteOutbox/${id}`,core.RepiteOperationSchema)
  if (old) {
    if (retry && ['failed','not_configured','skipped'].includes(old.status)) c.stage(`repiteOutbox/${id}`,{ status:'queued',nextAttemptAt:ts(c.now),leaseUntil:null },'update')
    return { operationId:id,status:retry && ['failed','not_configured','skipped'].includes(old.status) ? 'queued' : ['done','duplicate','not_configured','failed'].includes(old.status) ? old.status : 'queued' }
  }
  operation(c,id,customerId,settings.merchantId,'add_stamp',key,trigger)
  return { operationId:id,status:'queued' }
}
export async function avisarTeEchamosDeMenos(c: Ctx, d: Input<'avisarTeEchamosDeMenos'>) {
  const settings = await repiteSettings(c); if (!settings.enabled || !settings.merchantId) fail('Repite no está conectado.')
  const consents = await c.list('consents',core.ConsentSchema)
  let queued = 0
  const skipped: { customerId:string;reason:string }[] = []
  for (const customerId of d.customerIds) {
    const card = await c.maybe(`repiteCards/${customerId}`,core.RepiteCardLinkSchema)
    const id = core.repiteOperationId.weMissYou(customerId,core.horaLocal(c.now,c.tz).fecha)
    if (consents.some(e => e.purpose !== 'digital_receipt' && e.customerId === customerId && e.status === 'withdrawn' && !core.hasCurrentConsent(consents,customerId,e.purpose,c.now))) { skipped.push({ customerId,reason:'withdrawn' }); continue }
    if (!card || card.status !== 'active') { skipped.push({ customerId,reason:'no_card' }); continue }
    if ((await c.tx.get(c.ref(`repiteOutbox/${id}`))).exists) { skipped.push({ customerId,reason:'already_today' }); continue }
    operation(c,id,customerId,settings.merchantId,'we_miss_you'); queued++
  }
  return { queued,skipped }
}
export async function informeRepite(c: Ctx, d: Input<'informeRepite'>) {
  const settings = await repiteSettings(c)
  if (!settings.enabled || !settings.merchantId) return { status:'not_configured',message:'Repite no está conectado.' }
  const result = await adapter().monthReport({ merchantId:settings.merchantId,month:d.month })
  return result.ok ? { status:'ready',...result.value } : { status:result.error.code,message:result.error.message }
}

/** Claim y finalización con dueño de lease: ningún envío externo está dentro de una transacción. */
export async function processRepite(rid: string, now = Date.now(), provider: core.RepiteAdapter = adapter()) {
  const root = db.doc(`restaurants/${rid}`), rows = await root.collection('repiteOutbox').where('status','in',['queued','leased']).get()
  let processed = 0
  for (const row of rows.docs) {
    const owner = randomUUID()
    const claim = await db.runTransaction(async tx => {
      const c = await context(tx,rid,null,undefined,undefined,now)
      const settings = await repiteSettings(c), snap = await tx.get(row.ref), op = core.RepiteOperationSchema.parse(snap.data())
      if (op.kind !== 'remove_card' && (!core.hasModule(c.restaurant,'repite') || !settings.enabled || settings.merchantId !== op.merchantId)) return null
      if (!['queued','leased'].includes(op.status) || (op.nextAttemptAt !== null && op.nextAttemptAt > now) || (op.leaseUntil !== null && op.leaseUntil > now)) return null
      const link = await c.maybe(`repiteCards/${op.customerId}`,core.RepiteCardLinkSchema)
      const customer = await c.maybe(`customers/${op.customerId}`,raw)
      const tombstone = await tx.get(c.ref(`privacyTombstones/${core.sha256Hex(`${rid}:${op.customerId}`)}`))
      if (op.kind !== 'remove_card' && (!customer || customer.privacyRedacted === true || tombstone.exists)) { c.stage(`repiteOutbox/${row.id}`,{ status:'skipped',leaseUntil:null },'update'); c.flush(); return null }
      if (op.kind === 'we_miss_you') {
        const consents = await c.list('consents',core.ConsentSchema)
        if (consents.some(e => e.purpose !== 'digital_receipt' && e.customerId === op.customerId && e.status === 'withdrawn' && !core.hasCurrentConsent(consents,op.customerId,e.purpose,now))) { c.stage(`repiteOutbox/${row.id}`,{ status:'skipped' },'update'); c.flush(); return null }
      }
      if (!link && op.kind !== 'create_card' && op.kind !== 'remove_card' && !settings.autoCreateCard) { c.stage(`repiteOutbox/${row.id}`,{ status:'skipped' },'update'); c.flush(); return null }
      // La referencia opaca se persiste antes de llamar a Repite y sobrevive a fallos de red.
      const cardOperationId = core.repiteOperationId.card(op.customerId)
      const cardOperation = await tx.get(c.ref(`repiteOutbox/${cardOperationId}`))
      const externalRef = String(cardOperation.get('externalRef') ?? snap.get('externalRef') ?? randomBytes(24).toString('base64url'))
      if (!link && op.kind === 'add_stamp' && !cardOperation.exists) {
        operation(c,cardOperationId,op.customerId,op.merchantId,'create_card')
        c.stage(`repiteOutbox/${cardOperationId}`,{ externalRef },'update')
      } else if (!link && cardOperation.exists) c.stage(`repiteOutbox/${cardOperationId}`,{ externalRef },'update')
      c.stage(`repiteOutbox/${row.id}`,{ status:'leased',leaseUntil:ts(now+60000),leaseOwner:owner,externalRef },'update'); c.flush()
      return { op,link,externalRef,displayName:String(customer?.name ?? 'Cliente').split(' ')[0]!,language:core.LanguageSchema.catch('es').parse(customer?.language) }
    })
    if (!claim) continue
    let link = claim.link, result: core.RepiteResult<unknown>
    if (claim.op.kind === 'create_card' || !link && claim.op.kind === 'add_stamp') {
      const card = await provider.createCard({ merchantId:claim.op.merchantId,externalRef:claim.externalRef,displayName:claim.displayName,language:claim.language,idempotencyKey:`${rid}.${core.repiteOperationId.card(claim.op.customerId)}` })
      if (card.ok) link = { merchantId:claim.op.merchantId,cardId:card.value.cardId,externalRef:claim.externalRef,status:'active',createdAt:now }
      result = card
    } else result = { ok:true,value:{} }
    if (result.ok && claim.op.kind !== 'create_card') {
      const p = { merchantId:claim.op.merchantId,cardId:link?.cardId ?? String(claim.op.result?.cardId ?? ''),idempotencyKey:row.id }
      if (claim.op.kind === 'add_stamp') result = await provider.addStamp({ ...p,visitKey:claim.op.visitKey!,trigger:claim.op.trigger!,occurredAt:claim.op.occurredAt })
      else if (claim.op.kind === 'we_miss_you') result = await provider.sendWeMissYou(p)
      else result = await provider.removeCard(p)
    }
    await db.runTransaction(async tx => {
      const c = await context(tx,rid,null,undefined,undefined,now), snap = await tx.get(row.ref)
      if (snap.get('leaseOwner') !== owner || snap.get('status') !== 'leased') return
      const customer = await tx.get(c.ref(`customers/${claim.op.customerId}`))
      const tombstone = await tx.get(c.ref(`privacyTombstones/${core.sha256Hex(`${rid}:${claim.op.customerId}`)}`))
      if (link && customer.exists && !customer.get('privacyRedacted') && !tombstone.exists && claim.op.kind !== 'remove_card') c.stage(`repiteCards/${claim.op.customerId}`,{ ...link,createdAt:ts(link.createdAt) })
      const settled = core.settleRepiteOperation(claim.op,result,now)
      const retryAfterMs = !result.ok ? Number((result.error as core.RepiteError & { retryAfterMs?:number }).retryAfterMs ?? 0) : 0
      const next = settled.nextAttemptAt === null ? null : Math.max(settled.nextAttemptAt,now+retryAfterMs)
      c.stage(`repiteOutbox/${row.id}`,{ ...settled,nextAttemptAt:ts(next),leaseUntil:null,leaseOwner:null,result:claim.op.kind === 'remove_card' && !result.ok ? claim.op.result : result.ok ? result.value as object : null },'update')
      c.audit('repite.processed','Operación de Repite procesada',{ operationId:row.id,status:core.settleRepiteOperation(claim.op,result,now).status }); c.flush()
    }); processed++
  }
  return processed
}

const merchants = (process.env.REPITE_LOCAL_MERCHANTS ?? 'demo-lumbre').split(',')
const localKeys = new Map<string,string>()
const local = core.createLocalRepite({ merchantIds:merchants,now:() => Date.now() })
/** Doble HTTP en el emulador de Functions. Nunca disponible fuera de demo. */
export const repiteLocal = onRequest(options,async (req,res) => {
  if (process.env.GCLOUD_PROJECT !== 'demo-llenamos' || !process.env.FIRESTORE_EMULATOR_HOST) { res.status(404).end(); return }
  const path = req.path.replace(/^\/api\/v1/,'').split('/').filter(Boolean)
  if (path[0] === 'health') { res.json({ ok:true,version:'doble-local' }); return }
  if (req.headers.authorization !== `Bearer ${process.env.REPITE_API_TOKEN ?? 'local'}`) { res.status(401).json({ error:{ code:'unauthorized' } }); return }
  const merchantId = path[1] ?? '', cardId = path[3] ?? '', idempotencyKey = String(req.headers['idempotency-key'] ?? '')
  try {
    const mutation = ['POST','DELETE'].includes(req.method)
    if (mutation && (!idempotencyKey || idempotencyKey.length > 200)) { res.status(400).json({error:{code:'invalid_request'}}); return }
    const key = `${merchantId}.${idempotencyKey}`, fingerprint = core.sha256Hex(JSON.stringify([req.method,req.path,req.body]))
    if (mutation && localKeys.has(key) && localKeys.get(key) !== fingerprint) { res.status(409).json({error:{code:'idempotency_conflict'}}); return }
    if (req.method === 'POST' && !cardId) req.body = z.strictObject({externalRef:z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),displayName:z.string().min(1).max(80),language:core.LanguageSchema}).parse(req.body)
    if (req.method === 'POST' && path[4] === 'stamps') req.body = z.strictObject({visitKey:z.string().min(1).max(200),trigger:z.enum(['seated','paid','manual']),occurredAt:z.number().int().min(0)}).parse(req.body)
    let r: core.RepiteResult<unknown>
    if (path[2] === 'reports') r = await local.adapter.monthReport({ merchantId,month:cardId })
    else if (path[2] !== 'cards') { res.status(404).end(); return }
    else if (!cardId && req.method === 'POST') r = await local.adapter.createCard({ ...req.body,merchantId,idempotencyKey:key })
    else if (path[4] === 'stamps' && req.method === 'POST') r = await local.adapter.addStamp({ ...req.body,merchantId,cardId,idempotencyKey:key })
    else if (path[4] === 'notices' && req.method === 'POST') r = await local.adapter.sendWeMissYou({ merchantId,cardId,idempotencyKey:key })
    else if (req.method === 'DELETE') r = await local.adapter.removeCard({ merchantId,cardId,idempotencyKey:key })
    else r = await local.adapter.getCard({ merchantId,cardId })
    if (r.ok && mutation) localKeys.set(key,fingerprint)
    res.status(r.ok ? 200 : r.error.code === 'unauthorized' ? 403 : r.error.code === 'conflict' ? 409 : r.error.code === 'not_found' ? 404 : r.error.code === 'rate_limited' ? 429 : 503).json(r.ok ? r.value : { error:r.error })
  } catch { res.status(400).json({ error:{ code:'invalid_request',message:'Revisa la petición.' } }) }
})
