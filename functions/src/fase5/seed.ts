/** Datos inventados de fase 5. Solo crea documentos ausentes y nunca reinicia saldos ni cupos. */
import * as core from '@llenamos/core'
import { db,auth } from '../shared'
import { ts } from './context'
import { execute } from './index'
import { defaultAnalytics } from './analisis'
import { type CallableRequest } from 'firebase-functions/v2/https'

export async function seedFase5() {
  if (process.env.GCLOUD_PROJECT !== 'demo-llenamos' || !/^(127\.0\.0\.[12]|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')) throw new Error('El seed de fase 5 solo funciona contra un emulador local.')
  const rid='demo-lumbre',lid='centro',root=db.doc(`restaurants/${rid}`),local=root.collection('locations').doc(lid),now=Date.now(),today=core.horaLocal(now,'Europe/Madrid').fecha
  const restaurant=await root.get(); if (!restaurant.exists) throw new Error('Ejecuta primero pnpm seed y pnpm seed:servicio.')
  const owner=await auth.getUserByEmail('propietario@lumbre.test')
  await root.update({ plan:'completo',activeModules:[...new Set([...core.restaurantModules(restaurant.data()!),...core.MODULES])],updatedBy:owner.uid })
  const request={auth:{uid:owner.uid,token:{}}} as unknown as CallableRequest<unknown>
  const m=(id:string)=>({restaurantId:rid,requestId:`seed-fase5-${id}`})
  const call=<N extends keyof typeof core.CALLABLES_FASE5>(name:N,data:unknown)=>execute(name,data,request)
  const absent=async(path:string,data:FirebaseFirestore.DocumentData)=>{ const ref=root.collection(path.split('/').slice(0,-1).join('/')).doc(path.split('/').at(-1)!); if (!(await ref.get()).exists) await ref.create({createdAt:ts(now),updatedAt:ts(now),updatedBy:owner.uid,...data}) }
  await call('guardarConfiguracionFidelizacion',{...m('programa'),settings:{...core.defaultLoyaltySettings(),enabled:true}})
  const rewards=[]
  for (const [id,name,cost,value] of [['cafe','Café de la casa',30,250],['postre','Un postre para volver',80,700]] as const) rewards.push(await call('guardarPremio',{...m(`premio-${id}`),rewardId:null,expectedRevision:null,reward:{name,pointsCost:cost,kind:'amount',valueCents:value,itemId:null,active:true}}))
  for (const [id,name,discount,stacking] of [['martes','Martes para volver',{kind:'percent',bp:1000},'with_loyalty'],['bienvenida','Bienvenida a Lumbre',{kind:'amount',cents:500},'exclusive']] as const) {
    const promotion=await call('guardarPromocion',{...m(`promo-${id}`),promotionId:null,expectedRevision:null,promotion:{name,description:'Promoción inventada de demostración',discount,scope:{kind:'bill'},locationIds:[lid],channels:['dine_in','takeaway','qr'],validFrom:null,validTo:null,weekdays:id==='martes'?[2]:[],timeWindows:[],minSpendCents:2000,maxDiscountCents:2000,usageLimit:100,perCustomerLimit:2,code:id==='bienvenida'?'LUMBRE':null,stacking,priority:0}})
    await call('cambiarEstadoPromocion',{...m(`activar-${id}`),promotionId:promotion.promotionId,expectedRevision:1,to:'active'})
  }
  const rule:core.SegmentRule={minVisits:1,maxVisits:null,lastVisitAtLeastDaysAgo:null,lastVisitAtMostDaysAgo:null,includeNeverVisited:false,maxNoShows:null,minSpentCents:null,tagsAny:[],tagsNone:[],languages:[],minPoints:null}
  const segment=await call('guardarSegmento',{...m('segmento'),segmentId:null,expectedRevision:null,segment:{name:'Clientes que ya vinieron',rule}})
  await call('guardarSegmento',{...m('ausentes'),segmentId:null,expectedRevision:null,segment:{name:'Hace tiempo que no vienen',rule:{...rule,lastVisitAtLeastDaysAgo:60}}})
  await call('guardarCampana',{...m('campana'),campaignId:null,expectedRevision:null,campaign:{name:'Volvemos a vernos',segmentId:segment.segmentId,channel:'email',content:{title:'Un sitio para volver',body:'Esta semana tenemos mesa para ti.',includeBookingLink:true},locationId:lid}})
  await call('guardarConfiguracionAnalisis',{...m('analisis'),settings:{...defaultAnalytics(),dailySummary:{enabled:false,hour:'09:00',channels:['email'],recipientUids:[owner.uid],covers:'previous'}}})
  await absent('settings/repite',{merchantId:'demo-lumbre',enabled:true,stampOn:'both',autoCreateCard:true})
  const customers=[]
  for (let n=0;n<4;n++) {
    const phone=`+3469900010${n}`,customerId=core.customerIdFor(rid,phone);customers.push(customerId)
    await absent(`customers/${customerId}`,{name:['Ana Prueba','Marc Prueba','Laia Prueba','Pau Prueba'][n],phone,email:`fase5-${n}@lumbre.test`,language:'es',visits:12,noShows:n===3?2:0,cancellations:0,lastVisitAt:ts(now-(n===2?80:7)*86400000),spentCents:30000,notes:'Cliente inventado para pruebas locales',allergies:'',tags:['fase5']})
    await call('altaFidelizacion',{...m(`alta-${n}`),customerId,acceptedTermsVersion:'1'})
    await call('ajustarPuntos',{...m(`saldo-${n}`),customerId,points:120,reason:'Saldo inventado para la demostración local'})
    // Solo las dos primeras personas dieron permiso; las demás prueban exclusiones.
    if (n<2) for (const purpose of ['marketing_email','marketing_whatsapp'] as const) await absent(`consents/fase5-${n}-${purpose}`,core.consentForWrite({customerId,purpose,status:'granted',policyVersion:'demo-1',at:now-60000,source:'staff',evidenceId:`fase5-demo-${n}`},n=>ts(n)))
  }
  for(let days=1;days<=84;days++) {
    const date=core.sumarDias(today,-days),id=`fase5-historia-${date}`,at=core.instanteDeHoraLocal(date,13*60,'Europe/Madrid')!,customerId=customers[days%4]!,guests=2+(days%3),total=guests*2500
    const reservation:core.Reservation=core.ReservationSchema.parse({guestName:'Cliente de prueba',phone:`+3469900010${days%4}`,email:null,language:'es',partySize:guests,startAt:at,durationMinutes:90,status:days%11===0?'no_show':'finished',tableIds:['sala-1'],suggestedTableIds:[],suggestionReason:null,source:days%2?'web':'phone',notes:'Historia inventada para la previsión',guestNotes:'',customerId,reference:core.reservationReference(new Uint8Array([days%248,30,25,12,5,4,2,3])),manageTokenHash:core.sha256Hex(id),deposit:{status:'none',amountCents:0,checkoutSessionId:null},history:[],createdBy:null})
    await absent(`locations/${lid}/reservations/${id}`,core.reservationForWrite(reservation,n=>ts(n)))
    const origin:core.ReservationOrigin={...core.classifyOrigin({reservationSource:reservation.source,attribution:days%2?core.attributionFromUrl('http://localhost/r/lumbre?utm_source=instagram',null):null,ownHosts:['127.0.0.1']}),date,partySize:guests,createdAt:at}
    await absent(`locations/${lid}/reservationOrigins/${id}`,core.reservationOriginForWrite(origin,n=>ts(n)))
    if (reservation.status==='no_show') continue
    await absent(`locations/${lid}/tableSessions/${id}`,{status:'closed',tableIds:['sala-1'],label:'S1',guests,reservationId:id,customerId,guestName:'Cliente de prueba',waiterUid:owner.uid,waiterName:'Marta',notes:'',openedAt:ts(at),openedBy:owner.uid,closedAt:ts(at+90*60000),closedBy:owner.uid,billRequestedAt:null,mergedInto:null,totalCents:total,lineCount:1,unservedCount:0,history:[]})
    const bill:core.Bill={target:{kind:'session',id},customerId,status:'settled',revision:1,lines:[{lineId:id,parentLineId:null,name:'Consumo de demostración',quantity:guests,grossCents:total,taxRate:10,guest:null}],adjustments:[],totalCents:total,paidCents:total,refundedCents:0,openedAt:at,lockedAt:at+85*60000,settledAt:at+90*60000}
    await absent(`locations/${lid}/bills/${id}`,core.billForWrite(bill,n=>ts(n)))
  }
  return {restaurantId:rid,customers,rewards,weeks:12,repite:'Doble local, sin Repite real',campaign:'Borrador sin envíos'}
}
