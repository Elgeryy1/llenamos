import { afterAll, describe, expect, it } from 'vitest'
import * as core from '@llenamos/core'
import { db } from '../shared'
import { enabled,fixture,cleanup,bill,now,promotion,rule } from './fixture'
import { accruePoints,reversePoints,expirePoints,stampBill,stampReservation,aggregateDay,evaluateAutomations,sendDailySummary } from './procesos'
import { processRepite } from './repite/service'
import { processCampaigns,unsubscribe,captureMarketingMessages } from './marketing'
import { context,ts } from './context'
import { facts,totalsFor,defaultAnalytics } from './analisis'

afterAll(cleanup,30000)
describe.skipIf(!enabled)('Fase 5 · backend real contra emuladores',() => {
  async function enroll(fx:Awaited<ReturnType<typeof fixture>>,points=100) {
    await fx.call('altaFidelizacion',{ ...fx.mutation(),customerId:'aaaaaaaaaaaaaaaaaaaa',acceptedTermsVersion:'1' })
    await fx.call('ajustarPuntos',{ ...fx.mutation(),customerId:'aaaaaaaaaaaaaaaaaaaa',points,reason:'Prueba' })
  }
  async function reward(fx:Awaited<ReturnType<typeof fixture>>) { return fx.call('guardarPremio',{ ...fx.mutation(),rewardId:null,expectedRevision:null,reward:{ name:'Premio',pointsCost:80,kind:'amount',valueCents:500,itemId:null,active:true } }) }
  async function promo(fx:Awaited<ReturnType<typeof fixture>>,stacking:'exclusive'|'with_loyalty'='with_loyalty') {
    const p = await fx.call('guardarPromocion',{ ...fx.mutation(),promotionId:null,expectedRevision:null,promotion:{ ...promotion,stacking } })
    await fx.call('cambiarEstadoPromocion',{ ...fx.mutation(),promotionId:p.promotionId,expectedRevision:p.revision,to:'active' }); return p.promotionId
  }
  it('rechaza cocina, camarero en campañas, local ajeno, módulo apagado y claim falso',async () => {
    const fx = await fixture()
    for (const uid of ['kitchen','bar','inactive',null]) await expect(fx.call('verCuentaFidelizacion',{ ...fx.scope(),customerId:'aaaaaaaaaaaaaaaaaaaa' },uid)).rejects.toMatchObject({ code:'permission-denied' })
    await expect(fx.call('previsualizarSegmento',{ ...fx.scope(),rule,channel:'email' },'waiter')).rejects.toMatchObject({ code:'permission-denied' })
    await expect(fx.call('panelAnalisis',{ ...fx.scope(),from:'2026-11-10',to:'2026-11-10',locationIds:['centro'] },'limited')).rejects.toMatchObject({ code:'permission-denied' })
    await expect(fx.call('vincularRepite',{ ...fx.mutation(),merchantId:'otro',reason:'Prueba' })).rejects.toMatchObject({ code:'permission-denied' })
    await fx.root.update({ activeModules:[] })
    await expect(fx.call('verCuentaFidelizacion',{ ...fx.scope(),customerId:'aaaaaaaaaaaaaaaaaaaa' })).rejects.toMatchObject({ code:'permission-denied' })
  },30000)
  it('idempotencia por actor, nombre y requestId, con rechazo de otra entrada y actividad',async () => {
    const fx = await fixture(); await enroll(fx)
    const data = { ...fx.mutation(),customerId:'aaaaaaaaaaaaaaaaaaaa',points:10,reason:'Ajuste' }
    expect(await fx.call('ajustarPuntos',data)).toEqual(await fx.call('ajustarPuntos',data))
    await expect(fx.call('ajustarPuntos',{ ...data,points:11 })).rejects.toMatchObject({ code:'already-exists' })
    expect((await fx.call('verCuentaFidelizacion',{ ...fx.scope(),customerId:'aaaaaaaaaaaaaaaaaaaa' })).available).toBe(110)
    expect((await fx.root.collection('activity').where('action','==','loyalty.adjusted').get()).size).toBe(2)
  },30000)
  it('dos liquidaciones acumulan solo una vez y la devolución quita la proporción una vez',async () => {
    const fx = await fixture(); await enroll(fx,1); await bill(fx,'b1','aaaaaaaaaaaaaaaaaaaa','settled')
    await Promise.all([accruePoints(fx.rid,'centro','b1',now),accruePoints(fx.rid,'centro','b1',now)])
    expect((await fx.call('verCuentaFidelizacion',{ ...fx.scope(),customerId:'aaaaaaaaaaaaaaaaaaaa' })).available).toBe(101)
    const payment:core.Payment = { billId:'b1',partId:'p',cashSessionId:'cash',kind:'refund',originalPaymentId:'charge',method:'card',status:'succeeded',amountCents:2500,tipCents:0,tenderedCents:0,changeCents:0,externalId:null,requestId:'refund',reason:'Prueba',at:now,by:'owner' }
    await db.doc(`${fx.path}/payments/refund`).set(core.paymentForWrite(payment,n=>ts(n)))
    await Promise.all([reversePoints(fx.rid,'centro','refund',now),reversePoints(fx.rid,'centro','refund',now)])
    expect((await fx.call('verCuentaFidelizacion',{ ...fx.scope(),customerId:'aaaaaaaaaaaaaaaaaaaa' })).available).toBe(76)
  },30000)
  it('no da puntos por cuentas liquidadas antes del alta en el programa',async () => {
    const fx = await fixture(); await enroll(fx,1)
    const b = await bill(fx,'historica','aaaaaaaaaaaaaaaaaaaa','settled')
    await db.doc(`${fx.path}/bills/historica`).update({ settledAt:ts(now-86400000) })
    expect(await accruePoints(fx.rid,'centro','historica',now)).toBe(false)
    expect((await fx.call('verCuentaFidelizacion',{ ...fx.scope(),customerId:b.customerId })).available).toBe(1)
  },30000)
  it('dos canjes a la vez no dejan saldo negativo y anular devuelve puntos',async () => {
    const fx = await fixture(); await enroll(fx); const r = await reward(fx); await bill(fx,'b1'); await bill(fx,'b2')
    const results = await Promise.all(['b1','b2'].map(billId => fx.call('canjearPuntos',{ ...fx.lm(),customerId:'aaaaaaaaaaaaaaaaaaaa',rewardId:r.rewardId,billId,expectedBillRevision:1 })))
    expect(results.map(r => r.status).sort()).toEqual(['applied','insufficient'])
    const applied = results.find(r => r.status === 'applied')!; if (applied.status !== 'applied') return
    const a = await fx.call('anularCanje',{ ...fx.lm(),redemptionId:applied.redemptionId,expectedBillRevision:2,reason:'Prueba' }); expect(a.available).toBe(100)
  },30000)
  it('dos cajas disputan el último cupo y quitar lo devuelve',async () => {
    const fx = await fixture(), id = await promo(fx); await bill(fx,'b1'); await bill(fx,'b2')
    const rs = await Promise.all(['b1','b2'].map(billId => fx.call('aplicarPromocion',{ ...fx.lm(),billId,promotionId:id,expectedBillRevision:1 })))
    expect(rs.map(r => r.status).sort()).toEqual(['applied','rejected'])
    expect(rs.find(r => r.status === 'rejected')).toMatchObject({ reason:'usage_limit' })
    const i = rs.findIndex(r => r.status === 'applied')
    await fx.call('quitarPromocion',{ ...fx.lm(),billId:`b${i+1}`,expectedBillRevision:2,reason:'Prueba' })
    expect((await fx.root.collection('promotions').doc(id).get()).get('uses')).toBe(0)
  },30000)
  it('una promoción exclusiva bloquea canje en ambos órdenes',async () => {
    const fx = await fixture(); await enroll(fx,200); const r = await reward(fx), id = await promo(fx,'exclusive'); await bill(fx,'b1'); await bill(fx,'b2')
    await fx.call('aplicarPromocion',{ ...fx.lm(),billId:'b1',promotionId:id,expectedBillRevision:1 })
    await expect(fx.call('canjearPuntos',{ ...fx.lm(),billId:'b1',customerId:'aaaaaaaaaaaaaaaaaaaa',rewardId:r.rewardId,expectedBillRevision:2 })).rejects.toMatchObject({ code:'failed-precondition' })
    await fx.call('quitarPromocion',{ ...fx.lm(),billId:'b1',expectedBillRevision:2,reason:'Prueba' })
    await fx.call('canjearPuntos',{ ...fx.lm(),billId:'b2',customerId:'aaaaaaaaaaaaaaaaaaaa',rewardId:r.rewardId,expectedBillRevision:1 })
    expect(await fx.call('aplicarPromocion',{ ...fx.lm(),billId:'b2',promotionId:id,expectedBillRevision:2 })).toMatchObject({ status:'rejected',reason:'stacking' })
  },30000)
  it('los puntos vencidos no se canjean y caducan solo una vez aun apagado el módulo',async () => {
    const fx = await fixture(); await enroll(fx)
    await fx.root.update({ activeModules:[] })
    await Promise.all([expirePoints(fx.rid,now+366*86400000),expirePoints(fx.rid,now+366*86400000)])
    expect((await fx.root.collection('loyaltyAccounts').doc('aaaaaaaaaaaaaaaaaaaa').get()).get('balance')).toBe(0)
    expect((await fx.root.collection('loyaltyMovements').where('kind','==','expire').get()).size).toBe(1)
  },30000)
  it('sentar y cobrar dan una operación y un sello; caída y reintento con la misma clave',async () => {
    const fx = await fixture(); await bill(fx,'b1','aaaaaaaaaaaaaaaaaaaa','settled')
    const r = { guestName:'Ana',phone:'+34600100200',email:null,language:'es',partySize:2,startAt:ts(now),durationMinutes:90,status:'seated',tableIds:['t1'],suggestedTableIds:[],suggestionReason:null,source:'web',notes:'',guestNotes:'',customerId:'aaaaaaaaaaaaaaaaaaaa',reference:'BCD234',manageTokenHash:core.sha256Hex('token'),deposit:{ status:'none',amountCents:0,checkoutSessionId:null },history:[],createdBy:null }
    await db.doc(`${fx.path}/reservations/r1`).set(r)
    await Promise.all([stampReservation(fx.rid,'centro','r1',now),stampBill(fx.rid,'centro','b1',now)])
    expect((await fx.root.collection('repiteOutbox').get()).size).toBe(1)
    const local = core.createLocalRepite({ merchantIds:['demo-lumbre'],now:()=>now })
    local.failNext({ code:'unavailable',message:'Caído',retryable:true })
    await processRepite(fx.rid,now,local.adapter)
    expect((await fx.root.collection('repiteOutbox').get()).docs[0]!.get('status')).toBe('queued')
    await processRepite(fx.rid,now+30001,local.adapter)
    await processRepite(fx.rid,now+60001,local.adapter)
    expect(local.stampsCount()).toBe(1)
    expect((await fx.root.collection('repiteCards').doc('aaaaaaaaaaaaaaaaaaaa').get()).get('externalRef')).not.toContain('aaaaaaaaaaaaaaaaaaaa')
  },30000)
  async function campaign(fx:Awaited<ReturnType<typeof fixture>>,consent=true) {
    if (consent) await fx.root.collection('consents').doc('permission').set({ customerId:'aaaaaaaaaaaaaaaaaaaa',purpose:'marketing_email',status:'granted',policyVersion:'1',at:ts(now-1000),source:'public',evidenceId:'r1' })
    const s = await fx.call('guardarSegmento',{ ...fx.mutation(),segmentId:null,expectedRevision:null,segment:{ name:'Todos',rule } })
    const c = await fx.call('guardarCampana',{ ...fx.mutation(),campaignId:null,expectedRevision:null,campaign:{ name:'Campaña',segmentId:s.segmentId,channel:'email',content:{ title:'Hola',body:'Volvemos',includeBookingLink:true },locationId:'centro' } })
    await fx.call('lanzarCampana',{ ...fx.mutation(),campaignId:c.campaignId,expectedRevision:1,at:null }); return c.campaignId
  }
  it('no encola sin permiso; baja cancela pendientes, token falso y repetido responden igual',async () => {
    const fx = await fixture(); await campaign(fx,false); await processCampaigns(fx.rid,now)
    expect((await fx.root.collection('messages').get()).size).toBe(0)
    const id = await campaign(fx)
    await processCampaigns(fx.rid,now)
    expect((await fx.root.collection('messages').get()).size).toBe(1)
    const message = (await fx.root.collection('messages').get()).docs[0]!, url = String(message.get('data.unsubscribeUrl')), token = new URL(url).searchParams.get('t')!
    expect(await unsubscribe(fx.rid,'falso'.repeat(8),now)).toEqual({ ok:true })
    await fx.root.update({ activeModules:[] })
    expect(await unsubscribe(fx.rid,token,now)).toEqual(await unsubscribe(fx.rid,token,now))
    expect((await message.ref.get()).get('status')).toBe('cancelled')
    expect((await fx.root.collection('consents').where('status','==','withdrawn').get()).size).toBe(1)
    expect((await fx.root.collection('campaigns').doc(id).collection('recipients').doc('aaaaaaaaaaaaaaaaaaaa').get()).get('status')).toBe('cancelled')
  },30000)
  it('vuelve a comprobar la baja al capturar, respeta frecuencia y ventana de envío',async () => {
    const fx = await fixture(); await campaign(fx); await processCampaigns(fx.rid,now)
    await fx.root.collection('consents').doc('withdrawn').set({ customerId:'aaaaaaaaaaaaaaaaaaaa',purpose:'marketing_email',status:'withdrawn',policyVersion:'1',at:ts(now),source:'public',evidenceId:'r1' })
    await captureMarketingMessages(fx.rid,now)
    expect((await fx.root.collection('messages').get()).docs[0]!.get('status')).toBe('cancelled')
    await fx.root.collection('consents').doc('withdrawn').delete()
    const id = await campaign(fx)
    expect(await processCampaigns(fx.rid,now)).toBe(0)
    expect((await fx.root.collection('campaigns').doc(id).collection('recipients').doc('aaaaaaaaaaaaaaaaaaaa').get()).get('excludedReason')).toBe('frequency')
    const later = await campaign(fx)
    expect(await processCampaigns(fx.rid,Date.UTC(2026,10,10,23))).toBe(0)
    expect((await fx.root.collection('campaigns').doc(later).get()).get('status')).toBe('scheduled')
  },30000)
  it('analyticsDays coincide con computeTotals y el panel; resumen y recomendaciones no duplican',async () => {
    const fx = await fixture(); await bill(fx,'b1','aaaaaaaaaaaaaaaaaaaa','settled')
    const expected = await db.runTransaction(async tx => { const c = await context(tx,fx.rid,null,undefined,'centro',now); const f = await facts(c,['centro'],'2026-11-10','2026-11-10'); return totalsFor(c,f,['centro'],'2026-11-10','2026-11-10') })
    expect(await aggregateDay(fx.rid,'centro','2026-11-10',now)).toEqual(expected)
    const panel = await fx.call('panelAnalisis',{ ...fx.scope(),from:'2026-11-10',to:'2026-11-10',locationIds:['centro'] })
    expect(panel.total).toEqual(core.deriveMetrics(expected))
    const settings = defaultAnalytics(); settings.dailySummary={ enabled:true,hour:'00:00',channels:['email'],recipientUids:['owner'],covers:'same' }
    await fx.call('guardarConfiguracionAnalisis',{ ...fx.mutation(),settings })
    await Promise.all([sendDailySummary(fx.rid,now),sendDailySummary(fx.rid,now)])
    expect((await fx.root.collection('dailySummaries').get()).size).toBe(1)
    expect((await fx.root.collection('messages').get()).size).toBe(1)
    await fx.call('guardarAutomatizacion',{ ...fx.mutation(),ruleId:null,expectedRevision:null,rule:{ name:'Revisar',enabled:true,event:'day.closed',conditions:{ all:[] },recommendation:{ kind:'review_day',note:null,segmentId:null },cooldownMinutes:0,locationIds:[] } })
    await Promise.all([evaluateAutomations(fx.rid,now),evaluateAutomations(fx.rid,now)])
    expect((await fx.root.collection('recommendations').get()).size).toBe(1)
  },30000)
})
