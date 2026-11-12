import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest'
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc } from 'firebase/firestore'
let env: RulesTestEnvironment
const root = 'restaurants/caja', local = `${root}/locations/centro`
const visible = ['bills','billParts','payments','invoices','invoiceEvents','printStatuses']
const managed = ['billAdjustments','cashSessions','cashMovements','tipDistributions','invoiceSeries','printers','settings','mobileIncidents']
const privateLocal = ['billTargets','registerLocks','posRequests','depositApplications','paymentEvents','mobileCheckouts','digitalReceipts','printRequests','printJobs','printBridges','printLeases','paymentReservations','refundReviews','printIntents','printCopies','mobileRequests','mobileStripeEvents']
const privateRoot = ['fiscalRecords','fiscalChains','fiscalOutbox','fiscalResponses','fiscalRequestKeys','invoiceNumbers','fiscalIncidents','mobileRateLimits']
const path = (key: string) => `${local}/${key}/${key === 'settings' ? 'pos' : 'uno'}`
const client = (uid?: string) => uid ? env.authenticatedContext(uid).firestore() : env.unauthenticatedContext().firestore()
beforeAll(async () => {
  const [host,port] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8098').split(':')
  env = await initializeTestEnvironment({ projectId:'demo-llenamos',firestore:{ host,port:Number(port),rules:readFileSync(new URL('../../firebase/firestore.rules',import.meta.url),'utf8') } })
})
beforeEach(async () => {
  await env.clearFirestore()
  await env.withSecurityRulesDisabled(async c => {
    const db = c.firestore()
    await setDoc(doc(db,root),{ plan:'completo',activeModules:['pos','floor'] })
    for (const role of ['owner','manager','waiter','kitchen','bar','inactive','limited']) await setDoc(doc(db,`${root}/members/${role}`),{ role:['inactive','limited'].includes(role) ? 'owner' : role,active:role !== 'inactive',locationIds:role === 'limited' ? ['otro'] : [] })
    for (const key of [...visible,...managed,...privateLocal]) await setDoc(doc(db,path(key)),{ tokenHash:'token',payloadBase64:'bytes',updatedBy:'owner' })
    for (const key of privateRoot) await setDoc(doc(db,`${root}/${key}/uno`),{})
    await setDoc(doc(db,'fiscalInstallations/uno'),{ restaurantId:'caja' })
  })
})
afterAll(async () => { await env?.cleanup() })
describe('Caja: aislamiento de historial, índices y credenciales',() => {
  for (const role of ['owner','manager','waiter']) it(`${role} lee solo los documentos de su permiso y nunca escribe caja`,async () => {
    const db = client(role)
    for (const key of visible) {
      await assertSucceeds(getDoc(doc(db,path(key)))); await assertSucceeds(getDocs(collection(db,`${local}/${key}`)))
    }
    for (const key of managed) await (role === 'waiter' ? assertFails : assertSucceeds)(getDoc(doc(db,path(key))))
    for (const key of [...visible,...managed,...privateLocal]) {
      await assertFails(setDoc(doc(db,path(key)),{ updatedBy:role }))
      await assertFails(updateDoc(doc(db,path(key)),{ updatedBy:role }))
      await assertFails(deleteDoc(doc(db,path(key))))
    }
  })
  for (const uid of [undefined,'kitchen','bar','inactive','limited','foreign']) it(`${uid ?? 'sin sesión'} no lee ninguna colección de caja`,async () => {
    const db = client(uid)
    for (const key of [...visible,...managed]) await assertFails(getDoc(doc(db,path(key))))
  })
  it('ni el propietario ni quien conoce tokens obtiene colecciones privadas',async () => {
    for (const uid of ['owner','manager','waiter',undefined]) {
      const db = client(uid)
      for (const key of privateLocal) { await assertFails(getDoc(doc(db,path(key)))); await assertFails(getDocs(collection(db,`${local}/${key}`))) }
      for (const key of privateRoot) await assertFails(getDoc(doc(db,`${root}/${key}/uno`)))
      await assertFails(getDoc(doc(db,'fiscalInstallations/uno')))
    }
  })
  it('apagar sala conserva historial; apagar pos oculta caja sin borrar nada',async () => {
    const db = client('owner')
    await env.withSecurityRulesDisabled(c => updateDoc(doc(c.firestore(),root),{ activeModules:['pos'] }))
    for (const key of ['bills','billParts']) await assertFails(getDoc(doc(db,path(key))))
    for (const key of ['invoices','payments','invoiceEvents','cashSessions','printStatuses']) await assertSucceeds(getDoc(doc(db,path(key))))
    await env.withSecurityRulesDisabled(c => updateDoc(doc(c.firestore(),root),{ activeModules:['floor'] }))
    for (const key of [...visible,...managed]) await assertFails(getDoc(doc(db,path(key))))
  })
  it('otro restaurante y otro local no autorizan lectura por id conocido',async () => {
    await env.withSecurityRulesDisabled(c => setDoc(doc(c.firestore(),'restaurants/otro/members/foreign'),{ role:'owner',active:true,locationIds:[] }))
    await assertFails(getDoc(doc(client('foreign'),path('payments'))))
    await assertFails(getDoc(doc(client('limited'),path('invoices'))))
  })
  it('los registros fiscales y la vinculación global rechazan altas, cambios y borrados de cliente',async () => {
    const db = client('owner')
    for (const key of privateRoot) {
      const ref = doc(db,`${root}/${key}/uno`)
      await assertFails(setDoc(ref,{ updatedBy:'owner' }))
      await assertFails(updateDoc(ref,{ updatedBy:'owner' }))
      await assertFails(deleteDoc(ref))
    }
    await assertFails(setDoc(doc(db,'fiscalInstallations/nueva'),{ restaurantId:'caja',updatedBy:'owner' }))
    await assertFails(deleteDoc(doc(db,'fiscalInstallations/uno')))
  })
})
