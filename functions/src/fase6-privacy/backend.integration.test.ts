import { randomUUID } from 'node:crypto'
import { afterAll,beforeEach,describe,expect,it } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'
import type { CallableRequest } from 'firebase-functions/v2/https'
import * as core from '@llenamos/core'
import { execute,assertMarketingConsent } from './index'
import { processPrivacyJobs,runRetention } from './worker'
import { db } from '../shared'
import { readPrivate,rootOf,bucket } from './infra'
const enabled = process.env.TEST_FIREBASE_EMULATORS === '1'
const request = (uid='owner',logiqd=false) => ({ auth:{ uid,token:{ logiqd } } }) as unknown as CallableRequest<unknown>
let rid:string,cid:string,path:string
const roots:string[] = []
const mutation = () => ({ restaurantId:rid,requestId:randomUUID() })
async function call<N extends Parameters<typeof execute>[0]>(name:N,data:unknown,uid='owner'):Promise<core.CallableOutput<N>> { return await execute(name,data,request(uid)) as core.CallableOutput<N> }
async function job(kind:'export'|'erase',verify=true) {
  const result = await call('solicitarPrivacidad',{ ...mutation(),customerId:cid,kind,reason:'Solicitud de la persona' })
  if (verify) await call('verificarSolicitudPrivacidad',{ ...mutation(),jobId:result.jobId,evidenceId:'prueba' })
  return rootOf(rid).collection('privacyJobs').doc(result.jobId)
}
describe.skipIf(!enabled)('Privacidad real con emuladores', { timeout:120000 },() => {
  beforeEach(async () => {
    rid = `privacy-${randomUUID()}`;roots.push(rid);cid = core.customerIdFor(rid,'+34600000444');path = `restaurants/${rid}/locations/centro`
    await rootOf(rid).set({ name:'Privacidad',slug:rid,plan:'completo' })
    await db.doc(path).set({ name:'Centro' })
    for (const role of ['owner','manager','waiter','limited','inactive']) await rootOf(rid).collection('members').doc(role).set({ uid:role,displayName:role,email:`${role}@test.es`,role:['limited','inactive'].includes(role) ? 'manager' : role,active:role !== 'inactive',locationIds:role === 'limited' ? ['centro'] : [] })
    await rootOf(rid).collection('customers').doc(cid).set({ name:'Ana privada',phone:'+34600000444',email:'ana@example.test',notes:'Nota privada',allergies:'Nueces',tags:[],updatedAt:Timestamp.now() })
    await rootOf(rid).collection('privacyEvidence').doc('prueba').set({ customerId:cid,verified:true,method:'in_person',expiresAt:Timestamp.fromMillis(Date.now()+3600000) })
  },60000)
  afterAll(async () => { for (const rid of roots) { await db.recursiveDelete(rootOf(rid)); await bucket().deleteFiles({ prefix:`platform/${rid}/` }) } },60000)
  it('exige permisos actuales, identidad real y una clave estable',async () => {
    const data = { ...mutation(),customerId:cid,kind:'erase',reason:'Petición' }
    for (const uid of ['waiter','limited','inactive','foreign']) await expect(call('solicitarPrivacidad',data,uid)).rejects.toMatchObject({ code:'permission-denied' })
    const a = await call('solicitarPrivacidad',data), b = await call('solicitarPrivacidad',data)
    expect(a).toEqual(b)
    await expect(call('solicitarPrivacidad',{ ...data,kind:'export' })).rejects.toMatchObject({ code:'already-exists' })
    await expect(call('verificarSolicitudPrivacidad',{ ...mutation(),jobId:a.jobId,evidenceId:'inventada' })).rejects.toMatchObject({ code:'failed-precondition' })
    await processPrivacyJobs(rid)
    expect((await rootOf(rid).collection('privacyJobs').doc(a.jobId).get()).get('status')).toBe('requested')
  })
  it('consentimiento separado, baja cancela marketing y vuelve a comprobar al enviar',async () => {
    const data = { ...mutation(),customerId:cid,purpose:'marketing_email',status:'granted',policyVersion:'2026.1',evidenceId:'prueba' }
    await call('registrarConsentimiento',data)
    await db.runTransaction(tx => assertMarketingConsent(tx,rid,cid,'marketing_email'))
    await expect(db.runTransaction(tx => assertMarketingConsent(tx,rid,cid,'marketing_whatsapp'))).rejects.toMatchObject({ code:'failed-precondition' })
    await rootOf(rid).collection('messages').doc('campaign').set({ customerId:cid,purpose:'marketing_email',status:'queued' })
    await call('registrarConsentimiento',{ ...data,...mutation(),status:'withdrawn' })
    expect((await rootOf(rid).collection('messages').doc('campaign').get()).get('status')).toBe('cancelled')
    await expect(db.runTransaction(tx => assertMarketingConsent(tx,rid,cid,'marketing_email'))).rejects.toMatchObject({ code:'failed-precondition' })
  })
  it('cierra puntos, anonimiza el libro y conserva el destino Repite hasta que se retira la tarjeta',async () => {
    await rootOf(rid).collection('settings').doc('repite').set({ merchantId:'merchant',enabled:true,stampOn:'both',autoCreateCard:true })
    await rootOf(rid).collection('loyaltyAccounts').doc(cid).set({ customerId:cid,status:'active',balance:40,earned:40,redeemed:0,expired:0,termsVersion:'1',enrolledAt:Timestamp.now(),enrolledBy:'owner',revision:1 })
    await rootOf(rid).collection('settings').doc('loyalty').set({ ...core.defaultLoyaltySettings(),enabled:true })
    const { execute: phase5 } = await import('../fase5/index')
    const enrollment = { restaurantId:rid,requestId:'alta-privacidad-prueba',customerId:cid,acceptedTermsVersion:'1' }
    await phase5('altaFidelizacion',enrollment,request())
    await rootOf(rid).collection('loyaltyMovements').doc('earn.bill').set({ customerId:cid,kind:'earn',points:40,reason:'Ana privada',at:Timestamp.now() })
    await rootOf(rid).collection('repiteCards').doc(cid).set({ merchantId:'merchant',cardId:'card-private',externalRef:'opaque-private',status:'active',createdAt:Timestamp.now() })
    await rootOf(rid).collection('marketingSendLog').doc(cid).set({ entries:[] })
    await rootOf(rid).collection('campaigns').doc('c').collection('recipients').doc(cid).set({ status:'queued',customerId:cid })
    await rootOf(rid).collection('unsubscribeTokens').doc('t').set({ customerId:cid })
    const ref = await job('erase');await processPrivacyJobs(rid)
    expect((await ref.get()).get('error')).toBeNull()
    expect((await ref.get()).get('status')).toBe('completed')
    await expect(phase5('altaFidelizacion',enrollment,request())).rejects.toMatchObject({ code:'failed-precondition' })
    expect((await rootOf(rid).collection('loyaltyAccounts').doc(cid).get()).data()).toMatchObject({ status:'closed',balance:0,privacyRedacted:true })
    const movement = (await rootOf(rid).collection('loyaltyMovements').doc('earn.bill').get()).data()!
    expect(movement.points).toBe(40);expect(movement.customerId).not.toBe(cid);expect(JSON.stringify(movement)).not.toContain('Ana privada')
    for (const path of [`repiteCards/${cid}`,`marketingSendLog/${cid}`,`campaigns/c/recipients/${cid}`,'unsubscribeTokens/t']) expect((await rootOf(rid).collection(path.split('/').slice(0,-1).join('/')).doc(path.split('/').at(-1)!).get()).exists).toBe(false)
    const operations = (await rootOf(rid).collection('repiteOutbox').get()).docs
    expect(operations).toHaveLength(1)
    expect(operations[0]!.data()).toMatchObject({ kind:'remove_card',merchantId:'merchant',result:{ cardId:'card-private',merchantId:'merchant' },status:'queued' })
    const { processRepite } = await import('../fase5/repite/service')
    let removed:unknown
    const provider = { ...core.notConfiguredRepite(),removeCard:async (input:unknown) => { removed=input;return { ok:true as const,value:{ removed:true as const,duplicate:false } } } }
    const retryAt = Date.now()
    await processRepite(rid,retryAt,{ ...core.notConfiguredRepite(),removeCard:async () => ({ ok:false,error:{ code:'unavailable',message:'Repite local caído',retryable:true } }) })
    expect((await operations[0]!.ref.get()).get('result')).toEqual({ cardId:'card-private',merchantId:'merchant' })
    await processRepite(rid,retryAt+31_000,provider)
    expect(removed).toMatchObject({ cardId:'card-private',merchantId:'merchant' })
    expect((await operations[0]!.ref.get()).get('status')).toBe('done')
  })
  it('exporta histórico y contacto replicado, sin secretos ni otra persona, cifrado y listado saneado',async () => {
    await db.doc(`${path}/tableSessions/s`).set({ customerId:cid,status:'closed',guestName:'Ana privada',notes:'Sin lactosa',totalCents:1500 })
    await db.doc(`${path}/orders/o`).set({ sessionId:'s',status:'accepted',totalCents:1500,token:'NO_EXPORTAR' })
    await db.doc(`${path}/orderLines/l`).set({ orderId:'o',sessionId:'s',status:'served',notes:'Nueces',totalCents:1500 })
    await rootOf(rid).collection('messages').doc('unlinked').set({ to:'ana@example.test',status:'sent',rendered:'Hola Ana',token:'NO_EXPORTAR' })
    await rootOf(rid).collection('customers').doc('other').set({ name:'OTRA_PERSONA',phone:'+34600000555' })
    const ref = await job('export');await processPrivacyJobs(rid)
    const data = (await ref.get()).data()!
    expect(data.status).toBe('completed')
    const content = (await readPrivate(data.artifactPath)).toString()
    expect(content).toContain('Ana privada');expect(content).toContain('1500');expect(content).not.toContain('NO_EXPORTAR');expect(content).not.toContain('OTRA_PERSONA')
    const [raw] = await bucket().file(data.artifactPath).download();expect(raw.toString()).not.toContain('Ana privada')
    const list = await call('listarSolicitudesPrivacidad',{ restaurantId:rid })
    expect(JSON.stringify(list)).not.toContain('artifactPath');expect(JSON.stringify(list)).not.toContain('planPath')
    await expect(call('listarSolicitudesPrivacidad',{ restaurantId:rid,cursor:'manipulado' })).rejects.toMatchObject({ code:'invalid-argument' })
    const link = await call('descargarExportacionPrivacidad',{ restaurantId:rid,jobId:ref.id })
    expect(link.expiresAt-Date.now()).toBeLessThanOrEqual(900000)
    // Con un enlace de descarga ya emitido, el borrado posterior no debe bloquearse ni dejar el ticket vivo.
    const erase = await job('erase');await processPrivacyJobs(rid)
    expect((await erase.get()).get('error')).toBeNull();expect((await erase.get()).get('status')).toBe('completed')
    expect((await rootOf(rid).collection('privacyDownloads').get()).size).toBe(0)
  })
  it('bloquea servicio vivo y copia desconocida en vez de completar a medias',async () => {
    await db.doc(`${path}/tableSessions/s`).set({ customerId:cid,status:'open' })
    const ref = await job('erase');await processPrivacyJobs(rid)
    expect((await ref.get()).get('status')).toBe('blocked');expect((await rootOf(rid).collection('customers').doc(cid).get()).exists).toBe(true)
    await db.doc(`${path}/tableSessions/s`).update({ status:'closed' })
    await db.doc(`${path}/futureCopies/x`).set({ customerId:cid,phone:'+34600000444' })
    await call('verificarSolicitudPrivacidad',{ ...mutation(),jobId:ref.id,evidenceId:'prueba' });await processPrivacyJobs(rid)
    expect((await ref.get()).get('status')).toBe('blocked')
  })
  it('borra por páginas, conserva barreras y fiscal inmutable, se puede retomar',async () => {
    for (let i=0;i<45;i++) await db.doc(`${path}/orderSubmissions/${i.toString().padStart(3,'0')}`).set({ customerId:cid,payloadHash:'HASH_ESTABLE',result:{ email:'ana@example.test',token:'SECRETO' } })
    for (const id of ['a','B','b','A','z','Z']) await db.doc(`${path}/orderSubmissions/${id}`).set({ customerId:cid,payloadHash:'HASH_ESTABLE',result:{ email:'ana@example.test',token:'SECRETO' } })
    await db.doc(`${path}/invoices/f`).set({ customerId:cid,number:'F1',recipient:{ name:'Ana privada' },hash:'ORIGINAL' })
    const before = (await db.doc(`${path}/invoices/f`).get()).data()
    const ref = await job('erase');await processPrivacyJobs(rid,1)
    expect((await ref.get()).get('status')).toBe('running');await processPrivacyJobs(rid)
    expect((await ref.get()).get('status')).toBe('completed')
    expect((await rootOf(rid).collection('customers').doc(cid).get()).exists).toBe(false)
    const receipt = (await db.doc(`${path}/orderSubmissions/000`).get()).data()!
    expect(receipt.payloadHash).toBe('HASH_ESTABLE');expect(receipt.result.token).toBeNull();expect(JSON.stringify(receipt)).not.toContain('ana@example.test')
    for (const row of (await db.collection(`${path}/orderSubmissions`).get()).docs) expect(row.get('privacyRedacted'),row.id).toBe(true)
    expect((await db.doc(`${path}/invoices/f`).get()).data()).toEqual(before)
    expect((await rootOf(rid).collection('privacyTombstones').get()).size).toBe(1)
    await processPrivacyJobs(rid);expect((await ref.get()).get('status')).toBe('completed')
  })
  it('anonimiza la cola de impresión de la cuenta, conserva la factura impresa y no toca el registro de jornada',async () => {
    await db.doc(`${path}/tableSessions/s`).set({ customerId:cid,status:'closed',guestName:'Ana privada' })
    await db.doc(`${path}/bills/b`).set({ sessionId:'s',status:'settled',totalCents:2000,target:{ kind:'session',id:'s' } })
    await db.doc(`${path}/printJobs/prebill`).set({ kind:'prebill',sourceId:'b',printerId:'p',status:'printed',payloadBase64:'TICKET_ANA',document:{ lines:[{ text:'Ana privada' }] } })
    await db.doc(`${path}/printJobs/factura`).set({ kind:'invoice',sourceId:'f',printerId:'p',status:'printed',payloadBase64:'FACTURA_ORIGINAL' })
    await db.doc(`${path}/invoices/f`).set({ customerId:cid,billId:'b',number:'F2',recipient:{ name:'Ana privada' } })
    await db.doc(`${path}/timeEntries/t1`).set({ uid:'waiter',status:'closed',workedMinutes:300,updatedAt:Timestamp.fromMillis(Date.now()-5*365*86400000) })
    await db.doc(`${path}/timeEntryEvents/e1`).set({ entryId:'t1',reason:'Corrección del encargado' })
    const ref = await job('erase');await processPrivacyJobs(rid)
    expect((await ref.get()).get('error')).toBeNull();expect((await ref.get()).get('status')).toBe('completed')
    const ticket = (await db.doc(`${path}/printJobs/prebill`).get()).data()!
    expect(ticket.payloadBase64).toBe('');expect(JSON.stringify(ticket)).not.toContain('Ana privada')
    expect((await db.doc(`${path}/printJobs/factura`).get()).get('payloadBase64')).toBe('FACTURA_ORIGINAL')
    expect((await db.doc(`${path}/invoices/f`).get()).get('recipient.name')).toBe('Ana privada')
    await runRetention(rid)
    expect((await db.doc(`${path}/timeEntries/t1`).get()).get('workedMinutes')).toBe(300)
    expect((await db.doc(`${path}/timeEntryEvents/e1`).get()).exists).toBe(true)
  })
  it('caduca mensajes, exportación y contactos inactivos sin purgar datos fiscales o vivos',async () => {
    const old = Timestamp.fromMillis(Date.now()-400*86400000)
    await rootOf(rid).collection('customers').doc(cid).update({ updatedAt:old })
    await rootOf(rid).collection('messages').doc('old').set({ to:'old@example.test',status:'sent',updatedAt:old })
    await rootOf(rid).collection('messages').doc('hold').set({ to:'hold@example.test',status:'sent',legalHold:true,updatedAt:old })
    const result = await runRetention(rid)
    expect(result.messages).toBe(1);expect((await rootOf(rid).collection('messages').doc('old').get()).get('status')).toBe('cancelled');expect(result.customers).toBe(1);expect((await rootOf(rid).collection('messages').doc('hold').get()).exists).toBe(true)
  })
})
