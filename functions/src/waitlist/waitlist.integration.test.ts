/**
 * Lista de espera de punta a punta contra los emuladores: cancelar una reserva (como lo hace el
 * personal, con `cambiarEstadoReserva`) → el disparador ofrece el hueco a la primera entrada
 * compatible → el mensaje capturado lleva el enlace → aceptar crea la reserva → una oferta que
 * pasa de `waitlist.offerMinutes` caduca y el hueco pasa a la siguiente.
 *
 *   TEST_R2_EMULATORS=1 GCLOUD_PROJECT=demo-llenamos FIRESTORE_EMULATOR_HOST=127.0.0.1:8097 \
 *   FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9103 pnpm --filter functions exec vitest run src/waitlist
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'
import { customerIdFor, defaultReservationSettings, horaLocal, instanteDeHoraLocal, reservationForWrite, sha256Hex, sumarDias } from '@llenamos/core'
import { db, stamp } from '../shared'
import { procesarMensajesPendientes } from '../messages/process'
import { cambiarEstadoReserva, consultarDisponibilidad, crearReservaPublica, verReservaPublica } from '../reservations'
import { aceptarOfertaListaEspera, apuntarseListaEspera } from './service'

const enabled = process.env.TEST_R2_EMULATORS === '1' && /^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '') && process.env.GCLOUD_PROJECT === 'demo-llenamos'
const OFFER_MINUTES = 30

describe.skipIf(!enabled)('Lista de espera de punta a punta', () => {
 beforeAll(() => { process.env.FUNCTIONS_EMULATOR = 'true' })
 const rid = `le-${Date.now()}`, slug = rid, lid = 'centro', path = `restaurants/${rid}/locations/${lid}`
 const startAt = instanteDeHoraLocal(sumarDias(horaLocal(Date.now(), 'Europe/Madrid').fecha, 2), 13 * 60, 'Europe/Madrid')!
 const date = horaLocal(startAt, 'Europe/Madrid').fecha, otherDate = sumarDias(date, 1)
 const request = (data: unknown, uid?: string, token: Record<string, unknown> = {}) => ({ data, ...(uid ? { auth: { uid, token } } : {}) }) as never
 const wait = (id: string) => db.doc(`${path}/waitlist/${id}`)
 const status = async (id: string) => (await wait(id).get()).get('status')
 const join = async (guestName: string, phone: string, partySize: number, day = date) => (await apuntarseListaEspera.run(request({ slug, locationId: lid, date: day, from: '13:00', to: '13:00', partySize, guestName, phone, email: `${guestName.toLowerCase()}@example.test`, language: 'es', website: '' }))).waitlistId as string
 const cancel = (reservationId: string) => cambiarEstadoReserva.run(request({ restaurantId: rid, locationId: lid, reservationId, status: 'cancelled' }, 'owner'))
 const linkOf = async (id: string) => {
  const message = db.doc(`restaurants/${rid}/messages/offer_${id}_email`)
  await expect.poll(async () => (await message.get()).get('status'), { timeout: 60000 }).toBe('captured')
  const url = new URL((await message.get()).get('data.offerUrl'))
  return { url, token: url.searchParams.get('t')!, body: String((await message.get()).get('rendered.body')) }
 }

 afterAll(async () => { await db.recursiveDelete(db.doc(`restaurants/${rid}`)); await db.doc(`publicRestaurants/${slug}`).delete() }, 60000)

 it('ofrece el hueco a la primera entrada compatible, lo reserva, se acepta con el enlace y caduca a su hora', async () => {
  const s = defaultReservationSettings()
  s.publicBooking = true; s.autoConfirm = true; s.minNoticeMinutes = 0; s.waitlist = { enabled: true, offerMinutes: OFFER_MINUTES }
  for (const day of Object.keys(s.week) as (keyof typeof s.week)[]) s.week[day] = [{ name: 'comida', from: '13:00', lastEntry: '13:00' }]
  await db.doc(`restaurants/${rid}`).set({ name: 'Lista de espera', slug, brandColor: '#f0a35e', currency: 'EUR', timezone: 'Europe/Madrid', locale: 'es', isDemo: true, plan: 'reservas', activeModules: ['reservations'] })
  await db.doc(path).set({ name: 'Centro', slug: lid, address: '', city: '', phone: '' })
  await db.doc(`${path}/settings/reservations`).set(s)
  await db.doc(`${path}/tables/t1`).set({ name: 'Mesa 1', areaId: 'sala', seats: 4, shape: 'rect', x: 0, y: 0, w: 10, h: 10, joinableWith: [], enabled: true })
  await db.doc(`restaurants/${rid}/members/owner`).set({ uid: 'owner', displayName: 'Dueño', email: 'owner@test.es', role: 'owner', active: true, locationIds: [] })
  await db.doc(`publicRestaurants/${slug}`).set({ restaurantId: rid, name: 'Lista de espera', brandColor: '#f0a35e', locale: 'es', timezone: 'Europe/Madrid', bookingEnabled: true, bookingDisabledReason: null, locations: [{ id: lid, name: 'Centro', address: '', city: '', phone: '' }], minPartySize: 1, maxPartySize: 12, maxAdvanceDays: 90, deposit: s.deposit, cancellationFreeUntilHours: 0 })
  const booked = { guestName: 'Ana', phone: '+34600000001', email: null, language: 'es' as const, partySize: 4, startAt, durationMinutes: 90, status: 'confirmed' as const, tableIds: ['t1'], suggestedTableIds: [], suggestionReason: null, source: 'web' as const, notes: '', guestNotes: '', customerId: customerIdFor(rid, '+34600000001'), reference: 'ABCD23', manageTokenHash: sha256Hex('test'), deposit: { status: 'none' as const, amountCents: 0, checkoutSessionId: null }, history: [], createdBy: null }
  await db.doc(`restaurants/${rid}/reservationReferences/ABCD23`).set({ locationId: lid, reservationId: 'book1' })
  await db.doc(`${path}/reservations/book1`).set({ ...reservationForWrite(booked, Timestamp.fromMillis), ...stamp() })

  // Con la sala llena nadie puede reservar; hay cuatro en la lista: tres del día y una de otro día que no cabe en ninguna mesa (C).
  const A = await join('Luis', '+34600000002', 4), B = await join('Marta', '+34600000003', 2), C = await join('Pau', '+34600000004', 6, otherDate), D = await join('Sara', '+34600000005', 2)
  expect(await status(A)).toBe('waiting')

  // 1. Cancela el personal: se ofrece a la primera compatible (A) y a nadie más.
  await cancel('book1')
  await expect.poll(() => status(A), { timeout: 60000 }).toBe('offered')
  expect(await status(B)).toBe('waiting')
  expect(await status(C)).toBe('waiting')
  const offer = (await wait(A).get()).get('offer')
  expect(offer.startAt.toMillis()).toBe(startAt)
  // La oferta dura `offerMinutes` minutos desde que se hace.
  const left = offer.expiresAt.toMillis() - Date.now()
  expect(left).toBeGreaterThan((OFFER_MINUTES - 1) * 60000)
  expect(left).toBeLessThanOrEqual(OFFER_MINUTES * 60000)

  // 2. El mensaje capturado lleva el enlace de la página pública con el token.
  const link = await linkOf(A)
  expect(link.url.pathname).toBe(`/r/${slug}/lista-espera/${A}`)
  expect(link.token).toMatch(/^[\w-]{43}$/)
  expect(link.body).toContain(link.url.toString())

  // 3. Mientras dura la oferta, el hueco está guardado: ni se ve libre ni se puede reservar.
  const slots = (await consultarDisponibilidad.run(request({ slug, locationId: lid, date, partySize: 4 }))) as { slots: Array<{ available: boolean }> }
  expect(slots.slots.every(x => !x.available)).toBe(true)
  await expect(crearReservaPublica.run(request({ slug, locationId: lid, date, time: '13:00', partySize: 4, guestName: 'Intruso', phone: '600000009', language: 'es', acceptPolicy: true }))).rejects.toMatchObject({ code: 'failed-precondition' })

  // 4. Aceptar: un enlace falso no vale; el bueno crea la reserva y no se puede usar dos veces.
  await expect(aceptarOfertaListaEspera.run(request({ slug, waitlistId: A, token: 'x'.repeat(43), website: '' }))).rejects.toMatchObject({ code: 'failed-precondition' })
  const out = (await aceptarOfertaListaEspera.run(request({ slug, waitlistId: A, token: link.token, website: '' }))) as { reference: string; manageToken: string; status: string; startAt: number }
  expect(out).toMatchObject({ status: 'confirmed', startAt })
  const accepted = (await db.collection(`${path}/reservations`).where('source', '==', 'waitlist').get()).docs[0]!
  expect((await db.doc(`${path}/reservationOrigins/${accepted.id}`).get()).get('channel')).toBe('waitlist')
  expect((await db.collection(`restaurants/${rid}/consents`).get()).size).toBe(0)
  expect(accepted.data()).toMatchObject({ guestName: 'Luis', partySize: 4, status: 'confirmed' })
  expect(await status(A)).toBe('booked')
  expect(await verReservaPublica.run(request({ slug, reference: out.reference, token: out.manageToken }))).toMatchObject({ reference: out.reference, guestName: 'Luis', status: 'confirmed' })
  await expect(aceptarOfertaListaEspera.run(request({ slug, waitlistId: A, token: link.token, website: '' }))).rejects.toMatchObject({ code: 'failed-precondition' })

  // 5. Se cae esa reserva y se ofrece el hueco a B. Si B no contesta pasado `offerMinutes`,
  //    el enlace deja de valer aunque nadie haya procesado aún la caducidad.
  await cancel(accepted.id)
  await expect.poll(() => status(B), { timeout: 60000 }).toBe('offered')
  const linkB = await linkOf(B)
  await wait(B).update({ 'offer.expiresAt': Timestamp.fromMillis(Date.now() - 1000) })
  await expect(aceptarOfertaListaEspera.run(request({ slug, waitlistId: B, token: linkB.token, website: '' }))).rejects.toMatchObject({ code: 'failed-precondition' })
  expect(await status(B)).toBe('offered')

  // 6. Al procesar (lo hace `mensajesProgramados` cada 5 minutos) B pasa a caducada y la siguiente, D, recibe el hueco.
  await procesarMensajesPendientes.run(request({}, 'team', { logiqd: true }))
  expect(await status(B)).toBe('expired')
  await expect.poll(() => status(D), { timeout: 60000 }).toBe('offered')
  expect(await status(C)).toBe('waiting')
  const linkD = await linkOf(D)
  await expect(aceptarOfertaListaEspera.run(request({ slug, waitlistId: B, token: linkB.token, website: '' }))).rejects.toMatchObject({ code: 'failed-precondition' })
  await expect(aceptarOfertaListaEspera.run(request({ slug, waitlistId: D, token: linkD.token, website: '' }))).resolves.toMatchObject({ status: 'confirmed' })
 }, 180000)
})
