import { readFileSync } from 'node:fs'
import { afterAll,beforeAll,describe,it } from 'vitest'
import { assertFails,initializeTestEnvironment,type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { doc,getDoc,setDoc,deleteDoc } from 'firebase/firestore'
import { ref,getBytes,uploadBytes,deleteObject } from 'firebase/storage'
let env:RulesTestEnvironment
const enabled = !!process.env.FIRESTORE_EMULATOR_HOST
const paths = ['restaurants/copias/backups/b','restaurants/copias/restoreDrills/d','restaurants/copias/backupRequests/r','restaurants/copias/backupHealth/worker','restoreSandbox/restore-x/restaurants/copias/customers/c','restaurants/copias/webhookSecrets/e_1','restaurants/copias/locations/centro/staffPins/u']
const files = ['platform/copias/backups/b/snapshot.enc','platform/copias/exports/j/datos.enc','restore-drills/restore-x/restaurants/copias/foto.webp']
describe.skipIf(!enabled)('Copias y simulacro: nada accesible por SDK',() => {
  beforeAll(async () => {
    const [host,port] = process.env.FIRESTORE_EMULATOR_HOST!.split(':'),[sh,sp] = process.env.FIREBASE_STORAGE_EMULATOR_HOST!.split(':')
    env = await initializeTestEnvironment({ projectId:'demo-llenamos',firestore:{ host,port:Number(port),rules:readFileSync(new URL('../../firebase/firestore.rules',import.meta.url),'utf8') },storage:{ host:sh,port:Number(sp),rules:readFileSync(new URL('../../firebase/storage.rules',import.meta.url),'utf8') } })
    await env.withSecurityRulesDisabled(async c => {
      await setDoc(doc(c.firestore(),'restaurants/copias'),{ plan:'completo',activeModules:['pos','floor','reservations'] })
      for (const role of ['owner','manager']) await setDoc(doc(c.firestore(),`restaurants/copias/members/${role}`),{ role,active:true,locationIds:[] })
      for (const path of paths) await setDoc(doc(c.firestore(),path),{ private:true })
      for (const file of files) await uploadBytes(ref(c.storage(),file),new Uint8Array([1]))
    })
  })
  afterAll(async () => { await env?.cleanup() })
  it('ni propietario, encargado, equipo de LogiQD ni anónimos leen o escriben copias, simulacros o sus archivos',async () => {
    for (const uid of [null,'owner','manager','foreign','logiqd']) {
      const ctx = uid ? env.authenticatedContext(uid,uid === 'logiqd' ? { logiqd:true } : {}) : env.unauthenticatedContext()
      for (const path of paths) {
        await assertFails(getDoc(doc(ctx.firestore(),path)));await assertFails(setDoc(doc(ctx.firestore(),path),{ updatedBy:uid }));await assertFails(deleteDoc(doc(ctx.firestore(),path)))
      }
      for (const file of files) { await assertFails(getBytes(ref(ctx.storage(),file)));await assertFails(uploadBytes(ref(ctx.storage(),file),new Uint8Array([2])));await assertFails(deleteObject(ref(ctx.storage(),file))) }
    }
  })
})
