import { setTimeout } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { auth, db } from './shared'
import { crearRestaurante } from './crearRestaurante'
import { invitarMiembro } from './invitarMiembro'
import { cambiarRolMiembro } from './cambiarRolMiembro'
import { desactivarMiembro } from './desactivarMiembro'
import { initializeApp, deleteApp } from 'firebase/app'
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword } from 'firebase/auth'
import { getFirestore, connectFirestoreEmulator, doc, updateDoc, serverTimestamp, terminate } from 'firebase/firestore'
import { sha256Hex } from '@llenamos/core'
import { unseal } from './fase6-api/security'
import { acceptAccountInvitation } from './account-invitations'

// Esta suite solo se habilita de forma explícita con emuladores del proyecto demo.
const enabled = process.env.TEST_FIREBASE_EMULATORS === '1'
  && !!process.env.FIRESTORE_EMULATOR_HOST && !!process.env.FIREBASE_AUTH_EMULATOR_HOST
  && process.env.GCLOUD_PROJECT === 'demo-llenamos'
type CallableRunRequest = Parameters<typeof crearRestaurante.run>[0]
const request = (uid: string | undefined, data: unknown) => ({ data, ...(uid ? { auth: { uid, token: {} } } : {}) }) as CallableRunRequest
describe.skipIf(!enabled)('Callables con Auth y Firestore reales en emuladores', () => {
  const users: string[] = []
  const restaurants: string[] = []
  beforeAll(() => {
    vi.stubEnv('PLATFORM_EMAIL_ENABLED', '1'); vi.stubEnv('PUBLIC_APP_URL', 'https://app.example.test')
    vi.stubEnv('RESEND_API_KEY', 'fixture'); vi.stubEnv('EMAIL_FROM', 'acceso@example.test'); vi.stubEnv('PLATFORM_API_MASTER_KEY', 'a'.repeat(64))
    const original = globalThis.fetch
    vi.stubGlobal('fetch', (url: string | URL | Request, options?: RequestInit) => String(url) === 'https://api.resend.com/emails'
      ? Promise.resolve(new Response('{"id":"fixture-invitation"}', { status: 200 })) : original(url, options))
  })
  async function accept(rid: string, uid: string) {
    const ref = db.doc(`accountInvitations/${sha256Hex(`${rid}:${uid}`)}`)
    const record = await ref.get(), secret = unseal(record.get('tokenCiphertext'), ref.path) as { token: string }
    await acceptAccountInvitation({ invitationId: ref.id, token: secret.token, password: 'Nueva-Privada2026!' })
  }
  afterAll(async () => {
    for (const rid of restaurants) await db.recursiveDelete(db.doc(`restaurants/${rid}`))
    for (const uid of users) {
      const invitations = await db.collection('accountInvitations').where('uid', '==', uid).get()
      for (const invitation of invitations.docs) await invitation.ref.delete()
      await db.doc(`identitySecurity/${uid}`).delete(); await db.doc(`users/${uid}`).delete(); await auth.deleteUser(uid)
    }
    vi.unstubAllGlobals(); vi.unstubAllEnvs()
  })
  it('valida sesión y entrada', async () => {
    await expect(crearRestaurante.run(request(undefined, {}))).rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(crearRestaurante.run(request('cualquiera', { name: '' }))).rejects.toMatchObject({ code: 'invalid-argument' })
  })
  it('atribuye los ajustes escritos por el SDK cliente al uid y nombre del perfil', async () => {
    const email = `ajustes-${Date.now()}@test.es`
    const owner = await auth.createUser({ displayName: 'Marta Soler', email, password: 'Llenamos2026!' })
    users.push(owner.uid)
    const created = await crearRestaurante.run(request(owner.uid, { name: `Taberna Lumbre ${Date.now()}`, locationName: 'Centro' }))
    restaurants.push(created.restaurantId)
    const app = initializeApp({ projectId: 'demo-llenamos', apiKey: 'demo-key' }, `ajustes-${owner.uid}`)
    const clientAuth = getAuth(app)
    connectAuthEmulator(clientAuth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true })
    const clientDb = getFirestore(app)
    const [host, port] = process.env.FIRESTORE_EMULATOR_HOST!.split(':')
    connectFirestoreEmulator(clientDb, host!, Number(port))
    try {
      await signInWithEmailAndPassword(clientAuth, email, 'Llenamos2026!')
      await updateDoc(doc(clientDb, 'restaurants', created.restaurantId), { name: 'Taberna Lumbre nueva', updatedBy: owner.uid, updatedAt: serverTimestamp() })
      await expect.poll(async () => {
        const logs = await db.collection(`restaurants/${created.restaurantId}/activity`).where('action', '==', 'restaurant.updated').get()
        return logs.docs.map(row => ({ actorUid: row.data().actorUid, actorName: row.data().actorName, summary: row.data().summary }))
      }, { timeout: 20000 }).toEqual([{ actorUid: owner.uid, actorName: 'Marta Soler', summary: 'Restaurante actualizado: Taberna Lumbre nueva' }])
    } finally {
      await terminate(clientDb)
      await deleteApp(app)
    }
  }, 30000)
  it('crea, invita, cambia roles y desactiva manteniendo perfiles y aislamiento', async () => {
    const owner = await auth.createUser({ displayName: 'Marta Soler', email: `owner-${Date.now()}@test.es`, password: 'Llenamos2026!' })
    users.push(owner.uid)
    const first = await crearRestaurante.run(request(owner.uid, { name: `Prueba uno ${Date.now()}`, locationName: 'Centro' }))
    // La prueba gratis es única por cuenta: el segundo restaurante, anterior a la fase 6, se prepara a mano.
    const second = { restaurantId: `segundo-${Date.now()}` }
    await db.doc(`restaurants/${second.restaurantId}`).set({ name: 'Prueba dos', slug: second.restaurantId, brandColor: '#f0a35e', currency: 'EUR', timezone: 'Europe/Madrid', locale: 'es', isDemo: false })
    await db.doc(`restaurants/${second.restaurantId}/members/${owner.uid}`).set({ uid: owner.uid, displayName: 'Marta Soler', email: 'marta@test.es', role: 'owner', active: true, locationIds: [] })
    await db.doc(`users/${owner.uid}`).set({ restaurants: { [second.restaurantId]: { name: 'Prueba dos', role: 'owner' } } }, { merge: true })
    restaurants.push(first.restaurantId, second.restaurantId)
    expect(Object.keys((await db.doc(`users/${owner.uid}`).get()).data()!.restaurants)).toHaveLength(2)
    const email = `manager-${Date.now()}@test.es`
    const invited = await invitarMiembro.run(request(owner.uid, { restaurantId: first.restaurantId, email, displayName: 'Encargada', role: 'manager' }))
    users.push(invited.uid)
    await accept(first.restaurantId, invited.uid)
    const input = { restaurantId: first.restaurantId, uid: invited.uid }
    await expect(invitarMiembro.run(request(owner.uid, { restaurantId: first.restaurantId, email, displayName: 'Encargada', role: 'manager' }))).rejects.toMatchObject({ code: 'already-exists' })
    await expect(cambiarRolMiembro.run(request(invited.uid, { ...input, uid: owner.uid, role: 'waiter' }))).rejects.toMatchObject({ code: 'permission-denied' })
    await expect(cambiarRolMiembro.run(request(invited.uid, { ...input, role: 'owner' }))).rejects.toMatchObject({ code: 'failed-precondition' })
    await expect(desactivarMiembro.run(request(owner.uid, { ...input, uid: owner.uid }))).rejects.toMatchObject({ code: 'failed-precondition' })
    await expect(cambiarRolMiembro.run(request(invited.uid, { ...input, restaurantId: second.restaurantId, uid: owner.uid, role: 'waiter' }))).rejects.toMatchObject({ code: 'permission-denied' })
    await cambiarRolMiembro.run(request(owner.uid, { ...input, role: 'waiter' }))
    expect((await db.doc(`users/${invited.uid}`).get()).data()!.restaurants[first.restaurantId].role).toBe('waiter')
    await invitarMiembro.run(request(owner.uid, { restaurantId: second.restaurantId, email, displayName: 'Encargada', role: 'bar' }))
    await accept(second.restaurantId, invited.uid)
    const members = async () => (await db.doc(`restaurants/${first.restaurantId}/platform/usage`).get()).get('members') as number
    expect(await members()).toBe(2)
    await desactivarMiembro.run(request(owner.uid, input))
    // Desactivar libera su hueco del plan; el restaurante anterior a la fase 6 no tiene contadores.
    expect(await members()).toBe(1)
    const profile = (await db.doc(`users/${invited.uid}`).get()).data()!
    expect(profile.restaurants[first.restaurantId]).toBeUndefined()
    expect(profile.restaurants[second.restaurantId].role).toBe('bar')
    expect((await db.doc(`restaurants/${first.restaurantId}/members/${invited.uid}`).get()).data()!.active).toBe(false)
    await expect(invitarMiembro.run(request(invited.uid, { restaurantId: first.restaurantId, email: 'nuevo@test.es', displayName: 'Nuevo', role: 'waiter' }))).rejects.toMatchObject({ code: 'permission-denied' })
    const memberRef = db.doc(`restaurants/${first.restaurantId}/members/${invited.uid}`)
    const createdAt = (await memberRef.get()).data()!.createdAt
    const reinvite = { restaurantId: first.restaurantId, email, displayName: 'Laura Vidal', role: 'bar' }
    const reactivated = await invitarMiembro.run(request(owner.uid, reinvite))
    await accept(first.restaurantId, invited.uid)
    expect(reactivated.uid).toBe(invited.uid)
    expect(await members()).toBe(2)
    expect((await memberRef.get()).data()).toMatchObject({ active: true, role: 'bar', createdAt })
    expect((await db.doc(`users/${invited.uid}`).get()).data()!.restaurants).toMatchObject({ [first.restaurantId]: { role: 'bar' }, [second.restaurantId]: { role: 'bar' } })
    await expect(invitarMiembro.run(request(owner.uid, reinvite))).rejects.toMatchObject({ code: 'already-exists' })
    // El alta guiada deja además su propia actividad (zona, mesas, ajustes y suscripción): aquí solo importa la del equipo.
    // Permite que los disparadores procesen las escrituras; no deben añadir duplicados.
    await setTimeout(2000)
    const logs = (await db.collection(`restaurants/${first.restaurantId}/activity`).get()).docs.map(doc => doc.data()).filter(log => String(log.action).startsWith('member.') && log.action !== 'member.accepted')
    expect(logs).toHaveLength(4)
    for (const log of logs) expect(log).toMatchObject({ actorUid: owner.uid, actorName: 'Marta Soler' })
    expect(logs.map(log => log.action).sort()).toEqual(['member.invited', 'member.roleChanged', 'member.deactivated', 'member.reactivated'].sort())
    expect(logs.find(log => log.action === 'member.reactivated')!.summary).toBe('Marta Soler ha reactivado a Laura Vidal con el rol de barra')
    await cambiarRolMiembro.run(request(owner.uid, { restaurantId: second.restaurantId, uid: invited.uid, role: 'owner' }))
    const concurrent = await Promise.allSettled([
      cambiarRolMiembro.run(request(owner.uid, { restaurantId: second.restaurantId, uid: invited.uid, role: 'waiter' })),
      cambiarRolMiembro.run(request(invited.uid, { restaurantId: second.restaurantId, uid: owner.uid, role: 'waiter' })),
    ])
    expect(concurrent.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect((await db.collection(`restaurants/${second.restaurantId}/members`).where('role', '==', 'owner').where('active', '==', true).get()).size).toBe(1)
  }, 30000)
})
