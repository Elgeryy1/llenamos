import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { auth, db } from '../shared'
import { administrativeConfigure, administrativeCreate, administrativeList } from './administration'

const enabled = process.env.TEST_FIREBASE_EMULATORS === '1' && process.env.GCLOUD_PROJECT === 'demo-llenamos'
  && !!process.env.FIRESTORE_EMULATOR_HOST && !!process.env.FIREBASE_AUTH_EMULATOR_HOST
describe.skipIf(!enabled)('Alta administrativa con emuladores y correo interceptado', () => {
  const owners: string[] = [], restaurants: string[] = [], provisionings: string[] = []
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
  afterAll(async () => {
    for (const rid of restaurants) { await db.recursiveDelete(db.doc(`restaurants/${rid}`)); await db.doc(`platformRestaurants/${rid}`).delete() }
    for (const uid of owners) { await db.doc(`users/${uid}`).delete(); await auth.deleteUser(uid) }
    for (const id of provisionings) await db.doc(`platformProvisioning/${id}`).delete()
  }, 30_000)
  it('permite dar de alta sin APIs y sin correo de plataforma, con invitación pendiente', async () => {
    vi.stubEnv('PLATFORM_EMAIL_ENABLED','0'); vi.stubEnv('RESEND_API_KEY','')
    const suffix=randomUUID().replaceAll('-','').slice(0,14)
    const input={requestId:randomUUID(),ownerEmail:`pending-${suffix}@example.test`,ownerName:'Propietario',name:'Sin proveedores',slug:`pending-${suffix}`,locationName:'Principal',planId:'sala',planVersion:1,integrations:{email:{apiKey:'',from:''}}}
    const created=await administrativeCreate('logiqd-fixture',input)
    restaurants.push(created.restaurantId); const owner=await auth.getUserByEmail(input.ownerEmail); owners.push(owner.uid)
    const provisions=await db.collection('platformProvisioning').where('ownerUid','==',owner.uid).get(); provisionings.push(...provisions.docs.map(doc=>doc.id))
    expect(created.invitationStatus).toBe('pending')
    expect(created).not.toHaveProperty('password'); expect(created).not.toHaveProperty('link')
    const row=(await db.doc(`platformRestaurants/${created.restaurantId}`).get()).data()!
    expect(row.integrationStatus.email.status).toBe('not_configured')
    expect((await db.doc(`restaurants/${created.restaurantId}/integrationSecrets/providers`).get()).exists).toBe(false)
  },30_000)
  it('retoma un fallo de correo sin duplicar restaurante y configura solo metadata administrativa', async () => {
    vi.stubEnv('PLATFORM_EMAIL_ENABLED', '1')
    const suffix = randomUUID().replaceAll('-', '').slice(0, 14)
    vi.stubEnv('PUBLIC_APP_URL', 'https://app.llenamos.logiqd.me'); vi.stubEnv('RESEND_API_KEY', 'fixture-no-red')
    vi.stubEnv('EMAIL_FROM', 'acceso@example.test'); vi.stubEnv('PLATFORM_API_MASTER_KEY', 'a'.repeat(64))
    const bodies: string[] = [], keys: string[] = []
    let successful = false
    const originalFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url) === 'https://api.resend.com/emails') {
        bodies.push(String(options?.body)); keys.push((options?.headers as Record<string,string>)['Idempotency-Key']!)
        return new Response(successful ? '{"id":"fixture-mail"}' : '{}', { status: successful ? 200 : 503 })
      }
      const host = new URL(String(url)).hostname
      if (!['localhost', '127.0.0.1'].includes(host)) throw new Error('Red externa prohibida en esta prueba')
      return originalFetch(url, options)
    })
    const input = { requestId: randomUUID(), ownerEmail: `owner-${suffix}@example.test`, ownerName: 'Propietario de prueba', name: 'Restaurante de integración',
      slug: `admin-${suffix}`, locationName: 'Principal', planId: 'sala', planVersion: 1 }
    await expect(administrativeCreate('logiqd-fixture', input)).rejects.toMatchObject({ code: 'unavailable' })
    const owner = await auth.getUserByEmail(input.ownerEmail); owners.push(owner.uid)
    const records = await db.collection('platformRestaurants').where('ownerEmail', '==', input.ownerEmail).get()
    expect(records.size).toBe(1)
    const rid = records.docs[0]!.id; restaurants.push(rid)
    const provisions = await db.collection('platformProvisioning').where('ownerUid', '==', owner.uid).get()
    provisionings.push(...provisions.docs.map(doc => doc.id))
    successful = true
    const created = await administrativeCreate('logiqd-fixture', input)
    expect(created).toEqual({ restaurantId: rid, locationId: 'principal', invitationStatus: 'sent' })
    expect(await administrativeCreate('logiqd-fixture', input)).toEqual(created)
    expect(bodies).toHaveLength(2); expect(bodies[0]).toBe(bodies[1]); expect(keys[0]).toBe(keys[1])
    expect((await db.doc(`restaurants/${rid}/members/logiqd-fixture`).get()).exists).toBe(false)
    expect((await db.doc(`restaurants/${rid}/members/${owner.uid}`).get()).get('role')).toBe('owner')
    expect((await db.doc(`restaurants/${rid}/members/${owner.uid}`).get()).get('active')).toBe(false)
    const row = (await db.doc(`platformRestaurants/${rid}`).get()).data()!
    const configured = await administrativeConfigure('logiqd-fixture', { requestId: randomUUID(), restaurantId: rid, expectedRevision: row.revision,
      planId: 'grupo', planVersion: 1, moduleOverrides: {}, reason: 'Plan acordado para integración', serviceUntil: Date.now() + 30 * 86_400_000 })
    expect(configured.restaurant.planId).toBe('grupo'); expect(configured.restaurant.status).toBe('active')
    const listing = await administrativeList({ limit: 100, cursor: null })
    const listed = listing.restaurants.find(r => r.restaurantId === rid)
    expect(listed).toEqual(configured.restaurant)
    expect(listed).not.toHaveProperty('members'); expect(listed).not.toHaveProperty('pendingCommands')
    expect(created).not.toHaveProperty('password'); expect(created).not.toHaveProperty('link')
    await expect(administrativeConfigure('logiqd-fixture', { requestId: randomUUID(), restaurantId: rid, expectedRevision: row.revision,
      planId: 'sala', planVersion: 1, moduleOverrides: {}, reason: 'Revisión antigua' })).rejects.toMatchObject({ code: 'aborted' })
  }, 30_000)
})
