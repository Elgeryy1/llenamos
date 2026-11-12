import { readFileSync } from 'node:fs'
import { beforeAll, afterAll, it } from 'vitest'
import { initializeTestEnvironment, assertFails, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc } from 'firebase/firestore'
let env: RulesTestEnvironment
const base = 'restaurants/sync/locations/centro'
const names = ['syncDevices', 'syncStreams', 'syncReceipts', 'syncResolutions', 'orderSubmissions']
beforeAll(async () => {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8098').split(':')
  env = await initializeTestEnvironment({ projectId: 'demo-llenamos', firestore: { host, port: Number(port), rules: readFileSync(new URL('../../firebase/firestore.rules', import.meta.url), 'utf8') } })
  await env.withSecurityRulesDisabled(async c => {
    await setDoc(doc(c.firestore(), 'restaurants/sync'), { plan: 'completo', activeModules: ['floor', 'kitchen', 'pos'] })
    for (const role of ['owner', 'manager', 'waiter', 'kitchen', 'bar']) await setDoc(doc(c.firestore(), `restaurants/sync/members/${role}`), { role, active: true, locationIds: [] })
    for (const name of names) await setDoc(doc(c.firestore(), `${base}/${name}/private`), { fingerprint: 'private', updatedBy: 'owner' })
  })
})
afterAll(async () => { await env?.cleanup() })
for (const uid of [undefined, 'owner', 'manager', 'waiter', 'kitchen', 'bar', 'foreign']) it(`${uid ?? 'sin sesión'} no obtiene ni altera el protocolo privado`, async () => {
  const c = uid ? env.authenticatedContext(uid) : env.unauthenticatedContext(), db = c.firestore()
  for (const name of names) {
    const ref = doc(db, `${base}/${name}/private`)
    await assertFails(getDoc(ref)); await assertFails(getDocs(collection(db, `${base}/${name}`)))
    await assertFails(setDoc(ref, { updatedBy: uid ?? 'owner' })); await assertFails(updateDoc(ref, { updatedBy: uid ?? 'owner' })); await assertFails(deleteDoc(ref))
  }
})
