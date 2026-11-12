import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { assertFails, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore'
let env: RulesTestEnvironment
beforeAll(async () => {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8097').split(':')
  env = await initializeTestEnvironment({ projectId: 'demo-llenamos', firestore: { host, port: Number(port), rules: readFileSync(new URL('../../firebase/firestore.rules', import.meta.url), 'utf8') } })
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'restaurants/fase6-api-rules'), { name: 'Prueba', plan: 'sala', activeModules: ['floor'] })
    await setDoc(doc(ctx.firestore(), 'restaurants/fase6-api-rules/members/owner'), { uid: 'owner', role: 'owner', active: true, locationIds: [] })
  })
})
afterAll(async () => { await env?.cleanup() })
describe('Integraciones privadas y proyección del plan', () => {
  for (const uid of [undefined, 'owner', 'team']) it(`${uid ?? 'anónimo'} no lee ni escribe secretos, outbox o registros internos desde SDK`, async () => {
    const db = uid ? env.authenticatedContext(uid, uid === 'team' ? { logiqd: true } : {}).firestore() : env.unauthenticatedContext().firestore()
    for (const path of ['platformRequests/id', 'platformSupport/id', 'platformRestaurantUsage/fase6-api-rules', ...['apiKeys', 'webhookEndpoints', 'webhookSecrets', 'platformEvents', 'webhookDeliveries', 'webhookAttempts', 'platform'].map(c => `restaurants/fase6-api-rules/${c}/id`)]) {
      await assertFails(getDoc(doc(db, path))); await assertFails(setDoc(doc(db, path), { updatedBy: uid ?? null }))
    }
  })
  it('owner no modifica la proyección ni las cuotas del restaurante', async () => {
    const db = env.authenticatedContext('owner').firestore()
    for (const field of ['commercialPlanId', 'commercialPlanVersion', 'entitlementVersion', 'accessValidUntil', 'activeModules']) await assertFails(updateDoc(doc(db, 'restaurants/fase6-api-rules'), { [field]: field === 'activeModules' ? ['floor', 'pos'] : 1, updatedBy: 'owner' }))
  })
})
