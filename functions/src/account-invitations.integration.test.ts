import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeApp, deleteApp } from 'firebase/app'
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword } from 'firebase/auth'
import { auth, db } from './shared'
import { administrativeCreate } from './fase6-billing/administration'
import { acceptAccountInvitation } from './account-invitations'
import { assertCurrentIdentity } from './identity-security'
import type { CallableRequest } from 'firebase-functions/v2/https'
import { crearRestaurante } from './crearRestaurante'
import { desactivarMiembro } from './desactivarMiembro'
import { invitarMiembro } from './invitarMiembro'

const enabled = process.env.TEST_FIREBASE_EMULATORS === '1' && process.env.GCLOUD_PROJECT === 'demo-llenamos' && !!process.env.FIRESTORE_EMULATOR_HOST && !!process.env.FIREBASE_AUTH_EMULATOR_HOST
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })
describe.skipIf(!enabled)('Invitaciones con prueba de buzón y cierre de sesiones anteriores', () => {
  it('cancelar una invitación impide aceptarla y reenviar genera otra credencial privada', async () => {
    const suffix = randomUUID().slice(0, 12), owner = await auth.createUser({ email: `owner-${suffix}@example.test` })
    const call = (data: unknown) => ({ auth: { uid: owner.uid, token: {} }, data }) as CallableRequest<unknown>
    let rid: string | undefined, guestUid: string | undefined
    try {
      const originalFetch = globalThis.fetch, links: URL[] = []
      vi.stubEnv('PLATFORM_EMAIL_ENABLED', '1'); vi.stubEnv('PUBLIC_APP_URL', 'https://app.example.test')
      vi.stubEnv('RESEND_API_KEY', 'solo-prueba'); vi.stubEnv('EMAIL_FROM', 'acceso@example.test'); vi.stubEnv('PLATFORM_API_MASTER_KEY', 'a'.repeat(64))
      vi.stubGlobal('fetch', async (url: string | URL | Request, options?: RequestInit) => {
        if (String(url) !== 'https://api.resend.com/emails') return originalFetch(url, options)
        links.push(new URL((JSON.parse(String(options?.body)) as { text: string }).text.match(/https:\/\/[^\s]+/)![0]))
        return new Response('{"id":"fixture"}', { status: 200 })
      })
      rid = (await crearRestaurante.run(call({ name: `Invitación ${suffix}`, locationName: 'Principal' }))).restaurantId
      const data = { restaurantId: rid, email: `worker-${suffix}@example.test`, displayName: 'Trabajadora', role: 'waiter' }
      guestUid = (await invitarMiembro.run(call(data))).uid
      const credential = (link: URL) => { const p = new URLSearchParams(link.hash.slice(1)); return { invitationId: p.get('i')!, token: p.get('t')!, password: 'Titular-Privada-2026!' } }
      await desactivarMiembro.run(call({ restaurantId: rid, uid: guestUid }))
      expect((await db.doc(`restaurants/${rid}/members/${guestUid}`).get()).get('invitationPending')).toBe(false)
      await expect(acceptAccountInvitation(credential(links[0]!))).rejects.toMatchObject({ code: 'failed-precondition' })
      await invitarMiembro.run(call(data))
      expect(links[1]!.hash).not.toBe(links[0]!.hash)
      await expect(acceptAccountInvitation(credential(links[0]!))).rejects.toMatchObject({ code: 'failed-precondition' })
      await acceptAccountInvitation(credential(links[1]!))
      expect((await db.doc(`restaurants/${rid}/members/${guestUid}`).get()).get('active')).toBe(true)
    } finally {
      if (rid) await db.recursiveDelete(db.doc(`restaurants/${rid}`))
      for (const uid of [owner.uid, guestUid].filter((uid): uid is string => !!uid)) {
        for (const invitation of (await db.collection('accountInvitations').where('uid', '==', uid).get()).docs) await invitation.ref.delete()
        await db.doc(`identitySecurity/${uid}`).delete(); await db.doc(`users/${uid}`).delete(); await auth.deleteUser(uid)
      }
    }
  }, 30_000)
  it('una cuenta precargada con password conocido no entra en otro restaurante antes de aceptar y sus tokens antiguos no sobreviven', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12), email = `victim-${suffix}@example.test`
    // Simula el estado vulnerable anterior: A ya conocía la contraseña de esta identidad.
    const victim = await auth.createUser({ email, password: 'Password-Conocido-Por-A', emailVerified: false })
    const app = initializeApp({ projectId: 'demo-llenamos', apiKey: 'demo-api-key' }, `identity-${suffix}`)
    const client = getAuth(app)
    connectAuthEmulator(client, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true })
    let rid: string | null = null
    try {
      const original = await signInWithEmailAndPassword(client, email, 'Password-Conocido-Por-A')
      const oldToken = (await original.user.getIdTokenResult()).claims
      let privateLink: URL | null = null
      vi.stubEnv('PLATFORM_EMAIL_ENABLED', '1'); vi.stubEnv('PUBLIC_APP_URL', 'https://app.example.test')
      vi.stubEnv('RESEND_API_KEY', 'solo-prueba'); vi.stubEnv('EMAIL_FROM', 'Llenamos <acceso@example.test>'); vi.stubEnv('PLATFORM_API_MASTER_KEY', 'a'.repeat(64))
      const originalFetch = globalThis.fetch
      vi.stubGlobal('fetch', async (url: string | URL | Request, options?: RequestInit) => {
        if (String(url) === 'https://api.resend.com/emails') {
          const body = JSON.parse(String(options?.body)) as { to: string[]; text: string }
          expect(body.to).toEqual([email])
          privateLink = new URL(body.text.match(/https:\/\/[^\s]+/)![0])
          return new Response('{"id":"invitation-fixture"}', { status: 200 })
        }
        if (!['localhost','127.0.0.1'].includes(new URL(String(url)).hostname)) throw new Error('Red externa no permitida')
        return originalFetch(url, options)
      })
      const created = await administrativeCreate('equipo-logiqd-fixture', { requestId: randomUUID(), name: 'Restaurante B', slug: `b-${suffix}`, locationName: 'Principal', ownerName: 'Titular B', ownerEmail: email, planId: 'sala', planVersion: 1 })
      rid = created.restaurantId
      expect(created).not.toHaveProperty('link'); expect(created).not.toHaveProperty('password')
      expect((await db.doc(`restaurants/${rid}/members/${victim.uid}`).get()).get('active')).toBe(false)
      expect((await db.doc(`users/${victim.uid}`).get()).get(`restaurants.${rid}`)).toBeUndefined()
      // El alta no modifica arbitrariamente la contraseña de una cuenta existente.
      await expect(signInWithEmailAndPassword(client, email, 'Password-Conocido-Por-A')).resolves.toBeTruthy()
      const delivered = privateLink as URL | null
      expect(delivered).not.toBeNull()
      expect(delivered!.search).toBe('')
      const privateParams = new URLSearchParams(delivered!.hash.slice(1))
      const invitationId = privateParams.get('i')!, token = privateParams.get('t')!
      await expect(acceptAccountInvitation({ invitationId, token: 'x'.repeat(43), password: 'Nueva-Privada-Del-Titular' })).rejects.toMatchObject({ code: 'failed-precondition' })
      await acceptAccountInvitation({ invitationId, token, password: 'Nueva-Privada-Del-Titular' })
      expect((await db.doc(`restaurants/${rid}/members/${victim.uid}`).get()).get('active')).toBe(true)
      const current = await auth.getUser(victim.uid)
      expect(current.emailVerified).toBe(true)
      expect(current.customClaims?.sessionVersion).toMatch(/^[a-f0-9]{32}$/)
      const request = { auth: { uid: victim.uid, token: oldToken } } as unknown as CallableRequest<unknown>
      await expect(assertCurrentIdentity(request, true)).rejects.toMatchObject({ code: 'unauthenticated' })
      await expect(signInWithEmailAndPassword(client, email, 'Password-Conocido-Por-A')).rejects.toBeTruthy()
      const fresh = await signInWithEmailAndPassword(client, email, 'Nueva-Privada-Del-Titular')
      const freshClaims = (await fresh.user.getIdTokenResult(true)).claims
      await expect(assertCurrentIdentity({ auth: { uid: victim.uid, token: freshClaims } } as unknown as CallableRequest<unknown>, true)).resolves.toBeUndefined()
      await expect(acceptAccountInvitation({ invitationId, token, password: 'Intento-De-Reusar-El-Enlace' })).rejects.toMatchObject({ code: 'failed-precondition' })
      await expect(signInWithEmailAndPassword(client, email, 'Nueva-Privada-Del-Titular')).resolves.toBeTruthy()
    } finally {
      if (rid) {
        const invitations = await db.collection('accountInvitations').where('restaurantId', '==', rid).get()
        for (const invitation of invitations.docs) await invitation.ref.delete()
        await db.recursiveDelete(db.doc(`restaurants/${rid}`)); await db.doc(`platformRestaurants/${rid}`).delete()
      }
      await db.doc(`identitySecurity/${victim.uid}`).delete(); await db.doc(`users/${victim.uid}`).delete()
      await auth.deleteUser(victim.uid); await deleteApp(app)
    }
  }, 30_000)
})
