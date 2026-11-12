import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { assertFails, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { doc, setDoc } from 'firebase/firestore'
import { ref, uploadBytes, getBytes, listAll, deleteObject } from 'firebase/storage'

let env: RulesTestEnvironment
const paths = ['fiscal/registro.xml', 'locations/centro/invoices/factura.pdf', 'locations/centro/digitalReceipts/recibo.pdf', 'locations/centro/printJobs/trabajo.bin']
describe.skipIf(!process.env.FIREBASE_STORAGE_EMULATOR_HOST)('Artefactos privados de caja en Storage', () => {
  beforeAll(async () => {
    const [host, port] = process.env.FIRESTORE_EMULATOR_HOST!.split(':')
    const [storageHost, storagePort] = process.env.FIREBASE_STORAGE_EMULATOR_HOST!.split(':')
    env = await initializeTestEnvironment({ projectId: 'demo-llenamos',
      firestore: { host, port: Number(port), rules: readFileSync(new URL('../../firebase/firestore.rules', import.meta.url), 'utf8') },
      storage: { host: storageHost, port: Number(storagePort), rules: readFileSync(new URL('../../firebase/storage.rules', import.meta.url), 'utf8') } })
    await env.clearFirestore(); await env.clearStorage()
    await env.withSecurityRulesDisabled(async c => {
      await setDoc(doc(c.firestore(), 'restaurants/caja'), { plan: 'completo', activeModules: ['floor', 'pos'] })
      for (const role of ['owner', 'manager', 'waiter', 'kitchen', 'bar']) await setDoc(doc(c.firestore(), `restaurants/caja/members/${role}`), { role, active: true, locationIds: [] })
      for (const path of paths) await uploadBytes(ref(c.storage(), `restaurants/caja/${path}`), new Uint8Array([1]), { contentType: 'application/octet-stream' })
    })
  })
  afterAll(async () => { await env?.cleanup() })
  for (const uid of [undefined, 'owner', 'manager', 'waiter', 'kitchen', 'bar', 'foreign']) it(`${uid ?? 'token público'} no descarga, lista ni escribe artefactos`, async () => {
    const storage = uid ? env.authenticatedContext(uid).storage() : env.unauthenticatedContext().storage()
    for (const path of paths) {
      const file = ref(storage, `restaurants/caja/${path}`)
      await assertFails(getBytes(file)); await assertFails(uploadBytes(file, new Uint8Array([2])))
      await assertFails(deleteObject(file)); await assertFails(listAll(ref(storage, `restaurants/caja/${path.split('/').slice(0, -1).join('/')}`)))
    }
  })
})
