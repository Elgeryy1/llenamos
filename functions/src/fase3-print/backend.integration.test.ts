import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'
import { type CallableRequest } from 'firebase-functions/v2/https'
import * as core from '@llenamos/core'
import { testInvoice, testFiscalRecord } from '../../../packages/core/src/caja/datos-prueba'
import { db } from '../shared'
import { execute } from './index'
import { enqueueKitchen } from './triggers'
import { processRequest, expireLeases } from './queue'
import { encode } from './documents'

const enabled = process.env.TEST_FIREBASE_EMULATORS === '1' && process.env.GCLOUD_PROJECT === 'demo-llenamos' && !!process.env.FIRESTORE_EMULATOR_HOST
const roots: string[] = []
let rid: string, path: string, bridgeToken: string, printerId: string
const lid = 'centro'
const request = (data: unknown, uid: string | null = 'owner') => ({ data, ...(uid ? { auth: { uid, token: {} } } : {}), rawRequest: { ip: '127.0.0.1' } }) as unknown as CallableRequest<unknown>
const staff = () => ({ restaurantId: rid, locationId: lid, requestId: randomUUID() })
const bridge = () => ({ restaurantId: rid, locationId: lid, bridgeId: 'local', token: bridgeToken })
const printer = (changes: Partial<core.Printer> = {}): core.Printer => ({ name: 'Térmica de prueba', bridgeId: 'local', paperMm: 80, columns: 48, tickets: true, drawer: true, stationIds: [], active: true, ...changes })
const call = <N extends Parameters<typeof execute>[0]>(name: N, data: unknown, uid: string | null = 'owner') => execute(name, data, request(data, uid))
async function testJob() { return call('solicitarImpresion', { ...staff(), printerId, kind: 'test', sourceId: printerId }) as Promise<core.CallableOutput<'solicitarImpresion'>> }
async function claim() { return call('reclamarImpresiones', bridge(), null) as Promise<core.CallableOutput<'reclamarImpresiones'>> }
async function confirm(job: core.CallableOutput<'reclamarImpresiones'>['jobs'][number], status: 'printed' | 'failed' | 'uncertain' = 'printed') {
  return call('confirmarImpresion', { ...bridge(), printJobId: job.id, leaseToken: job.leaseToken, status, error: null }, null)
}
describe.skipIf(!enabled)('Impresión contra emuladores reales', { timeout: 30000 }, () => {
  beforeEach(async () => {
    rid = `print-${randomUUID()}`; roots.push(rid); path = `restaurants/${rid}/locations/${lid}`
    await db.doc(`restaurants/${rid}`).set({ name: 'Prueba local', slug:rid, brandColor:'#f0a35e',currency:'EUR',locale:'es', plan: 'completo', activeModules: ['pos','floor','kitchen'], timezone: 'Europe/Madrid', isDemo: true })
    await db.doc(path).set({ name: 'Centro' })
    for (const uid of ['owner','manager','waiter','kitchen','inactive','limited']) await db.doc(`restaurants/${rid}/members/${uid}`).set({ uid, role: ['inactive','limited'].includes(uid) ? 'owner' : uid, email: `${uid}@test.local`, displayName: uid, active: uid !== 'inactive', locationIds: uid === 'limited' ? ['otro'] : [] })
    const paired = await call('vincularPuente', { ...staff(), bridgeId: 'local' }) as core.CallableOutput<'vincularPuente'>
    bridgeToken = paired.token
    printerId = (await call('guardarImpresora', { ...staff(), printerId: null, printer: printer() }) as core.CallableOutput<'guardarImpresora'>).printerId
  }, 60000)
  afterAll(async () => { for (const id of roots) await db.recursiveDelete(db.doc(`restaurants/${id}`)) }, 60000)
  it('comprueba sesión, rol, membresía, local y módulo', async () => {
    for (const uid of [null,'waiter','kitchen','inactive','limited','foreign']) await expect(call('guardarImpresora', { ...staff(), printerId: null, printer: printer() }, uid)).rejects.toMatchObject({ code: uid ? 'permission-denied' : 'unauthenticated' })
    await db.doc(`restaurants/${rid}`).update({ activeModules: ['floor'] })
    await expect(testJob()).rejects.toMatchObject({ code: 'failed-precondition' })
    await expect(claim()).rejects.toMatchObject({ code: 'failed-precondition' })
  })
  it('valida perfil, puente y estaciones locales antes de guardar', async () => {
    for (const p of [printer({ paperMm: 58 }), printer({ bridgeId: 'otro' }), printer({ stationIds: ['inexistente'] })]) await expect(call('guardarImpresora', { ...staff(), printerId, printer: p })).rejects.toMatchObject({ code: 'failed-precondition' })
    await expect(call('guardarImpresora', { ...staff(), printerId: null, printer: printer() })).rejects.toMatchObject({ code: 'failed-precondition' })
  })
  it('mismo requestId recupera impresora y credencial; otro contenido se rechaza', async () => {
    const d = { ...staff(), bridgeId: 'segundo' }, a = await call('vincularPuente', d)
    expect(await call('vincularPuente', d)).toEqual(a)
    await expect(call('vincularPuente', { ...d, bridgeId: 'otro' })).rejects.toMatchObject({ code: 'already-exists' })
    const stored = await db.doc(`${path}/printBridges/segundo`).get()
    expect(stored.get('token')).toBeUndefined()
    expect(stored.get('tokenHash')).toMatch(/^[a-f0-9]{64}$/)
  })
  it('dos puentes concurrentes no reclaman los mismos bytes', async () => {
    const queued = await testJob()
    const [a,b] = await Promise.all([claim(), claim()])
    expect([...a.jobs,...b.jobs]).toHaveLength(1)
    const j = [...a.jobs,...b.jobs][0]!
    expect(j.id).toBe(queued.printJobId)
    expect(j.printerId).toBe(printerId)
    expect(j.payloadHash).toMatch(/^[a-f0-9]{64}$/)
    const doc = core.prebillPrintDocument(['Prueba de impresora', 'Llenamos · impresión local', 'Papel térmico y acentos: á é í ó ú ñ €', 'No es una venta. No abre el cajón.'])
    expect(Buffer.from(j.payloadBase64, 'base64')).toEqual(Buffer.from(encode(doc, printer())))
    const projection = (await db.doc(`${path}/printStatuses/${j.id}`).get()).data()!
    expect(projection.status).toBe('leased'); expect(projection.payloadBase64).toBeUndefined(); expect(projection.leaseToken).toBeUndefined()
  })
  it('solo confirma el dueño con el token y lease correctos, idempotente', async () => {
    await testJob(); const j = (await claim()).jobs[0]!
    await expect(call('confirmarImpresion', { ...bridge(), printJobId: j.id, leaseToken: 'x'.repeat(43), status: 'printed', error: null }, null)).rejects.toMatchObject({ code: 'permission-denied' })
    expect(await confirm(j)).toEqual({ ok: true }); expect(await confirm(j)).toEqual({ ok: true })
    expect((await db.doc(`${path}/printStatuses/${j.id}`).get()).get('status')).toBe('printed')
    expect((await claim()).jobs).toEqual([])
  })
  it('caducar lease produce incierto y jamás reenvía automáticamente', async () => {
    await testJob(); const j = (await claim()).jobs[0]!
    await db.doc(`${path}/printJobs/${j.id}`).update({ leaseUntil: Timestamp.fromMillis(Date.now()-1) })
    expect((await claim()).jobs).toEqual([])
    expect((await db.doc(`${path}/printStatuses/${j.id}`).get()).get('status')).toBe('uncertain')
    await confirm(j)
    expect((await db.doc(`${path}/printJobs/${j.id}`).get()).get('status')).toBe('uncertain')
  })
  it('confirmación tardía tampoco se convierte en impreso', async () => {
    await testJob(); const j = (await claim()).jobs[0]!
    await db.doc(`${path}/printJobs/${j.id}`).update({ leaseUntil: Timestamp.fromMillis(Date.now()-1) })
    await confirm(j)
    expect((await db.doc(`${path}/printStatuses/${j.id}`).get()).get('status')).toBe('uncertain')
  })
  it('la reconciliación caduca leases aunque el puente siga apagado', async () => {
    await testJob(); const j = (await claim()).jobs[0]!
    await db.doc(`${path}/printJobs/${j.id}`).update({ leaseUntil: Timestamp.fromMillis(Date.now()-1) })
    expect(await expireLeases({restaurantId:rid,locationId:lid})).toBe(1)
    expect((await db.doc(`${path}/printStatuses/${j.id}`).get()).get('status')).toBe('uncertain')
    expect(await expireLeases({restaurantId:rid,locationId:lid})).toBe(0)
  })
  it('no acepta bytes ni autor del cliente y la prueba exige permiso de configuración', async () => {
    await expect(call('solicitarImpresion', {...staff(),printerId,kind:'test',sourceId:printerId,payloadBase64:'AAAA'})).rejects.toMatchObject({code:'invalid-argument'})
    await expect(call('solicitarImpresion', {...staff(),printerId,kind:'test',sourceId:printerId},'waiter')).rejects.toMatchObject({code:'permission-denied'})
    await expect(call('vincularPuente',{...staff(),bridgeId:'local',updatedBy:'otra-persona'})).rejects.toMatchObject({code:'invalid-argument'})
  })
  it('rotación revoca la credencial anterior y protege contra recuperación de credencial vieja', async () => {
    const d = { ...staff(), bridgeId: 'local' }
    await call('vincularPuente', d)
    await expect(claim()).rejects.toMatchObject({ code: 'permission-denied' })
    await call('vincularPuente', { ...staff(), bridgeId: 'local' })
    await expect(call('vincularPuente', d)).rejects.toMatchObject({ code: 'failed-precondition' })
    await expect(call('reclamarImpresiones', { ...bridge(), locationId: 'otro' }, null)).rejects.toBeDefined()
  })
  it('factura congelada con QR de prueba, copia marcada y sin cajón ni otro número', async () => {
    const a = core.createTestFiscalProvider().prepare({ regime: 'verifactu', record: testFiscalRecord(), ticketbaiPrevious: null })
    const { record: _, ...artifact } = a
    await db.doc(`${path}/invoices/i1`).set({ ...testInvoice(), recordId: 'record' })
    await db.doc(`restaurants/${rid}/fiscalRecords/record`).set({ ...artifact, locationId: lid, invoiceId: 'i1' })
    const d = { ...staff(), printerId, kind: 'invoice', sourceId: 'i1' }
    const original = await call('solicitarImpresion', d) as core.CallableOutput<'solicitarImpresion'>
    expect(await call('solicitarImpresion', d)).toEqual(original)
    await call('solicitarImpresion', { ...staff(), printerId, kind: 'invoice', sourceId: 'i1', copy: true })
    const jobs = await db.collection(`${path}/printJobs`).get()
    expect(jobs.size).toBe(2)
    const copy = jobs.docs.find(j => j.get('copy') === 1)!
    expect(copy.get('document').lines[0].text).toBe('Copia')
    expect(copy.get('document').fiscal.warning).toBe('no válido para Hacienda')
    expect(Buffer.from(copy.get('payloadBase64'), 'base64').includes(Buffer.from([27,112]))).toBe(false)
    expect((await db.collection(`${path}/invoices`).get()).size).toBe(1)
  })
  it('cajón solo para efectivo confirmado, encargado, una vez y sin copias', async () => {
    const payment = core.PaymentSchema.parse({ billId:'b',partId:'p',cashSessionId:'c',kind:'charge',originalPaymentId:null,method:'cash',status:'succeeded',amountCents:100,tipCents:0,tenderedCents:100,changeCents:0,externalId:null,requestId:'pay',reason:null,at:Date.now(),by:'owner' })
    await db.doc(`${path}/payments/p`).set(core.paymentForWrite(payment, Timestamp.fromMillis))
    const d = { ...staff(), printerId, kind:'drawer',sourceId:'p' }
    await expect(call('solicitarImpresion', d, 'waiter')).rejects.toMatchObject({ code:'permission-denied' })
    const a = await call('solicitarImpresion', d)
    expect(await call('solicitarImpresion', { ...d,requestId:randomUUID() })).toEqual(a)
    await expect(call('solicitarImpresion', { ...d,requestId:randomUUID(),copy:true })).rejects.toMatchObject({ code:'failed-precondition' })
    expect(Buffer.from((await claim()).jobs[0]!.payloadBase64,'base64')).toEqual(Buffer.from(core.drawerPulse()))
  })
  it('petición durable sin puente se recupera al configurar, sin duplicados', async () => {
    await db.doc(`${path}/printers/${printerId}`).update({ active:false })
    const id = 'durable', r: core.PrintRequest = { kind:'prebill',sourceId:'unused',printerId,copy:0,status:'queued',requestedAt:Date.now(),requestedBy:'owner' }
    await db.doc(`${path}/printRequests/${id}`).set({ ...core.printRequestForWrite(r, Timestamp.fromMillis),test:true })
    await processRequest({ restaurantId:rid,locationId:lid },id)
    expect((await db.doc(`${path}/printRequests/${id}`).get()).get('status')).toBe('not_configured')
    await db.doc(`${path}/printers/${printerId}`).update({ active:true })
    await processRequest({ restaurantId:rid,locationId:lid },id)
    await processRequest({ restaurantId:rid,locationId:lid },id)
    expect((await db.collection(`${path}/printJobs`).get()).size).toBe(1)
  })
  it('comanda marchada se agrupa y deduplica por estación, pase y destino', async () => {
    const demo = core.demoMenu(), settings = demo.settings
    const stationId = Object.keys(demo.stations)[0]!
    const station = demo.stations[stationId]!
    await db.doc(`${path}/stations/${stationId}`).set(station)
    await db.doc(`${path}/printers/${printerId}`).update({ stationIds:[stationId] })
    const priced = core.priceOrder(core.OrderLinesInputSchema.parse([{ kind:'item',itemId:'bravas',quantity:2 }]), { items:demo.items,dailyMenus:demo.dailyMenus }, { channel:'staff',now:Date.now(),timezone:'Europe/Madrid' })
    const draft = core.planOrderLines(priced.lines,demo.items,demo.stations,settings)[0]!
    const line = core.OrderLineSchema.parse({ ...draft,parentLineId:null,orderId:'o1',sessionId:'s1',takeawayId:null,label:'S1',status:'fired',fireAt:null,firedAt:Date.now(),placedAt:Date.now(),startedAt:null,readyAt:null,servedAt:null,cancelReason:null,history:[],createdBy:'owner',stationId })
    await db.doc(`${path}/orders/o1`).set({ sessionId:'s1',takeawayId:null,source:'staff',status:'accepted',lineIds:['l1'],totalCents:1300,note:'',language:'es',fire:'all',placedAt:Timestamp.now(),createdBy:'owner',decidedBy:null,decidedAt:null,rejectReason:null })
    await db.doc(`${path}/orderLines/l1`).set(core.orderLineForWrite(line,Timestamp.fromMillis))
    await Promise.all([enqueueKitchen({ restaurantId:rid,locationId:lid },line),enqueueKitchen({ restaurantId:rid,locationId:lid },line)])
    const jobs = await db.collection(`${path}/printJobs`).get()
    expect(jobs.size).toBe(1)
    expect(jobs.docs[0]!.get('document').lines.map((l:{text:string})=>l.text).join(' ')).toContain('2 x')
    await db.doc(`${path}/orderLines/l1`).update({ 'name.es':'Nombre cambiado después',notes:'Nota cambiada' })
    await call('solicitarImpresion',{...staff(),printerId,kind:'kitchen',sourceId:'o1',copy:true})
    const copied=(await db.collection(`${path}/printJobs`).where('copy','==',1).get()).docs[0]!
    const text=copied.get('document').lines.map((l:{text:string})=>l.text).join(' ')
    expect(text).toContain('Copia'); expect(text).not.toContain('Nombre cambiado');expect(text).not.toContain('Nota cambiada')
  })
})
