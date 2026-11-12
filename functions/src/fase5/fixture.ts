import { randomUUID } from 'node:crypto'
import type { CallableRequest } from 'firebase-functions/v2/https'
import * as core from '@llenamos/core'
import { db } from '../shared'
import { execute } from './index'
import { type Name,ts } from './context'
export const enabled = process.env.TEST_FIREBASE_EMULATORS === '1' && process.env.GCLOUD_PROJECT === 'demo-llenamos' && /^(127\.0\.0\.[12]|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')
export const now = Date.now()
export const req = (uid:string|null='owner',logiqd=false) => ({ ...(uid ? { auth:{ uid,token:{ logiqd } } } : {}) }) as unknown as CallableRequest<unknown>
const roots:string[] = []
export async function fixture() {
  const rid = `f5-${randomUUID()}`, root = db.doc(`restaurants/${rid}`), path = `${root.path}/locations/centro`
  roots.push(rid)
  await root.set({ name:'Prueba fase 5',slug:rid,brandColor:'#f0a35e',timezone:'Europe/Madrid',locale:'es',currency:'EUR',isDemo:true,plan:'completo',activeModules:[...core.MODULES] })
  for (const lid of ['centro','otro']) await root.collection('locations').doc(lid).set({ name:lid })
  for (const uid of ['owner','manager','waiter','kitchen','bar','limited','inactive']) await root.collection('members').doc(uid).set({ uid,displayName:uid,email:`${uid}@lumbre.test`,role:['limited','inactive'].includes(uid) ? 'owner' : uid,active:uid !== 'inactive',locationIds:uid === 'limited' ? ['otro'] : [] })
  await root.collection('settings').doc('loyalty').set({ ...core.defaultLoyaltySettings(),enabled:true })
  await root.collection('settings').doc('repite').set({ merchantId:'demo-lumbre',enabled:true,stampOn:'both',autoCreateCard:true })
  await root.collection('customers').doc('aaaaaaaaaaaaaaaaaaaa').set({ name:'Ana Ruiz',phone:'+34600100200',email:'ana@lumbre.test',language:'es',visits:4,noShows:0,cancellations:0,lastVisitAt:ts(now-86400000),spentCents:10000,tags:[],notes:'',allergies:'' })
  await db.doc(`${path}/settings/reservations`).set(core.defaultReservationSettings())
  const scope = () => ({ restaurantId:rid }), mutation = () => ({ ...scope(),requestId:randomUUID() }), local = () => ({ ...scope(),locationId:'centro' }), lm = () => ({ ...local(),requestId:randomUUID() })
  return { rid,root,path,scope,mutation,local,lm,call:<N extends Name>(name:N,d:unknown,uid:string|null='owner',at=now) => execute(name,d,req(uid),{ now:at }) }
}
export async function cleanup() { for (const rid of roots) await db.recursiveDelete(db.doc(`restaurants/${rid}`)); roots.length=0 }
export async function bill(fx:Awaited<ReturnType<typeof fixture>>,id='b1',customerId:string|null='aaaaaaaaaaaaaaaaaaaa',status:core.BillStatus='open') {
  const b:core.Bill = { target:{ kind:'session',id:`s-${id}` },customerId,status,revision:1,lines:[{ lineId:`l-${id}`,parentLineId:null,name:'Plato',quantity:1,grossCents:10000,taxRate:10,guest:null }],adjustments:[],totalCents:10000,paidCents:status === 'settled' ? 10000 : 0,refundedCents:0,openedAt:now-3600000,lockedAt:null,settledAt:status === 'settled' ? now : null }
  await db.doc(`${fx.path}/bills/${id}`).set(core.billForWrite(b,n => ts(n)))
  await db.doc(`${fx.path}/tableSessions/s-${id}`).set({ status:status === 'settled' ? 'closed' : 'open',tableIds:['t1'],label:'S1',guests:2,reservationId:'r1',customerId,guestName:'Ana',waiterUid:null,waiterName:null,notes:'',openedAt:ts(now-3600000),openedBy:'owner',closedAt:status === 'settled' ? ts(now) : null,closedBy:null,billRequestedAt:null,mergedInto:null,totalCents:10000,lineCount:1,unservedCount:0,history:[] })
  return b
}
export const rule:core.SegmentRule = { minVisits:null,maxVisits:null,lastVisitAtLeastDaysAgo:null,lastVisitAtMostDaysAgo:null,includeNeverVisited:true,maxNoShows:null,minSpentCents:null,tagsAny:[],tagsNone:[],languages:[],minPoints:null }
export const promotion:core.PromotionInput = { name:'Oferta',description:'',discount:{ kind:'amount',cents:500 },scope:{ kind:'bill' },locationIds:[],channels:['dine_in','qr','takeaway'],validFrom:null,validTo:null,weekdays:[],timeWindows:[],minSpendCents:0,maxDiscountCents:null,usageLimit:1,perCustomerLimit:null,code:null,stacking:'with_loyalty',priority:0 }
