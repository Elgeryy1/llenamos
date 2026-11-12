/**
 * Señal con Stripe de punta a punta, sin cuenta de Stripe: la clave es de mentira, `fetch` a
 * api.stripe.com está simulado y las cargas del webhook van firmadas con HMAC como las de Stripe.
 * No prueba nada contra Stripe real.
 *
 *   TEST_R2_EMULATORS=1 GCLOUD_PROJECT=demo-llenamos FIRESTORE_EMULATOR_HOST=127.0.0.1:8097 \
 *   FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9103 pnpm --filter functions exec vitest run src/deposit
 *
 * El webhook corre en el emulador de Functions (5013) con `STRIPE_WEBHOOK_SECRET=r2-local-test`
 * de `functions/.env.local`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'
import { CrearReservaPublicaOutputSchema, defaultReservationSettings, horaLocal, instanteDeHoraLocal, sha256Hex, sumarDias } from '@llenamos/core'
import { db } from '../shared'
import { crearReservaPublica } from '../reservations'
import { iniciarPagoSenal } from './stripe'
import { aceptarOfertaListaEspera, apuntarseListaEspera } from '../waitlist/service'
import { checkoutEvent, postWebhook, stripeSignature } from './stripe-ejemplos'

const enabled = process.env.TEST_R2_EMULATORS === '1' && /^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '') && process.env.GCLOUD_PROJECT === 'demo-llenamos'
const SECRET = 'r2-local-test'
const WEBHOOK = `http://127.0.0.1:${process.env.FUNCTIONS_PORT ?? '5013'}/demo-llenamos/europe-west1/stripeWebhook`
const TOTAL = 2000 // 4 personas × 500 céntimos

describe.skipIf(!enabled)('Señal con Stripe simulado', () => {
 beforeAll(() => { process.env.FUNCTIONS_EMULATOR = 'true' })
 const rid = `sg-${Date.now()}`, slug = rid, lid = 'centro', path = `restaurants/${rid}/locations/${lid}`
 const date = sumarDias(horaLocal(Date.now(), 'Europe/Madrid').fecha, 3)
 const request = (data: unknown) => ({ data }) as never
 let nextHour = 13
 const book = async (extra: Record<string, unknown> = {}) => {
  const out = CrearReservaPublicaOutputSchema.parse(await crearReservaPublica.run(request({ slug, locationId: lid, date, time: `${nextHour++}:00`, partySize: 4, guestName: 'Berta', phone: `+3460000${String(nextHour).padStart(4, '0')}`, email: 'berta@example.test', language: 'es', acceptPolicy: true, ...extra })))
  const snap = (await db.collection(`${path}/reservations`).where('reference', '==', out.reference).get()).docs[0]!
  return { out, ref: snap.ref }
 }
 const pay = (out: { reference: string; manageToken: string }) => iniciarPagoSenal.run(request({ slug, reference: out.reference, token: out.manageToken }))
 const deposit = async (ref: FirebaseFirestore.DocumentReference) => (await ref.get()).get('deposit')
 const messages = async (ref: FirebaseFirestore.DocumentReference, template: string) => (await db.collection(`restaurants/${rid}/messages`).where('reservationId', '==', ref.id).where('template', '==', template).get()).size
 const stripeCalls = () => (fetcher.mock.calls as Array<[string | URL, RequestInit]>).filter(([u]) => String(u).startsWith('https://api.stripe.com'))
 // `fetch` simulado solo para api.stripe.com; el resto (Firestore, emuladores) pasa tal cual.
 const realFetch = globalThis.fetch
 const stripeAnswers: Response[] = []
 const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => String(url).startsWith('https://api.stripe.com') ? (stripeAnswers.shift() ?? new Response('{}', { status: 500 })) : realFetch(url, init))

 beforeAll(async () => {
  const s = defaultReservationSettings()
  s.publicBooking = true; s.autoConfirm = true; s.minNoticeMinutes = 0; s.waitlist = { enabled: true, offerMinutes: 30 }; s.deposit = { mode: 'perPerson', amountCents: 500, fromPartySize: 1 }
  for (const day of Object.keys(s.week) as (keyof typeof s.week)[]) s.week[day] = [{ name: 'comida', from: '13:00', lastEntry: '20:00' }]
  await db.doc(`restaurants/${rid}`).set({ name: 'Señal', slug, brandColor: '#f0a35e', currency: 'EUR', timezone: 'Europe/Madrid', locale: 'es', isDemo: true, plan: 'reservas', activeModules: ['reservations'] })
  await db.doc(path).set({ name: 'Centro', slug: lid, address: '', city: '', phone: '' })
  await db.doc(`${path}/settings/reservations`).set(s)
  for (let i = 1; i <= 8; i++) await db.doc(`${path}/tables/t${i}`).set({ name: `Mesa ${i}`, areaId: 'sala', seats: 4, shape: 'rect', x: i, y: 0, w: 10, h: 10, joinableWith: [], enabled: true })
  await db.doc(`publicRestaurants/${slug}`).set({ restaurantId: rid, name: 'Señal', brandColor: '#f0a35e', locale: 'es', timezone: 'Europe/Madrid', bookingEnabled: true, bookingDisabledReason: null, locations: [{ id: lid, name: 'Centro', address: '', city: '', phone: '' }], minPartySize: 1, maxPartySize: 12, maxAdvanceDays: 90, deposit: s.deposit, cancellationFreeUntilHours: 0 })
 })
 afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); fetcher.mockClear(); stripeAnswers.length = 0 })
 afterAll(async () => { await db.recursiveDelete(db.doc(`restaurants/${rid}`)); await db.doc(`publicRestaurants/${slug}`).delete() }, 60000)

 it('sin clave de Stripe: la reserva queda pendiente con la señal «no configurada» y no se llama a Stripe', async () => {
  vi.stubEnv('STRIPE_SECRET_KEY', ''); vi.stubGlobal('fetch', fetcher)
  const { out, ref } = await book()
  expect(out).toMatchObject({ status: 'pending', deposit: { status: 'not_configured', amountCents: TOTAL } })
  expect(await deposit(ref)).toMatchObject({ status: 'not_configured', amountCents: TOTAL, checkoutSessionId: null })
  await expect(pay(out)).resolves.toMatchObject({ status: 'not_configured', message: expect.stringContaining('no están configurados') })
  expect(stripeCalls()).toHaveLength(0)
  expect(await messages(ref, 'deposit_request')).toBe(0)
 }, 60000)

 it('con clave de mentira: reserva pendiente con señal requerida y Checkout simulado con el importe del servidor', async () => {
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_de_mentira'); vi.stubEnv('PUBLIC_APP_URL', 'https://llenamos.example.test'); vi.stubGlobal('fetch', fetcher)
  const { out, ref } = await book()
  expect(out).toMatchObject({ status: 'pending', deposit: { status: 'required', amountCents: TOTAL } })
  expect(await messages(ref, 'deposit_request')).toBeGreaterThan(0)

  await expect(iniciarPagoSenal.run(request({ slug, reference: out.reference, token: 'x'.repeat(43) }))).rejects.toMatchObject({ code: 'not-found' })
  vi.stubEnv('PUBLIC_APP_URL', 'http://localhost:3012')
  await expect(pay(out)).rejects.toMatchObject({ code: 'failed-precondition' })
  vi.stubEnv('PUBLIC_APP_URL', 'https://llenamos.example.test')
  expect(stripeCalls()).toHaveLength(0)

  // Stripe falla: error claro y la reserva sigue sin sesión.
  stripeAnswers.push(new Response('{"error":{"message":"boom"}}', { status: 500 }))
  await expect(pay(out)).rejects.toMatchObject({ code: 'unavailable' })
  expect((await deposit(ref)).checkoutSessionId).toBeNull()

  // Stripe responde: se guarda la sesión y se manda a la página de pago.
  stripeAnswers.push(new Response(JSON.stringify({ id: 'cs_test_a1', url: 'https://checkout.stripe.com/c/pay/cs_test_a1' })))
  await expect(pay(out)).resolves.toEqual({ status: 'redirect', url: 'https://checkout.stripe.com/c/pay/cs_test_a1' })
  expect(await deposit(ref)).toMatchObject({ status: 'required', amountCents: TOTAL, checkoutSessionId: 'cs_test_a1' })
  const [url, init] = stripeCalls().at(-1)!
  const body = new URLSearchParams(String(init.body))
  expect(String(url)).toBe('https://api.stripe.com/v1/checkout/sessions')
  expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk_test_de_mentira')
  expect(body.get('mode')).toBe('payment')
  expect(body.get('line_items[0][price_data][currency]')).toBe('eur')
  expect(body.get('line_items[0][price_data][unit_amount]')).toBe(String(TOTAL))
  expect(body.get('metadata[reservationPath]')).toBe(ref.path)
  expect(body.get('success_url')).toBe(`https://llenamos.example.test/r/${slug}/reserva/${out.reference}?t=${out.manageToken}`)
  // La misma clave de idempotencia en cada intento por la misma reserva e importe.
  const keys = stripeCalls().map(([, i]) => (i.headers as Record<string, string>)['Idempotency-Key'])
  expect(new Set(keys).size).toBe(1)
 }, 60000)

 it('webhook: rechaza firmas malas, caducadas o de otro secreto y no toca la reserva', async () => {
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_de_mentira'); vi.stubEnv('PUBLIC_APP_URL', 'https://llenamos.example.test'); vi.stubGlobal('fetch', fetcher)
  const { out, ref } = await book()
  stripeAnswers.push(new Response(JSON.stringify({ id: 'cs_test_b1', url: 'https://checkout.stripe.com/c/pay/cs_test_b1' })))
  await pay(out)
  vi.unstubAllGlobals()
  const raw = JSON.stringify(checkoutEvent({ sessionId: 'cs_test_b1', reservationPath: ref.path, amountCents: TOTAL }))
  const now = Math.floor(Date.now() / 1000)
  const attempts: Array<[string, number, string | null, string?]> = [
   ['sin firma', 401, null],
   ['firma sin sentido', 401, 'invalid'],
   ['otro secreto', 401, stripeSignature(raw, 'otro-secreto')],
   ['cuerpo cambiado tras firmar', 401, stripeSignature(raw.replace('2000', '1'), SECRET), raw],
   ['firma de hace 10 minutos', 401, stripeSignature(raw, SECRET, now - 600)],
   ['firma con fecha de dentro de 10 minutos', 401, stripeSignature(raw, SECRET, now + 600)],
   ['firma sin hora', 401, `v1=${stripeSignature(raw, SECRET).split('v1=')[1]}`],
  ]
  for (const [what, status, signature, sent] of attempts) expect((await postWebhook(WEBHOOK, sent ?? raw, signature)).status, what).toBe(status)
  expect((await postWebhook(WEBHOOK, raw, stripeSignature(raw, SECRET), 'GET')).status).toBe(405)
  expect(await deposit(ref)).toMatchObject({ status: 'required', checkoutSessionId: 'cs_test_b1' })
  expect((await ref.get()).get('status')).toBe('pending')

  // Firma buena pero el pago no cuadra: error (Stripe reintenta) y nada cambia.
  const signed = (event: unknown) => { const r = JSON.stringify(event); return postWebhook(WEBHOOK, r, stripeSignature(r, SECRET)) }
  const base = { sessionId: 'cs_test_b1', reservationPath: ref.path, amountCents: TOTAL }
  expect((await signed(checkoutEvent({ ...base, amountCents: 1 }))).status).toBe(500)
  expect((await signed(checkoutEvent({ ...base, currency: 'usd' }))).status).toBe(500)
  expect((await signed(checkoutEvent({ ...base, sessionId: 'cs_test_otra' }))).status).toBe(500)
  // Eventos que no son un pago completo se aceptan sin hacer nada.
  expect((await signed(checkoutEvent({ ...base, paymentStatus: 'unpaid' }))).status).toBe(200)
  expect((await signed(checkoutEvent({ ...base, type: 'checkout.session.expired' }))).status).toBe(200)
  expect((await signed(checkoutEvent({ ...base, reservationPath: `restaurants/${rid}/locations/${lid}/reservations/no-existe` }))).status).toBe(200)
  expect((await signed(checkoutEvent({ ...base, reservationPath: 'restaurants/x/../../y' }))).status).toBe(200)
  expect((await signed({ id: 'evt_raro', nada: true })).status).toBe(500)
  expect(await deposit(ref)).toMatchObject({ status: 'required' })
  expect((await ref.get()).get('status')).toBe('pending')
 }, 60000)

 it('webhook: el pago bueno confirma la reserva una sola vez aunque Stripe repita el evento', async () => {
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_de_mentira'); vi.stubEnv('PUBLIC_APP_URL', 'https://llenamos.example.test'); vi.stubGlobal('fetch', fetcher)
  const { out, ref } = await book()
  stripeAnswers.push(new Response(JSON.stringify({ id: 'cs_test_c1', url: 'https://checkout.stripe.com/c/pay/cs_test_c1' })))
  await pay(out)
  vi.unstubAllGlobals()
  const raw = JSON.stringify(checkoutEvent({ sessionId: 'cs_test_c1', reservationPath: ref.path, amountCents: TOTAL }))
  expect((await postWebhook(WEBHOOK, raw, stripeSignature(raw, SECRET))).status).toBe(200)
  const after = await ref.get()
  expect(after.get('deposit')).toMatchObject({ status: 'paid', amountCents: TOTAL, checkoutSessionId: 'cs_test_c1' })
  expect(after.get('status')).toBe('confirmed')
  expect(after.get('history')).toHaveLength(1)
  expect(after.get('history')[0]).toMatchObject({ from: 'pending', to: 'confirmed', reason: 'Señal pagada' })
  const confirmations = await messages(ref, 'confirmation')
  expect(confirmations).toBeGreaterThan(0)
  // Dos entregas más, una con firma nueva y otra repetida byte a byte: nada cambia.
  expect((await postWebhook(WEBHOOK, raw, stripeSignature(raw, SECRET))).status).toBe(200)
  expect((await postWebhook(WEBHOOK, raw, stripeSignature(raw, SECRET, Math.floor(Date.now() / 1000) - 120))).status).toBe(200)
  expect((await ref.get()).get('history')).toHaveLength(1)
  expect(await messages(ref, 'confirmation')).toBe(confirmations)
  await expect(pay(out)).resolves.toEqual({ status: 'already_paid' })
 }, 60000)

 it('webhook: un pago tardío de una reserva cancelada se anota sin reabrirla', async () => {
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_de_mentira'); vi.stubEnv('PUBLIC_APP_URL', 'https://llenamos.example.test'); vi.stubGlobal('fetch', fetcher)
  const { out, ref } = await book()
  stripeAnswers.push(new Response(JSON.stringify({ id: 'cs_test_d1', url: 'https://checkout.stripe.com/c/pay/cs_test_d1' })))
  await pay(out)
  vi.unstubAllGlobals()
  await ref.update({ status: 'cancelled', updatedAt: Timestamp.now() })
  const raw = JSON.stringify(checkoutEvent({ sessionId: 'cs_test_d1', reservationPath: ref.path, amountCents: TOTAL }))
  expect((await postWebhook(WEBHOOK, raw, stripeSignature(raw, SECRET))).status).toBe(200)
  expect(await deposit(ref)).toMatchObject({ status: 'paid' })
  expect((await ref.get()).get('status')).toBe('cancelled')
 }, 60000)

 it.each([
  ['sin clave de Stripe', '', 'not_configured', 'pending'],
  ['con clave de mentira', 'sk_test_de_mentira', 'required', 'deposit_request'],
 ])('lista de espera con señal, %s: la reserva nace pendiente y el aviso solo pide pagar si se puede', async (_, key, state, template) => {
  vi.stubEnv('STRIPE_SECRET_KEY', key)
  const token = 'c'.repeat(43), startAt = instanteDeHoraLocal(date, 20 * 60, 'Europe/Madrid')!
  const joined = await apuntarseListaEspera.run(request({ slug, locationId: lid, date, from: '20:00', to: '20:00', partySize: 4, guestName: 'Rosa', phone: `+3461000${key ? '0002' : '0001'}`, email: 'rosa@example.test', language: 'es', website: '' })) as { waitlistId: string }
  await db.doc(`${path}/waitlist/${joined.waitlistId}`).update({ status: 'offered', offer: { startAt: Timestamp.fromMillis(startAt), expiresAt: Timestamp.fromMillis(Date.now() + 600000), tokenHash: sha256Hex(token) } })
  const out = await aceptarOfertaListaEspera.run(request({ slug, waitlistId: joined.waitlistId, token, website: '' })) as { status: string; deposit: { status: string; amountCents: number } }
  expect(out).toMatchObject({ status: 'pending', deposit: { status: state, amountCents: TOTAL } })
  const sent = (await db.collection(`restaurants/${rid}/messages`).where('waitlistId', '==', joined.waitlistId).get()).docs.map(d => d.get('template'))
  expect(new Set(sent)).toEqual(new Set([template]))
 }, 60000)
})
