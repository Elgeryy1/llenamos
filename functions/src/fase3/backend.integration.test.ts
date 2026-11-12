import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { type CallableRequest } from 'firebase-functions/v2/https'
import * as core from '@llenamos/core'
import { testFiscalRecord, testInvoice } from '../../../packages/core/src/caja/datos-prueba'
import * as api from './index'
import * as floor from '../fase2'
import * as reservationApi from '../reservations'
import { db } from '../shared'
import { chainKey, fiscalClock } from './fiscal'
import { processFiscalOutbox } from './process'
import { confirmExternalPayment, issuePartInvoice, correctRejectedFiscalRecord, payTipDistribution } from './service'

const enabled = process.env.TEST_FIREBASE_EMULATORS === '1' && process.env.GCLOUD_PROJECT === 'demo-llenamos' && !!process.env.FIRESTORE_EMULATOR_HOST
const req = (data: unknown, uid: string | null = 'owner') => ({ data,...(uid ? { auth:{ uid,token:{} } } : {}) }) as unknown as CallableRequest<unknown>
let rid: string, path: string
const lid = 'centro', roots: string[] = [], installations: string[] = []
const scope = () => ({ restaurantId:rid,locationId:lid })
const mutation = () => ({ ...scope(),requestId:randomUUID() })
async function call<N extends (typeof api.names)[number]>(name: N, d: unknown, uid: string | null = 'owner'): Promise<core.CallableOutput<N>> {
  return api.execute(name,d,req(d,uid))
}
function settings(installation = rid): core.PosSettings {
  const year = fiscalClock(Date.now(),'Europe/Madrid').year
  const s = testFiscalRecord().system
  return { issuer:testInvoice().issuer,system:{ ...s,installation },providerId:'local_test',fiscalRegime:'verifactu',environment:'test',ordinarySeriesId:`ordinary_${year}`,rectifyingSeriesId:`rectifying_${year}`,mobilePayments:false }
}
const current = async (billId: string) => call('verCuenta',{ ...scope(),billId })
async function fixture(count = 2, tableId = 't1') {
  const opened = await floor.abrirMesa.run(req({ ...scope(),tableIds:[tableId],guests:2,guest:{ name:'Ana Prueba',phone:'600000000' } })) as core.CallableOutput<'abrirMesa'>
  const placed = await floor.enviarPedido.run(req({ ...scope(),sessionId:opened.sessionId,lines:[{ kind:'item',itemId:'bravas',quantity:count }] })) as core.CallableOutput<'enviarPedido'>
  const { billId,bill } = await call('abrirCuenta',{ ...mutation(),target:{ kind:'session',id:opened.sessionId } })
  if (placed.status !== 'sent') throw new Error('Pedido rechazado')
  return { sessionId:opened.sessionId,lineIds:placed.lineIds,billId,bill }
}
async function lock(billId: string) {
  const { bill,parts } = await current(billId)
  const { revision } = await call('prepararCobro',{ ...mutation(),billId,expectedRevision:bill.revision })
  return { ...scope(),billId,expectedRevision:revision,partId:parts[0]!.id }
}
async function cash() { return (await call('abrirCaja',{ ...mutation(),registerId:'principal',openingCents:10000 })).cashSessionId }
async function pay(d: {billId:string;expectedRevision:number;partId:string}, cashSessionId: string, amountCents: number, extra = {}) {
  return call('registrarCobro',{ ...mutation(),...d,cashSessionId,method:'cash',amountCents,tenderedCents:amountCents,...extra })
}
async function invoice(d: {billId:string;expectedRevision:number;partId:string}, type: 'F1' | 'F2' = 'F2') {
  return call('emitirFactura',{ ...mutation(),...d,type,recipient:type === 'F1' ? testInvoice().recipient : null })
}

describe.skipIf(!enabled)('Caja y fiscalidad con transacciones reales', { timeout:60000 }, () => {
  beforeEach(async () => {
    rid = `fase3-${randomUUID()}`; roots.push(rid); path = `restaurants/${rid}/locations/${lid}`
    await db.doc(`restaurants/${rid}`).set({ name:'Prueba de caja',slug:rid,brandColor:'#f0a35e',timezone:'Europe/Madrid',locale:'es',currency:'EUR',isDemo:true,plan:'completo',activeModules:['reservations','floor','kitchen','pos'] })
    await db.doc(path).set({ name:'Centro',slug:'centro',address:'',city:'',phone:'' })
    await db.doc(`restaurants/${rid}/locations/otro`).set({ name:'Otro' })
    for (const role of ['owner','manager','waiter','kitchen','bar','inactive','limited']) await db.doc(`restaurants/${rid}/members/${role}`).set({ uid:role,displayName:role,email:`${role}@test.es`,role:['inactive','limited'].includes(role) ? 'owner' : role,active:role !== 'inactive',locationIds:role === 'limited' ? ['otro'] : [] })
    for (let i = 1;i <= 5;i++) await db.doc(`${path}/tables/t${i}`).set({ name:`S${i}`,areaId:'sala',seats:8,enabled:true,joinableWith:['t1','t2','t3','t4','t5'].filter(t => t !== `t${i}`),shape:'rect',x:10,y:10,w:10,h:10 })
    const demo = core.demoMenu(), rs = core.defaultReservationSettings()
    const shifts = [{ name:'Servicio',from:'00:00',lastEntry:'23:45' }]
    rs.week = { mon:shifts,tue:shifts,wed:shifts,thu:shifts,fri:shifts,sat:shifts,sun:shifts }; rs.publicBooking = true; rs.autoConfirm = true
    demo.settings.selfOrder.enabled = true; demo.settings.takeaway.enabled = true; demo.settings.takeaway.publicOrdering = true
    await db.doc(`${path}/settings/reservations`).set(rs); await db.doc(`${path}/settings/floor`).set(demo.settings)
    for (const [collection,rows] of Object.entries({ menuCategories:demo.categories,menuItems:demo.items,dailyMenus:demo.dailyMenus,stations:demo.stations })) {
      const batch = db.batch(); for (const [id,value] of Object.entries(rows)) batch.set(db.doc(`${path}/${collection}/${id}`),value); await batch.commit()
    }
    installations.push(chainKey(settings()))
    await call('guardarConfiguracionCaja',{ ...mutation(),settings:settings() })
  },60000)
  afterAll(async () => {
    for (const id of roots) { await db.recursiveDelete(db.doc(`restaurants/${id}`)); await db.doc(`publicRestaurants/${id}`).delete(); await db.doc(`publicMenus/${core.publicMenuId(id,lid)}`).delete() }
    for (const key of installations) await db.doc(`fiscalInstallations/${key}`).delete()
  },120000)
  it('exporta 17 callables de su propiedad y exige sesión, rol, local y módulo',async () => {
    expect(api.names).toHaveLength(17)
    for (const name of api.names) expect(api[name].run).toBeTypeOf('function')
    for (const uid of [null,'kitchen','bar','inactive','limited','foreign']) await expect(call('abrirCaja',{ ...mutation(),registerId:'x',openingCents:0 },uid)).rejects.toMatchObject({ code:uid === null ? 'unauthenticated' : 'permission-denied' })
    await expect(call('abrirCaja',{ ...mutation(),registerId:'x',openingCents:0 },'waiter')).rejects.toMatchObject({ code:'permission-denied' })
    await db.doc(`restaurants/${rid}`).update({ activeModules:['floor'] })
    await expect(cash()).rejects.toMatchObject({ code:'failed-precondition' })
  })
  it('deduplica apertura por petición, rechaza otro contenido y dos aperturas del terminal',async () => {
    const input = { ...mutation(),registerId:'principal',openingCents:0 }
    const [one,two] = await Promise.all([call('abrirCaja',input),call('abrirCaja',input)])
    expect(one).toEqual(two)
    await expect(call('abrirCaja',{ ...input,openingCents:1 })).rejects.toMatchObject({ code:'already-exists' })
    await expect(cash()).rejects.toMatchObject({ code:'failed-precondition' })
  })
  it('reparte por iguales, platos e importe, registra efectivo parcial, cambio, datáfono y propina',async () => {
    const f = await fixture(), cashSessionId = await cash()
    let v = await current(f.billId)
    const equal = await call('dividirCuenta',{ ...mutation(),billId:f.billId,expectedRevision:v.bill.revision,split:{ kind:'equal',parts:3 } })
    expect(core.sumCents(equal.parts.map(p => p.totalCents))).toBe(f.bill.totalCents)
    const dishes = await call('dividirCuenta',{ ...mutation(),billId:f.billId,expectedRevision:equal.revision,split:{ kind:'dishes',lineIds:[f.lineIds] } })
    const amounts = await call('dividirCuenta',{ ...mutation(),billId:f.billId,expectedRevision:dishes.revision,split:{ kind:'amount',amountsCents:[501,f.bill.totalCents - 501] } })
    const locked = await call('prepararCobro',{ ...mutation(),billId:f.billId,expectedRevision:amounts.revision })
    const d = { billId:f.billId,expectedRevision:locked.revision,partId:amounts.parts[0]!.id }
    const input = { ...mutation(),...d,cashSessionId,method:'cash',amountCents:200,tipCents:50,tenderedCents:500 }
    const p = await call('registrarCobro',input)
    expect(p).toMatchObject({ changeCents:250,dueCents:301 }); expect(await call('registrarCobro',input)).toEqual(p)
    await call('registrarCobro',{ ...mutation(),...d,cashSessionId,method:'card',amountCents:301,terminalReference:'Ticket del datáfono 7' })
    await pay({ ...d,partId:amounts.parts[1]!.id },cashSessionId,amounts.parts[1]!.totalCents)
    v = await current(f.billId); expect(v.bill.status).toBe('settled'); expect(v.bill.revision).toBe(locked.revision)
    expect((await db.collection(`${path}/payments`).get()).size).toBe(3)
  })
  it('dos cobros competidores no superan el saldo y las reservas no caducan por reloj local',async () => {
    const f = await fixture(), cashSessionId = await cash(), d = await lock(f.billId)
    const attempts = await Promise.allSettled([pay(d,cashSessionId,f.bill.totalCents),pay(d,cashSessionId,f.bill.totalCents)])
    expect(attempts.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect((await current(f.billId)).bill.paidCents).toBe(f.bill.totalCents)
    const f2 = await fixture(1,'t2'), d2 = await lock(f2.billId)
    await db.doc(`${path}/mobileCheckouts/pendiente`).set({ billId:d2.billId,partId:d2.partId,revision:d2.expectedRevision,amountCents:f2.bill.totalCents,tipCents:0,status:'pending',stripeSessionId:'cs_pending',expiresAt:1,tokenHash:'a'.repeat(64),cashSessionId })
    await db.doc(`${path}/paymentReservations/${d2.partId}`).set({ billId:d2.billId,partId:d2.partId,revision:d2.expectedRevision,amountCents:f2.bill.totalCents,checkoutId:'pendiente',expiresAt:1 })
    await expect(pay(d2,cashSessionId,1)).rejects.toMatchObject({ code:'failed-precondition' })
    await expect(call('desbloquearCuenta',{ ...mutation(),billId:f2.billId,expectedRevision:d2.expectedRevision,reason:'Cambio' })).rejects.toMatchObject({ code:'failed-precondition' })
    await expect(call('cerrarCaja',{ ...mutation(),cashSessionId,countedCents:0,reason:'Prueba' })).rejects.toMatchObject({ code:'failed-precondition' })
  })
  it('invitación y anulación requieren motivo y permiso, y no admiten exceder la línea',async () => {
    const f = await fixture(), lineId = f.bill.lines[0]!.lineId
    await expect(call('ajustarCuenta',{ ...mutation(),billId:f.billId,expectedRevision:1,lineId,kind:'invitation',amountCents:100,reason:'Invitación' },'waiter')).rejects.toMatchObject({ code:'permission-denied' })
    await expect(call('ajustarCuenta',{ ...mutation(),billId:f.billId,expectedRevision:1,lineId,kind:'void',amountCents:100,reason:'' })).rejects.toMatchObject({ code:'invalid-argument' })
    const a = await call('ajustarCuenta',{ ...mutation(),billId:f.billId,expectedRevision:1,lineId,kind:'invitation',amountCents:100,reason:'Atención de la casa' })
    await expect(call('ajustarCuenta',{ ...mutation(),billId:f.billId,expectedRevision:a.revision,lineId,kind:'void',amountCents:f.bill.totalCents,reason:'Error' })).rejects.toMatchObject({ code:'failed-precondition' })
    await call('ajustarCuenta',{ ...mutation(),billId:f.billId,expectedRevision:a.revision,lineId,kind:'void',amountCents:50,reason:'Error de servicio' })
    expect((await db.collection(`${path}/billAdjustments`).get()).size).toBe(2)
  })
  it('refresca el consumo e invalida reparto y revisión antes del cobro',async () => {
    const f = await fixture()
    await floor.enviarPedido.run(req({ ...scope(),sessionId:f.sessionId,lines:[{ kind:'item',itemId:'bravas',quantity:1 }] }))
    await expect(call('prepararCobro',{ ...mutation(),billId:f.billId,expectedRevision:1 })).rejects.toMatchObject({ code:'failed-precondition' })
    expect((await current(f.billId)).bill.revision).toBe(2)
    await expect(call('prepararCobro',{ ...mutation(),billId:f.billId,expectedRevision:1 })).rejects.toMatchObject({ code:'failed-precondition' })
    await lock(f.billId)
    await expect(floor.enviarPedido.run(req({ ...scope(),sessionId:f.sessionId,lines:[{ kind:'item',itemId:'bravas',quantity:1 }] }))).rejects.toMatchObject({ code:'failed-precondition' })
    await expect(floor.cambiarEstadoLineas.run(req({ ...scope(),lineIds:f.lineIds,status:'cancelled',reason:'Error' }))).rejects.toMatchObject({ code:'failed-precondition' })
    await expect(floor.moverMesa.run(req({ ...scope(),sessionId:f.sessionId,tableIds:['t2'] }))).rejects.toMatchObject({ code:'failed-precondition' })
    await expect(floor.juntarMesas.run(req({ ...scope(),sessionId:f.sessionId,tableIds:['t2'] }))).rejects.toMatchObject({ code:'failed-precondition' })
  })
  it('el cierre exige saldar y no duplica gasto del cliente al pagar o facturar',async () => {
    const f = await fixture(), cashSessionId = await cash(), d = await lock(f.billId)
    await floor.cambiarEstadoLineas.run(req({ ...scope(),lineIds:f.lineIds,status:'served' }))
    await expect(floor.cambiarEstadoMesa.run(req({ ...scope(),sessionId:f.sessionId,status:'closed' }))).rejects.toMatchObject({ code:'failed-precondition' })
    await pay(d,cashSessionId,f.bill.totalCents); await invoice(d)
    await floor.cambiarEstadoMesa.run(req({ ...scope(),sessionId:f.sessionId,status:'closed' }))
    await expect(floor.cambiarEstadoMesa.run(req({ ...scope(),sessionId:f.sessionId,status:'open' }))).rejects.toMatchObject({ code:'failed-precondition' })
    expect((await db.doc(`${path}/tableSessions/${f.sessionId}`).get()).get('status')).toBe('closed')
    const customerId = core.customerIdFor(rid,'+34600000000')
    expect((await db.doc(`restaurants/${rid}/customers/${customerId}`).get()).get('spentCents')).toBe(f.bill.totalCents)
    await current(f.billId); await invoice(d)
    expect((await db.doc(`restaurants/${rid}/customers/${customerId}`).get()).get('spentCents')).toBe(f.bill.totalCents)
  })
  it('una cuenta por destino y factura por parte, con reintentos sin duplicar',async () => {
    const f = await fixture(), d = await lock(f.billId), input = { ...mutation(),...d,type:'F2',recipient:null }
    const [a,b] = await Promise.all([call('emitirFactura',input),call('emitirFactura',input)])
    expect(a).toEqual(b); expect(a.warning).toBe('no válido para Hacienda')
    expect(await invoice(d)).toEqual(a)
    const opened = await call('abrirCuenta',{ ...mutation(),target:{ kind:'session',id:f.sessionId } }); expect(opened.billId).toBe(f.billId)
    expect((await db.collection(`${path}/invoices`).get()).size).toBe(1)
    expect((await db.collection(`restaurants/${rid}/fiscalRecords`).get()).size).toBe(1)
  })
  it('fallo fiscal no consume número y dos locales comparten cadena sin compartir correlativos',async () => {
    const f = await fixture(), d = await lock(f.billId)
    await expect(call('emitirFactura',{ ...mutation(),...d,type:'F1',recipient:null })).rejects.toMatchObject({ code:'failed-precondition' })
    const a = await invoice(d)
    expect(a.number.endsWith('000001')).toBe(true)
    const otherPath = `restaurants/${rid}/locations/otro`
    await db.doc(`${otherPath}/bills/b`).set({ ...f.bill,status:'locked',revision:1,lockedAt:Date.now() })
    const plan = core.splitBill(f.bill.lines,{ kind:'equal',parts:1 })[0]!
    await db.doc(`${otherPath}/billParts/p`).set({ ...plan,billId:'b',label:'Otra',revision:1,paidCents:0,invoiceId:null })
    await call('guardarConfiguracionCaja',{ ...mutation(),locationId:'otro',settings:settings() })
    const f2 = await fixture(1,'t2'), d2 = await lock(f2.billId)
    await Promise.all([invoice(d2),call('emitirFactura',{ ...mutation(),locationId:'otro',billId:'b',partId:'p',expectedRevision:1,type:'F2',recipient:null })])
    const records = (await db.collection(`restaurants/${rid}/fiscalRecords`).orderBy('input.chainSequence').get()).docs.map(d => core.FiscalStoredRecordSchema.parse(d.data()))
    expect(records).toHaveLength(3); expect(core.verifyFiscalChain(records)).toBe(true)
    expect(new Set(records.map(r => core.fiscalIdentity(r.input).number)).size).toBe(3)
  })
  it('detecta manipulación de XML o cabeza, conserva incidencia y bloquea emisión',async () => {
    const f = await fixture(), d = await lock(f.billId), a = await invoice(d)
    await db.doc(`restaurants/${rid}/fiscalRecords/${a.recordId}`).update({ xml:'manipulado' })
    const f2 = await fixture(1,'t2'), d2 = await lock(f2.billId)
    await expect(invoice(d2)).rejects.toMatchObject({ code:'failed-precondition' })
    expect((await db.collection(`restaurants/${rid}/fiscalIncidents`).get()).size).toBe(1)
    expect((await db.collection(`${path}/invoices`).get()).size).toBe(1)
  })
  it('devuelve consumo y propina una vez sin reabrir saldo, rectifica y evita excesos',async () => {
    const f = await fixture(), cashSessionId = await cash(), d = await lock(f.billId)
    const payment = await pay(d,cashSessionId,f.bill.totalCents,{ tipCents:100,tenderedCents:f.bill.totalCents + 100 })
    const inv = await invoice(d)
    const input = { ...mutation(),paymentId:payment.paymentId,amountCents:100,tipCents:50,reason:'Devolución parcial' }
    const refund = await call('devolverCobro',input); expect(refund.status).toBe('succeeded'); expect(await call('devolverCobro',input)).toEqual(refund)
    await call('devolverCobro',{ ...mutation(),paymentId:payment.paymentId,amountCents:0,tipCents:50,reason:'Propina' })
    await expect(call('devolverCobro',{ ...mutation(),paymentId:payment.paymentId,amountCents:f.bill.totalCents,reason:'Exceso' })).rejects.toMatchObject({ code:'failed-precondition' })
    const rect = await call('rectificarFactura',{ ...mutation(),invoiceId:inv.invoiceId,type:'R5',mode:'I',reason:'Devolución',reductions:[{ lineIndex:0,amountCents:100 }] })
    expect((await db.doc(`${path}/invoices/${rect.invoiceId}`).get()).get('totalCents')).toBe(-100)
    await expect(call('rectificarFactura',{ ...mutation(),invoiceId:inv.invoiceId,type:'R5',mode:'I',reason:'Exceso',reductions:[{ lineIndex:0,amountCents:f.bill.totalCents }] })).rejects.toMatchObject({ code:'failed-precondition' })
    expect((await current(f.billId)).bill).toMatchObject({ status:'settled',refundedCents:100,paidCents:f.bill.totalCents })
  })
  it('factura completa, rectificativa S y sustitución de simplificada conservan los originales',async () => {
    const f = await fixture(), d = await lock(f.billId), inv = await invoice(d,'F1')
    const rect = await call('rectificarFactura',{ ...mutation(),invoiceId:inv.invoiceId,type:'R4',mode:'S',reason:'Reducción de servicio',reductions:[{ lineIndex:0,amountCents:100 }] })
    expect((await db.doc(`${path}/invoices/${rect.invoiceId}`).get()).get('totalCents')).toBe(f.bill.totalCents - 100)
    expect((await db.doc(`${path}/invoices/${inv.invoiceId}`).get()).get('totalCents')).toBe(f.bill.totalCents)
    const f2 = await fixture(1,'t2'), d2 = await lock(f2.billId), inv2 = await invoice(d2)
    const replacement = await call('sustituirSimplificada',{ ...mutation(),invoiceId:inv2.invoiceId,recipient:testInvoice().recipient })
    expect((await db.doc(`${path}/invoices/${replacement.invoiceId}`).get()).data()).toMatchObject({ type:'F3',totalCents:f2.bill.totalCents })
    await expect(call('sustituirSimplificada',{ ...mutation(),invoiceId:inv2.invoiceId,recipient:testInvoice().recipient })).rejects.toMatchObject({ code:'failed-precondition' })
  })
  it('arquea entradas, salidas, cambio y devoluciones sin doble resta; reparte una vez',async () => {
    const f = await fixture(), cashSessionId = await cash(), d = await lock(f.billId)
    const p = await pay(d,cashSessionId,f.bill.totalCents,{ tipCents:100,tenderedCents:f.bill.totalCents + 1000 })
    await call('devolverCobro',{ ...mutation(),paymentId:p.paymentId,amountCents:100,reason:'Error' })
    await call('registrarMovimientoCaja',{ ...mutation(),cashSessionId,kind:'in',amountCents:200,reason:'Cambio añadido' })
    await call('registrarMovimientoCaja',{ ...mutation(),cashSessionId,kind:'out',amountCents:300,reason:'Compra de hielo' })
    const expected = 10000 + f.bill.totalCents - 100
    await expect(call('cerrarCaja',{ ...mutation(),cashSessionId,countedCents:0,reason:null })).rejects.toMatchObject({ code:'failed-precondition' })
    const closed = await call('cerrarCaja',{ ...mutation(),cashSessionId,countedCents:expected,reason:null })
    expect(closed.cashSession).toMatchObject({ expectedCents:expected,differenceCents:0,status:'closed' })
    await expect(pay(d,cashSessionId,1)).rejects.toMatchObject({ code:'failed-precondition' })
    const distribution = await call('repartirPropinas',{ ...mutation(),cashSessionId,hours:[{ uid:'owner',minutes:60 },{ uid:'waiter',minutes:120 }] })
    expect(core.sumCents(distribution.shares.map(s => s.amountCents))).toBe(100)
    await expect(call('repartirPropinas',{ ...mutation(),cashSessionId,hours:[{ uid:'owner',minutes:60 }] })).rejects.toMatchObject({ code:'failed-precondition' })
  })
  it('el proveedor de prueba conserva artefacto y responde no configurado sin red ni nueva factura',async () => {
    const f = await fixture(), d = await lock(f.billId), inv = await invoice(d)
    expect(await processFiscalOutbox(rid)).toEqual({ processed:1 })
    expect(await processFiscalOutbox(rid)).toEqual({ processed:0 })
    expect((await db.doc(`restaurants/${rid}/fiscalOutbox/${inv.recordId}`).get()).get('status')).toBe('not_configured')
    expect((await db.collection(`restaurants/${rid}/fiscalResponses`).get()).size).toBe(1)
    expect((await db.doc(`${path}/invoices/${inv.invoiceId}`).get()).get('artifact.warning')).toBe('no válido para Hacienda')
  })
  it('deniega producción y regímenes forales antes de consumir números',async () => {
    for (const changed of [{ environment:'production' },{ fiscalRegime:'ticketbai_araba' },{ providerId:'inventado' }]) await expect(call('guardarConfiguracionCaja',{ ...mutation(),settings:{ ...settings(),...changed } })).rejects.toMatchObject({ code:'failed-precondition' })
    expect([...((await db.collection(`${path}/invoiceSeries`).get()).docs)].every(d => d.get('lastSequence') === 0)).toBe(true)
  })
  it('rechaza histórico sin IVA sin inventar un tipo actual',async () => {
    const f = await fixture()
    await db.doc(`${path}/orderLines/${f.lineIds[0]}`).update({ taxRate:null })
    await expect(current(f.billId)).rejects.toMatchObject({ code:'failed-precondition' })
  })
  it('confirma pago externo verificado una vez y permite emisión automática con destinatario guardado',async () => {
    const f = await fixture(), cashSessionId = await cash(), d = await lock(f.billId)
    const checkoutId = 'checkout', externalId = 'cs_test_local', amountCents = f.bill.totalCents
    await db.doc(`${path}/mobileCheckouts/${checkoutId}`).set({ billId:d.billId,partId:d.partId,revision:d.expectedRevision,amountCents,tipCents:0,status:'pending',stripeSessionId:externalId,expiresAt:Date.now() + 10000,tokenHash:'a'.repeat(64),cashSessionId,recipient:null })
    await db.doc(`${path}/paymentReservations/${d.partId}`).set({ billId:d.billId,partId:d.partId,revision:d.expectedRevision,amountCents,checkoutId,expiresAt:Date.now() + 10000 })
    const input: core.ConfirmedExternalPayment = { ...mutation(),...d,cashSessionId,checkoutId,externalId,currency:'EUR',amountCents,tipCents:0 }
    await expect(confirmExternalPayment({ ...input,amountCents:1 })).rejects.toMatchObject({ code:'failed-precondition' })
    const paid = await confirmExternalPayment(input); expect(await confirmExternalPayment(input)).toEqual(paid); expect(await confirmExternalPayment({ ...input,requestId:randomUUID() })).toEqual(paid)
    const invoiceInput = core.EmitirFacturaInputSchema.parse({ ...mutation(),...d,type:'F2',recipient:null })
    const inv = await issuePartInvoice(invoiceInput,null); expect(inv.number).toBeTruthy()
    await expect(call('devolverCobro',{ ...mutation(),paymentId:paid.paymentId,amountCents:100,reason:'Reembolso solicitado' })).resolves.toMatchObject({ status:'not_configured' })
    expect((await current(f.billId)).bill.refundedCents).toBe(0)
  })
  it('cobra para llevar, impide recoger sin saldar y conserva la preparación tras bloquear',async () => {
    const date = core.sumarDias(core.horaLocal(Date.now(),'Europe/Madrid').fecha,1)
    const take = await floor.crearParaLlevar.run(req({ ...scope(),date,time:'13:00',guestName:'Recogida',phone:'600000002',source:'phone',lines:[{ kind:'item',itemId:'bravas',quantity:1 }] })) as core.CallableOutput<'crearParaLlevar'>
    if (take.status !== 'accepted') throw new Error('Pedido rechazado')
    const lines = (await db.collection(`${path}/orderLines`).where('takeawayId','==',take.takeawayId).get()).docs.map(d => d.id)
    const opened = await call('abrirCuenta',{ ...mutation(),target:{ kind:'takeaway',id:take.takeawayId } })
    const cashSessionId = await cash(), d = await lock(opened.billId)
    await floor.marcharPase.run(req({ ...scope(),takeawayId:take.takeawayId,course:'all' }))
    await floor.cambiarEstadoLineas.run(req({ ...scope(),lineIds:lines,status:'served' }))
    await expect(floor.cambiarEstadoParaLlevar.run(req({ ...scope(),takeawayId:take.takeawayId,status:'picked_up' }))).rejects.toMatchObject({ code:'failed-precondition' })
    await expect(floor.cambiarEstadoParaLlevar.run(req({ ...scope(),takeawayId:take.takeawayId,status:'cancelled',reason:'Error' }))).rejects.toMatchObject({ code:'failed-precondition' })
    await pay(d,cashSessionId,opened.bill.totalCents)
    await floor.cambiarEstadoParaLlevar.run(req({ ...scope(),takeawayId:take.takeawayId,status:'picked_up' }))
    expect((await db.doc(`${path}/takeaways/${take.takeawayId}`).get()).get('status')).toBe('picked_up')
    await invoice(d)
  })
  it('congela IVA del menú y mueve el padre con sus suplementos al repartir por platos',async () => {
    await db.doc(`${path}/dailyMenus/mediodia`).update({ days:['mon','tue','wed','thu','fri','sat','sun'],from:'00:00',to:'23:59',taxRate:4 })
    const session = await floor.abrirMesa.run(req({ ...scope(),tableIds:['t1'],guests:2 })) as core.CallableOutput<'abrirMesa'>
    await floor.enviarPedido.run(req({ ...scope(),sessionId:session.sessionId,lines:[{ kind:'menu',dailyMenuId:'mediodia',quantity:2,selections:[{ sectionId:'primeros',itemId:'sopa' },{ sectionId:'segundos',itemId:'entrecot',optionIds:['punto','roquefort'] },{ sectionId:'postres',itemId:'crema' }] }] }))
    const opened = await call('abrirCuenta',{ ...mutation(),target:{ kind:'session',id:session.sessionId } })
    expect(opened.bill.totalCents).toBe(4300); expect(opened.bill.lines.every(l => l.taxRate === 4)).toBe(true)
    const parent = opened.bill.lines.find(l => l.parentLineId === null)!
    const split = await call('dividirCuenta',{ ...mutation(),billId:opened.billId,expectedRevision:1,split:{ kind:'dishes',lineIds:[[parent.lineId]] } })
    expect(split.parts[0]!.allocations).toHaveLength(4)
    const d = await lock(opened.billId), inv = await invoice(d)
    expect((await db.doc(`${path}/invoices/${inv.invoiceId}`).get()).get('taxes')[0].taxRate).toBe(4)
  })
  it('el QR no añade consumo a una cuenta bloqueada',async () => {
    const f = await fixture(), qr = await floor.regenerarQrMesa.run(req({ ...scope(),tableIds:['t1'] })) as core.CallableOutput<'regenerarQrMesa'>
    await lock(f.billId)
    await expect(floor.pedirDesdeMesa.run(req({ slug:rid,locationId:lid,tableId:'t1',token:qr.tokens[0]!.token,sessionId:f.sessionId,lines:[{ kind:'item',itemId:'bravas',quantity:1 }],expectedTotalCents:f.bill.totalCents / 2,language:'es',website:'' },null))).rejects.toMatchObject({ code:'failed-precondition' })
  })
  it('aplica la señal pagada parcialmente una sola vez y el cierre desde Reservas exige caja',async () => {
    const date = core.sumarDias(core.horaLocal(Date.now(),'Europe/Madrid').fecha,1)
    const reservation = await reservationApi.crearReserva.run(req({ ...scope(),date,time:'13:00',guestName:'Señal',phone:'600000003',partySize:2,tableIds:['t1'],source:'phone' })) as core.CallableOutput<'crearReserva'>
    await db.doc(`${path}/reservations/${reservation.reservationId}`).update({ deposit:{ status:'paid',amountCents:500,checkoutSessionId:'cs_deposit_local' } })
    await reservationApi.cambiarEstadoReserva.run(req({ ...scope(),reservationId:reservation.reservationId,status:'seated' }))
    const session = (await db.collection(`${path}/tableSessions`).where('reservationId','==',reservation.reservationId).get()).docs[0]!
    const order = await floor.enviarPedido.run(req({ ...scope(),sessionId:session.id,lines:[{ kind:'item',itemId:'bravas',quantity:1 }] })) as core.CallableOutput<'enviarPedido'>
    if (order.status !== 'sent') throw new Error('Pedido rechazado')
    const opened = await call('abrirCuenta',{ ...mutation(),target:{ kind:'session',id:session.id } }), d = await lock(opened.billId), cashSessionId = await cash()
    await floor.cambiarEstadoLineas.run(req({ ...scope(),lineIds:order.lineIds,status:'served' }))
    await expect(reservationApi.cambiarEstadoReserva.run(req({ ...scope(),reservationId:reservation.reservationId,status:'finished' }))).rejects.toMatchObject({ code:'failed-precondition' })
    const input = { ...mutation(),...d,cashSessionId,method:'deposit',amountCents:300 }
    expect(await call('registrarCobro',input)).toEqual(await call('registrarCobro',input))
    await expect(call('registrarCobro',{ ...mutation(),...d,cashSessionId,method:'deposit',amountCents:201 })).rejects.toMatchObject({ code:'failed-precondition' })
    await call('registrarCobro',{ ...mutation(),...d,cashSessionId,method:'deposit',amountCents:200 })
    await pay(d,cashSessionId,opened.bill.totalCents - 500)
    await reservationApi.cambiarEstadoReserva.run(req({ ...scope(),reservationId:reservation.reservationId,status:'finished' }))
    expect((await db.doc(`${path}/tableSessions/${session.id}`).get()).get('status')).toBe('closed')
    expect((await db.doc(`${path}/depositApplications/${reservation.reservationId}`).get()).get('amountCents')).toBe(500)
  })
  it('anula un registro sin venta y conserva el número; impide anular una venta cobrada',async () => {
    const f = await fixture(), d = await lock(f.billId), inv = await invoice(d)
    await expect(call('anularRegistroFiscal',{ ...mutation(),invoiceId:inv.invoiceId,reason:'No es una anulación de operación' })).rejects.toMatchObject({ code:'failed-precondition' })
    // Evidencia de ausencia de operación revisada: la sesión se anuló por un proceso de reparación.
    await db.doc(`${path}/tableSessions/${f.sessionId}`).update({ status:'cancelled' })
    const cancellation = await call('anularRegistroFiscal',{ ...mutation(),invoiceId:inv.invoiceId,reason:'Emisión errónea sin operación ni cobro' })
    expect((await db.doc(`restaurants/${rid}/fiscalRecords/${cancellation.recordId}`).get()).get('input.kind')).toBe('anulacion')
    expect((await db.doc(`${path}/invoices/${inv.invoiceId}`).get()).get('number')).toBe(inv.number)
    const records = (await db.collection(`restaurants/${rid}/fiscalRecords`).orderBy('input.chainSequence').get()).docs.map(d => core.FiscalStoredRecordSchema.parse(d.data()))
    expect(core.verifyFiscalChain(records)).toBe(true)
  })
  it('reintenta un timeout con el mismo XML y subsana un rechazo sin nuevo número',async () => {
    const f = await fixture(), d = await lock(f.billId), inv = await invoice(d)
    const artifact = (await db.doc(`restaurants/${rid}/fiscalRecords/${inv.recordId}`).get()).get('xml')
    const provider = core.createTestFiscalProvider(), sent: string[] = []
    provider.submit = async a => { sent.push(a.xml); throw new Error('Timeout de prueba') }
    await processFiscalOutbox(rid,provider)
    provider.submit = async a => { sent.push(a.xml); return { status:'rejected',provider:'local_test',externalId:null,csv:null,errorCode:'test_rejection',message:'Rechazo de prueba',retryAfterSeconds:null } }
    await processFiscalOutbox(rid,provider,Date.now() + 120000)
    expect(sent).toEqual([artifact,artifact])
    expect(await processFiscalOutbox(rid,provider,Date.now() + 180000)).toEqual({ processed:0 })
    const input = { ...mutation(),recordId:inv.recordId,reason:'Revisión técnica local del rechazo' }
    const corrected = await correctRejectedFiscalRecord(input,'manager')
    expect(await correctRejectedFiscalRecord(input,'manager')).toEqual(corrected)
    expect(corrected.number).toBe(inv.number)
    expect((await db.collection(`${path}/invoices`).get()).size).toBe(1)
    expect((await db.doc(`restaurants/${rid}/fiscalRecords/${corrected.recordId}`).get()).get('input.subsanacion')).toBe(true)
    expect(await processFiscalOutbox(rid)).toEqual({ processed:1 })
  })
  it('la instalación no se duplica entre restaurantes y las series usadas no se reinician',async () => {
    const first = settings(), oldRid = rid
    const foreign = `fase3-${randomUUID()}`; roots.push(foreign)
    await db.doc(`restaurants/${foreign}`).set((await db.doc(`restaurants/${rid}`).get()).data()!)
    await db.doc(`restaurants/${foreign}/locations/centro`).set({ name:'Otro' })
    await db.doc(`restaurants/${foreign}/members/owner`).set({ uid:'owner',displayName:'Owner',email:'owner@test.es',role:'owner',active:true,locationIds:[] })
    await expect(call('guardarConfiguracionCaja',{ ...mutation(),restaurantId:foreign,settings:first })).rejects.toMatchObject({ code:'failed-precondition' })
    const f = await fixture(), d = await lock(f.billId); await invoice(d)
    await expect(call('guardarConfiguracionCaja',{ ...mutation(),settings:{ ...first,system:{ ...first.system,installation:'otra' } } })).rejects.toMatchObject({ code:'failed-precondition' })
    const currentSeries = `${path}/invoiceSeries/${first.ordinarySeriesId}`
    await db.doc(currentSeries).update({ lastSequence:9 })
    const f2 = await fixture(1,'t2'), d2 = await lock(f2.billId)
    await expect(invoice(d2)).rejects.toMatchObject({ code:'failed-precondition' })
    expect(rid).toBe(oldRid)
  })

  it('devuelve propina desde otra caja, la descuenta del reparto original y paga una sola vez',async () => {
    const f = await fixture(), firstCash = await cash(), d = await lock(f.billId)
    const payment = await pay(d,firstCash,f.bill.totalCents,{ tipCents:100,tenderedCents:f.bill.totalCents + 100 })
    const counted = 10000 + f.bill.totalCents + 100
    await call('cerrarCaja',{ ...mutation(),cashSessionId:firstCash,countedCents:counted,reason:null })
    const nextCash = await cash()
    await call('devolverCobro',{ ...mutation(),paymentId:payment.paymentId,amountCents:0,tipCents:40,reason:'Propina devuelta al cliente' })
    const distribution = await call('repartirPropinas',{ ...mutation(),cashSessionId:firstCash,hours:[{ uid:'owner',minutes:60 }] })
    expect(distribution.shares[0]!.amountCents).toBe(60)
    const input = { ...mutation(),distributionId:distribution.distributionId,cashSessionId:nextCash,reason:'Entrega del reparto aprobado' }
    await expect(payTipDistribution(input,'waiter')).rejects.toMatchObject({ code:'permission-denied' })
    const [one,two] = await Promise.all([payTipDistribution(input,'owner'),payTipDistribution(input,'owner')])
    expect(one).toEqual(two)
    await expect(payTipDistribution({ ...input,requestId:randomUUID() },'owner')).rejects.toMatchObject({ code:'failed-precondition' })
    await expect(call('devolverCobro',{ ...mutation(),paymentId:payment.paymentId,amountCents:0,tipCents:1,reason:'Reparto ya aprobado' })).rejects.toMatchObject({ code:'failed-precondition' })
    const closed = await call('cerrarCaja',{ ...mutation(),cashSessionId:nextCash,countedCents:9900,reason:null })
    expect(closed.cashSession.expectedCents).toBe(9900)
    expect((await db.doc(`${path}/cashSessions/${firstCash}`).get()).get('expectedCents')).toBe(counted)
  })

  it('dos devoluciones concurrentes reservan solo lo cobrado',async () => {
    const f = await fixture(), cashSessionId = await cash(), d = await lock(f.billId)
    const payment = await pay(d,cashSessionId,f.bill.totalCents)
    const refund = () => call('devolverCobro',{ ...mutation(),paymentId:payment.paymentId,amountCents:f.bill.totalCents,reason:'Devolución completa' })
    const results = await Promise.allSettled([refund(),refund()])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect((await current(f.billId)).bill.refundedCents).toBe(f.bill.totalCents)
  })

  it('el cierre conserva el servicio de fase 2 cuando pos está apagado',async () => {
    const f = await fixture()
    await db.doc(`restaurants/${rid}`).update({ activeModules:['floor','kitchen','reservations'] })
    await floor.cambiarEstadoLineas.run(req({ ...scope(),lineIds:f.lineIds,status:'served' }))
    await floor.cambiarEstadoMesa.run(req({ ...scope(),sessionId:f.sessionId,status:'closed' }))
    expect((await db.doc(`${path}/tableSessions/${f.sessionId}`).get()).get('status')).toBe('closed')
  })

  it('un registro fiscal mal formado deja incidencia sin gastar número',async () => {
    const f = await fixture(), d = await lock(f.billId), inv = await invoice(d)
    await db.doc(`restaurants/${rid}/fiscalRecords/${inv.recordId}`).update({ hash:'inválida' })
    const second = await fixture(1,'t2'), d2 = await lock(second.billId)
    await expect(invoice(d2)).rejects.toMatchObject({ code:'failed-precondition' })
    expect((await db.collection(`restaurants/${rid}/fiscalIncidents`).get()).size).toBe(1)
    expect((await db.doc(`${path}/invoiceSeries/${settings().ordinarySeriesId}`).get()).get('lastSequence')).toBe(1)
  })

  it('dos trabajadores fiscales no remiten dos veces y la remisión rechaza XML manipulado',async () => {
    const f = await fixture(), d = await lock(f.billId), inv = await invoice(d)
    const results = await Promise.all([processFiscalOutbox(rid),processFiscalOutbox(rid)])
    expect(results.reduce((sum,r) => sum + r.processed,0)).toBe(1)
    expect((await db.collection(`restaurants/${rid}/fiscalResponses`).get()).size).toBe(1)
    const second = await fixture(1,'t2'), d2 = await lock(second.billId)
    await invoice(d2)
    await db.doc(`restaurants/${rid}/fiscalRecords/${inv.recordId}`).update({ xml:'XML alterado después de generar' })
    expect(await processFiscalOutbox(rid)).toEqual({ processed:0 })
    expect((await db.collection(`restaurants/${rid}/fiscalIncidents`).get()).size).toBe(1)
    expect((await db.collection(`restaurants/${rid}/fiscalResponses`).get()).size).toBe(1)
  })

})
