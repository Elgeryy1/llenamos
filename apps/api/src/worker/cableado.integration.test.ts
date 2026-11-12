import { createHmac, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as core from '@llenamos/core'
import { fileStore } from '../files/storage.js'
import { fileRoutes } from '../files/routes.js'
import { openExport } from '../privacy/crypto.js'
import { privacyRoutes } from '../privacy/routes.js'
import { integrationVault, webhookSubset, WEBHOOK_PROVIDERS } from '../platform/integrations.js'
import { MODULES } from '../modules/index.js'
import type { ModuleDefinition } from '../modules/types.js'
import { campaignOutboxId } from '../modules/campanas/proceso.js'
import { limits, resetMemoryLimits } from '../modules/reservas/abuse.js'
import { reservasMaintenance } from '../modules/reservas/worker.js'
import { salaMaintenance } from '../modules/sala/jobs.js'
import { apiServer } from '../server.js'
import { webhookReceiver } from '../webhooks/receiver.js'
import { buildHandlers, createWorker } from './index.js'
import { testDatabase } from './harness.js'

const enabled = process.env.TEST_POSTGRES_API === '1' && !!process.env.TEST_POSTGRES_URL
const key = Buffer.alloc(32, 11), vault = integrationVault(key)
const RID = 'ra', LID = 'la', OTHER = 'rb'
const phone = (n: number) => `+346000${String(n).padStart(5, '0')}`
const nextWednesday = () => { const d = new Date(Date.now() + 6 * 86_400_000); while (d.getUTCDay() !== 3) d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10) }
const dayAfter = (k: number) => { const d = new Date(`${nextWednesday()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 7 * k); return d.toISOString().slice(0, 10) }
const ALL_DAY = { name: 'Servicio', from: '00:00', lastEntry: '23:45' }
const ALL_DAY_WEEK = { mon: [ALL_DAY], tue: [ALL_DAY], wed: [ALL_DAY], thu: [ALL_DAY], fri: [ALL_DAY], sat: [ALL_DAY], sun: [ALL_DAY] }
const SECRETS = { email: { apiKey: 'key-a', from: 'a@example.test' }, whatsapp: { token: 'wa', phoneNumberId: '111', appSecret: 'wa-secret', verifyToken: 'v', templateTakeawayAccepted: 'acepta', templateTakeawayReady: 'lista' }, stripe: { secretKey: 'sk', webhookSecret: 'whsec_a' } }

describe.skipIf(!enabled)('Cableado A: jobs, Stripe, respuestas de WhatsApp y privacidad con el worker real', { timeout: 30_000 }, () => {
  process.env.SALA_SECRET_KEY = 'ef'.repeat(32)
  process.env.PUBLIC_APP_URL = 'https://app.example.test'
  process.env.TRUSTED_IP_HEADER = 'x-test-ip'; process.env.TRUSTED_PROXY_ADDRESSES = '127.0.0.1,::1'
  let db: Awaited<ReturnType<typeof testDatabase>>, token: (uid: string) => import('../auth.js').IdentityToken, server: ReturnType<typeof apiServer>, base: string, root: string
  let store: ReturnType<typeof fileStore>, ip = 0
  const requests: Array<{ url: string; body: any }> = []
  let providerIds = 0
  const fetchStub = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init!.body)) })
    return new Response(JSON.stringify(String(url).includes('resend') ? { id: `re_${++providerIds}` } : { messages: [{ id: `wamid.out${++providerIds}` }] }), { status: 200 })
  }) as unknown as typeof fetch
  const worker = () => createWorker({ pool: db.worker, fetch: fetchStub, log: () => undefined, openCredentials: (rid, cipher) => vault.open(rid, cipher), handlers: buildHandlers(MODULES, { files: store, privacyKey: key }) })
  const drain = async () => { const w = worker(); for (let i = 0; i < 12; i++) if (!await w.runOnce()) break }
  const call = async (name: string, data: unknown, actor?: string) => {
    const response = await fetch(`${base}/v1/operations/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-ip': `198.51.100.${(++ip % 250) + 1}`, ...(actor ? { Authorization: `Bearer ${actor}` } : {}) }, body: JSON.stringify({ data }) })
    const body = await response.json() as { result?: any; error?: { code: string } }
    return { status: response.status, body, result: body.result, code: body.error?.code }
  }
  const one = async (sql: string, values: unknown[] = []) => (await db.admin.query(sql, values)).rows[0]
  const count = async (sql: string, values: unknown[] = []) => Number((await one(sql, values)).count)
  const pub = (over: Record<string, unknown> = {}) => ({ slug: RID, locationId: LID, date: nextWednesday(), time: '20:00', partySize: 4, guestName: 'Ana Pruebas', phone: phone(1), email: null, language: 'es', guestNotes: '', acceptPolicy: true, source: 'web', website: '', ...over })
  const settings = (over: Record<string, unknown> = {}) => ({ ...core.defaultReservationSettings('Europe/Madrid'), publicBooking: true, autoConfirm: true, minNoticeMinutes: 0, maxAdvanceDays: 700, ...over })
  const configure = (over: Record<string, unknown> = {}) => call('guardarConfiguracionReservas', { restaurantId: RID, locationId: LID, settings: settings(over) }, 'owner-a')
  const setSecrets = async (rid: string, value: object | null) => {
    await db.admin.query('DELETE FROM llenamos.integration_secrets WHERE restaurant_id=$1', [rid])
    await db.admin.query('DELETE FROM llenamos.integration_webhook_secrets WHERE restaurant_id=$1', [rid])
    if (!value) return
    await db.admin.query('INSERT INTO llenamos.integration_secrets(restaurant_id,ciphertext) VALUES($1,$2)', [rid, vault.seal(rid, value)])
    for (const provider of WEBHOOK_PROVIDERS) {
      const sealed = vault.sealWebhook(rid, provider, webhookSubset(value, provider))
      if (sealed) await db.admin.query('INSERT INTO llenamos.integration_webhook_secrets(restaurant_id,provider,ciphertext) VALUES($1,$2,$3)', [rid, provider, sealed])
    }
  }
  const stripePost = (rid: string, event: object, secret = 'whsec_a') => {
    const body = JSON.stringify(event), t = Math.floor(Date.now() / 1000)
    return fetch(`${base}/v1/webhooks/stripe/${rid}`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}` } })
  }
  const whatsappPost = (rid: string, message: object, secret = 'wa-secret') => {
    const body = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: '111' }, messages: [{ timestamp: String(Math.floor(Date.now() / 1000)), ...message }] } }] }] })
    return fetch(`${base}/v1/webhooks/whatsapp/${rid}`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex') } })
  }

  beforeAll(async () => {
    db = await testDatabase('cableado')
    token = await db.seed([RID, OTHER], [[RID, 'owner-a', 'owner'], [RID, 'waiter-a', 'waiter'], [OTHER, 'owner-b', 'owner']])
    await db.admin.query("UPDATE llenamos.restaurants SET plan='sala',active_modules='{reservations,floor,kitchen,pos}'")
    for (const rid of [RID, OTHER]) await db.admin.query('INSERT INTO llenamos.locations(restaurant_id,id,name,slug,address,phone) VALUES($1,$2,$2,$2,$3,$4)', [rid, LID, 'Calle Mayor 1', '910000000'])
    await setSecrets(RID, SECRETS)
    root = await mkdtemp(path.join(os.tmpdir(), 'llenamos-cableado-')); store = fileStore(root)
    const receive = webhookReceiver(db.webhook, vault, { handled: new Set(['webhook.stripe', 'webhook.whatsapp']) })
    server = apiServer(db.app, async value => token(value), () => undefined, { routes: [({ req, res, path: p }) => receive(req, res, p), fileRoutes(store), privacyRoutes(store, key)] })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const area = { id: 'sala', name: 'Sala', sortOrder: 0 }
    const tables = ['T1', 'T2', 'T3'].map((name, i) => ({ id: `${LID}-${name}`, name, areaId: 'sala', seats: 4, shape: 'rect', x: 5 + i * 20, y: 5, w: 10, h: 10, joinableWith: [], enabled: true }))
    expect((await call('guardarPlano', { restaurantId: RID, locationId: LID, createAreas: [area], createTables: tables }, 'owner-a')).status).toBe(200)
    expect((await configure()).status).toBe(200)
    // Sala: carta de demostración y recogida pública.
    const demo = core.demoMenu(), reservations = core.defaultReservationSettings(), shifts = [{ name: 'Servicio', from: '00:00', lastEntry: '23:45' }]
    reservations.week = { mon: shifts, tue: shifts, wed: shifts, thu: shifts, fri: shifts, sat: shifts, sun: shifts }
    demo.settings.takeaway.autoAccept = true; demo.settings.takeaway.enabled = true; demo.settings.takeaway.publicOrdering = true
    // Los horarios viven solo en reservation_settings (014 prohíbe la copia en sala_settings).
    await db.admin.query("INSERT INTO llenamos.reservation_settings(restaurant_id,location_id,data) VALUES($1,$2,$3) ON CONFLICT(restaurant_id,location_id) DO UPDATE SET data=EXCLUDED.data", [RID, LID, JSON.stringify(reservations)])
    await db.admin.query("INSERT INTO llenamos.sala_settings(restaurant_id,location_id,kind,doc) VALUES($1,$2,'floor',$3)", [RID, LID, JSON.stringify(demo.settings)])
    for (const [table, rows] of Object.entries({ sala_menu_categories: demo.categories, sala_menu_items: demo.items, sala_daily_menus: demo.dailyMenus, sala_stations: demo.stations }))
      for (const [itemId, value] of Object.entries(rows)) await db.admin.query(`INSERT INTO llenamos.${table}(restaurant_id,location_id,id,doc) VALUES($1,$2,$3,$4)`, [RID, LID, itemId, JSON.stringify(value)])
  }, 90_000)
  afterAll(async () => {
    server?.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await db?.close(); await rm(root, { recursive: true, force: true })
  })
  beforeEach(() => { resetMemoryLimits(); requests.length = 0 })

  describe('trabajos periódicos', () => {
    it('reservas.caducar_oferta: el worker caduca la oferta vencida y ofrece el hueco a la siguiente persona', async () => {
      await configure({ waitlist: { enabled: true, offerMinutes: 5 } })
      const date = dayAfter(10)
      const made = await Promise.all(['T1', 'T2', 'T3'].map((t, i) => call('crearReserva', { restaurantId: RID, locationId: LID, date, time: '13:00', partySize: 4, guestName: `Cad ${i}`, phone: phone(500 + i), source: 'phone', tableIds: [`${LID}-${t}`], durationMinutes: 240 }, 'owner-a')))
      expect(made.every(r => r.status === 200)).toBe(true)
      const waiting = []
      for (const i of [0, 1]) waiting.push(await call('apuntarseListaEspera', { slug: RID, locationId: LID, date, from: '13:00', to: '13:30', partySize: 4, guestName: `Espera ${i}`, phone: phone(510 + i), email: null, language: 'es', source: 'web', website: '' }))
      expect((await call('cambiarEstadoReserva', { restaurantId: RID, locationId: LID, reservationId: made[0]!.result.reservationId, status: 'cancelled' }, 'owner-a')).status).toBe(200)
      const [first, second] = waiting.map(w => w.result.waitlistId)
      expect((await one('SELECT status FROM llenamos.waitlist WHERE id=$1', [first])).status).toBe('offered')
      // El trabajo de la oferta existe, programado a su hora de caducidad: aún no toca.
      const job = await one("SELECT id,scheduled_at>now() AS later FROM llenamos.jobs WHERE restaurant_id=$1 AND kind='reservas.caducar_oferta' AND payload->>'waitlistId'=$2", [RID, first])
      expect(job.later).toBe(true)
      await drain()
      expect((await one('SELECT status FROM llenamos.waitlist WHERE id=$1', [first])).status).toBe('offered')
      // Llega la hora: la oferta vence y el worker reclama el trabajo.
      await db.admin.query("UPDATE llenamos.waitlist SET offer_expires_at=now()-interval '1 minute' WHERE id=$1", [first])
      await db.admin.query("UPDATE llenamos.jobs SET scheduled_at=now() WHERE id=$1", [job.id])
      await drain()
      expect((await one('SELECT status FROM llenamos.waitlist WHERE id=$1', [first])).status).toBe('expired')
      expect((await one('SELECT status FROM llenamos.waitlist WHERE id=$1', [second])).status).toBe('offered')
      expect((await one('SELECT status FROM llenamos.jobs WHERE id=$1', [job.id])).status).toBe('done')
      // Repetir el trabajo no cambia nada.
      await db.admin.query("UPDATE llenamos.jobs SET status='pending',scheduled_at=now(),lease_id=NULL,lease_until=NULL WHERE id=$1", [job.id])
      await drain()
      expect((await one('SELECT status FROM llenamos.waitlist WHERE id=$1', [second])).status).toBe('offered')
      await configure()
    })

    it('la red de seguridad encola el trabajo de un local con ofertas vencidas aunque se perdiera el suyo', async () => {
      await configure({ waitlist: { enabled: true, offerMinutes: 5 } })
      const date = dayAfter(11)
      const made = await Promise.all(['T1', 'T2', 'T3'].map((t, i) => call('crearReserva', { restaurantId: RID, locationId: LID, date, time: '13:00', partySize: 4, guestName: `Red ${i}`, phone: phone(520 + i), source: 'phone', tableIds: [`${LID}-${t}`], durationMinutes: 240 }, 'owner-a')))
      const join = await call('apuntarseListaEspera', { slug: RID, locationId: LID, date, from: '13:00', to: '13:30', partySize: 4, guestName: 'Espera Red', phone: phone(530), email: null, language: 'es', source: 'web', website: '' })
      await call('cambiarEstadoReserva', { restaurantId: RID, locationId: LID, reservationId: made[0]!.result.reservationId, status: 'cancelled' }, 'owner-a')
      await db.admin.query("DELETE FROM llenamos.jobs WHERE restaurant_id=$1 AND kind='reservas.caducar_oferta' AND payload->>'waitlistId'=$2", [RID, join.result.waitlistId])
      await db.admin.query("UPDATE llenamos.waitlist SET offer_expires_at=now()-interval '1 minute' WHERE id=$1", [join.result.waitlistId])
      const [task] = reservasMaintenance(db.worker)
      expect(await task!.run()).toBeGreaterThanOrEqual(1)
      expect(await task!.run()).toBeGreaterThanOrEqual(1) // mismo tramo de 5 minutos: no duplica
      expect(await count("SELECT count(*) FROM llenamos.jobs WHERE restaurant_id=$1 AND kind='reservas.caducar_oferta' AND deduplication_key LIKE 'sweep:%'", [RID])).toBe(1)
      await drain()
      expect((await one('SELECT status FROM llenamos.waitlist WHERE id=$1', [join.result.waitlistId])).status).toBe('expired')
      await configure()
    })

    it('el barrido de ofertas con el restaurante sin servicio caduca por SQL y no genera fallos cada 5 minutos', async () => {
      await configure({ waitlist: { enabled: true, offerMinutes: 5 } })
      const date = dayAfter(18)
      const made = await Promise.all(['T1', 'T2', 'T3'].map((t, i) => call('crearReserva', { restaurantId: RID, locationId: LID, date, time: '13:00', partySize: 4, guestName: `Sin servicio ${i}`, phone: phone(540 + i), source: 'phone', tableIds: [`${LID}-${t}`], durationMinutes: 240 }, 'owner-a')))
      const join = await call('apuntarseListaEspera', { slug: RID, locationId: LID, date, from: '13:00', to: '13:30', partySize: 4, guestName: 'Espera sin servicio', phone: phone(550), email: null, language: 'es', source: 'web', website: '' })
      await call('cambiarEstadoReserva', { restaurantId: RID, locationId: LID, reservationId: made[0]!.result.reservationId, status: 'cancelled' }, 'owner-a')
      expect((await one('SELECT status FROM llenamos.waitlist WHERE id=$1', [join.result.waitlistId])).status).toBe('offered')
      await db.admin.query("DELETE FROM llenamos.jobs WHERE restaurant_id=$1 AND kind='reservas.caducar_oferta'", [RID])
      await db.admin.query("UPDATE llenamos.waitlist SET offer_expires_at=now()-interval '1 minute' WHERE id=$1", [join.result.waitlistId])
      await db.admin.query("UPDATE llenamos.restaurants SET entitlement_version=1,access_valid_until=now()-interval '1 day' WHERE id=$1", [RID])
      try {
        const [sweep] = reservasMaintenance(db.worker)
        expect(await sweep!.run()).toBe(1)
        await drain()
        expect(await one("SELECT status,last_error FROM llenamos.jobs WHERE restaurant_id=$1 AND kind='reservas.caducar_oferta'", [RID])).toEqual({ status: 'done', last_error: null })
        expect((await one('SELECT status FROM llenamos.waitlist WHERE id=$1', [join.result.waitlistId])).status).toBe('expired')
        // Nadie recibe el hueco (el restaurante no tiene servicio) y el siguiente barrido ya no encuentra nada.
        const [later] = reservasMaintenance(db.worker, () => Date.now() + 600_000)
        expect(await later!.run()).toBe(0)
      } finally {
        await db.admin.query('UPDATE llenamos.restaurants SET entitlement_version=NULL,access_valid_until=NULL WHERE id=$1', [RID])
        await configure()
      }
    })

    it('sala.marchar_recogidas: el plato de una recogida aceptada marcha cuando llega su hora', async () => {
      await configure({ week: ALL_DAY_WEEK }) // recogida a cualquier hora, sea cual sea la del día de la prueba
      const date = core.sumarDias(core.horaLocal(Date.now(), 'Europe/Madrid').fecha, 1) // mañana: a última hora de hoy ya no quedan franjas
      const slots = await call('consultarRecogida', { slug: RID, locationId: LID, date }, undefined)
      const slot = slots.result.slots.find((s: { available: boolean }) => s.available)
      expect(slot).toBeTruthy()
      const lines = [{ kind: 'item', itemId: 'bravas', quantity: 1 }]
      const placed = await call('pedirParaLlevar', { slug: RID, locationId: LID, date, time: slot.time, guestName: 'Ana Prueba', phone: phone(40), email: 'ana@example.test', language: 'es', lines, expectedTotalCents: 650, notes: '', acceptPolicy: true, website: '' })
      expect(placed.status, JSON.stringify(placed.body)).toBe(200)
      const line = async () => (await db.admin.query('SELECT id,doc FROM llenamos.sala_order_lines WHERE restaurant_id=$1 AND takeaway_id=(SELECT id FROM llenamos.sala_takeaways WHERE restaurant_id=$1 AND reference=$2)', [RID, placed.result.reference])).rows[0]
      expect((await line()).doc.status).toBe('held')
      const [task] = salaMaintenance(db.worker)
      expect(await task!.run()).toBe(0) // plato retenido pero aún no es su hora: no se encola nada
      await drain()
      expect((await line()).doc.status).toBe('held')
      await db.admin.query("UPDATE llenamos.sala_order_lines SET doc=jsonb_set(doc,'{fireAt}',to_jsonb((extract(epoch from now())*1000)::bigint-1000)) WHERE id=$1", [(await line()).id])
      await db.admin.query("DELETE FROM llenamos.jobs WHERE kind='sala.marchar_recogidas'")
      expect(await task!.run()).toBeGreaterThanOrEqual(1)
      await drain()
      expect((await line()).doc.status).toBe('fired')
      expect(await count("SELECT count(*) FROM llenamos.events WHERE restaurant_id=$1 AND topic='sala.linea' AND entity_id=$2", [RID, (await line()).id])).toBeGreaterThan(0)
    })
  })

  describe('webhook.stripe: señal de reserva', () => {
    let stripeDay = 20
    async function stripeReservation(deposit = 500) {
      await configure({ deposit: { mode: 'perPerson', amountCents: deposit, fromPartySize: 2 } })
      await db.admin.query("INSERT INTO llenamos.platform_restaurants(restaurant_id,name,slug,plan_id,owner_email,integration_status) VALUES($1,'Restaurante ra',$1,'sala','o@example.test','{\"stripe\":{\"configured\":true,\"status\":\"configured\"}}') ON CONFLICT(restaurant_id) DO UPDATE SET integration_status=EXCLUDED.integration_status", [RID])
      const out = await call('crearReservaPublica', pub({ date: dayAfter(stripeDay++), time: '14:00', phone: phone(600 + stripeDay), guestName: `Señal ${randomUUID().slice(0, 4)}` }))
      expect(out.status, JSON.stringify(out.body)).toBe(200)
      expect(out.result.deposit.status).toBe('required')
      const row = await one('SELECT id FROM llenamos.reservations WHERE restaurant_id=$1 AND reference=$2', [RID, out.result.reference])
      const session = `cs_${randomUUID().replaceAll('-', '')}`
      const { recordCheckoutSession } = await import('../modules/reservas/deposit.js')
      expect(await recordCheckoutSession(db.app, RID, LID, row.id, session)).toBe(true)
      return { id: row.id as string, session, amount: out.result.deposit.amountCents as number }
    }
    const event = (id: string, r: { id: string; session: string; amount: number }, over: object = {}) => ({ id, type: 'checkout.session.completed', created: 1, livemode: false,
      data: { object: { id: r.session, payment_status: 'paid', amount_total: r.amount, currency: 'eur', metadata: { kind: 'reservation_deposit', reservationId: r.id, locationId: LID }, ...over } } })

    it('un evento firmado confirma la reserva una sola vez, aunque Stripe lo repita', async () => {
      const r = await stripeReservation()
      const evt = `evt_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      expect((await stripePost(RID, event(evt, r))).status).toBe(200)
      expect((await stripePost(RID, event(evt, r))).status).toBe(200) // duplicado: el receptor lo descarta
      await drain()
      expect((await one('SELECT status,data FROM llenamos.reservations WHERE id=$1', [r.id]))).toMatchObject({ status: 'confirmed', data: { deposit: { status: 'paid' } } })
      // Otro evento distinto con la misma sesión tampoco repite el efecto.
      const notices = await count("SELECT count(*) FROM llenamos.outbox WHERE restaurant_id=$1 AND payload->>'reservationId'=$2 AND payload->>'template'='confirmation'", [RID, r.id])
      expect((await stripePost(RID, event(`evt_${randomUUID().replaceAll('-', '').slice(0, 16)}`, r))).status).toBe(200)
      await drain()
      expect(await count("SELECT count(*) FROM llenamos.outbox WHERE restaurant_id=$1 AND payload->>'reservationId'=$2 AND payload->>'template'='confirmation'", [RID, r.id])).toBe(notices)
    })

    it('firma incorrecta, pago sin completar e importe que no cuadra no confirman nada', async () => {
      const r = await stripeReservation()
      expect((await stripePost(RID, event('evt_malafirma01', r), 'otro-secreto')).status).toBe(401)
      expect((await stripePost(RID, event('evt_sinpagar0001', r, { payment_status: 'unpaid' }))).status).toBe(200)
      const wrong = `evt_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      expect((await stripePost(RID, event(wrong, r, { amount_total: 1 }))).status).toBe(200)
      await drain()
      expect((await one('SELECT status,data FROM llenamos.reservations WHERE id=$1', [r.id])).data.deposit.status).toBe('required')
      // El pago que no cuadra no se pierde ni se aplica: queda en cuarentena para revisarlo.
      expect((await one("SELECT status,last_error FROM llenamos.outbox WHERE restaurant_id=$1 AND kind='webhook.stripe' AND payload->>'eventId'=$2", [RID, wrong]))).toEqual({ status: 'quarantined', last_error: 'senal-no-corresponde' })
    })

    it('async_payment_succeeded también confirma la señal', async () => {
      const r = await stripeReservation()
      const evt = `evt_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      expect((await stripePost(RID, { ...event(evt, r), type: 'checkout.session.async_payment_succeeded' })).status).toBe(200)
      await drain()
      expect((await one('SELECT status,data FROM llenamos.reservations WHERE id=$1', [r.id]))).toMatchObject({ status: 'confirmed', data: { deposit: { status: 'paid' } } })
    })

    it('una señal cobrada sin reserva o sin local queda en cuarentena, no se pierde', async () => {
      const r = await stripeReservation()
      const noReservation = `evt_${randomUUID().replaceAll('-', '').slice(0, 16)}`, noLocation = `evt_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      await stripePost(RID, event(noReservation, { ...r, id: 'no-existe-123' }))
      await stripePost(RID, { ...event(noLocation, r), data: { object: { ...event(noLocation, r).data.object, metadata: { kind: 'reservation_deposit', reservationId: r.id, locationId: 'local-que-no-existe' } } } })
      await drain()
      for (const evt of [noReservation, noLocation])
        expect(await one("SELECT status,last_error FROM llenamos.outbox WHERE restaurant_id=$1 AND kind='webhook.stripe' AND payload->>'eventId'=$2", [RID, evt])).toEqual({ status: 'quarantined', last_error: expect.stringMatching(/^senal-sin-/) })
      expect((await one('SELECT data FROM llenamos.reservations WHERE id=$1', [r.id])).data.deposit.status).toBe('required')
    })

    it('una señal con el restaurante sin servicio se reintenta unas horas y después queda en cuarentena', async () => {
      const r = await stripeReservation()
      const evt = `evt_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      await stripePost(RID, event(evt, r))
      await db.admin.query("UPDATE llenamos.restaurants SET entitlement_version=1,access_valid_until=now()-interval '1 day' WHERE id=$1", [RID])
      try {
        await drain()
        expect(await one("SELECT status,attempts FROM llenamos.outbox WHERE restaurant_id=$1 AND kind='webhook.stripe' AND payload->>'eventId'=$2", [RID, evt])).toEqual({ status: 'pending', attempts: 1 })
        await db.admin.query("UPDATE llenamos.outbox SET attempts=7,available_at=now() WHERE restaurant_id=$1 AND payload->>'eventId'=$2", [RID, evt])
        await drain()
        expect(await one("SELECT status,last_error FROM llenamos.outbox WHERE restaurant_id=$1 AND kind='webhook.stripe' AND payload->>'eventId'=$2", [RID, evt])).toEqual({ status: 'quarantined', last_error: 'senal-sin-servicio' })
      } finally { await db.admin.query('UPDATE llenamos.restaurants SET entitlement_version=NULL,access_valid_until=NULL WHERE id=$1', [RID]) }
    })

    it('una señal de reserva sin reservationId queda en cuarentena, no se purga como fallo', async () => {
      const r = await stripeReservation()
      const evt = `evt_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      await stripePost(RID, { ...event(evt, r), data: { object: { ...event(evt, r).data.object, metadata: { kind: 'reservation_deposit', locationId: LID } } } })
      await drain()
      expect(await one("SELECT status,last_error FROM llenamos.outbox WHERE restaurant_id=$1 AND kind='webhook.stripe' AND payload->>'eventId'=$2", [RID, evt])).toEqual({ status: 'quarantined', last_error: 'senal-sin-reserva' })
    })

    it('una señal sobre una reserva ya cancelada se anota sin resucitarla y alerta en cuarentena', async () => {
      const r = await stripeReservation()
      await call('cambiarEstadoReserva', { restaurantId: RID, locationId: LID, reservationId: r.id, status: 'cancelled' }, 'owner-a')
      const evt = `evt_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      await stripePost(RID, event(evt, r))
      await drain()
      expect(await one("SELECT status,last_error FROM llenamos.outbox WHERE restaurant_id=$1 AND kind='webhook.stripe' AND payload->>'eventId'=$2", [RID, evt])).toEqual({ status: 'quarantined', last_error: 'senal-reserva-cancelada' })
      expect((await one('SELECT status,data FROM llenamos.reservations WHERE id=$1', [r.id]))).toMatchObject({ status: 'cancelled', data: { deposit: { status: 'paid' } } })
    })

    it('el receptor guarda solo lo necesario del evento: nada del pagador', async () => {
      const r = await stripeReservation()
      const evt = `evt_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      const full = event(evt, r)
      Object.assign(full.data.object, { customer_details: { email: 'pagador@example.test', name: 'Pagador Real', address: { line1: 'Calle 9' } }, customer_email: 'pagador@example.test', metadata: { ...(full.data.object as any).metadata, nota: 'dato libre del pagador' } })
      expect((await stripePost(RID, full)).status).toBe(200)
      const stored = JSON.stringify((await one("SELECT payload FROM llenamos.outbox WHERE restaurant_id=$1 AND kind='webhook.stripe' AND payload->>'eventId'=$2", [RID, evt])).payload)
      expect(stored).not.toMatch(/pagador|Pagador|Calle 9|customer_details|dato libre/)
      expect(JSON.parse(stored).object).toEqual({ id: r.session, payment_status: 'paid', amount_total: r.amount, currency: 'eur', metadata: { kind: 'reservation_deposit', reservationId: r.id, locationId: LID } })
      await drain()
      expect((await one('SELECT data FROM llenamos.reservations WHERE id=$1', [r.id])).data.deposit.status).toBe('paid')
    })

    it('un cobro móvil de caja que no corresponde a ningún cobro del servidor no se ignora: queda como incidencia y no registra nada', async () => {
      const evt = `evt_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      expect((await stripePost(RID, { id: evt, type: 'checkout.session.completed', created: 1, livemode: false, data: { object: { id: 'cs_caja1', payment_status: 'paid', amount_total: 2600, currency: 'eur', metadata: { restaurantId: RID, locationId: LID, checkoutId: 'chk1' } } } })).status).toBe(200)
      await drain()
      expect(await one("SELECT status,last_error FROM llenamos.outbox WHERE restaurant_id=$1 AND kind='webhook.stripe' AND payload->>'eventId'=$2", [RID, evt])).toEqual({ status: 'done', last_error: null })
      expect(await one("SELECT code,status FROM llenamos.pos_mobile_incidents WHERE restaurant_id=$1 AND checkout_id='chk1'", [RID])).toEqual({ code: 'unknown_checkout', status: 'open' })
      expect(await count('SELECT count(*) FROM llenamos.pos_payments WHERE restaurant_id=$1', [RID])).toBe(0)
    })

    it('un evento de un restaurante no toca reservas de otro con el mismo id', async () => {
      const r = await stripeReservation()
      await setSecrets(OTHER, { stripe: { secretKey: 'sk', webhookSecret: 'whsec_b' } })
      const evt = `evt_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      expect((await stripePost(OTHER, event(evt, r), 'whsec_b')).status).toBe(200)
      await drain()
      expect((await one('SELECT data FROM llenamos.reservations WHERE id=$1', [r.id])).data.deposit.status).toBe('required')
      expect(await one("SELECT status,last_error FROM llenamos.outbox WHERE restaurant_id=$1 AND kind='webhook.stripe' AND payload->>'eventId'=$2", [OTHER, evt])).toEqual({ status: 'quarantined', last_error: 'senal-sin-reserva' })
    })
  })

  describe('mensaje.respuesta: confirmar o cancelar desde el mismo teléfono', () => {
    async function sentReservation(phoneNumber: string, status: 'pending' | 'confirmed' = 'pending') {
      await configure({ autoConfirm: status === 'confirmed' })
      const out = await call('crearReservaPublica', pub({ date: dayAfter(13), time: '21:00', phone: phoneNumber, guestName: `Resp ${randomUUID().slice(0, 4)}` }))
      expect(out.status, JSON.stringify(out.body)).toBe(200)
      await drain() // sale el aviso por WhatsApp (y queda registrado en message_deliveries)
      const row = await one('SELECT id FROM llenamos.reservations WHERE restaurant_id=$1 AND reference=$2', [RID, out.result.reference])
      const delivery = await one("SELECT id,provider_message_id FROM llenamos.message_deliveries WHERE restaurant_id=$1 AND channel='whatsapp' AND context->>'reservationId'=$2 AND status='sent' LIMIT 1", [RID, row.id])
      expect(delivery).toBeTruthy()
      return { id: row.id as string, delivery }
    }
    const reply = (from: string, message: object) => whatsappPost(RID, { id: `wamid.in${randomUUID().replaceAll('-', '')}`, from, ...message })

    it('«confirmo» desde el mismo teléfono confirma la reserva pendiente', async () => {
      const r = await sentReservation(phone(700))
      expect((await one('SELECT status FROM llenamos.reservations WHERE id=$1', [r.id])).status).toBe('pending')
      expect((await reply('346000' + '00700', { text: { body: 'Confirmo' }, context: { id: r.delivery.provider_message_id } })).status).toBe(200)
      await drain()
      expect((await one('SELECT status FROM llenamos.reservations WHERE id=$1', [r.id])).status).toBe('confirmed')
    })

    it('el botón de cancelar cancela la reserva y avisa; repetir la respuesta no hace nada más', async () => {
      const r = await sentReservation(phone(701), 'confirmed')
      const message = { id: 'wamid.in-fijo-1', from: '34600000701', interactive: { button_reply: { id: `${r.delivery.id}:cancel` } } }
      expect((await whatsappPost(RID, message)).status).toBe(200)
      expect((await whatsappPost(RID, message)).status).toBe(200) // Meta reintenta: mismo ID, un solo efecto
      await drain()
      expect((await one('SELECT status FROM llenamos.reservations WHERE id=$1', [r.id])).status).toBe('cancelled')
      const notices = await count("SELECT count(*) FROM llenamos.outbox WHERE restaurant_id=$1 AND payload->>'reservationId'=$2 AND payload->>'template'='cancellation'", [RID, r.id])
      expect(notices).toBeGreaterThan(0)
      await drain()
      expect(await count("SELECT count(*) FROM llenamos.outbox WHERE restaurant_id=$1 AND payload->>'reservationId'=$2 AND payload->>'template'='cancellation'", [RID, r.id])).toBe(notices)
    })

    it('otro teléfono, el aviso de otra reserva, otro restaurante o una reserva ya terminada no generan ni cambian nada', async () => {
      const r = await sentReservation(phone(702))
      const other = await sentReservation(phone(704))
      const replies = () => count("SELECT count(*) FROM llenamos.outbox WHERE kind='mensaje.respuesta'")
      const before = await replies()
      // Un teléfono distinto que cita el aviso: no genera el hecho (el aviso se busca por teléfono).
      await reply('34699999999', { text: { body: 'Cancelar' }, context: { id: r.delivery.provider_message_id } })
      // Otra persona cita el aviso de OTRA reserva con su propio teléfono: tampoco.
      await reply('34600000702', { text: { body: 'Cancelar' }, context: { id: other.delivery.provider_message_id } })
      // Sin referencia al aviso.
      await reply('34600000702', { text: { body: 'Cancelar' } })
      // Otro restaurante, con su propia firma, citando el aviso de este.
      await setSecrets(OTHER, { whatsapp: { token: 'wa', phoneNumberId: '111', appSecret: 'wa-secret', verifyToken: 'v' } })
      expect((await whatsappPost(OTHER, { id: 'wamid.in-otro', from: '34600000702', text: { body: 'Cancelar' }, context: { id: r.delivery.provider_message_id } })).status).toBe(200)
      await drain()
      expect(await replies()).toBe(before)
      expect((await one('SELECT status FROM llenamos.reservations WHERE id=$1', [r.id])).status).toBe('pending')
      expect((await one('SELECT status FROM llenamos.reservations WHERE id=$1', [other.id])).status).toBe('pending')
      // Reserva ya cancelada: confirmar no la resucita (sí genera el hecho: el teléfono y el aviso son suyos).
      await db.admin.query("UPDATE llenamos.reservations SET status='cancelled',data=jsonb_set(data,'{status}','\"cancelled\"') WHERE id=$1", [r.id])
      await reply('34600000702', { text: { body: 'Confirmo' }, context: { id: r.delivery.provider_message_id } })
      await drain()
      expect(await replies()).toBe(before + 1)
      expect((await one('SELECT status FROM llenamos.reservations WHERE id=$1', [r.id])).status).toBe('cancelled')
      expect(await count("SELECT count(*) FROM llenamos.outbox WHERE kind='mensaje.respuesta' AND status='done'")).toBe(before + 1)
    })

    it('la baja (STOP) sigue funcionando junto al manejador de reservas', async () => {
      const r = await sentReservation(phone(703))
      await reply('34600000703', { text: { body: 'STOP' }, context: { id: r.delivery.provider_message_id } })
      await drain()
      expect(await count("SELECT count(*) FROM llenamos.message_optouts WHERE restaurant_id=$1 AND recipient=$2", [RID, phone(703)])).toBe(1)
      expect((await one('SELECT status FROM llenamos.reservations WHERE id=$1', [r.id])).status).toBe('pending')
    })
  })

  describe('privacidad de extremo a extremo (reservas, sala y caja)', () => {
    const subject = core.customerIdFor(RID, phone(900))
    // Además de nombre, correo y teléfono: el id de la persona (sale de su teléfono sin sal) y el UUID del mensaje de campaña que deriva de él, que no pueden
    // quedar como llave en ninguna tabla, tampoco en las de fidelización, campañas y análisis (V7).
    const MESSAGE_ID = campaignOutboxId('camp900', subject)
    const PERSONAL = ['%Persona Prueba%', '%persona@example%', '%frutos secos%', '%Sin gluten%', '%600000900%', `%${subject}%`, `%${MESSAGE_ID}%`]
    const V7 = ['customer_marketing', 'marketing_consents', 'marketing_campaign_recipients', 'marketing_send_log', 'marketing_unsubscribe_tokens', 'loyalty_accounts', 'loyalty_movements', 'loyalty_lots', 'loyalty_redemptions', 'promotion_customer_uses', 'bill_promotions', 'repite_cards', 'repite_queue', 'automation_events', 'recommendations']
    const TABLES = [...V7, 'reservations', 'customers', 'waitlist', 'consents', 'reservation_origins', 'sala_takeaways', 'sala_table_sessions', 'sala_orders', 'sala_order_lines', 'sala_floor_tasks', 'sala_private', 'sala_spend', 'outbox', 'message_deliveries', 'jobs', 'events']
    let seq = 0
    const known: { reservationId: string; reference: string; takeawayId: string; takeawayReference: string; waitlistId: string } = {} as never
    const command = () => `privacy_${(++seq).toString().padStart(2, '0')}_${'0'.repeat(16)}`
    async function request(kind: 'export' | 'erase', customerId = subject) {
      const asked = await call('solicitarPrivacidad', { restaurantId: RID, requestId: command(), customerId, kind, reason: 'Petición de la persona' }, 'owner-a')
      expect(asked.status, JSON.stringify(asked.body)).toBe(200)
      const evidence = `ev-${seq}`
      await db.admin.query("INSERT INTO llenamos.privacy_evidence(id,restaurant_id,subject_id,method,expires_at,recorded_by) VALUES($1,$2,$3,'in_person',now()+interval '1 day','owner-a')", [evidence, RID, customerId])
      expect((await call('verificarSolicitudPrivacidad', { restaurantId: RID, requestId: command(), jobId: asked.result.jobId, evidenceId: evidence }, 'owner-a')).status).toBe(200)
      await drain()
      return asked.result.jobId as string
    }
    const status = async (jobId: string) => one('SELECT status,error,processed,artifact_file_id FROM llenamos.privacy_requests WHERE id::text=$1', [jobId])
    const leaks = async (patterns = PERSONAL) => {
      const found: Record<string, number> = {}
      for (const table of TABLES) {
        const n = await count(`SELECT count(*) FROM llenamos.${table} t WHERE t.restaurant_id=$1 AND t::text LIKE ANY($2)`, [RID, patterns])
        if (n) found[table] = n
      }
      return found
    }

    beforeAll(async () => {
      await configure({ week: ALL_DAY_WEEK })
      expect((await call('crearReservaPublica', pub({ date: dayAfter(14), time: '13:00', phone: phone(900), email: 'persona@example.test', guestName: 'Persona Prueba', guestNotes: 'Alergia a los frutos secos' }))).status).toBe(200)
      expect((await call('crearReservaPublica', pub({ date: dayAfter(16), time: '13:00' }))).status).toBe(200) // otra persona del mismo restaurante
      const reservation = await one('SELECT id,reference FROM llenamos.reservations WHERE restaurant_id=$1 AND customer_id=$2', [RID, subject])
      Object.assign(known, { reservationId: reservation.id, reference: reservation.reference })
      await drain() // salen los avisos por correo y WhatsApp a la persona
      await call('cambiarEstadoReserva', { restaurantId: RID, locationId: LID, reservationId: reservation.id, status: 'cancelled' }, 'owner-a')
      await drain()
      // Origen de marketing con campaña y clics, permiso de marketing y una entrada de espera ya cerrada.
      await db.admin.query("UPDATE llenamos.reservation_origins SET campaign='camp-x',campaign_id='c1',content='ct',term='tm',click_ids='{gclid-1}',ad_id='ad-1',referrer_host='ref.example' WHERE restaurant_id=$1 AND reservation_id=$2", [RID, reservation.id])
      await db.admin.query("INSERT INTO llenamos.consents(restaurant_id,id,data) VALUES($1,'consent-900',$2)", [RID, JSON.stringify({ customerId: subject, purpose: 'marketing_whatsapp', status: 'granted', policyVersion: 'v1', at: Date.now(), source: 'public', evidenceId: 'ev-900' })])
      const waitlist: core.WaitlistEntry = { guestName: 'Persona Prueba', phone: phone(900), email: 'persona@example.test', language: 'es', partySize: 2, date: dayAfter(14), from: '13:00', to: '13:30', status: 'expired', offer: null, customerId: subject, source: 'web' }
      known.waitlistId = 'wl900'
      await db.admin.query("INSERT INTO llenamos.waitlist(restaurant_id,location_id,id,customer_id,service_date,status,data) VALUES($1,$2,'wl900',$3,$4,'expired',$5)", [RID, LID, subject, waitlist.date, JSON.stringify(waitlist)])
      // La persona responde a su aviso de WhatsApp: quedan el hecho entrante y el derivado con su teléfono y su texto.
      const delivery = await one("SELECT provider_message_id FROM llenamos.message_deliveries WHERE restaurant_id=$1 AND channel='whatsapp' AND context->>'reservationId'=$2 AND status='sent' LIMIT 1", [RID, reservation.id])
      expect((await whatsappPost(RID, { id: 'wamid.in-900', from: '34600000900', text: { body: 'Confirmo, soy Persona Prueba' }, context: { id: delivery.provider_message_id } })).status).toBe(200)
      await drain()
      expect(await count("SELECT count(*) FROM llenamos.outbox WHERE restaurant_id=$1 AND kind IN ('mensaje.respuesta','webhook.whatsapp')", [RID])).toBeGreaterThanOrEqual(2)
      await db.admin.query("INSERT INTO llenamos.sala_spend(restaurant_id,target_kind,target_id,location_id,customer_id,amount_cents) VALUES($1,'takeaway','spend-t900',$2,$3,650)", [RID, LID, subject])
      // Recogida entregada, con su etiqueta de cocina y su cuenta.
      const dateSala = core.sumarDias(core.horaLocal(Date.now(), 'Europe/Madrid').fecha, 1) // mañana: a última hora de hoy ya no quedan franjas
      const slot = (await call('consultarRecogida', { slug: RID, locationId: LID, date: dateSala })).result.slots.find((s: { available: boolean }) => s.available)
      const placed = await call('pedirParaLlevar', { slug: RID, locationId: LID, date: dateSala, time: slot.time, guestName: 'Persona Prueba', phone: phone(900), email: 'persona@example.test', language: 'es', lines: [{ kind: 'item', itemId: 'bravas', quantity: 1 }], expectedTotalCents: 650, notes: 'Sin gluten, por favor', acceptPolicy: true, website: '' })
      expect(placed.status, JSON.stringify(placed.body)).toBe(200)
      const take = await one('SELECT id FROM llenamos.sala_takeaways WHERE restaurant_id=$1 AND reference=$2', [RID, placed.result.reference])
      Object.assign(known, { takeawayId: take.id, takeawayReference: placed.result.reference })
      await drain()
      // Etiqueta de cocina con el nombre, como la que genera la pantalla de recogidas.
      await db.admin.query("UPDATE llenamos.sala_order_lines SET doc=jsonb_set(doc,'{label}','\"Para llevar · Persona Prueba · 21:30\"') WHERE restaurant_id=$1 AND takeaway_id=$2", [RID, take.id])
      await db.admin.query("UPDATE llenamos.sala_takeaways SET doc=jsonb_set(jsonb_set(doc,'{status}','\"picked_up\"'),'{pickedUpAt}',to_jsonb((extract(epoch from now())*1000)::bigint)) WHERE id=$1", [take.id])
      const bill: core.Bill = { target: { kind: 'takeaway', id: take.id } as any, customerId: subject, status: 'settled', revision: 1, lines: [], adjustments: [], totalCents: 650, paidCents: 650, refundedCents: 0, openedAt: Date.now(), lockedAt: null, settledAt: Date.now() }
      await db.admin.query("INSERT INTO llenamos.pos_bills(restaurant_id,location_id,id,target_kind,target_id,status,revision,opened_at,data) VALUES($1,$2,'bill900','takeaway',$3,'settled',1,now(),$4)", [RID, LID, take.id, JSON.stringify(bill)])
      // Factura a nombre de la persona en una cuenta SIN vínculo de cliente: solo se localiza por el nombre del destinatario.
      await db.admin.query("INSERT INTO llenamos.pos_bills(restaurant_id,location_id,id,target_kind,target_id,status,revision,opened_at,data) VALUES($1,$2,'bill-otra','takeaway','t-otra','settled',1,now(),$3)", [RID, LID, JSON.stringify({ ...bill, customerId: null })])
      await db.admin.query("INSERT INTO llenamos.pos_invoices(restaurant_id,location_id,id,bill_id,part_id,series_id,sequence,issuer_nif,number,record_id,data) VALUES($1,$2,'inv900','bill-otra','p1','s1',1,'12345678Z','F-900','rec900',$3)", [RID, LID, JSON.stringify({ type: 'F1', recipient: { name: 'Persona Prueba', address: 'Calle 1', identity: { kind: 'nif', nif: '12345678Z' } } })])
      // Lo que V7 guarda de la persona: puntos con un motivo con su nombre, tarjeta de Repite ya retirada con sus operaciones, un mensaje de campaña y sus avisos en vivo.
      await db.admin.query("INSERT INTO llenamos.loyalty_accounts(restaurant_id,customer_id,status,balance,earned,terms_version,enrolled_at,enrolled_by) VALUES($1,$2,'active',5,5,'1',1,'owner-a')", [RID, subject])
      await db.admin.query("INSERT INTO llenamos.loyalty_movements(restaurant_id,id,customer_id,kind,points,balance_after,at_ms,reason) VALUES($1,'mv900',$2,'adjust',5,5,1,'Regalo para Persona Prueba')", [RID, subject])
      await db.admin.query("INSERT INTO llenamos.repite_cards(restaurant_id,customer_id,merchant_id,card_id,external_ref,status,created_at_ms) VALUES($1,$2,'demo','c900','r900','removed',1)", [RID, subject])
      for (const [id, kind] of [[`card.${subject}`, 'create_card'], [`remove.${subject}`, 'remove_card'], [`missyou.${subject}.2026-01-01`, 'we_miss_you']])
        await db.admin.query("INSERT INTO llenamos.repite_queue(restaurant_id,id,kind,customer_id,merchant_id,occurred_at_ms,next_attempt_at_ms,status) VALUES($1,$2,$3,$4,'demo',1,1,'done')", [RID, id, kind, subject])
      await db.admin.query("INSERT INTO llenamos.jobs(id,restaurant_id,kind,deduplication_key,payload,scheduled_at,status) VALUES($1,$2,'fidelizacion.procesar_repite',$3,$4,now(),'done')", [randomUUID(), RID, `card.${subject}:0`, JSON.stringify({ restaurantId: RID, operationId: `card.${subject}` })])
      await db.admin.query("INSERT INTO llenamos.events(restaurant_id,topic,entity_id) VALUES($1,'fidelizacion.cuenta',$2)", [RID, subject])
      await db.admin.query("INSERT INTO llenamos.marketing_campaigns(restaurant_id,id,name,segment_id,channel,content,status,updated_by) VALUES($1,'camp900','x','s','email','{\"title\":\"x\",\"body\":\"y\",\"includeBookingLink\":false}','sent','x')", [RID])
      // Baja por enlace anterior: su prueba guarda el UUID del mensaje (derivado del id de la persona); `leaks()` lo busca.
      await db.admin.query("INSERT INTO llenamos.marketing_consents(restaurant_id,id,customer_id,purpose,status,policy_version,at,source,evidence_id) VALUES($1,'unsubscribe.'||repeat('d',64),$2,'marketing_email','withdrawn','unsubscribe',now(),'public',$3)", [RID, subject, MESSAGE_ID])
      await db.admin.query("INSERT INTO llenamos.marketing_campaign_recipients(restaurant_id,campaign_id,customer_id,status,message_id,at) VALUES($1,'camp900',$2,'sent',$3,now())", [RID, subject, MESSAGE_ID])
      await db.admin.query("INSERT INTO llenamos.outbox(id,restaurant_id,kind,payload,status) VALUES($1,$2,'marketing.campaign_message',$3,'done')", [MESSAGE_ID, RID, JSON.stringify({ campaignId: 'camp900', customerId: subject, purpose: 'marketing_email', data: { guestName: 'Persona Prueba' } })])
      await db.admin.query("INSERT INTO llenamos.automation_events(restaurant_id,id,type,subject,at,data) VALUES($1,$2,'customer.lapsed',$3,now(),'{\"daysSinceVisit\":90,\"visits\":2,\"spentCents\":1000}')", [RID, `customer.lapsed.${subject}.d`, subject])
      await db.admin.query("INSERT INTO llenamos.recommendations(restaurant_id,id,rule_id,event_id,event_type,subject,kind,text,evidence,created_at,expires_at) VALUES($1,$2,'r',$3,'customer.lapsed',$4,'contact_customer','Llamar','{}',now(),now()+interval '7 days')", [RID, `r1.customer.lapsed.${subject}.d`, `customer.lapsed.${subject}.d`, subject])
    })

    it('antes de borrar, los datos de la persona están donde se espera (la prueba de borrado no es vacía)', async () => {
      const present = await leaks()
      for (const table of ['reservations', 'customers', 'waitlist', 'sala_takeaways', 'outbox', 'message_deliveries']) expect(present[table], table).toBeGreaterThan(0)
      expect((await one("SELECT count(*) FROM llenamos.sala_order_lines WHERE restaurant_id=$1 AND takeaway_id=$2 AND doc->>'label' LIKE '%Persona Prueba%'", [RID, known.takeawayId])).count, 'etiqueta de línea con el nombre').not.toBe('0')
    })

    it('el gasto por cliente existe antes del borrado', async () => {
      expect(await count('SELECT count(*) FROM llenamos.sala_spend WHERE restaurant_id=$1 AND customer_id=$2', [RID, subject])).toBe(1)
    })

    it('exportar entrega clientes, reservas, recogidas y cuentas de la persona, cifrado y sin datos ajenos', async () => {
      const jobId = await request('export')
      const done = await status(jobId)
      expect(done).toMatchObject({ status: 'completed' })
      const sealed = await (await import('node:fs/promises')).readFile(store.locate(RID, done.artifact_file_id))
      expect(sealed.toString()).not.toContain('Persona Prueba')
      const exported = JSON.parse(openExport(key, RID, jobId, sealed).toString()).data as Record<string, any[]>
      expect(exported.clientes?.[0]).toMatchObject({ nombre: 'Persona Prueba', telefono: phone(900), correo: 'persona@example.test' })
      expect(exported.reservas?.[0]).toMatchObject({ nombre: 'Persona Prueba', notasCliente: 'Alergia a los frutos secos' })
      expect(exported.recogidas?.[0]).toMatchObject({ nombre: 'Persona Prueba', correo: 'persona@example.test', notas: 'Sin gluten, por favor' })
      expect(exported.cuentas?.[0]).toMatchObject({ id: 'bill900', totalCentimos: 650 })
      expect(exported.gasto_sala).toEqual([{ destino: 'takeaway', id: 'spend-t900', local: LID, importeCentimos: 650 }])
      expect(exported.espera?.[0]).toMatchObject({ nombre: 'Persona Prueba' })
      expect(exported.facturas).toEqual([expect.objectContaining({ numero: 'F-900', destinatario: expect.objectContaining({ nombre: 'Persona Prueba' }) })])
      expect(exported.consentimientos?.[0]).toMatchObject({ finalidad: 'marketing_whatsapp' })
      expect(JSON.stringify(exported)).not.toContain(phone(1))
    })

    it('un módulo que declara datos personales sin contribuyente bloquea exportar y borrar, y no se toca nada', async () => {
      // V7 ya tiene contribuyentes: se prueba el mecanismo con un módulo falso que declara una tabla de datos personales y no aporta `privacy`.
      const fake: ModuleDefinition = { name: 'falso', operations: [], personalData: ['tabla_falsa'] }
      ;(MODULES as ModuleDefinition[]).push(fake)
      try {
        const before = await leaks()
        for (const kind of ['erase', 'export'] as const) {
          const jobId = await request(kind)
          expect(await status(jobId), kind).toMatchObject({ status: 'blocked', error: expect.stringMatching(/Faltan adaptadores de privacidad en: falso/) })
        }
        expect(await leaks()).toEqual(before) // el bloqueo ocurre antes de anonimizar nada
      } finally { ;(MODULES as ModuleDefinition[]).splice((MODULES as ModuleDefinition[]).indexOf(fake), 1) }
    })

    it('antes de borrar, la persona tiene datos en las tablas de V7 y en los ids derivados', async () => {
      const present = await leaks()
      for (const table of ['customer_marketing', 'marketing_consents', 'loyalty_accounts', 'loyalty_movements', 'repite_cards', 'repite_queue', 'marketing_campaign_recipients', 'automation_events', 'recommendations', 'jobs', 'events', 'outbox']) expect(present[table], table).toBeGreaterThan(0)
    })

    it('borrar anonimiza todo rastro de la persona, sin poder volver a ligarlo con su teléfono, y respeta a las demás', async () => {
      const other = core.customerIdFor(RID, phone(1))
      expect(await count('SELECT count(*) FROM llenamos.customers WHERE restaurant_id=$1 AND id=$2', [RID, other])).toBe(1)
      const jobId = await request('erase')
      expect(await status(jobId)).toMatchObject({ status: 'completed', error: null })
      expect((await status(jobId)).processed).toBeGreaterThan(5)
      // Ni nombre, correo, notas ni teléfono en ninguna tabla (incluidas espera, permisos, orígenes y colas).
      expect(await leaks()).toEqual({})
      // Lo guardado antes del borrado, ahora anonimizado y localizado por su id.
      expect(await one('SELECT data->>\'guestName\' AS name,data->>\'guestNotes\' AS notes,data->>\'email\' AS email,privacy_redacted FROM llenamos.reservations WHERE id=$1', [known.reservationId]))
        .toEqual({ name: 'Persona suprimida', notes: '', email: null, privacy_redacted: true })
      expect((await one('SELECT doc FROM llenamos.sala_takeaways WHERE id=$1', [known.takeawayId])).doc).toMatchObject({ guestName: 'Persona suprimida', email: null, notes: '' })
      expect((await one('SELECT doc FROM llenamos.sala_private WHERE id=$1 AND kind=\'takeawaySecrets\'', [known.takeawayId])).doc).toEqual({})
      expect(await count("SELECT count(*) FROM llenamos.sala_order_lines WHERE restaurant_id=$1 AND takeaway_id=$2 AND doc->>'label' LIKE '%Persona suprimida%'", [RID, known.takeawayId])).toBeGreaterThan(0)
      expect((await one('SELECT data FROM llenamos.waitlist WHERE id=$1', [known.waitlistId])).data).toMatchObject({ guestName: 'Persona suprimida', email: null })
      expect((await one("SELECT campaign,campaign_id,content,term,click_ids,ad_id,referrer_host FROM llenamos.reservation_origins WHERE reservation_id=$1", [known.reservationId])))
        .toEqual({ campaign: null, campaign_id: null, content: null, term: null, click_ids: [], ad_id: null, referrer_host: null })
      // El permiso conserva su historia (sigue siendo prueba), pero ya no apunta a la persona.
      expect((await one("SELECT data FROM llenamos.consents WHERE id='consent-900'")).data).toMatchObject({ status: 'granted', purpose: 'marketing_whatsapp' })
      expect((await one("SELECT data->>'customerId' AS c FROM llenamos.consents WHERE id='consent-900'")).c).not.toBe(subject)
      // Con el teléfono de la persona no se recupera nada: ni ficha, ni reservas, ni consentimientos, ni cuentas.
      expect(await count('SELECT count(*) FROM llenamos.sala_spend WHERE restaurant_id=$1 AND customer_id=$2', [RID, subject])).toBe(0) // el gasto por cliente también se borra
      expect(await count('SELECT count(*) FROM llenamos.customers WHERE restaurant_id=$1 AND id=$2', [RID, subject])).toBe(0)
      for (const [table, column] of [['reservations', 'customer_id'], ['waitlist', 'customer_id']] as const) expect(await count(`SELECT count(*) FROM llenamos.${table} WHERE restaurant_id=$1 AND ${column}=$2`, [RID, subject]), table).toBe(0)
      for (const [table, column] of [['consents', 'data->>\'customerId\''], ['sala_takeaways', 'doc->>\'customerId\''], ['sala_table_sessions', 'doc->>\'customerId\''], ['pos_bills', 'data->>\'customerId\'']] as const)
        expect(await count(`SELECT count(*) FROM llenamos.${table} WHERE restaurant_id=$1 AND ${column}=$2`, [RID, subject]), table).toBe(0)
      // El sustituto es aleatorio: no es el hash de la huella de borrado ni se repite entre borrados.
      const tomb = (await one('SELECT customer_id FROM llenamos.reservations WHERE id=$1', [known.reservationId])).customer_id as string
      expect(await count("SELECT count(*) FROM llenamos.privacy_tombstones WHERE restaurant_id=$1 AND left(subject_hash,20)=$2", [RID, tomb])).toBe(0)
      expect(tomb).not.toBe(core.customerIdFor(RID, phone(900)))
      expect((await one("SELECT data->>'customerId' AS c FROM llenamos.pos_bills WHERE id='bill900'")).c).toBeNull()
      expect((await one("SELECT data->>'totalCents' AS total FROM llenamos.pos_bills WHERE id='bill900'")).total).toBe('650')
      // Otra persona del mismo restaurante queda intacta.
      expect((await one('SELECT data->>\'name\' AS name FROM llenamos.customers WHERE restaurant_id=$1 AND id=$2', [RID, other])).name).toBe('Ana Pruebas')
      expect(await count('SELECT count(*) FROM llenamos.privacy_tombstones WHERE restaurant_id=$1', [RID])).toBe(1)
      // Tras borrar, la persona ya no existe como ficha para otra solicitud.
      expect((await call('solicitarPrivacidad', { restaurantId: RID, requestId: command(), customerId: subject, kind: 'export', reason: 'Otra vez' }, 'owner-a')).status).toBe(412)
    })

    it('dos borrados distintos no comparten teléfono ni identificador sustituto', async () => {
      const made: string[] = []
      for (const n of [910, 911]) {
        const who = core.customerIdFor(RID, phone(n))
        expect((await call('crearReservaPublica', pub({ date: dayAfter(17), time: n === 910 ? '13:00' : '13:30', phone: phone(n), guestName: `Borrar ${n}` }))).status).toBe(200)
        const row = await one('SELECT id FROM llenamos.reservations WHERE restaurant_id=$1 AND customer_id=$2', [RID, who])
        await call('cambiarEstadoReserva', { restaurantId: RID, locationId: LID, reservationId: row.id, status: 'cancelled' }, 'owner-a')
        await drain()
        expect(await status(await request('erase', who))).toMatchObject({ status: 'completed' })
        made.push(row.id)
      }
      const rows = (await db.admin.query('SELECT customer_id,data->>\'phone\' AS phone FROM llenamos.reservations WHERE id=ANY($1)', [made])).rows
      expect(new Set(rows.map(r => r.customer_id)).size).toBe(2)
      expect(new Set(rows.map(r => r.phone)).size).toBe(2)
      for (const row of rows) { expect(row.phone).toMatch(/^\+34000\d{6}$/); expect(row.phone).not.toBe('+34000000000') }
    })

    it('con una reserva abierta, el borrado se bloquea con su motivo y no toca nada', async () => {
      const blocked = core.customerIdFor(RID, phone(901))
      expect((await call('crearReservaPublica', pub({ date: dayAfter(15), time: '13:00', phone: phone(901), guestName: 'Abierta Prueba' }))).status).toBe(200)
      const jobId = await request('erase', blocked)
      expect(await status(jobId)).toMatchObject({ status: 'blocked', error: expect.stringContaining('reserva abierta') })
      expect((await one('SELECT data->>\'guestName\' AS name FROM llenamos.reservations WHERE restaurant_id=$1 AND customer_id=$2', [RID, blocked])).name).toBe('Abierta Prueba')
    })

    it('otro restaurante no puede pedir ni borrar a esta persona', async () => {
      const foreign = await call('solicitarPrivacidad', { restaurantId: RID, requestId: command(), customerId: core.customerIdFor(RID, phone(901)), kind: 'export', reason: 'x' }, 'owner-b')
      expect(foreign.status).toBe(403)
      const empty = await call('solicitarPrivacidad', { restaurantId: OTHER, requestId: command(), customerId: core.customerIdFor(RID, phone(901)), kind: 'export', reason: 'x' }, 'owner-b')
      expect(empty.status).toBe(412) // allí esa persona no existe
    })
  })
})
