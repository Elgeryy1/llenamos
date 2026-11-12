import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest'
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { doc, setDoc, updateDoc } from 'firebase/firestore'
import { ref, uploadBytes, getBytes, listAll, deleteObject } from 'firebase/storage'

const enabled = !!process.env.FIREBASE_STORAGE_EMULATOR_HOST
const path = 'restaurants/uno/locations/centro/menu/plato/foto.webp'
let env: RulesTestEnvironment
const roles = ['owner','manager','waiter','kitchen','bar','inactive','limited','foreign']
const storage = (uid?: string) => uid ? env.authenticatedContext(uid).storage() : env.unauthenticatedContext().storage()
describe.skipIf(!enabled)('Fotos de carta con Storage y Firestore', () => {
  beforeAll(async () => {
    const [host, port] = process.env.FIRESTORE_EMULATOR_HOST!.split(':')
    const [storageHost, storagePort] = process.env.FIREBASE_STORAGE_EMULATOR_HOST!.split(':')
    env = await initializeTestEnvironment({ projectId: 'demo-llenamos', firestore: { host, port: Number(port), rules: readFileSync(new URL('../../firebase/firestore.rules', import.meta.url), 'utf8') }, storage: { host: storageHost, port: Number(storagePort), rules: readFileSync(new URL('../../firebase/storage.rules', import.meta.url), 'utf8') } })
  })
  beforeEach(async () => {
    await env.clearFirestore(); await env.clearStorage()
    await env.withSecurityRulesDisabled(async context => {
      const db = context.firestore()
      await setDoc(doc(db, 'restaurants/uno'), { plan: 'sala', activeModules: ['floor','kitchen'] })
      for (const role of roles) await setDoc(doc(db, `restaurants/uno/members/${role}`), { active: role !== 'inactive', role: ['inactive','limited','foreign'].includes(role) ? 'owner' : role, locationIds: role === 'limited' ? ['otro'] : [] })
      await setDoc(doc(db, 'restaurants/uno/members/foreign'), { active: false, role: 'owner', locationIds: [] })
      await setDoc(doc(db, 'restaurants/uno/locations/centro/menuItems/plato'), { active: true, photoPath: path })
      await uploadBytes(ref(context.storage(), path), new Uint8Array([1,2,3]), { contentType: 'image/webp' })
    })
  })
  afterAll(async () => { await env?.cleanup() })
  it('no acepta un ID token anterior al relevo de la cuenta para escribir fotos', async () => {
    await env.withSecurityRulesDisabled(async context => { await setDoc(doc(context.firestore(), 'identitySecurity/owner'), { version: 'new-session', locked: false }) })
    await assertFails(uploadBytes(ref(storage('owner'), path), new Uint8Array([1]), { contentType: 'image/png' }))
    const fresh = env.authenticatedContext('owner', { sessionVersion: 'new-session' }).storage()
    await assertSucceeds(uploadBytes(ref(fresh, path), new Uint8Array([1]), { contentType: 'image/png' }))
  })
  it('LogiQD no sube, borra ni lista archivos aunque conserve rol owner', async () => {
    const platformStorage = env.authenticatedContext('owner', { logiqd: true }).storage()
    await assertFails(uploadBytes(ref(platformStorage, path), new Uint8Array([1]), { contentType: 'image/png' }))
    await assertFails(deleteObject(ref(platformStorage, path)))
    await assertFails(listAll(ref(platformStorage, 'restaurants/uno/locations/centro/menu/plato')))
    await assertFails(getBytes(ref(platformStorage, 'platform/restaurants/uno/copia.enc')))
  })
  for (const role of roles) it(`${role}: solo propietario y encargado suben y borran`, async () => {
    const check = ['owner','manager'].includes(role) ? assertSucceeds : assertFails
    await check(uploadBytes(ref(storage(role), path), new Uint8Array([1]), { contentType: 'image/png' }))
    await check(deleteObject(ref(storage(role), path)))
  })
  it('solo expone la foto referenciada de un plato activo, sin listado', async () => {
    await assertSucceeds(getBytes(ref(storage(), path)))
    await assertFails(listAll(ref(storage(), 'restaurants/uno/locations/centro/menu/plato')))
    await assertFails(uploadBytes(ref(storage(), path), new Uint8Array([1]), { contentType: 'image/png' }))
    await env.withSecurityRulesDisabled(async c => { await updateDoc(doc(c.firestore(), 'restaurants/uno/locations/centro/menuItems/plato'), { active: false }) })
    await assertFails(getBytes(ref(storage(), path)))
    await env.withSecurityRulesDisabled(async c => { await updateDoc(doc(c.firestore(), 'restaurants/uno/locations/centro/menuItems/plato'), { active: true, photoPath: path.replace('foto','otra') }) })
    await assertFails(getBytes(ref(storage(), path)))
  })
  it('rechaza tipo, tamaño, local, plato y módulo incorrectos', async () => {
    for (const contentType of ['image/svg+xml','text/plain']) await assertFails(uploadBytes(ref(storage('owner'), path), new Uint8Array([1]), { contentType }))
    await assertFails(uploadBytes(ref(storage('owner'), path), new Uint8Array(5 * 1024 * 1024 + 1), { contentType: 'image/jpeg' }))
    await assertFails(uploadBytes(ref(storage('owner'), path.replace('plato','otro')), new Uint8Array([1]), { contentType: 'image/png' }))
    await assertFails(uploadBytes(ref(storage('owner'), path.replace('centro','otro')), new Uint8Array([1]), { contentType: 'image/png' }))
    await assertFails(uploadBytes(ref(storage('owner'), path.replace('uno','otro')), new Uint8Array([1]), { contentType: 'image/png' }))
    await env.withSecurityRulesDisabled(async c => { await updateDoc(doc(c.firestore(), 'restaurants/uno'), { activeModules: ['reservations'] }) })
    await assertFails(uploadBytes(ref(storage('owner'), path), new Uint8Array([1]), { contentType: 'image/png' }))
    await assertFails(deleteObject(ref(storage('owner'), path)))
  })
})
