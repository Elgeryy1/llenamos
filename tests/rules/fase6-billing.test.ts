import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { doc, getDoc, setDoc, updateDoc, serverTimestamp, Timestamp } from 'firebase/firestore'

// Prueba las reglas comunes ya integradas (módulos por suscripción, locales de servidor y datos privados).
const base = readFileSync(new URL('../../firebase/firestore.rules',import.meta.url),'utf8')
let env: RulesTestEnvironment
const root = 'restaurants/fase6-billing-rules', local = `${root}/locations/principal`
describe('Reglas de Alta y Billing', () => {
  beforeAll(async () => {
    const [host,port] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8099').split(':')
    env = await initializeTestEnvironment({ projectId:'demo-llenamos',firestore:{ host,port:Number(port),rules:base } })
    await env.withSecurityRulesDisabled(async c => {
      const db = c.firestore()
      await setDoc(doc(db,root),{ name:'Restaurante local',brandColor:'#f0a35e',locale:'es',entitlementVersion:1,activeModules:['reservations','floor'],accessValidUntil:Timestamp.fromMillis(Date.now()-1000) })
      await setDoc(doc(db,`${root}/members/owner`),{ active:true,role:'owner',locationIds:[] })
      await setDoc(doc(db,local),{ name:'Principal',slug:'principal',address:'',city:'',phone:'',createdAt:Timestamp.fromMillis(1000),updatedAt:Timestamp.fromMillis(1000) })
      await setDoc(doc(db,`${local}/reservations/uno`),{ status:'confirmed' })
      await setDoc(doc(db,`${local}/areas/sala`),{ name:'Sala' })
      await setDoc(doc(db,`${root}/platform/subscription`),{ status:'trialing' })
      await setDoc(doc(db,'onboardings/privado'),{ ownerUid:'owner' })
      await setDoc(doc(db,'onboardingKeys/privado'),{ uid:'owner' })
    })
  })
  afterAll(async () => {
    await env.cleanup()
    const [host,port] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8099').split(':')
    const restore = await initializeTestEnvironment({ projectId:'demo-llenamos',firestore:{ host,port:Number(port),rules:base } })
    await restore.cleanup()
  })
  it('bloquea la lectura operativa al vencer aunque el worker no haya quitado los módulos', async () => {
    const db = env.authenticatedContext('owner').firestore()
    await assertFails(getDoc(doc(db,`${local}/reservations/uno`)))
    await assertFails(getDoc(doc(db,`${local}/areas/sala`)))
    await assertSucceeds(getDoc(doc(db,root)))
  })
  it('no deja manipular la proyección ni leer o escribir documentos privados', async () => {
    const db = env.authenticatedContext('owner').firestore()
    for (const patch of [{ activeModules:['pos'] },{ accessValidUntil:Timestamp.fromMillis(Date.now()+86400000) },{ commercialPlanId:'grupo' },{ entitlementVersion:0 }]) await assertFails(updateDoc(doc(db,root),{ ...patch,updatedBy:'owner',updatedAt:serverTimestamp() }))
    for (const path of ['onboardings/privado','onboardingKeys/privado','platformRequests/privado','restaurantSlugs/privado','billingEvents/privado',`${root}/billingIntents/privado`,`${root}/platform/subscription`]) {
      await assertFails(getDoc(doc(db,path))); await assertFails(setDoc(doc(db,path),{ updatedBy:'owner' }))
    }
  })
  it('impide crear locales por el SDK y sigue exigiendo updatedBy para identidad', async () => {
    const db = env.authenticatedContext('owner').firestore()
    await assertFails(setDoc(doc(db,`${root}/locations/otro`),{ name:'Otro local',slug:'otro',address:'',city:'',phone:'',createdAt:serverTimestamp(),updatedAt:serverTimestamp(),updatedBy:'owner' }))
    await assertFails(updateDoc(doc(db,root),{ name:'Nuevo nombre',updatedAt:serverTimestamp() }))
    await assertSucceeds(updateDoc(doc(db,root),{ name:'Nuevo nombre',updatedAt:serverTimestamp(),updatedBy:'owner' }))
  })
  it('una proyección vigente habilita reservas y un migrado sin módulos no hereda completo', async () => {
    await env.withSecurityRulesDisabled(async c => { await updateDoc(doc(c.firestore(),root),{ accessValidUntil:Timestamp.fromMillis(Date.now()+60000) }) })
    const db = env.authenticatedContext('owner').firestore()
    await assertSucceeds(getDoc(doc(db,`${local}/reservations/uno`)))
    await env.withSecurityRulesDisabled(async c => { await updateDoc(doc(c.firestore(),root),{ activeModules:[] }) })
    await assertFails(getDoc(doc(db,`${local}/reservations/uno`)))
    expect(base).toContain('request.time < r.accessValidUntil')
  })
})
