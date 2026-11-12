import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as core from '@llenamos/core'
import { db } from './shared'
import { crearReservaPublica, verReservaPublica } from './reservations'

const enabled = process.env.TEST_FIREBASE_EMULATORS === '1'
  && process.env.GCLOUD_PROJECT === 'demo-llenamos' && !!process.env.FIRESTORE_EMULATOR_HOST
afterEach(() => vi.unstubAllEnvs())

describe.skipIf(!enabled)('Enlaces entregados en avisos de reservas', () => {
  it('entrega un enlace absoluto funcional y revierte la reserva si el origen configurado es inseguro', async () => {
    const rid = `links-${randomUUID()}`, lid = 'principal'
    const root = db.doc(`restaurants/${rid}`), local = root.collection('locations').doc(lid)
    const request = (data: unknown) => ({ data }) as Parameters<typeof crearReservaPublica.run>[0]
    try {
      await root.set({ name: 'Prueba enlaces', slug: rid, brandColor: '#f0a35e', locale: 'es',
        timezone: 'Europe/Madrid', plan: 'reservas', activeModules: ['reservations'] })
      await local.set({ name: 'Principal', address: '', city: '', phone: '' })
      const settings = core.defaultReservationSettings()
      settings.publicBooking = true; settings.autoConfirm = true
      for (const day of Object.keys(settings.week) as (keyof typeof settings.week)[])
        settings.week[day] = [{ name: 'Comida', from: '13:00', lastEntry: '15:00' }]
      await local.collection('settings').doc('reservations').set(settings)
      await local.collection('tables').doc('mesa').set({ name: 'Mesa', areaId: 'sala', seats: 2,
        enabled: true, joinableWith: [], shape: 'rect', x: 0, y: 0, w: 10, h: 10 })
      const input = { slug: rid, locationId: lid, date: core.sumarDias(core.horaLocal(Date.now(), 'Europe/Madrid').fecha, 2),
        time: '13:00', partySize: 2, guestName: 'Titular', phone: '600000000', language: 'es', acceptPolicy: true }
      vi.stubEnv('PUBLIC_APP_URL', 'http://app.example.test')
      await expect(crearReservaPublica.run(request(input))).rejects.toMatchObject({ code: 'failed-precondition' })
      expect((await local.collection('reservations').get()).size).toBe(0)
      expect((await root.collection('messages').get()).size).toBe(0)

      vi.stubEnv('PUBLIC_APP_URL', 'https://app.example.test')
      const created = core.CrearReservaPublicaOutputSchema.parse(await crearReservaPublica.run(request(input)))
      const messages = (await root.collection('messages').get()).docs
      expect(messages.length).toBeGreaterThan(0)
      for (const message of messages) {
        const link = new URL(message.get('data.manageUrl'))
        expect(link.origin).toBe('https://app.example.test')
        expect(link.pathname).toBe(`/r/${rid}/reserva/${created.reference}`)
        expect(link.searchParams.get('t')).toBe(created.manageToken)
        await expect(verReservaPublica.run(request({ slug: rid, reference: created.reference,
          token: link.searchParams.get('t') }))).resolves.toMatchObject({ reference: created.reference })
      }
    } finally { await db.recursiveDelete(root) }
  }, 30_000)
})
