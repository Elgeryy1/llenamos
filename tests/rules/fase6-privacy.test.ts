import { readFileSync } from 'node:fs'
import { afterAll,beforeAll,describe,it } from 'vitest'
import { assertFails,assertSucceeds,initializeTestEnvironment,type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { doc,getDoc,setDoc } from 'firebase/firestore'
import { ref,getBytes,uploadBytes } from 'firebase/storage'
let env:RulesTestEnvironment
const enabled = !!process.env.FIRESTORE_EMULATOR_HOST
const baseline = readFileSync(new URL('../../firebase/firestore.rules',import.meta.url),'utf8')
describe.skipIf(!enabled)('Privacidad y reglas fiscales integradas',() => {
  beforeAll(async () => {
    const [host,port] = process.env.FIRESTORE_EMULATOR_HOST!.split(':'),[sh,sp] = process.env.FIREBASE_STORAGE_EMULATOR_HOST!.split(':')
    env = await initializeTestEnvironment({ projectId:'demo-llenamos',firestore:{ host,port:Number(port),rules:baseline },storage:{ host:sh,port:Number(sp),rules:readFileSync(new URL('../../firebase/storage.rules',import.meta.url),'utf8') } })
    await env.withSecurityRulesDisabled(async c => {
      await setDoc(doc(c.firestore(),'restaurants/privacidad'),{ plan:'completo',activeModules:['pos','floor','reservations'] })
      for (const role of ['owner','manager','waiter']) await setDoc(doc(c.firestore(),`restaurants/privacidad/members/${role}`),{ role,active:true,locationIds:[] })
      await setDoc(doc(c.firestore(),'restaurants/privacidad/locations/centro/invoices/fiscal'),{ recipient:{ name:'Conservado restringido' } })
      await setDoc(doc(c.firestore(),'restaurants/privacidad/locations/centro/privacyRestrictedInvoices/fiscal'),{ reason:'Conservación fiscal' })
      await setDoc(doc(c.firestore(),'restaurants/privacidad/locations/centro/invoices/normal'),{})
      for (const path of ['restaurants/privacidad/consents/c','restaurants/privacidad/privacyJobs/j','restaurants/privacidad/privacyEvidence/e','restaurants/privacidad/privacyTombstones/t','restaurants/privacidad/privacyDownloads/t','restoreSandbox/d/restaurants/privacidad/customers/c']) await setDoc(doc(c.firestore(),path),{ private:true })
      await uploadBytes(ref(c.storage(),'platform/privacidad/exports/j/datos.enc'),new Uint8Array([1]))
    })
  })
  afterAll(async () => {
    await env?.cleanup()
    const [host,port] = process.env.FIRESTORE_EMULATOR_HOST!.split(':')
    const reset = await initializeTestEnvironment({ projectId:'demo-llenamos',firestore:{ host,port:Number(port),rules:baseline } });await reset.cleanup()
  })
  it('nadie accede por SDK a evidencias, trabajos, tombstones o destinos restaurados',async () => {
    for (const uid of [null,'owner','manager','waiter','foreign','logiqd']) {
      const ctx = uid ? env.authenticatedContext(uid,uid === 'logiqd' ? { logiqd:true } : {}) : env.unauthenticatedContext()
      for (const path of ['restaurants/privacidad/consents/c','restaurants/privacidad/privacyJobs/j','restaurants/privacidad/privacyEvidence/e','restaurants/privacidad/privacyTombstones/t','restaurants/privacidad/privacyDownloads/t','restoreSandbox/d/restaurants/privacidad/customers/c']) {
        await assertFails(getDoc(doc(ctx.firestore(),path)));await assertFails(setDoc(doc(ctx.firestore(),path),{ updatedBy:uid }))
      }
      await assertFails(getBytes(ref(ctx.storage(),'platform/privacidad/exports/j/datos.enc')))
      await assertFails(uploadBytes(ref(ctx.storage(),'platform/privacidad/exports/j/datos.enc'),new Uint8Array([2])))
    }
  })
  it('el fragmento conserva el original fiscal y restringe su consulta tras suprimir a la persona',async () => {
    await assertFails(getDoc(doc(env.authenticatedContext('waiter').firestore(),'restaurants/privacidad/locations/centro/invoices/fiscal')))
    await assertSucceeds(getDoc(doc(env.authenticatedContext('waiter').firestore(),'restaurants/privacidad/locations/centro/invoices/normal')))
    for (const uid of ['owner','manager']) await assertSucceeds(getDoc(doc(env.authenticatedContext(uid).firestore(),'restaurants/privacidad/locations/centro/invoices/fiscal')))
  })
})
