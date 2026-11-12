import { readFileSync } from 'node:fs'
import { afterAll,beforeAll,beforeEach,describe,it } from 'vitest'
import { initializeTestEnvironment,assertFails,assertSucceeds,type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { collection,doc,getDoc,getDocs,setDoc,updateDoc,deleteDoc,query,where,Timestamp } from 'firebase/firestore'
let env:RulesTestEnvironment
const root='restaurants/f5', local=`${root}/locations/centro`
const roles=['owner','manager','waiter','kitchen','bar','inactive','limited']
const client=(uid?:string)=>uid ? env.authenticatedContext(uid).firestore() : env.unauthenticatedContext().firestore()
const loyalty=['settings/loyalty','loyaltyAccounts/a','loyaltyRewards/r','loyaltyMovements/m']
const campaigns=['settings/marketing','segments/s','campaigns/c','campaigns/c/recipients/a']
const analytics=['settings/analytics','automationRules/r','recommendations/r']
const priv=['unsubscribeTokens/secret','marketingSendLog/a','repiteOutbox/op','automationEvents/e','dailySummaries/2026-11-10','fase5Requests/r','promotions/p/customerUses/a','fase5Health/worker']
beforeAll(async()=>{
 const [host,port]=(process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8096').split(':')
 env=await initializeTestEnvironment({projectId:'demo-llenamos',firestore:{host,port:Number(port),rules:readFileSync(new URL('../../firebase/firestore.rules',import.meta.url),'utf8')}})
})
beforeEach(async()=>{
 await env.clearFirestore()
 await env.withSecurityRulesDisabled(async c=>{
  const db=c.firestore(); await setDoc(doc(db,root),{plan:'completo',activeModules:['loyalty','repite','marketing','analytics','reservations','pos']})
  for(const uid of roles) await setDoc(doc(db,`${root}/members/${uid}`),{role:['inactive','limited'].includes(uid)?'owner':uid,active:uid!=='inactive',locationIds:uid==='limited'?['otro']:[]})
  for(const path of [...loyalty,...campaigns,...analytics,...priv,'settings/repite','repiteCards/a','loyaltyRedemptions/r','promotions/p','promotions/draft']) await setDoc(doc(db,`${root}/${path}`),{status:path==='promotions/draft'?'draft':'active',locationId:'centro',locationIds:['centro']})
  for(const path of ['analyticsDays/2026-11-10','billPromotions/b','reservationOrigins/r']) await setDoc(doc(db,`${local}/${path}`),{x:1})
 })
})
afterAll(async()=>{await env?.cleanup()})
describe('Fase 5 · reglas por rol, módulo y local',()=>{
 for(const role of roles) it(`${role}: puntos, campañas, Repite, análisis y secretos`,async()=>{
  const db=client(role),active=role!=='inactive',reader=['owner','manager','waiter','limited'].includes(role),manager=['owner','manager','limited'].includes(role),unlimited=role!=='limited'
  for(const p of loyalty) await (active&&reader?assertSucceeds:assertFails)(getDoc(doc(db,`${root}/${p}`)))
  for(const p of campaigns) await (active&&manager&&(!p.startsWith('campaigns')||unlimited)?assertSucceeds:assertFails)(getDoc(doc(db,`${root}/${p}`)))
  for(const p of analytics) await (active&&manager&&(p.startsWith('settings')||unlimited)?assertSucceeds:assertFails)(getDoc(doc(db,`${root}/${p}`)))
  await (reader&&active?assertSucceeds:assertFails)(getDoc(doc(db,`${root}/repiteCards/a`)))
  await (manager&&active?assertSucceeds:assertFails)(getDoc(doc(db,`${root}/settings/repite`)))
  await (reader&&active?assertSucceeds:assertFails)(getDoc(doc(db,`${root}/promotions/p`)))
  await (manager&&active?assertSucceeds:assertFails)(getDoc(doc(db,`${root}/promotions/draft`)))
  for(const p of priv) await assertFails(getDoc(doc(db,`${root}/${p}`)))
  await (manager&&active&&unlimited?assertSucceeds:assertFails)(getDoc(doc(db,`${local}/analyticsDays/2026-11-10`)))
  await (reader&&active&&unlimited?assertSucceeds:assertFails)(getDoc(doc(db,`${local}/billPromotions/b`)))
  await (reader&&active&&unlimited?assertSucceeds:assertFails)(getDoc(doc(db,`${local}/reservationOrigins/r`)))
 })
 it('el camarero consulta solo promociones activas, no la colección entera',async()=>{
  const db=client('waiter')
  await assertSucceeds(getDocs(query(collection(db,`${root}/promotions`),where('status','==','active'))))
  await assertFails(getDocs(collection(db,`${root}/promotions`)))
 })
 it('todos los documentos nuevos rechazan creación, modificación y borrado, incluso owner y logiqd',async()=>{
  for(const db of [client('owner'),env.authenticatedContext('owner',{logiqd:true}).firestore()]) for(const path of [...loyalty,...campaigns,...analytics,...priv,'repiteCards/a','promotions/p']) {
   await assertFails(setDoc(doc(db,`${root}/${path}`),{x:1,updatedBy:'owner'}))
   await assertFails(updateDoc(doc(db,`${root}/${path}`),{updatedBy:'owner'}))
   await assertFails(deleteDoc(doc(db,`${root}/${path}`)))
  }
 })
 it('módulos apagados, anónimo y otros restaurantes no leen',async()=>{
  await env.withSecurityRulesDisabled(c=>setDoc(doc(c.firestore(),root),{plan:'completo',activeModules:[]}))
  for(const uid of ['owner',undefined,'extraño']) for(const p of [...loyalty,...campaigns,...analytics,'repiteCards/a','promotions/p']) await assertFails(getDoc(doc(client(uid),`${root}/${p}`)))
 })
 it('entitlements caducados tampoco dan acceso a los módulos de fase 5',async()=>{
  await env.withSecurityRulesDisabled(c=>setDoc(doc(c.firestore(),root),{plan:'completo',activeModules:['loyalty','marketing','analytics','repite'],entitlementVersion:1,accessValidUntil:Timestamp.fromMillis(0)}))
  for(const p of [...loyalty,...campaigns,...analytics,'repiteCards/a']) await assertFails(getDoc(doc(client('owner'),`${root}/${p}`)))
 })
})
