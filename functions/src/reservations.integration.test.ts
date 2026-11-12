import { afterAll, describe, expect, it } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'
import * as core from '@llenamos/core'
import * as api from './reservations'
import { db } from './shared'

const enabled = process.env.TEST_FIREBASE_EMULATORS === '1' && process.env.GCLOUD_PROJECT === 'demo-llenamos' && !!process.env.FIRESTORE_EMULATOR_HOST
type Request = Parameters<typeof api.crearReserva.run>[0]
const request = (data: unknown, uid?: string, token = {}) => ({ data, ...(uid ? { auth: { uid, token } } : {}) }) as Request
const rid = `r1-${Date.now()}`, lid = 'centro', base = { restaurantId: rid, locationId: lid }
describe.skipIf(!enabled)('Reservas con Firestore real', () => {
  afterAll(async () => {
    const hub = process.env.FIREBASE_EMULATOR_HUB
    // La limpieza no es servicio real: no genera actividad ni recrea fichas mientras borra el árbol.
    if (hub) await fetch(`http://${hub}/functions/disableBackgroundTriggers`,{ method:'PUT' })
    try { await db.recursiveDelete(db.doc(`restaurants/${rid}`)); await db.doc(`publicRestaurants/${rid}`).delete() }
    finally { if (hub) await fetch(`http://${hub}/functions/enableBackgroundTriggers`,{ method:'PUT' }) }
  },60000)
  it('valida entradas y evita acceso sin sesión', async () => {
    await expect(api.crearReservaPublica.run(request({}))).rejects.toMatchObject({ code: 'invalid-argument' })
    await expect(api.crearReserva.run(request({ ...base, date: '2026-11-10', time: '13:00', partySize: 2, guestName: 'Ana', phone: '600000000', source: 'phone' }))).rejects.toBeDefined()
  })
  it('serializa altas públicas sin mesa, protege el enlace y cambia estados', async () => {
    const root = db.doc(`restaurants/${rid}`)
    await root.set({ name: 'Prueba', slug: rid, brandColor: '#f0a35e', locale: 'es', timezone: 'Europe/Madrid', plan: 'reservas', activeModules: ['reservations'] })
    await root.collection('locations').doc(lid).set({ name: 'Centro', address: '', city: '', phone: '' })
    const settings = core.defaultReservationSettings()
    const shifts = [{ name: 'Comida', from: '13:00', lastEntry: '15:00' }]
    settings.week = { mon: shifts, tue: shifts, wed: shifts, thu: shifts, fri: shifts, sat: shifts, sun: shifts }; settings.publicBooking = true; settings.autoConfirm = true
    await db.doc(`${root.path}/locations/${lid}/settings/reservations`).set(settings)
    await db.doc(`${root.path}/locations/${lid}/tables/mesa`).set({ name: 'Mesa', areaId: 'sala', seats: 2, enabled: true, joinableWith: [], shape: 'rect', x: 0, y: 0, w: 10, h: 10 })
    for (const role of ['owner', 'waiter', 'kitchen']) await root.collection('members').doc(role).set({ uid: role, displayName: role, email: `${role}@test.es`, role, active: true, locationIds: [] })
    const date = core.sumarDias(core.horaLocal(Date.now(), 'Europe/Madrid').fecha, 2)
    const input = { slug: rid, locationId: lid, date, time: '13:00', partySize: 2, guestName: 'Ana', phone: '600000000', language: 'es', acceptPolicy: true, attribution: { campaignId:'campana-prueba',utmSource:'instagram' }, marketingOptIn:{ email:true,policyVersion:'demo-1' } }
    const results = await Promise.allSettled([api.crearReservaPublica.run(request(input)), api.crearReservaPublica.run(request(input))])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const success = results.find(r => r.status === 'fulfilled')!
    if (success.status !== 'fulfilled') throw new Error('Falta reserva')
    const out = core.CrearReservaPublicaOutputSchema.parse(success.value)
    const rows = await db.collection(`${root.path}/locations/${lid}/reservations`).get()
    const id = rows.docs[0]!.id
    expect(rows.docs[0]!.data().startAt).toBeInstanceOf(Timestamp)
    expect((await db.doc(`${root.path}/locations/${lid}/reservationOrigins/${id}`).get()).data()).toMatchObject({ channel:'campaign',campaignId:'campana-prueba' })
    const consents = (await root.collection('consents').get()).docs
    expect(consents).toHaveLength(1)
    expect(core.ConsentSchema.parse(consents[0]!.data())).toMatchObject({ purpose:'marketing_email',status:'granted',source:'public',evidenceId:id })
    expect(rows.docs[0]!.data().manageToken).toBeUndefined()
    await expect(api.verReservaPublica.run(request({ slug: rid, reference: out.reference, token: core.linkToken(new Uint8Array(32)) }))).rejects.toMatchObject({ code: 'permission-denied' })
    await expect(api.cambiarEstadoReserva.run(request({ ...base, reservationId: id, status: 'seated' }, 'kitchen'))).rejects.toMatchObject({ code: 'permission-denied' })
    await api.cambiarEstadoReserva.run(request({ ...base, reservationId: id, status: 'seated' }, 'waiter'))
    await api.cambiarEstadoReserva.run(request({ ...base, reservationId: id, status: 'finished' }, 'waiter'))
    const imported = await api.importarReservas.run(request({ ...base, rows: [{ guestName: 'Pepe', phone: '600000001', partySize: '2', date, time: '15:00' }, { guestName: '' }] }, 'owner'))
    expect((await db.collection(`${root.path}/locations/${lid}/reservationOrigins`).where('channel', '==', 'import').get()).size).toBe(1)
    expect((await root.collection('consents').get()).size).toBe(1)
    expect(imported).toMatchObject({ created: 1, errors: expect.arrayContaining([expect.objectContaining({ row: 1 })]) })
    await expect.poll(async () => (await root.collection('customers').doc(core.customerIdFor(rid, '+34600000000')).get()).data()?.visits, { timeout: 15000 }).toBe(1)
    await expect(api.cambiarPlan.run(request({ restaurantId: rid, plan: 'sala' }, 'owner'))).rejects.toMatchObject({ code: 'permission-denied' })
    await api.cambiarPlan.run(request({ restaurantId: rid, plan: 'sala', moduleOverrides: { reservations: false } }, 'team', { logiqd: true }))
    await expect(api.consultarDisponibilidad.run(request({ slug: rid, locationId: lid, date, partySize: 2 }))).rejects.toMatchObject({ code: 'failed-precondition' })
  }, 30000)
  it('señal sin proveedor, mesas, movimientos y mensajes programados', async () => {
    await api.cambiarPlan.run(request({ restaurantId: rid, plan: 'reservas' }, 'team', { logiqd: true }))
    const local = db.doc(`restaurants/${rid}/locations/${lid}`)
    const settings = core.ReservationSettingsSchema.parse((await local.collection('settings').doc('reservations').get()).data())
    settings.deposit = { mode: 'perPerson', amountCents: 500, fromPartySize: 1 }; settings.reminders.dayBefore = true
    await api.guardarConfiguracionReservas.run(request({ ...base, settings }, 'owner'))
    const date = core.sumarDias(core.horaLocal(Date.now(), settings.timezone).fecha, 4)
    const input = { slug: rid, locationId: lid, date, time: '13:00', partySize: 2, guestName: 'Berta', phone: '600000003', language: 'es', acceptPolicy: true }
    const out = core.CrearReservaPublicaOutputSchema.parse(await api.crearReservaPublica.run(request(input)))
    expect(out).toMatchObject({ status: 'pending', deposit: { status: 'not_configured', amountCents: 1000 } })
    const r = (await local.collection('reservations').where('reference', '==', out.reference).get()).docs[0]!
    const target = { ...base, reservationId: r.id }
    const proposed = core.ProponerMesasReservaOutputSchema.parse(await api.proponerMesasReserva.run(request(target, 'waiter')))
    expect(proposed.proposals[0]?.tableIds).toEqual(['mesa'])
    const alternative = core.ProponerMesasReservaOutputSchema.parse(await api.proponerMesasReserva.run(request({ ...target, date: core.sumarDias(date, 1) }, 'waiter')))
    expect(alternative.startAt).toBe(core.slotStartAt(core.settingsToConfiguracion(settings), core.sumarDias(date, 1), '13:00')?.startAt)
    await api.asignarMesas.run(request({ ...target, tableIds: ['mesa'] }, 'waiter'))
    await expect(api.crearReserva.run(request({ ...base, date, time: '13:00', partySize: 2, guestName: 'Choca', phone: '600000004', source: 'phone', tableIds: ['mesa'] }, 'waiter'))).rejects.toMatchObject({ code: 'failed-precondition' })
    await expect(api.gestionarReservaPublica.run(request({ slug: rid, reference: out.reference, token: out.manageToken, action: 'confirm' }))).rejects.toMatchObject({ code: 'failed-precondition' })
    await api.moverReserva.run(request({ ...target, date, time: '15:00' }, 'waiter'))
    let messages = (await db.collection(`restaurants/${rid}/messages`).where('reservationId', '==', r.id).get()).docs.map(d => core.MessageSchema.parse(d.data()))
    expect(messages.some(m => m.template === 'reminder' && m.status === 'queued' && m.sendAt > Date.now())).toBe(true)
    expect(messages.some(m => m.status === 'cancelled')).toBe(true)
    expect(messages.some(m => m.template === 'deposit_request')).toBe(false)
    await api.gestionarReservaPublica.run(request({ slug: rid, reference: out.reference, token: out.manageToken, action: 'cancel' }))
    messages = (await db.collection(`restaurants/${rid}/messages`).where('reservationId', '==', r.id).get()).docs.map(d => core.MessageSchema.parse(d.data()))
    expect(messages.filter(m => m.status === 'queued').map(m => m.template)).toEqual(['cancellation'])
    await expect.poll(async () => (await db.doc(`publicRestaurants/${rid}`).get()).data()?.bookingEnabled, { timeout: 15000 }).toBe(true)
    const savedKey = process.env.STRIPE_SECRET_KEY
    process.env.STRIPE_SECRET_KEY = 'sk_test_solo_prueba_local'
    try {
      const required = core.CrearReservaPublicaOutputSchema.parse(await api.crearReservaPublica.run(request({ ...input, date: core.sumarDias(date, 1) })))
      expect(required).toMatchObject({ status: 'pending', deposit: { status: 'required', amountCents: 1000 } })
      const messages = await db.collection(`restaurants/${rid}/messages`).where('template', '==', 'deposit_request').get()
      expect(messages.size).toBe(1)
    } finally {
      if (savedKey === undefined) delete process.env.STRIPE_SECRET_KEY
      else process.env.STRIPE_SECRET_KEY = savedKey
    }
    if (process.env.FUNCTIONS_EMULATOR_HOST) {
      const response = await fetch(`http://${process.env.FUNCTIONS_EMULATOR_HOST}/demo-llenamos/europe-west1/${core.CALLABLES.consultarDisponibilidad}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: { slug: rid, locationId: lid, date, partySize: 2 } }) })
      expect(response.ok).toBe(true)
      expect(core.ConsultarDisponibilidadOutputSchema.safeParse((await response.json() as { result: unknown }).result).success).toBe(true)
    }
  }, 30000)
})
