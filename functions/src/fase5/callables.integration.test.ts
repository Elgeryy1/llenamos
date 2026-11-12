import { afterAll,describe,expect,it } from 'vitest'
import * as core from '@llenamos/core'
import { db } from '../shared'
import { fixture,cleanup,enabled,now,bill,rule,promotion,req } from './fixture'
import { execute,names } from './index'
import { ts } from './context'
import { processCampaigns } from './marketing'
import { defaultAnalytics } from './analisis'

afterAll(cleanup,30000)
describe.skipIf(!enabled)('Fase 5 · firmas y lecturas de las 39 callables',()=>{
 it('configuración y consultas usan las firmas congeladas y no devuelven contactos',async()=>{
  expect(names).toHaveLength(39)
  const fx=await fixture(),cid='aaaaaaaaaaaaaaaaaaaa'
  await fx.call('guardarConfiguracionFidelizacion',{...fx.mutation(),settings:{...core.defaultLoyaltySettings(),enabled:true}})
  await fx.call('guardarConfiguracionMarketing',{...fx.mutation(),settings:core.defaultMarketingSettings('Lumbre')})
  const segment=await fx.call('guardarSegmento',{...fx.mutation(),segmentId:null,expectedRevision:null,segment:{name:'Todos',rule}})
  const campaign=await fx.call('guardarCampana',{...fx.mutation(),campaignId:null,expectedRevision:null,campaign:{name:'Hola',segmentId:segment.segmentId,channel:'whatsapp',content:{title:'Vuelve',body:'Tenemos mesa',includeBookingLink:true},locationId:'centro'}})
  const preview=await fx.call('simularCampana',{...fx.scope(),campaignId:campaign.campaignId})
  expect(preview.excluded.no_consent).toBe(1)
  expect(preview.preview.body).toContain('/baja/')
  expect(JSON.stringify(await fx.call('previsualizarSegmento',{...fx.scope(),rule,channel:'email'}))).not.toContain('@lumbre.test')
  await expect(fx.call('lanzarCampana',{...fx.mutation(),campaignId:campaign.campaignId,expectedRevision:1,at:null},'manager')).rejects.toMatchObject({code:'permission-denied'})
  await fx.call('cancelarCampana',{...fx.mutation(),campaignId:campaign.campaignId,expectedRevision:1,reason:'Prueba'})
  expect((await fx.call('informeCampana',{...fx.scope(),campaignId:campaign.campaignId})).status).toBe('cancelled')
  const other=await fx.call('guardarSegmento',{...fx.mutation(),segmentId:null,expectedRevision:null,segment:{name:'Borrar',rule}})
  expect(await fx.call('borrarSegmento',{...fx.mutation(),segmentId:other.segmentId,expectedRevision:1})).toEqual({ok:true})
  await bill(fx)
  const p=await fx.call('guardarPromocion',{...fx.mutation(),promotionId:null,expectedRevision:null,promotion})
  expect((await fx.call('promocionesAplicables',{...fx.local(),billId:'b1'})).best).toBeNull()
  await fx.call('cambiarEstadoPromocion',{...fx.mutation(),promotionId:p.promotionId,expectedRevision:1,to:'active'})
  expect((await fx.call('promocionesAplicables',{...fx.local(),billId:'b1'})).best?.discountCents).toBe(500)
  expect((await fx.call('exportarAnalisis',{...fx.scope(),from:'2026-11-10',to:'2026-11-10',locationIds:['centro'],kind:'sales_by_day'})).csv.startsWith(core.CSV_BOM)).toBe(true)
  expect((await fx.call('previsionOcupacion',{...fx.local(),from:'2026-11-11',days:1})).days[0]?.confidence).toBe('low')
  expect(await fx.call('informeOrigen',{...fx.scope(),from:'2026-11-10',to:'2026-11-10',locationIds:null})).toEqual({rows:[],withoutOrigin:0})
  expect(await execute('vincularRepite',{...fx.mutation(),merchantId:'demo-lumbre',reason:'Prueba'},req('platform',true),{now})).toEqual({ok:true})
  expect(await fx.call('guardarAjustesRepite',{...fx.mutation(),settings:{enabled:true,stampOn:'both',autoCreateCard:true}})).toHaveProperty('ok',true)
  expect(await fx.call('crearTarjetaRepite',{...fx.mutation(),customerId:cid})).toHaveProperty('status','not_configured')
  expect(await fx.call('verTarjetaRepite',{...fx.scope(),customerId:cid})).toEqual({status:'no_card'})
  expect(await fx.call('darSelloRepite',{...fx.lm(),customerId:cid,reservationId:null,sessionId:'s-b1'})).toHaveProperty('status','queued')
  expect(await fx.call('avisarTeEchamosDeMenos',{...fx.mutation(),customerIds:[cid]})).toMatchObject({queued:0,skipped:[{reason:'no_card'}]})
  expect(await fx.call('informeRepite',{...fx.scope(),month:'2026-11'})).toHaveProperty('status','not_configured')
  expect(await fx.call('darseDeBaja',{slug:fx.rid,token:'x'.repeat(43)})).toEqual({ok:true})
 },30000)
 it('resuelve recomendaciones sin ejecutar nada y simula sin escribir',async()=>{
  const fx=await fixture(),automation={name:'No presentado',enabled:true,event:'reservation.no_show',conditions:{all:[]},recommendation:{kind:'require_deposit',note:null,segmentId:null},cooldownMinutes:0,locationIds:['centro']}
  const r=await fx.call('guardarAutomatizacion',{...fx.mutation(),ruleId:null,expectedRevision:null,rule:automation})
  await fx.root.collection('automationEvents').doc('no-show').set({id:'no-show',type:'reservation.no_show',locationId:'centro',subject:'cliente',at:ts(now),data:{partySize:2,customerNoShows:1,hasDeposit:false}})
  const simulation=await fx.call('simularAutomatizacion',{...fx.scope(),rule:automation,from:'2026-11-10',to:'2026-11-10'})
  expect(simulation.fired).toHaveLength(1)
  expect((await fx.root.collection('recommendations').get()).size).toBe(0)
  await fx.root.collection('recommendations').doc('recommendation').set({ruleId:r.ruleId,eventId:'no-show',eventType:'reservation.no_show',locationId:'centro',subject:'cliente',kind:'require_deposit',text:'Pedir señal',evidence:{},status:'open',createdAt:ts(now),expiresAt:ts(now+86400000),decidedBy:null,decidedAt:null,note:null})
  expect(await fx.call('resolverRecomendacion',{...fx.mutation(),recommendationId:'recommendation',decision:'accepted',note:null})).toEqual({status:'accepted',kind:'require_deposit'})
  expect((await fx.root.collection('campaigns').get()).size).toBe(0)
  expect(await fx.call('borrarAutomatizacion',{...fx.mutation(),ruleId:r.ruleId,expectedRevision:1})).toEqual({ok:true})
  const config=defaultAnalytics();config.dailySummary.recipientUids=['owner']
  await fx.call('guardarConfiguracionAnalisis',{...fx.mutation(),settings:config})
  await fx.root.collection('dailySummaries').doc('2026-11-10').set({text:'Resumen',sentTo:[]})
  expect(await fx.call('verResumenDiario',{...fx.scope(),date:'2026-11-10'})).toMatchObject({text:'Resumen',sentTo:[]})
 },30000)
 it('baja a mitad de una campaña paginada y contactos duplicados no producen envío sin permiso',async()=>{
  const fx=await fixture(),cid='bbbbbbbbbbbbbbbbbbbb'
  const ana=(await fx.root.collection('customers').doc('aaaaaaaaaaaaaaaaaaaa').get()).data()!
  await fx.root.collection('customers').doc(cid).set({...ana,name:'Berta',phone:'+34600100201',email:'berta@lumbre.test'})
  for(const id of ['aaaaaaaaaaaaaaaaaaaa',cid]) await fx.root.collection('consents').doc(id).set({customerId:id,purpose:'marketing_email',status:'granted',policyVersion:'1',at:ts(now-1000),source:'staff',evidenceId:'r1'})
  const s=await fx.call('guardarSegmento',{...fx.mutation(),segmentId:null,expectedRevision:null,segment:{name:'Todos',rule}})
  const c=await fx.call('guardarCampana',{...fx.mutation(),campaignId:null,expectedRevision:null,campaign:{name:'Prueba',segmentId:s.segmentId,channel:'email',content:{title:'Hola',body:'Vuelve',includeBookingLink:false},locationId:'centro'}})
  await fx.call('lanzarCampana',{...fx.mutation(),campaignId:c.campaignId,expectedRevision:1,at:null})
  expect(await processCampaigns(fx.rid,now,1)).toBe(1)
  await fx.root.collection('consents').doc('baja-berta').set({customerId:cid,purpose:'marketing_email',status:'withdrawn',policyVersion:'1',at:ts(now),source:'public',evidenceId:'r1'})
  expect(await processCampaigns(fx.rid,now,1)).toBe(0)
  expect((await fx.root.collection('messages').get()).size).toBe(1)
  expect((await fx.root.collection('campaigns').doc(c.campaignId).collection('recipients').doc(cid).get()).get('excludedReason')).toBe('withdrawn')
 },30000)
})
