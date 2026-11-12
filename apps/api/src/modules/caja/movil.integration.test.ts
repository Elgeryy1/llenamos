import { createHmac, randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as core from '@llenamos/core'
import { configureStripeVault } from '../../payments/credentials.js'
import { setStripeTransport } from '../../payments/stripe.js'
import { integrationVault, webhookSubset, WEBHOOK_PROVIDERS } from '../../platform/integrations.js'
import { apiServer } from '../../server.js'
import { webhookReceiver } from '../../webhooks/receiver.js'
import { MODULES } from '../index.js'
import { resetMemoryLimits } from '../reservas/abuse.js'
import { limits } from './enlace.js'
import { buildHandlers, createWorker } from '../../worker/index.js'
import { testDatabase } from '../../worker/harness.js'
import { registerBillSource, type BillSource } from './source.js'
import { cajaMaintenance } from './worker.js'
import { open as openSecret } from '../sala/secrets.js'

const enabled = process.env.TEST_POSTGRES_API === '1' && !!process.env.TEST_POSTGRES_URL
const key = Buffer.alloc(32, 21), vault = integrationVault(key)
const A = { restaurantId: 'ra', locationId: 'la' }, B = { restaurantId: 'rb', locationId: 'lb' }
const LINES: core.BillLine[] = [
  { lineId: 'menu', parentLineId: null, name: 'Menú', quantity: 1, grossCents: 1550, taxRate: 10, guest: 1 },
  { lineId: 'extra', parentLineId: 'menu', name: 'Suplemento', quantity: 1, grossCents: 400, taxRate: 10, guest: 1 },
  { lineId: 'vino', parentLineId: null, name: 'Vino', quantity: 1, grossCents: 501, taxRate: 21, guest: 2 },
]
const TOTAL = 2451
const fiscal = (year = new Date().getFullYear()) => ({
  issuer: { name: 'Bar Prueba', nif: '12345678Z', address: 'Calle de prueba 1' },
  system: { producerName: 'Desarrollo de prueba', producerNif: '89890001K', name: 'Llenamos local', id: 'LL', version: 'test', installation: 'inst-movil', onlyVerifactu: true, multiTaxpayer: true, multipleTaxpayers: false },
  fiscalRegime: 'verifactu', providerId: 'local_test', environment: 'test', ordinarySeriesId: `ordinary_${year}`, rectifyingSeriesId: `rectifying_${year}`, mobilePayments: true,
})
const rid = () => randomUUID().replaceAll('-', '')
const SECRETS_A = { stripe: { secretKey: 'sk_test_restaurante_a', webhookSecret: 'whsec_a', mobileWebhookSecret: 'whsec_mobile_a' }, email: { apiKey: 'k', from: 'a@example.test' } }
const SECRETS_B = { stripe: { secretKey: 'sk_test_restaurante_b', webhookSecret: 'whsec_b' } }

describe.skipIf(!enabled)('Cobros con la Stripe del restaurante: señal, cobro móvil de caja y recibo digital', { timeout: 40_000 }, () => {
  process.env.PUBLIC_APP_URL = 'https://app.example.test'
  process.env.SALA_SECRET_KEY = 'ef'.repeat(32)
  process.env.TRUSTED_IP_HEADER = 'x-test-ip'; process.env.TRUSTED_PROXY_ADDRESSES = '127.0.0.1,::1'
  let db: Awaited<ReturnType<typeof testDatabase>>, token: (uid: string) => import('../../auth.js').IdentityToken, server: ReturnType<typeof apiServer>, base: string
  let ip = 0, cashA = '', cashB = ''
  const consumption = new Map<string, core.BillLine[]>()
  const fakeSource: BillSource = { load: async (_c, scope, target) => {
    const lines = consumption.get(`${scope.restaurantId}:${scope.locationId}:${target.kind}:${target.id}`)
    return lines ? { customerId: null, lines, cancelled: false } : null
  } }

  // ---- Stripe simulado: sesiones por clave de idempotencia; guarda lo recibido ----
  interface Sent { method: string; url: string; auth: string; account: string | null; key: string | null; form: URLSearchParams }
  const sent: Sent[] = []
  const sessions = new Map<string, any>(), byKey = new Map<string, string>()
  let stripeDown = false, sessionCount = 0, lostResponses = 0, rejectStatus: number | null = null, failGets = false
  const bodyByKey = new Map<string, string>()
  const stripe = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers = init!.headers as Record<string, string>, u = String(url), method = init!.method ?? 'GET'
    const form = new URLSearchParams(init!.body ? String(init!.body) : '')
    sent.push({ method, url: u, auth: headers.Authorization!, account: headers['Stripe-Account'] ?? null, key: headers['Idempotency-Key'] ?? null, form })
    if (stripeDown) return new Response('{}', { status: 503 })
    if (rejectStatus && method === 'POST') return new Response('{}', { status: rejectStatus })
    if (failGets && method === 'GET') return new Response('{}', { status: 503 })
    if (method === 'POST' && u.endsWith('/v1/checkout/sessions')) {
      const idem = headers['Idempotency-Key']!
      // Como Stripe real: la misma clave con parámetros distintos es un error (idempotency_error), no la sesión anterior.
      if (bodyByKey.has(idem) && bodyByKey.get(idem) !== String(init!.body)) return new Response('{"error":{"type":"idempotency_error"}}', { status: 400 })
      bodyByKey.set(idem, String(init!.body))
      if (byKey.has(idem)) return Response.json(sessions.get(byKey.get(idem)!))
      const id = `cs_test_${++sessionCount}_${rid().slice(0, 6)}`
      let total = 0
      for (let i = 0; form.has(`line_items[${i}][price_data][unit_amount]`); i++) total += Number(form.get(`line_items[${i}][price_data][unit_amount]`))
      const metadata = Object.fromEntries([...form.entries()].filter(([k]) => k.startsWith('metadata[')).map(([k, v]) => [k.slice(9, -1), v]))
      const session = { id, url: `https://checkout.stripe.com/c/pay/${id}`, status: 'open', payment_status: 'unpaid', amount_total: total, currency: 'eur', metadata, livemode: headers.Authorization!.includes('sk_live_'), expires_at: Number(form.get('expires_at')) }
      sessions.set(id, session); byKey.set(idem, id)
      // La sesión se crea pero la respuesta se pierde (tiempo agotado o 5xx tras crearla).
      if (lostResponses > 0) { lostResponses--; return new Response('{}', { status: 503 }) }
      return Response.json(session)
    }
    const id = decodeURIComponent(u.split('/checkout/sessions/')[1]!.split('/')[0]!)
    if (!sessions.has(id)) return new Response('{}', { status: 404 })
    if (u.endsWith('/expire')) { sessions.get(id).status = 'expired'; return Response.json(sessions.get(id)) }
    return Response.json(sessions.get(id))
  }) as unknown as typeof fetch
  const markPaid = (id: string) => { Object.assign(sessions.get(id), { status: 'complete', payment_status: 'paid' }) }

  const worker = () => createWorker({ pool: db.worker, fetch: stripe, log: () => undefined, openCredentials: (r, cipher) => vault.open(r, cipher), handlers: buildHandlers(MODULES, {}) })
  const drain = async () => { const w = worker(); for (let i = 0; i < 20; i++) if (!await w.runOnce()) break }
  const call = async (name: string, data: unknown, actor?: string, address?: string) => {
    const response = await fetch(`${base}/v1/operations/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-ip': address ?? `198.51.100.${(++ip % 250) + 1}`, ...(actor ? { Authorization: `Bearer ${actor}` } : {}) }, body: JSON.stringify({ data }) })
    const body = await response.json() as { result?: any; error?: { code: string; message: string } }
    return { status: response.status, body, result: body.result, code: body.error?.code }
  }
  const ok = async (name: string, data: unknown, actor = 'owner-a') => { const r = await call(name, data, actor); expect(r.status, JSON.stringify(r.body)).toBe(200); return r.result }
  const one = async (sql: string, values: unknown[] = []) => (await db.admin.query(sql, values)).rows[0]
  const count = async (table: string, where = 'true', values: unknown[] = []) => Number((await one(`SELECT count(*) FROM llenamos.${table} WHERE ${where}`, values)).count)
  const setSecrets = async (r: string, value: object | null) => {
    await db.admin.query('DELETE FROM llenamos.integration_secrets WHERE restaurant_id=$1', [r])
    await db.admin.query('DELETE FROM llenamos.integration_webhook_secrets WHERE restaurant_id=$1', [r])
    await db.admin.query("UPDATE llenamos.platform_restaurants SET integration_status=$2 WHERE restaurant_id=$1", [r, value ? JSON.stringify({ stripe: { configured: true, status: 'configured' } }) : null])
    if (!value) return
    await db.admin.query('INSERT INTO llenamos.integration_secrets(restaurant_id,ciphertext) VALUES($1,$2)', [r, vault.seal(r, value)])
    for (const provider of WEBHOOK_PROVIDERS) {
      const sealed = vault.sealWebhook(r, provider, webhookSubset(value, provider))
      if (sealed) await db.admin.query('INSERT INTO llenamos.integration_webhook_secrets(restaurant_id,provider,ciphertext) VALUES($1,$2,$3)', [r, provider, sealed])
    }
  }
  let eventNumber = 0
  const stripeEvent = (session: any, type = 'checkout.session.completed', over: Record<string, unknown> = {}) => ({ id: `evt_${++eventNumber}_${rid().slice(0, 6)}`, type, created: Math.floor(Date.now() / 1000), livemode: false,
    data: { object: { id: session.id, status: type === 'checkout.session.expired' ? 'expired' : 'complete', payment_status: type === 'checkout.session.expired' ? 'unpaid' : 'paid', amount_total: session.amount_total, currency: 'eur', metadata: session.metadata, livemode: false, ...over } } })
  const post = (r: string, event: object, secret = 'whsec_mobile_a') => {
    const body = JSON.stringify(event), t = Math.floor(Date.now() / 1000)
    return fetch(`${base}/v1/webhooks/stripe/${r}`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}` } })
  }
  /** Una cuenta bloqueada con una o dos partes, lista para cobrar. */
  async function lockedBill(scope = A, parts = 1) {
    const targetId = `mesa-${rid().slice(0, 10)}`
    consumption.set(`${scope.restaurantId}:${scope.locationId}:session:${targetId}`, LINES)
    const opened = await ok('abrirCuenta', { ...scope, requestId: rid(), target: { kind: 'session', id: targetId } })
    if (parts > 1) await ok('dividirCuenta', { ...scope, requestId: rid(), billId: opened.billId, expectedRevision: 1, split: { kind: 'equal', parts } })
    const revision = parts > 1 ? 2 : 1
    const prepared = await ok('prepararCobro', { ...scope, requestId: rid(), billId: opened.billId, expectedRevision: revision })
    const view = await ok('verCuenta', { ...scope, billId: opened.billId })
    return { billId: opened.billId as string, revision: prepared.revision as number, parts: view.parts as { id: string; totalCents: number }[], targetId }
  }
  const linkFor = async (b: Awaited<ReturnType<typeof lockedBill>>, part = 0, scope = A, actor = 'waiter-a') =>
    ok('crearEnlaceCobro', { ...scope, requestId: rid(), billId: b.billId, expectedRevision: b.revision, partId: b.parts[part]!.id }, actor) as Promise<{ checkoutId: string; token: string; path: string; expiresAt: number }>
  const view = (link: { checkoutId: string; token: string }, over: Record<string, unknown> = {}) => call('verCobroPublico', { slug: 'ra', locationId: 'la', checkoutId: link.checkoutId, token: link.token, ...over })
  const start = (link: { checkoutId: string; token: string }, over: Record<string, unknown> = {}) => call('iniciarPagoCuenta', { slug: 'ra', locationId: 'la', checkoutId: link.checkoutId, token: link.token, requestId: rid(), tipCents: 0, recipient: null, acceptDigitalReceipt: false, email: null, website: '', language: 'es', ...over })

  beforeAll(async () => {
    db = await testDatabase('movil')
    token = await db.seed(['ra', 'rb'], [['ra', 'owner-a', 'owner'], ['ra', 'waiter-a', 'waiter'], ['ra', 'kitchen-a', 'kitchen'], ['rb', 'owner-b', 'owner']])
    await db.admin.query(`UPDATE llenamos.restaurants SET plan='completo',active_modules=$1,is_demo=true`, [[...core.MODULES]])
    for (const s of [A, B]) await db.admin.query('INSERT INTO llenamos.locations(restaurant_id,id,name,slug) VALUES($1,$2,$2,$2)', [s.restaurantId, s.locationId])
    for (const [r, slug] of [['ra', 'ra'], ['rb', 'rb']]) await db.admin.query("INSERT INTO llenamos.platform_restaurants(restaurant_id,name,slug,plan_id,owner_email) VALUES($1,$1,$2,'sala','o@example.test')", [r, slug])
    await setSecrets('ra', SECRETS_A); await setSecrets('rb', null)
    configureStripeVault(vault); setStripeTransport(stripe)
    registerBillSource(fakeSource)
    process.env.LLENAMOS_FISCAL_TEST_MODE = '1'
    const receive = webhookReceiver(db.webhook, vault, { handled: new Set(['webhook.stripe', 'webhook.whatsapp']) })
    server = apiServer(db.app, async value => token(value), entry => { if (process.env.DEBUG_CAJA) console.error(JSON.stringify(entry)) }, { routes: [({ req, res, path: p }) => receive(req, res, p)] })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    await ok('guardarConfiguracionCaja', { ...A, requestId: rid(), settings: fiscal() })
    cashA = (await ok('abrirCaja', { ...A, requestId: rid(), registerId: 'principal', openingCents: 10000 })).cashSessionId
    cashB = (await ok('abrirCaja', { ...B, requestId: rid(), registerId: 'principal', openingCents: 0 }, 'owner-b')).cashSessionId
  }, 90_000)
  afterAll(async () => {
    registerBillSource(null); setStripeTransport(null); configureStripeVault(null); delete process.env.LLENAMOS_FISCAL_TEST_MODE
    server?.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await db?.close()
  })
  beforeEach(() => { resetMemoryLimits(); sent.length = 0; stripeDown = false; lostResponses = 0; rejectStatus = null; failGets = false; process.env.LLENAMOS_FISCAL_TEST_MODE = '1' })

  describe('enlace del personal', () => {
    it('crea el enlace con permiso, local y revisión correctos; repetir la solicitud rota el secreto del mismo cobro', async () => {
      const b = await lockedBill()
      const input = { ...A, requestId: rid(), billId: b.billId, expectedRevision: b.revision, partId: b.parts[0]!.id }
      const first = await ok('crearEnlaceCobro', input, 'waiter-a')
      expect(first.path).toBe(`/p/ra/la/${first.checkoutId}?t=${first.token}`)
      expect(first.expiresAt).toBeGreaterThan(Date.now())
      const again = await ok('crearEnlaceCobro', input, 'waiter-a')
      expect(again.checkoutId).toBe(first.checkoutId); expect(again.token).not.toBe(first.token)
      expect(await count('pos_mobile_checkouts', `bill_id='${b.billId}'`)).toBe(1)
      expect((await view(first)).status).toBe(403) // el secreto anterior ya no vale
      expect((await view(again)).status).toBe(200)
      // El secreto no queda en claro en la tabla de idempotencia.
      expect(await count('idempotency', `operation IN ('crearEnlaceCobro','crearReciboDigital') AND (result::text LIKE '%${first.token}%' OR result::text LIKE '%${again.token}%' OR result::text LIKE '%?t=%')`)).toBe(0)
      // La base guarda solo el hash del secreto.
      const row = await one('SELECT token_hash,amount_cents FROM llenamos.pos_mobile_checkouts WHERE id=$1', [first.checkoutId])
      expect(row.token_hash).toBe(core.sha256Hex(again.token)); expect(row.amount_cents).toBe(TOTAL)
      expect((await call('crearEnlaceCobro', input, 'kitchen-a')).status).toBe(403)
      expect((await call('crearEnlaceCobro', input, 'owner-b')).status).toBe(403)
      expect((await call('crearEnlaceCobro', { ...input, requestId: rid(), expectedRevision: b.revision + 1 }, 'waiter-a')).status).toBe(412)
      expect((await call('crearEnlaceCobro', { ...input, requestId: rid() })).status).toBe(401)
    })
    it('una cuenta sin bloquear o sin una sola caja abierta no admite enlace', async () => {
      const targetId = `mesa-${rid().slice(0, 10)}`
      consumption.set(`ra:la:session:${targetId}`, LINES)
      const opened = await ok('abrirCuenta', { ...A, requestId: rid(), target: { kind: 'session', id: targetId } })
      const part = (await ok('verCuenta', { ...A, billId: opened.billId })).parts[0].id
      expect((await call('crearEnlaceCobro', { ...A, requestId: rid(), billId: opened.billId, expectedRevision: 1, partId: part }, 'waiter-a')).status).toBe(412)
      const b = await lockedBill()
      await db.admin.query("INSERT INTO llenamos.pos_cash_sessions(restaurant_id,location_id,id,register_id,status,opened_at,data) SELECT restaurant_id,location_id,'otra','barra','open',opened_at,data FROM llenamos.pos_cash_sessions WHERE id=$1", [cashA])
      const two = await call('crearEnlaceCobro', { ...A, requestId: rid(), billId: b.billId, expectedRevision: b.revision, partId: b.parts[0]!.id }, 'waiter-a')
      expect(two.status).toBe(412); expect(two.body.error!.message).toContain('una sola caja abierta')
      await db.admin.query("DELETE FROM llenamos.pos_cash_sessions WHERE id='otra'")
    })
  })

  describe('lectura y antiabuso del enlace público', () => {
    it('solo con el secreto correcto; un enlace falso no revela nada y se bloquea por IP aunque luego acierte', async () => {
      const b = await lockedBill(), link = await linkFor(b)
      const seen = await view(link)
      expect(seen.status).toBe(200)
      expect(seen.result).toMatchObject({ restaurantName: 'Restaurante ra', label: 'Cuenta completa', amountCents: TOTAL, status: 'pending', paymentsEnabled: true, paymentInProgress: false, invoicePending: false })
      expect(JSON.stringify(seen.result)).not.toContain(link.token)
      const fake = await view({ ...link, token: 'A'.repeat(43) })
      expect(fake.status).toBe(403); expect(fake.code).toBe('permission-denied')
      expect((await view({ checkoutId: 'inexistente', token: link.token })).status).toBe(403)
      // Muchos fallos desde una IP (contra enlaces distintos) la bloquean, también para un enlace correcto.
      const attacker = '203.0.113.9'
      let blocked = 0
      for (let i = 0; i < limits.failedIp.max + 3; i++) {
        const r = await call('verCobroPublico', { slug: 'ra', locationId: 'la', checkoutId: `falso${i}`, token: 'B'.repeat(43) }, undefined, attacker)
        if (r.status === 429) blocked++
      }
      expect(blocked).toBe(3)
      const other = await linkFor(await lockedBill())
      expect((await call('verCobroPublico', { slug: 'ra', locationId: 'la', checkoutId: other.checkoutId, token: other.token }, undefined, attacker)).status).toBe(429)
      expect((await view(other)).status).toBe(200)
      // Y demasiados fallos contra un mismo enlace lo bloquean para todas las IP.
      for (let i = 0; i < limits.failedReference.max; i++) await view({ checkoutId: link.checkoutId, token: 'D'.repeat(43) })
      expect((await view(link)).status).toBe(429)
    })
    it('un enlace de otro restaurante o local no abre la cuenta', async () => {
      const b = await lockedBill(), link = await linkFor(b)
      expect((await view(link, { slug: 'rb', locationId: 'lb' })).status).toBe(403)
      expect((await view(link, { locationId: 'otra' })).status).toBe(404)
    })
    it('sin Stripe del restaurante la página lo dice y no se cobra ni se reserva nada', async () => {
      const targetId = `mesa-${rid().slice(0, 10)}`
      consumption.set(`rb:lb:session:${targetId}`, LINES)
      const opened = await ok('abrirCuenta', { ...B, requestId: rid(), target: { kind: 'session', id: targetId } }, 'owner-b')
      await ok('prepararCobro', { ...B, requestId: rid(), billId: opened.billId, expectedRevision: 1 }, 'owner-b')
      const part = (await ok('verCuenta', { ...B, billId: opened.billId }, 'owner-b')).parts[0].id
      await ok('guardarConfiguracionCaja', { ...B, requestId: rid(), settings: { ...fiscal(), system: { ...fiscal().system, installation: 'inst-b' } } }, 'owner-b').catch(() => undefined)
      await db.admin.query("INSERT INTO llenamos.pos_settings(restaurant_id,location_id,settings) VALUES('rb','lb',$1) ON CONFLICT(restaurant_id,location_id) DO UPDATE SET settings=EXCLUDED.settings", [JSON.stringify({ ...fiscal(), system: { ...fiscal().system, installation: 'inst-b' } })])
      const link = await ok('crearEnlaceCobro', { ...B, requestId: rid(), billId: opened.billId, expectedRevision: 2, partId: part }, 'owner-b')
      const seen = await call('verCobroPublico', { slug: 'rb', locationId: 'lb', checkoutId: link.checkoutId, token: link.token })
      expect(seen.result.paymentsEnabled).toBe(false)
      const started = await call('iniciarPagoCuenta', { slug: 'rb', locationId: 'lb', checkoutId: link.checkoutId, token: link.token, requestId: rid(), acceptDigitalReceipt: false, website: '' })
      expect(started.result.status).toBe('not_configured')
      expect(sent).toHaveLength(0)
      expect(await count('pos_mobile_checkouts', "id=$1 AND start_request IS NOT NULL", [link.checkoutId])).toBe(0)
    })
  })

  describe('pago con la Stripe del restaurante', () => {
    it('crea la sesión con la clave del restaurante, importe y propina, y un reintento recupera la misma', async () => {
      const b = await lockedBill(), link = await linkFor(b)
      const request = rid()
      const first = await start(link, { requestId: request, tipCents: 250, acceptDigitalReceipt: true, email: 'cliente@example.test' })
      expect(first.status, JSON.stringify(first.body)).toBe(200)
      expect(first.result.status).toBe('ready'); expect(first.result.url).toMatch(/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/)
      const create = sent.find(s => s.method === 'POST')!
      expect(create.auth).toBe('Bearer sk_test_restaurante_a')
      expect(create.account).toBeNull()
      expect(create.form.get('metadata[restaurantId]')).toBe('ra'); expect(create.form.get('metadata[checkoutId]')).toBe(link.checkoutId)
      expect(create.form.get('line_items[0][price_data][unit_amount]')).toBe(String(TOTAL)); expect(create.form.get('line_items[1][price_data][unit_amount]')).toBe('250')
      expect(create.form.get('success_url')).toBe(`https://app.example.test/p/volver?checkout=${link.checkoutId}`)
      const again = await start(link, { requestId: request, tipCents: 250, acceptDigitalReceipt: true, email: 'cliente@example.test' })
      expect(again.result).toEqual(first.result)
      expect(sent.filter(s => s.method === 'POST')).toHaveLength(1)
      expect((await view(link)).result).toMatchObject({ paymentInProgress: true, checkoutUrl: first.result.url, tipCents: 250 })
      // Otro intento con otros datos mientras hay uno en curso se rechaza.
      expect((await start(link, { requestId: rid(), tipCents: 0 })).status).toBe(412)
    })
    it('exige consentimiento para el correo, rechaza el campo trampa y no admite pagar una parte ya pagada', async () => {
      const b = await lockedBill(), link = await linkFor(b)
      expect((await start(link, { email: 'a@example.test', acceptDigitalReceipt: false })).status).toBe(412)
      expect((await start(link, { website: 'http://spam' })).status).toBe(400)
      expect(sent).toHaveLength(0)
      expect(await count('pos_mobile_checkouts', 'id=$1 AND start_request IS NOT NULL', [link.checkoutId])).toBe(0)
    })
    it('reserva el saldo: otra persona, el cobro en caja y el desbloqueo quedan bloqueados mientras hay un pago en curso', async () => {
      const b = await lockedBill(A, 2)
      const first = await linkFor(b, 0), second = await linkFor(b, 0), other = await linkFor(b, 1)
      expect((await start(first)).status).toBe(200)
      const taken = await start(second)
      expect(taken.status).toBe(412); expect(taken.body.error!.message).toContain('Otra persona')
      // El cobro en caja de la parte reservada no puede pasarse del saldo libre.
      const part = b.parts[0]!
      const pay = (partId: string, amount: number) => call('registrarCobro', { ...A, requestId: rid(), billId: b.billId, expectedRevision: b.revision, partId, cashSessionId: cashA, method: 'cash', amountCents: amount, tipCents: 0, tenderedCents: amount }, 'owner-a')
      expect((await pay(part.id, 100)).status).toBe(412)
      expect((await call('desbloquearCuenta', { ...A, requestId: rid(), billId: b.billId, expectedRevision: b.revision, reason: 'Prueba' }, 'owner-a')).status).toBe(412)
      expect((await call('dividirCuenta', { ...A, requestId: rid(), billId: b.billId, expectedRevision: b.revision, split: { kind: 'equal', parts: 3 } }, 'owner-a')).status).toBe(412)
      // La otra parte se cobra en efectivo con normalidad, pero la cuenta no se salda mientras haya un pago móvil vivo.
      const rest = b.parts[1]!.totalCents
      const cash = await pay(b.parts[1]!.id, rest)
      expect(cash.status, JSON.stringify(cash.body)).toBe(200)
      expect((await one('SELECT status FROM llenamos.pos_bills WHERE id=$1', [b.billId])).status).toBe('locked')
      expect(other.checkoutId).toBeTruthy()
    })
    it('aislamiento SQL de la credencial: solo se abre la del restaurante del ámbito público en curso y el rol de la API no lee la bóveda', async () => {
      // Fuera de un ámbito público la función no entrega ninguna credencial; con el ámbito de otro restaurante, tampoco la de este.
      expect((await db.app.query("SELECT llenamos.payments_stripe_ciphertext('ra') AS c")).rows[0].c).toBeNull()
      const client = await db.app.connect()
      try {
        await client.query('BEGIN'); await client.query("SELECT set_config('app.public_restaurant','rb',true)")
        expect((await client.query("SELECT llenamos.payments_stripe_ciphertext('ra') AS c")).rows[0].c).toBeNull()
        await client.query("SELECT set_config('app.public_restaurant','ra',true)")
        expect((await client.query("SELECT llenamos.payments_stripe_ciphertext('ra') AS c")).rows[0].c).toMatch(/^v1\./)
        await client.query('ROLLBACK')
      } finally { client.release() }
      await expect(db.app.query('SELECT count(*)::int AS n FROM llenamos.integration_secrets')).rejects.toThrow('permission denied') // el rol de la API no lee la bóveda
    })
  })

  describe('confirmación por webhook firmado, factura y recibo', () => {
    async function paidSession(over: { tip?: number; email?: string; recipient?: unknown } = {}) {
      const b = await lockedBill(), link = await linkFor(b)
      const started = await start(link, { tipCents: over.tip ?? 0, acceptDigitalReceipt: !!over.email, email: over.email ?? null, recipient: over.recipient ?? null })
      expect(started.status, JSON.stringify(started.body)).toBe(200)
      const session = [...sessions.values()].find(s => s.metadata.checkoutId === link.checkoutId)
      return { b, link, session }
    }
    it('registra un único cobro, salda la cuenta, factura y crea el recibo; los eventos repetidos no cobran dos veces', async () => {
      const { b, link, session } = await paidSession({ tip: 300, email: 'cliente@example.test' })
      markPaid(session.id)
      const event = stripeEvent(session)
      expect((await post('ra', event)).status).toBe(200)
      expect((await post('ra', event)).status).toBe(200) // mismo evento: lo deduplica el receptor
      expect((await post('ra', stripeEvent(session, 'checkout.session.async_payment_succeeded'))).status).toBe(200) // otro evento del mismo pago
      await drain()
      const payments = (await db.admin.query("SELECT method,status,external_id,data FROM llenamos.pos_payments WHERE bill_id=$1", [b.billId])).rows
      expect(payments).toHaveLength(1)
      expect(payments[0]).toMatchObject({ method: 'stripe', status: 'succeeded', external_id: session.id })
      expect(payments[0].data).toMatchObject({ amountCents: TOTAL, tipCents: 300, cashSessionId: cashA })
      const bill = await one('SELECT status,data FROM llenamos.pos_bills WHERE id=$1', [b.billId])
      expect(bill.status).toBe('settled'); expect(bill.data.paidCents).toBe(TOTAL)
      const row = await one('SELECT * FROM llenamos.pos_mobile_checkouts WHERE id=$1', [link.checkoutId])
      expect(row).toMatchObject({ status: 'paid', invoice_state: 'done', delivery: 'queued' })
      expect(await count('pos_invoices', `bill_id='${b.billId}'`)).toBe(1)
      // El recibo se abre con su secreto y no expone identificadores internos ni líneas de origen.
      expect(row.receipt_path).not.toContain('?t=') // guardado sellado, no en claro
      const receiptPath = new URL(openSecret('ra', row.receipt_path), 'https://x.test')
      const [, , slug, lid, receiptId] = receiptPath.pathname.split('/')
      const receipt = await call('verReciboDigital', { slug, locationId: lid, receiptId, token: receiptPath.searchParams.get('t') })
      expect(receipt.status, JSON.stringify(receipt.body)).toBe(200)
      expect(receipt.result.invoice.totalCents).toBe(TOTAL); expect(receipt.result.restaurantName).toBe('Restaurante ra'); expect(receipt.result.warning).toContain('no válido para Hacienda')
      expect(JSON.stringify(receipt.result)).not.toContain(b.billId)
      expect((await call('verReciboDigital', { slug, locationId: lid, receiptId, token: 'C'.repeat(43) })).status).toBe(403)
      // El correo se encola una sola vez, con el aviso del recibo.
      expect(await count('outbox', "kind='mensaje.enviar' AND payload->>'template'='digital_receipt'")).toBeGreaterThanOrEqual(1)
      // La página del pagador ya enseña el cobro y el recibo.
      const seen = await view(link)
      expect(seen.result).toMatchObject({ status: 'paid', paidCents: TOTAL, invoicePending: false })
      // Evento duplicado posterior con otro ID: tampoco duplica.
      await post('ra', stripeEvent(session)); await drain()
      expect(await count('pos_payments', `bill_id='${b.billId}'`)).toBe(1)
      expect(await count('pos_invoices', `bill_id='${b.billId}'`)).toBe(1)
    })
    it('una firma de otro restaurante o de otro secreto se rechaza; un evento de este restaurante recibido por otro va a cuarentena', async () => {
      const { b, session } = await paidSession()
      markPaid(session.id)
      expect((await post('ra', stripeEvent(session), 'whsec_falso')).status).toBe(401)
      expect((await post('ra', stripeEvent(session), 'whsec_b')).status).toBe(401)
      // Restaurante B con su propio secreto, pero metadatos del cobro de A: el worker lo aísla.
      await setSecrets('rb', SECRETS_B)
      expect((await post('rb', stripeEvent(session), 'whsec_b')).status).toBe(200)
      await drain()
      expect(await count('pos_payments', `bill_id='${b.billId}'`)).toBe(0)
      expect((await one("SELECT status,last_error FROM llenamos.outbox WHERE restaurant_id='rb' AND kind='webhook.stripe' ORDER BY occurred_at DESC LIMIT 1")).status).toBe('quarantined')
      await setSecrets('rb', null)
    })
    it('importe, moneda o sesión que no cuadran no cobran: quedan como incidencia para revisar', async () => {
      const { b, link, session } = await paidSession()
      markPaid(session.id)
      await post('ra', stripeEvent(session, 'checkout.session.completed', { amount_total: TOTAL - 100 }))
      await drain()
      expect(await count('pos_payments', `bill_id='${b.billId}'`)).toBe(0)
      expect((await one('SELECT status FROM llenamos.pos_mobile_checkouts WHERE id=$1', [link.checkoutId])).status).toBe('reconciliation_required')
      expect((await one("SELECT code,status FROM llenamos.pos_mobile_incidents WHERE checkout_id=$1", [link.checkoutId]))).toEqual({ code: 'provider_mismatch', status: 'open' })
    })
    it('con la caja cerrada el dinero cobrado no se asienta y queda como incidencia', async () => {
      const register = 'cierre'
      const closing = (await ok('abrirCaja', { ...B, requestId: rid(), registerId: register, openingCents: 0 }, 'owner-b')).cashSessionId
      expect(closing).toBeTruthy()
      const { b, link, session } = await paidSession()
      await db.admin.query("UPDATE llenamos.pos_cash_sessions SET status='closed',data=jsonb_set(data,'{status}','\"closed\"') WHERE id=$1", [cashA])
      try {
        markPaid(session.id)
        await post('ra', stripeEvent(session)); await drain()
        expect(await count('pos_payments', `bill_id='${b.billId}'`)).toBe(0)
        expect((await one("SELECT code FROM llenamos.pos_mobile_incidents WHERE checkout_id=$1", [link.checkoutId])).code).toBe('ledger_conflict')
      } finally {
        await db.admin.query("UPDATE llenamos.pos_cash_sessions SET status='open',data=jsonb_set(data,'{status}','\"open\"') WHERE id=$1", [cashA])
      }
    })
    it('sin proveedor fiscal el cobro queda confirmado y la factura pendiente, sin inventar documento ni recibo', async () => {
      const { b, link, session } = await paidSession({ email: 'cliente@example.test' })
      process.env.LLENAMOS_FISCAL_TEST_MODE = '0'
      markPaid(session.id)
      await post('ra', stripeEvent(session)); await drain()
      expect(await count('pos_payments', `bill_id='${b.billId}' AND status='succeeded'`)).toBe(1)
      const row = await one('SELECT status,invoice_state,receipt_id,last_error FROM llenamos.pos_mobile_checkouts WHERE id=$1', [link.checkoutId])
      expect(row).toMatchObject({ status: 'paid', invoice_state: 'not_configured', receipt_id: null })
      expect(await count('pos_invoices', `bill_id='${b.billId}'`)).toBe(0)
      expect((await view(link)).result).toMatchObject({ status: 'paid', invoicePending: true, receiptPath: null })
    })
    it('un pago confirmado fuera de plazo no se asienta solo: queda como incidencia', async () => {
      const { b, link, session } = await paidSession()
      await db.admin.query("UPDATE llenamos.pos_mobile_checkouts SET stripe_expires_at=now()-interval '2 hours' WHERE id=$1", [link.checkoutId])
      markPaid(session.id)
      await post('ra', stripeEvent(session)); await drain()
      expect(await count('pos_payments', `bill_id='${b.billId}'`)).toBe(0)
      expect((await one('SELECT code FROM llenamos.pos_mobile_incidents WHERE checkout_id=$1', [link.checkoutId])).code).toBe('late_payment')
    })
    it('un evento que llega antes de guardar la sesión espera y se aplica cuando está guardada', async () => {
      const { b, link, session } = await paidSession()
      await db.admin.query('UPDATE llenamos.pos_mobile_checkouts SET stripe_session_id=NULL WHERE id=$1', [link.checkoutId])
      markPaid(session.id)
      await post('ra', stripeEvent(session)); await drain()
      const waiting = await one("SELECT status FROM llenamos.outbox WHERE restaurant_id='ra' AND kind='webhook.stripe' AND payload->'object'->>'id'=$1", [session.id])
      expect(waiting.status).not.toBe('done')
      expect(await count('pos_payments', `bill_id='${b.billId}'`)).toBe(0)
      await db.admin.query('UPDATE llenamos.pos_mobile_checkouts SET stripe_session_id=$2 WHERE id=$1', [link.checkoutId, session.id])
      await db.admin.query("UPDATE llenamos.outbox SET available_at=now(),status='pending',lease_id=NULL,lease_until=NULL WHERE restaurant_id='ra' AND kind='webhook.stripe' AND payload->'object'->>'id'=$1", [session.id])
      await drain()
      expect(await count('pos_payments', `bill_id='${b.billId}' AND status='succeeded'`)).toBe(1)
    })
    it('la factura completa lleva los datos del destinatario', async () => {
      const recipient = { name: 'Empresa Prueba SL', address: 'Calle Falsa 1', identity: { kind: 'nif', nif: '12345678Z' } }
      const { b, session } = await paidSession({ recipient })
      markPaid(session.id)
      await post('ra', stripeEvent(session)); await drain()
      const invoice = await one('SELECT data FROM llenamos.pos_invoices WHERE bill_id=$1', [b.billId].map(String))
      expect(invoice.data).toMatchObject({ type: 'F1', recipient: { name: 'Empresa Prueba SL' } })
    })
    it('la sesión caducada libera la parte y permite un nuevo intento', async () => {
      const { b, link, session } = await paidSession()
      await post('ra', stripeEvent(session, 'checkout.session.expired')); await drain()
      expect((await one('SELECT status FROM llenamos.pos_mobile_checkouts WHERE id=$1', [link.checkoutId])).status).toBe('expired')
      expect(await count('pos_payments', `bill_id='${b.billId}'`)).toBe(0)
      const next = await linkFor(b)
      expect((await start(next)).status).toBe(200)
    })
  })

  describe('recuperación por conciliación', () => {
    it('un corte de Stripe al crear la sesión no pierde el intento: el worker la recupera con la misma clave y confirma el pago', async () => {
      const b = await lockedBill(), link = await linkFor(b)
      lostResponses = 1
      const failed = await start(link, { tipCents: 100 })
      expect(failed.status).toBe(503)
      expect(await count('pos_mobile_checkouts', 'id=$1 AND stripe_session_id IS NULL AND start_request IS NOT NULL AND needs_reconciliation', [link.checkoutId])).toBe(1)
      expect(sessions.size).toBeGreaterThan(0) // la sesión se creó en Stripe aunque la respuesta se perdió
      const before = sessions.size
      await db.admin.query("UPDATE llenamos.pos_mobile_checkouts SET updated_at=now()-interval '1 minute' WHERE id=$1", [link.checkoutId])
      const [task] = cajaMaintenance(db.worker)
      expect(await task!.run()).toBeGreaterThanOrEqual(1)
      await drain()
      const row = await one('SELECT stripe_session_id,stripe_url FROM llenamos.pos_mobile_checkouts WHERE id=$1', [link.checkoutId])
      expect(row.stripe_session_id).toMatch(/^cs_test_/)
      expect(sessions.size).toBe(before) // la recuperación devolvió la misma sesión, sin crear otra
      // El pagador reintenta con la misma solicitud y recibe la misma URL, sin otra sesión.
      expect(sent.filter(s => s.method === 'POST' && s.url.endsWith('/sessions')).length).toBeGreaterThanOrEqual(2)
      expect(new Set(sent.filter(s => s.method === 'POST' && s.url.endsWith('/sessions')).map(s => s.key)).size).toBe(1)
      markPaid(row.stripe_session_id)
      await db.admin.query("UPDATE llenamos.pos_mobile_checkouts SET updated_at=now()-interval '1 minute' WHERE id=$1", [link.checkoutId])
      await db.admin.query('DELETE FROM llenamos.jobs')
      await task!.run(); await drain()
      expect((await one('SELECT status FROM llenamos.pos_mobile_checkouts WHERE id=$1', [link.checkoutId])).status).toBe('paid')
      expect(await count('pos_payments', `bill_id='${b.billId}' AND status='succeeded'`)).toBe(1)
    })
  })

  describe('pago desde el QR de la mesa', () => {
    const tableToken = 'T'.repeat(43)
    async function seatedTable(locked = true) {
      const tableId = `mesa${rid().slice(0, 8)}`, sessionId = `ses${rid().slice(0, 8)}`
      await db.admin.query("INSERT INTO llenamos.dining_areas(restaurant_id,location_id,id,data) VALUES('ra','la','qr','{\"id\":\"qr\",\"name\":\"QR\",\"sortOrder\":9}') ON CONFLICT DO NOTHING")
      await db.admin.query("INSERT INTO llenamos.dining_tables(restaurant_id,location_id,id,area_id,data) VALUES('ra','la',$1,'qr',$2)", [tableId, JSON.stringify({ id: tableId, name: 'M1', areaId: 'qr', seats: 4, shape: 'rect', x: 50, y: 50, w: 10, h: 10, joinableWith: [], enabled: true })])
      await db.admin.query("INSERT INTO llenamos.sala_private(restaurant_id,location_id,kind,id,doc) VALUES('ra','la','tableTokens',$1,$2)", [tableId, JSON.stringify({ tokenHash: core.sha256Hex(tableToken) })])
      await db.admin.query("INSERT INTO llenamos.sala_table_sessions(restaurant_id,location_id,id,doc) VALUES('ra','la',$1,$2)", [sessionId, JSON.stringify({ status: 'open', tableIds: [tableId], label: 'M1', guests: 2, reservationId: null, customerId: null, guestName: null, waiterUid: null, waiterName: null, notes: '', openedAt: Date.now(), openedBy: null, closedAt: null, closedBy: null, billRequestedAt: null, mergedInto: null, totalCents: 0, lineCount: 0, unservedCount: 0, history: [] })])
      consumption.set(`ra:la:session:${sessionId}`, LINES)
      const opened = await ok('abrirCuenta', { ...A, requestId: rid(), target: { kind: 'session', id: sessionId } })
      if (locked) await ok('prepararCobro', { ...A, requestId: rid(), billId: opened.billId, expectedRevision: 1 })
      return { tableId, sessionId, billId: opened.billId as string }
    }
    it('lista las partes con el enlace de la mesa y crea el cobro de la elegida; repetir la solicitud rota el secreto', async () => {
      const t = await seatedTable()
      const table = { slug: 'ra', locationId: 'la', tableId: t.tableId, token: tableToken }
      const parts = await call('verPartesPagoMesa', table)
      expect(parts.status, JSON.stringify(parts.body)).toBe(200)
      expect(parts.result).toMatchObject({ restaurantName: 'Restaurante ra', billId: t.billId, totalCents: TOTAL, revision: 2 })
      expect(parts.result.parts).toEqual([{ id: expect.any(String), label: 'Cuenta completa', amountCents: TOTAL }])
      expect((await call('verPartesPagoMesa', { ...table, token: 'U'.repeat(43) })).status).toBe(403)
      const choice = { ...table, partId: parts.result.parts[0].id, billId: t.billId, expectedRevision: 2, requestId: rid() }
      const first = await call('elegirPartePagoMesa', choice)
      expect(first.status, JSON.stringify(first.body)).toBe(200)
      expect((await view(first.result)).result).toMatchObject({ amountCents: TOTAL, status: 'pending' })
      const second = await call('elegirPartePagoMesa', choice)
      expect(second.result.checkoutId).toBe(first.result.checkoutId); expect(second.result.token).not.toBe(first.result.token)
      expect((await view(first.result)).status).toBe(403) // el secreto anterior ya no vale
      expect((await view(second.result)).status).toBe(200)
      expect(await count('pos_mobile_checkouts', `bill_id='${t.billId}'`)).toBe(1)
      expect((await call('elegirPartePagoMesa', { ...choice, requestId: rid(), expectedRevision: 1 })).status).toBe(412)
    })
    it('sin una cuenta preparada por el personal no se descubre nada', async () => {
      const t = await seatedTable(false)
      const r = await call('verPartesPagoMesa', { slug: 'ra', locationId: 'la', tableId: t.tableId, token: tableToken })
      expect(r.status).toBe(412); expect(r.body.error!.message).toContain('prepare tu cuenta')
    })
  })

  describe('señal de reserva con la Stripe del restaurante', () => {
    const DATE = (() => { const d = new Date(Date.now() + 8 * 86_400_000); while (d.getUTCDay() !== 3) d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10) })()
    let prepared = false
    async function book(phone: string) {
      // Cada prueba parte de un local libre: las reservas anteriores se anulan para no agotar las mesas.
      await db.admin.query("UPDATE llenamos.reservations SET status='cancelled',data=jsonb_set(data,'{status}','\"cancelled\"') WHERE restaurant_id='ra'")
      if (!prepared) {
        const area = { id: 'sala', name: 'Sala', sortOrder: 0 }
        const tables = ['T1', 'T2'].map((name, i) => ({ id: `la-${name}`, name, areaId: 'sala', seats: 4, shape: 'rect', x: 5 + i * 20, y: 5, w: 10, h: 10, joinableWith: [], enabled: true }))
        await ok('guardarPlano', { ...A, createAreas: [area], createTables: tables })
        const reservationSettings = { ...core.defaultReservationSettings('Europe/Madrid'), publicBooking: true, autoConfirm: true, minNoticeMinutes: 0, maxAdvanceDays: 700, deposit: { mode: 'perPerson', amountCents: 500, fromPartySize: 2 } }
        await ok('guardarConfiguracionReservas', { ...A, settings: reservationSettings })
        prepared = true
      }
      const made = await call('crearReservaPublica', { slug: 'ra', locationId: 'la', date: DATE, time: '14:00', partySize: 4, guestName: 'Ana Señal', phone, email: null, language: 'es', guestNotes: '', acceptPolicy: true, source: 'web', website: '' })
      expect(made.status, JSON.stringify(made.body)).toBe(200)
      return { link: { slug: 'ra', reference: made.result.reference, token: made.result.manageToken }, made: made.result }
    }
    it('crea la sesión con la clave del restaurante, reutiliza la abierta y el webhook firmado confirma la reserva una sola vez', async () => {
      const { link, made } = await book('+34600011001')
      expect(made.deposit).toEqual({ status: 'required', amountCents: 2000 })
      const started = await call('iniciarPagoSenal', link)
      expect(started.status, JSON.stringify(started.body)).toBe(200)
      expect(started.result.status).toBe('redirect'); expect(started.result.url).toMatch(/^https:\/\/checkout\.stripe\.com\//)
      const create = sent.find(s => s.method === 'POST')!
      expect(create.auth).toBe('Bearer sk_test_restaurante_a')
      expect(create.form.get('metadata[kind]')).toBe('reservation_deposit'); expect(create.form.get('metadata[restaurantId]')).toBe('ra')
      expect(create.form.get('line_items[0][price_data][unit_amount]')).toBe('2000')
      expect(create.form.get('success_url')).toBe(`https://app.example.test/r/ra/reserva/${link.reference}?t=${link.token}`)
      // Con una sesión aún abierta se devuelve la misma, sin abrir otra.
      const again = await call('iniciarPagoSenal', link)
      expect(again.result.url).toBe(started.result.url)
      expect(sent.filter(s => s.method === 'POST')).toHaveLength(1)
      const session = [...sessions.values()].find(s => s.metadata.reservationId)!
      markPaid(session.id)
      const event = stripeEvent(session)
      await post('ra', event); await post('ra', event); await drain()
      const reservation = await one('SELECT status,data FROM llenamos.reservations WHERE reference=$1', [link.reference])
      expect(reservation.status).toBe('confirmed'); expect(reservation.data.deposit).toMatchObject({ status: 'paid', checkoutSessionId: session.id })
      expect((await call('iniciarPagoSenal', link)).result.status).toBe('already_paid')
    })
    it('sin Stripe del restaurante no hay sesión ni redirección', async () => {
      await setSecrets('ra', null)
      try {
        const { link } = await book('+34600011002')
        const r = await call('iniciarPagoSenal', link)
        expect(r.result.status).toBe('not_configured'); expect(sent).toHaveLength(0)
      } finally { await setSecrets('ra', SECRETS_A) }
    })
    it('un corte tras crear la sesión de la señal se reintenta con la misma petición: Stripe no la rechaza y no se abre otra sesión', async () => {
      const { link } = await book('+34600011010')
      lostResponses = 1
      const lost = await call('iniciarPagoSenal', link)
      expect(lost.status).toBe(503)
      const created = sessions.size
      const retry = await call('iniciarPagoSenal', link)
      expect(retry.status, JSON.stringify(retry.body)).toBe(200)
      expect(retry.result.status).toBe('redirect')
      expect(sessions.size).toBe(created) // misma clave y mismos parámetros: Stripe devuelve la misma sesión
      const posts = sent.filter(x => x.method === 'POST')
      expect(posts).toHaveLength(2); expect(posts[0]!.key).toBe(posts[1]!.key); expect(posts[0]!.form.get('expires_at')).toBe(posts[1]!.form.get('expires_at'))
    })
    it('si no se puede consultar la sesión anterior de la señal no se crea otra', async () => {
      const { link } = await book('+34600011011')
      expect((await call('iniciarPagoSenal', link)).status).toBe(200)
      const created = sessions.size
      failGets = true
      const r = await call('iniciarPagoSenal', link)
      expect(r.status).toBe(503)
      expect(sessions.size).toBe(created)
      expect(sent.filter(x => x.method === 'POST')).toHaveLength(1)
    })
    it('una respuesta de Stripe que no cuadra con la señal no se guarda', async () => {
      const { link } = await book('+34600011003')
      const real = stripe
      setStripeTransport((async (url: any, init: any) => {
        const response = await (real as any)(url, init)
        if (init.method !== 'POST') return response
        const body = await response.json(); return Response.json({ ...body, amount_total: 1 })
      }) as typeof fetch)
      try {
        const r = await call('iniciarPagoSenal', link)
        expect(r.status).toBe(502)
        expect(await count("reservations", "reference=$1 AND data->'deposit'->>'checkoutSessionId' IS NOT NULL", [link.reference])).toBe(0)
      } finally { setStripeTransport(stripe) }
    })
  })
  describe('revisión del coordinador', () => {
    async function started(over: Record<string, unknown> = {}, part = 0, parts = 1) {
      const b = await lockedBill(A, parts), link = await linkFor(b, part)
      const r = await start(link, over)
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      return { b, link, session: [...sessions.values()].find(x => x.metadata.checkoutId === link.checkoutId) }
    }
    it('no se cierra la caja con un pago móvil en curso; al cancelarlo se libera', async () => {
      const { b, link } = await started()
      const close = await call('cerrarCaja', { ...A, requestId: rid(), cashSessionId: cashA, countedCents: 10000, reason: 'Cierre' }, 'owner-a')
      expect(close.status).toBe(412); expect(close.body.error!.message).toContain('pago móvil en curso')
      expect((await one('SELECT status FROM llenamos.pos_cash_sessions WHERE id=$1', [cashA])).status).toBe('open')
      const cancel = await call('cancelarCobroMovil', { ...A, requestId: rid(), checkoutId: link.checkoutId, reason: 'Cliente se va' }, 'owner-a')
      expect(cancel.result).toEqual({ ok: true, status: 'expired' })
      expect(await count('pos_mobile_checkouts', `bill_id='${b.billId}' AND status='pending' AND start_request IS NOT NULL`)).toBe(0)
    })
    it('cancelar caduca la sesión en Stripe, libera la parte y un pago posterior queda como incidencia, no como cobro', async () => {
      const { b, link, session } = await started()
      expect((await call('cancelarCobroMovil', { ...A, requestId: rid(), checkoutId: link.checkoutId, reason: 'Error' }, 'waiter-a')).status).toBe(403)
      await ok('cancelarCobroMovil', { ...A, requestId: rid(), checkoutId: link.checkoutId, reason: 'Error' })
      expect((await ok('cancelarCobroMovil', { ...A, requestId: rid(), checkoutId: link.checkoutId, reason: 'Error' })).status).toBe('already_final')
      await drain()
      expect(sessions.get(session.id).status).toBe('expired')
      // La parte vuelve a poder cobrarse en caja y a pagarse por móvil.
      const paid = await call('registrarCobro', { ...A, requestId: rid(), billId: b.billId, expectedRevision: b.revision, partId: b.parts[0]!.id, cashSessionId: cashA, method: 'cash', amountCents: 100, tipCents: 0, tenderedCents: 100 }, 'owner-a')
      expect(paid.status, JSON.stringify(paid.body)).toBe(200)
      // Si aun así llegara el pago, no se cobra.
      Object.assign(sessions.get(session.id), { status: 'complete', payment_status: 'paid' })
      await post('ra', stripeEvent(session)); await drain()
      expect(await count('pos_payments', `bill_id='${b.billId}' AND method='stripe'`)).toBe(0)
      expect((await one('SELECT code FROM llenamos.pos_mobile_incidents WHERE checkout_id=$1', [link.checkoutId])).code).toBe('late_payment')
    })
    it('el personal da una incidencia por revisada; solo owner y manager; lo ajeno no existe', async () => {
      const { link, session } = await started()
      markPaid(session.id)
      await post('ra', stripeEvent(session, 'checkout.session.completed', { amount_total: 1 })); await drain()
      const incident = await one('SELECT id FROM llenamos.pos_mobile_incidents WHERE checkout_id=$1', [link.checkoutId])
      const input = { ...A, requestId: rid(), incidentId: incident.id, reason: 'Revisado en Stripe' }
      expect((await call('resolverIncidenciaMovil', input, 'waiter-a')).status).toBe(403)
      expect((await call('resolverIncidenciaMovil', { ...input, restaurantId: 'rb', locationId: 'lb' }, 'owner-b')).status).toBe(404)
      await ok('resolverIncidenciaMovil', input)
      expect((await one('SELECT status FROM llenamos.pos_mobile_incidents WHERE id=$1', [incident.id])).status).toBe('resolved')
    })
    it('un rechazo definitivo de Stripe (clave inválida) no bloquea la parte', async () => {
      const b = await lockedBill(), link = await linkFor(b)
      rejectStatus = 401
      const r = await start(link)
      expect(r.status).toBe(502)
      const row = await one('SELECT status,needs_reconciliation,stripe_session_id FROM llenamos.pos_mobile_checkouts WHERE id=$1', [link.checkoutId])
      expect(row).toEqual({ status: 'failed', needs_reconciliation: false, stripe_session_id: null })
      rejectStatus = null
      // La parte está libre: se cobra en caja y no queda reserva.
      const pay = await call('registrarCobro', { ...A, requestId: rid(), billId: b.billId, expectedRevision: b.revision, partId: b.parts[0]!.id, cashSessionId: cashA, method: 'cash', amountCents: TOTAL, tipCents: 0, tenderedCents: TOTAL }, 'owner-a')
      expect(pay.status, JSON.stringify(pay.body)).toBe(200)
    })
    it('sin credenciales del restaurante un intento sale del flujo pasada una hora y el aviso queda como incidencia', async () => {
      const b = await lockedBill(), link = await linkFor(b)
      lostResponses = 1
      expect((await start(link)).status).toBe(503)
      await setSecrets('ra', null)
      try {
        await db.admin.query("UPDATE llenamos.pos_mobile_checkouts SET updated_at=now()-interval '1 minute',started_at=now()-interval '2 hours',stripe_session_id=NULL WHERE id=$1", [link.checkoutId])
        await db.admin.query('DELETE FROM llenamos.jobs')
        const [task] = cajaMaintenance(db.worker)
        await task!.run(); await drain()
        expect(await one('SELECT status FROM llenamos.pos_mobile_checkouts WHERE id=$1', [link.checkoutId])).toEqual({ status: 'reconciliation_required' })
        expect((await one('SELECT code FROM llenamos.pos_mobile_incidents WHERE checkout_id=$1', [link.checkoutId])).code).toBe('sin_credenciales')
      } finally { await setSecrets('ra', SECRETS_A) }
      expect(b.billId).toBeTruthy()
    })
    it('un pago diferido rechazado libera la parte', async () => {
      const { link, session } = await started()
      await post('ra', stripeEvent(session, 'checkout.session.async_payment_failed', { payment_status: 'unpaid' })); await drain()
      expect((await one('SELECT status FROM llenamos.pos_mobile_checkouts WHERE id=$1', [link.checkoutId])).status).toBe('failed')
    })
    it('un evento de un local que no existe se aparta a cuarentena, no falla en bucle', async () => {
      const { session } = await started()
      markPaid(session.id)
      const bad = { ...session, metadata: { ...session.metadata, locationId: 'no-existe', checkoutId: 'otro' } }
      await post('ra', stripeEvent(bad)); await drain()
      const evt = await one("SELECT status,last_error FROM llenamos.outbox WHERE restaurant_id='ra' AND kind='webhook.stripe' AND payload->'object'->'metadata'->>'locationId'='no-existe'")
      expect(evt).toEqual({ status: 'quarantined', last_error: 'cobro-movil-local-desconocido' })
    })
    it('la conciliación por consulta no marca como tardío un pago ya hecho y las filas atascadas rotan', async () => {
      const { b, link, session } = await started()
      await db.admin.query("UPDATE llenamos.pos_mobile_checkouts SET stripe_expires_at=now()-interval '3 hours',updated_at=now()-interval '1 minute' WHERE id=$1", [link.checkoutId])
      markPaid(session.id)
      const before = (await one('SELECT updated_at FROM llenamos.pos_mobile_checkouts WHERE id=$1', [link.checkoutId])).updated_at
      const [task] = cajaMaintenance(db.worker)
      await db.admin.query('DELETE FROM llenamos.jobs')
      await task!.run()
      expect((await one('SELECT updated_at FROM llenamos.pos_mobile_checkouts WHERE id=$1', [link.checkoutId])).updated_at.getTime()).toBeGreaterThan(before.getTime())
      await drain()
      expect(await count('pos_payments', `bill_id='${b.billId}' AND status='succeeded'`)).toBe(1)
    })
    it('el pagador sigue viendo la URL de pago y su recibo pasados los 15 minutos del enlace', async () => {
      const { link, session } = await started()
      await db.admin.query("UPDATE llenamos.pos_mobile_checkouts SET expires_at=now()-interval '1 minute' WHERE id=$1", [link.checkoutId])
      expect((await view(link)).result.checkoutUrl).toBe(session.url)
      markPaid(session.id)
      await post('ra', stripeEvent(session)); await drain()
      expect((await view(link)).result).toMatchObject({ status: 'paid', receiptPath: expect.stringContaining('/recibo/ra/la/') })
    })
    it('repetir crearReciboDigital rota el secreto del mismo recibo y no duplica el correo', async () => {
      const { b, session } = await started({ acceptDigitalReceipt: true, email: 'cliente@example.test' })
      markPaid(session.id)
      await post('ra', stripeEvent(session)); await drain()
      const invoice = await one('SELECT id FROM llenamos.pos_invoices WHERE bill_id=$1', [b.billId])
      const input = { ...A, requestId: rid(), invoiceId: invoice.id, email: 'otro@example.test', acceptDigitalReceipt: true }
      const first = await ok('crearReciboDigital', input), again = await ok('crearReciboDigital', input)
      expect(again.receiptId).toBe(first.receiptId); expect(again.token).not.toBe(first.token)
      const link = { slug: 'ra', locationId: 'la', receiptId: first.receiptId }
      expect((await call('verReciboDigital', { ...link, token: first.token })).status).toBe(403)
      expect((await call('verReciboDigital', { ...link, token: again.token })).status).toBe(200)
      expect(await count('outbox', "kind='mensaje.enviar' AND payload->>'to'='otro@example.test'")).toBe(1)
      expect(await count('idempotency', "operation='crearReciboDigital' AND result::text LIKE '%?t=%'")).toBe(0)
    })
  })

})

