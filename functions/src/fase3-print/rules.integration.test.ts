import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { initializeTestEnvironment, assertFails, assertSucceeds, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { doc, getDoc, setDoc, getDocs, collection } from 'firebase/firestore'

const enabled = process.env.TEST_FIREBASE_EMULATORS === '1' && process.env.GCLOUD_PROJECT === 'demo-llenamos' && !!process.env.FIRESTORE_EMULATOR_HOST
/** Datos de integración para el coordinador. No cambia firebase/**. */
export const printRules = `
    match /restaurants/{rid}/locations/{lid}/printers/{id} {
      allow read: if local(rid,lid) && module(rid,'pos') && manages(rid);
    }
    match /restaurants/{rid}/locations/{lid}/printStatuses/{id} {
      allow read: if local(rid,lid) && module(rid,'pos') && member(rid).role in ['owner','manager','waiter'];
    }
`
describe.skipIf(!enabled)('Reglas propuestas de impresión, sin editar firebase', () => {
  let env: RulesTestEnvironment
  const rid = 'print-rules', path = `restaurants/${rid}/locations/centro`
  beforeAll(async () => {
    const original = await readFile(resolve(import.meta.dirname, '../../../firebase/firestore.rules'), 'utf8')
    const rules = original.replace('    function member(rid)', printRules + '\n    function member(rid)')
    const [host,port] = process.env.FIRESTORE_EMULATOR_HOST!.split(':')
    env = await initializeTestEnvironment({ projectId:'demo-llenamos',firestore:{ host,port:Number(port),rules } })
    await env.withSecurityRulesDisabled(async c => {
      const db = c.firestore()
      await setDoc(doc(db,`restaurants/${rid}`),{plan:'completo',activeModules:['pos']})
      for (const role of ['owner','manager','waiter','kitchen','bar','limited','inactive']) await setDoc(doc(db,`restaurants/${rid}/members/${role}`), { active:role !== 'inactive',role:['limited','inactive'].includes(role)?'owner':role,locationIds:role === 'limited'?['otro']:[] })
      for (const name of ['printers','printStatuses','printJobs','printRequests','printBridges','printLeases','printIntents','printCopies']) await setDoc(doc(db,`${path}/${name}/test`), {status:'queued'})
    })
  })
  afterAll(async () => { await env?.cleanup() })
  it('solo responsables leen impresoras; camarero lee únicamente proyección', async () => {
    for (const role of ['owner','manager']) await assertSucceeds(getDocs(collection(env.authenticatedContext(role).firestore(),`${path}/printers`)))
    await assertFails(getDoc(doc(env.authenticatedContext('waiter').firestore(),`${path}/printers/test`)))
    await assertSucceeds(getDocs(collection(env.authenticatedContext('waiter').firestore(),`${path}/printStatuses`)))
  })
  it('niega público, cocina, barra, otro local e inactivo', async () => {
    for (const role of ['kitchen','bar','limited','inactive']) for (const name of ['printers','printStatuses']) await assertFails(getDoc(doc(env.authenticatedContext(role).firestore(),`${path}/${name}/test`)))
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(),`${path}/printStatuses/test`)))
  })
  it('privados y escrituras se deniegan incluso al propietario', async () => {
    const db=env.authenticatedContext('owner').firestore()
    for (const name of ['printJobs','printRequests','printBridges','printLeases','printIntents','printCopies']) await assertFails(getDoc(doc(db,`${path}/${name}/test`)))
    for (const name of ['printers','printStatuses']) await assertFails(setDoc(doc(db,`${path}/${name}/test`), {updatedBy:'owner'}))
  })
  it('apagar pos impide leer incluso al propietario', async () => {
    await env.withSecurityRulesDisabled(c => setDoc(doc(c.firestore(),`restaurants/${rid}`),{activeModules:[]},{merge:true}))
    await assertFails(getDoc(doc(env.authenticatedContext('owner').firestore(),`${path}/printers/test`)))
    await env.withSecurityRulesDisabled(c => setDoc(doc(c.firestore(),`restaurants/${rid}`),{activeModules:['pos']},{merge:true}))
  })
})
