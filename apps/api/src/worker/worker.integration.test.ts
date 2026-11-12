import { randomUUID, createHmac } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { integrationVault, webhookSubset, WEBHOOK_PROVIDERS } from '../platform/integrations.js'
import { withIdentity, checkRuntimeRole } from '../database.js'
import { checkWorkerRole } from '../database.js'
import { enqueueOutbox } from '../outbox.js'
import { enqueueJob } from '../jobs.js'
import { stableUuid } from '../ids.js'
import { apiServer } from '../server.js'
import { webhookReceiver } from '../webhooks/receiver.js'
import { buildHandlers, createWorker, enqueueMessage, PermanentFailure, RetryLater, type WorkerHandler } from './index.js'
import { claim, finish } from './queue.js'
import { testDatabase } from './harness.js'

const enabled = process.env.TEST_POSTGRES_API === '1' && !!process.env.TEST_POSTGRES_URL
const key = Buffer.alloc(32, 7), vault = integrationVault(key)

describe.skipIf(!enabled)('Worker: cola con lease, avisos y webhooks sobre PostgreSQL', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>, token: (uid: string) => import('../auth.js').IdentityToken
  const requests: Array<{ url: string; headers: Record<string, string>; body: any }> = []
  let providerStatus = 200
  let sequence = 0
  const fetchStub = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), headers: init!.headers as Record<string, string>, body: JSON.parse(String(init!.body)) })
    if (providerStatus !== 200) return new Response('{}', { status: providerStatus })
    return new Response(JSON.stringify(String(url).includes('resend') ? { id: `re_${++sequence}` } : { messages: [{ id: `wamid.${++sequence}` }] }), { status: 200 })
  }) as unknown as typeof fetch
  const makeWorker = (extra: ReadonlyArray<readonly [string, WorkerHandler]> = []) => createWorker({
    pool: db.worker, fetch: fetchStub, log: () => undefined, openCredentials: (rid, cipher) => vault.open(rid, cipher),
    handlers: buildHandlers([{ name: 'prueba', operations: [], workerHandlers: extra }]),
  })
  const message = (to = 'cliente@example.test') => ({ channel: 'email', to, template: 'confirmation', language: 'es', data: { guestName: 'Ana', restaurantName: 'Casa', reference: 'ABC123', startAt: Date.now() + 86_400_000, timezone: 'Europe/Madrid', partySize: 2, manageUrl: 'https://example.test/r/1' }, reservationId: 'res1', waitlistId: null, sendAt: Date.now() - 1000 })
  const setCredentials = async (rid: string, value: object) => {
    await db.admin.query('INSERT INTO llenamos.integration_secrets(restaurant_id,ciphertext) VALUES($1,$2) ON CONFLICT(restaurant_id) DO UPDATE SET ciphertext=EXCLUDED.ciphertext', [rid, vault.seal(rid, value)])
    for (const provider of WEBHOOK_PROVIDERS) {
      const sealed = vault.sealWebhook(rid, provider, webhookSubset(value, provider))
      if (sealed) await db.admin.query('INSERT INTO llenamos.integration_webhook_secrets(restaurant_id,provider,ciphertext) VALUES($1,$2,$3) ON CONFLICT(restaurant_id,provider) DO UPDATE SET ciphertext=EXCLUDED.ciphertext', [rid, provider, sealed])
    }
  }
  const enqueue = (rid: string, uid: string, id: string = randomUUID(), request: unknown = message()) => withIdentity(db.app, token(uid), rid, client => enqueueMessage(client, rid, id, request)).then(() => id)
  const drain = async (worker = makeWorker()) => { for (let i = 0; i < 5; i++) if (!await worker.runOnce()) break }

  beforeAll(async () => {
    db = await testDatabase('worker')
    token = await db.seed(['tenant-a', 'tenant-b'], [['tenant-a', 'owner-a', 'owner'], ['tenant-b', 'owner-b', 'owner']])
    await setCredentials('tenant-a', { email: { apiKey: 'key-a', from: 'a@example.test' }, whatsapp: { token: 'wa-token-a', phoneNumberId: '111', appSecret: 'secret-a', verifyToken: 'verify-a' }, stripe: { secretKey: 'sk', webhookSecret: 'whsec_a' } })
  }, 60_000)
  afterAll(async () => { await db?.close() })

  it('los roles quedan separados: la API no es worker y el worker no es API', async () => {
    await expect(checkWorkerRole(db.worker)).resolves.toBeUndefined()
    await expect(checkWorkerRole(db.app)).rejects.toThrow()
    await expect(checkRuntimeRole(db.app)).resolves.toBeUndefined()
    await expect(checkRuntimeRole(db.worker)).rejects.toThrow(/worker/)
  })

  it('dos workers reclaman a la vez sin repetir elementos y respetan el lease', async () => {
    const rid = 'tenant-a'
    const ids: string[] = Array.from({ length: 40 }, () => randomUUID())
    await withIdentity(db.app, token('owner-a'), rid, async client => { for (const id of ids) await enqueueOutbox(client, { id, restaurantId: rid, kind: 'prueba.cola', payload: {} }) })
    const [a, b] = await Promise.all([claim(db.worker, 'outbox', 30), claim(db.worker, 'outbox', 30)])
    const all = [...a, ...b].map(row => row.item.id).filter(id => ids.includes(id))
    expect(all.length).toBe(40)
    expect(new Set(all).size).toBe(40)
    expect(await claim(db.worker, 'outbox', 30)).toEqual([]) // lease vigente: nadie más lo toma
    // lease vencido: otro worker lo reclama; el primero ya no puede cerrar el elemento
    const victim = a[0]!
    await db.admin.query("UPDATE llenamos.outbox SET lease_until=now()-interval '1 second' WHERE id=$1", [victim.item.id])
    const [again] = await claim(db.worker, 'outbox', 5)
    expect(again!.item.id).toBe(victim.item.id)
    expect(again!.item.attempts).toBe(2)
    expect(await finish(db.worker, 'outbox', victim.item.id, victim.leaseId, 'done')).toBe(false)
    expect(await finish(db.worker, 'outbox', victim.item.id, again!.leaseId, 'done')).toBe(true)
    await db.admin.query("UPDATE llenamos.outbox SET status='done',finished_at=now() WHERE kind='prueba.cola'")
  })

  it('reintenta con espera, y tras agotar intentos manda a cuarentena sin perder el elemento', async () => {
    const rid = 'tenant-a', id = randomUUID()
    await withIdentity(db.app, token('owner-a'), rid, client => enqueueOutbox(client, { id, restaurantId: rid, kind: 'prueba.falla', payload: {} }))
    const handler = vi.fn(async () => { throw new Error('boom') })
    const worker = makeWorker([['prueba.falla', handler]])
    for (let attempt = 1; attempt <= 8; attempt++) {
      await worker.runOnce()
      const row = (await db.admin.query('SELECT status,attempts,available_at>now() AS later,last_error FROM llenamos.outbox WHERE id=$1', [id])).rows[0]
      if (attempt < 8) { expect(row).toMatchObject({ status: 'pending', attempts: attempt, later: true }) }
      else expect(row).toMatchObject({ status: 'quarantined', attempts: 8, last_error: 'unexpected' })
      await db.admin.query("UPDATE llenamos.outbox SET available_at=now() WHERE id=$1", [id])
    }
    expect(handler).toHaveBeenCalledTimes(8)
    await worker.runOnce()
    expect(handler).toHaveBeenCalledTimes(8)
  })

  it('un fallo permanente termina en failed y un tipo desconocido se reintenta, no se pierde', async () => {
    const rid = 'tenant-a', permanent = randomUUID(), unknown = randomUUID()
    await withIdentity(db.app, token('owner-a'), rid, async client => {
      await enqueueOutbox(client, { id: permanent, restaurantId: rid, kind: 'prueba.permanente', payload: {} })
      await enqueueOutbox(client, { id: unknown, restaurantId: rid, kind: 'prueba.sin_manejador', payload: {} })
    })
    await makeWorker([['prueba.permanente', async () => { throw new PermanentFailure('rechazado') }]]).runOnce()
    expect((await db.admin.query('SELECT status,last_error FROM llenamos.outbox WHERE id=$1', [permanent])).rows[0]).toEqual({ status: 'failed', last_error: 'rechazado' })
    expect((await db.admin.query('SELECT status,last_error FROM llenamos.outbox WHERE id=$1', [unknown])).rows[0]).toEqual({ status: 'pending', last_error: 'sin-manejador' })
  })

  it('los trabajos (jobs) usan la misma cola y no se duplican por clave', async () => {
    const rid = 'tenant-a', ran = vi.fn(async () => undefined)
    await withIdentity(db.app, token('owner-a'), rid, async client => {
      for (const id of [randomUUID(), randomUUID()]) await enqueueJob(client, { id, restaurantId: rid, kind: 'prueba.job', deduplicationKey: 'misma-clave', payload: {} })
    })
    await makeWorker([['prueba.job', ran]]).runOnce()
    expect(ran).toHaveBeenCalledTimes(1)
  })

  it('el aviso sale por el proveedor del propio restaurante con ID estable y no se repite', async () => {
    requests.length = 0
    const id = await enqueue('tenant-a', 'owner-a')
    await enqueue('tenant-a', 'owner-a', id) // misma operación repetida: mismo ID, un solo envío
    await drain()
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe('https://api.resend.com/emails')
    expect(requests[0]!.headers).toMatchObject({ Authorization: 'Bearer key-a', 'Idempotency-Key': id })
    expect(requests[0]!.body).toMatchObject({ from: 'a@example.test', to: ['cliente@example.test'] })
    const delivery = (await db.admin.query('SELECT status,provider,provider_message_id,context FROM llenamos.message_deliveries WHERE id=$1', [id])).rows[0]
    expect(delivery).toMatchObject({ status: 'sent', provider: 'resend', provider_message_id: expect.stringMatching(/^re_/) })
    expect((await db.admin.query('SELECT status FROM llenamos.outbox WHERE id=$1', [id])).rows[0].status).toBe('done')
    // entrega repetida del mismo elemento (lease vencido tras el efecto): no vuelve a enviar
    await db.admin.query("UPDATE llenamos.outbox SET status='pending' WHERE id=$1", [id])
    await drain()
    expect(requests).toHaveLength(1)
  })

  it('sin credenciales no hay envío ni éxito simulado, y no se usan las de otro restaurante', async () => {
    requests.length = 0
    const id = await enqueue('tenant-b', 'owner-b')
    await drain()
    expect(requests).toHaveLength(0)
    expect((await db.admin.query('SELECT status,last_error FROM llenamos.outbox WHERE id=$1', [id])).rows[0]).toEqual({ status: 'failed', last_error: 'not-configured' })
    expect((await db.admin.query('SELECT status FROM llenamos.message_deliveries WHERE id=$1', [id])).rows[0].status).toBe('not_configured')
  })

  it('errores transitorios del proveedor reintentan con la misma clave; un rechazo definitivo no', async () => {
    requests.length = 0
    providerStatus = 503
    const id = await enqueue('tenant-a', 'owner-a')
    await drain()
    expect(requests).toHaveLength(1)
    expect((await db.admin.query('SELECT status,attempts FROM llenamos.outbox WHERE id=$1', [id])).rows[0]).toMatchObject({ status: 'pending', attempts: 1 })
    providerStatus = 200
    await db.admin.query("UPDATE llenamos.outbox SET available_at=now() WHERE id=$1", [id])
    await drain()
    expect(requests.map(request => request.headers['Idempotency-Key'])).toEqual([id, id])
    expect((await db.admin.query('SELECT status FROM llenamos.message_deliveries WHERE id=$1', [id])).rows[0].status).toBe('sent')
    providerStatus = 400
    const rejected = await enqueue('tenant-a', 'owner-a')
    await drain()
    providerStatus = 200
    expect((await db.admin.query('SELECT status,last_error FROM llenamos.outbox WHERE id=$1', [rejected])).rows[0]).toEqual({ status: 'failed', last_error: 'provider-400' })
    expect((await db.admin.query('SELECT status FROM llenamos.message_deliveries WHERE id=$1', [rejected])).rows[0].status).toBe('failed')
  })

  it('marketing no sale sin comprobador de consentimiento ni con consentimiento retirado', async () => {
    requests.length = 0
    const marketing = { ...message(), template: 'marketing_campaign', purpose: 'marketing_email', customerId: 'cus1' }
    const blocked = await enqueue('tenant-a', 'owner-a', randomUUID(), marketing)
    await drain()
    expect(requests).toHaveLength(0)
    expect((await db.admin.query('SELECT status,last_error FROM llenamos.message_deliveries WHERE id=$1', [blocked])).rows[0]).toEqual({ status: 'cancelled', last_error: 'sin-consentimiento' })
    const granted = createWorker({ pool: db.worker, fetch: fetchStub, log: () => undefined, openCredentials: (rid, cipher) => vault.open(rid, cipher),
      handlers: buildHandlers([{ name: 'clientes', operations: [], marketingConsent: async (_c, _r, customer) => customer === 'cus1' }]) })
    const allowed = await enqueue('tenant-a', 'owner-a', randomUUID(), marketing)
    await drain(granted)
    expect(requests).toHaveLength(1)
    expect((await db.admin.query('SELECT status FROM llenamos.message_deliveries WHERE id=$1', [allowed])).rows[0].status).toBe('sent')
  })

  it('el worker solo ve datos del restaurante de su transacción; la API no abre credenciales ajenas desde SQL arbitrario', async () => {
    await expect(db.worker.query('SELECT * FROM llenamos.message_deliveries')).resolves.toMatchObject({ rows: [] })
    await expect(db.app.query('SELECT * FROM llenamos.outbox')).resolves.toMatchObject({ rows: [] })
    await expect(db.app.query('SELECT * FROM llenamos.integration_secrets')).rejects.toThrow()
    await expect(db.app.query("SELECT llenamos.worker_claim_outbox(1,60,3)")).rejects.toThrow()
    const own = await withIdentity(db.app, token('owner-a'), 'tenant-a', client => client.query('SELECT count(*)::int AS n FROM llenamos.message_deliveries'))
    expect(own.rows[0].n).toBeGreaterThan(0)
    const other = await withIdentity(db.app, token('owner-b'), 'tenant-b', client => client.query("SELECT count(*)::int AS n FROM llenamos.message_deliveries WHERE status='sent'"))
    expect(other.rows[0].n).toBe(0)
  })

  describe('receptor de webhooks', () => {
    let server: ReturnType<typeof apiServer>, base: string
    const sign = (body: string, secret = 'secret-a') => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
    const stripeSign = (body: string, secret = 'whsec_a', t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`
    beforeAll(async () => {
      const receive = webhookReceiver(db.webhook, vault, { handled: new Set(['webhook.stripe', 'webhook.whatsapp']) })
      server = apiServer(db.app, async () => token('owner-a'), () => undefined, { routes: [({ req, res, path }) => receive(req, res, path)] })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    })
    afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
    const stripeEvent = (id: string) => JSON.stringify({ id, type: 'checkout.session.completed', created: 1, livemode: false, data: { object: { id: 'cs_1', amount_total: 2000 } } })

    it('Stripe: firma válida se acepta una sola vez por ID de evento; duplicados no repiten el efecto', async () => {
      const body = stripeEvent('evt_dup1'), seen = vi.fn(async () => undefined)
      const send = () => fetch(`${base}/v1/webhooks/stripe/tenant-a`, { method: 'POST', body, headers: { 'stripe-signature': stripeSign(body), 'content-type': 'application/json' } })
      expect((await Promise.all([send(), send(), send()])).map(r => r.status)).toEqual([200, 200, 200])
      expect(Number((await db.admin.query("SELECT count(*) AS n FROM llenamos.outbox WHERE kind='webhook.stripe' AND payload->>'eventId'='evt_dup1'")).rows[0].n)).toBe(1)
      const worker = makeWorker([['webhook.stripe', seen]])
      await worker.runOnce(); await worker.runOnce()
      expect(seen).toHaveBeenCalledTimes(1)
      expect(seen.mock.calls[0]).toBeDefined()
    })
    it('firma falsa, caducada o de otro restaurante se rechaza sin encolar', async () => {
      const body = stripeEvent('evt_bad1')
      const post = (rid: string, signature: string) => fetch(`${base}/v1/webhooks/stripe/${rid}`, { method: 'POST', body, headers: { 'stripe-signature': signature } }).then(r => r.status)
      expect(await post('tenant-a', stripeSign(body, 'otro-secreto'))).toBe(401)
      expect(await post('tenant-a', stripeSign(body, 'whsec_a', 1000))).toBe(401)
      expect(await post('tenant-b', stripeSign(body))).toBe(401) // tenant-b no tiene credenciales
      expect(await post('no-existe', stripeSign(body))).toBe(401)
      expect(Number((await db.admin.query("SELECT count(*) AS n FROM llenamos.webhook_events WHERE event_id='evt_bad1'")).rows[0].n)).toBe(0)
    })
    it('WhatsApp: verificación del desafío y firma HMAC del cuerpo crudo', async () => {
      const ok = await fetch(`${base}/v1/webhooks/whatsapp/tenant-a?hub.mode=subscribe&hub.verify_token=verify-a&hub.challenge=12345`)
      expect([ok.status, await ok.text()]).toEqual([200, '12345'])
      expect((await fetch(`${base}/v1/webhooks/whatsapp/tenant-a?hub.mode=subscribe&hub.verify_token=mal&hub.challenge=1`)).status).toBe(403)
      const body = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: '111' }, messages: [{ id: 'wamid.in1', from: '34600111222', timestamp: String(Math.floor(Date.now() / 1000)), text: { body: 'hola' } }] } }] }] })
      expect((await fetch(`${base}/v1/webhooks/whatsapp/tenant-a`, { method: 'POST', body, headers: { 'x-hub-signature-256': sign(body, 'otra') } })).status).toBe(401)
      expect((await fetch(`${base}/v1/webhooks/whatsapp/tenant-a`, { method: 'POST', body: body + ' ', headers: { 'x-hub-signature-256': sign(body) } })).status).toBe(401)
    })
    it('WhatsApp: la respuesta a un aviso confirma o cancela solo desde el mismo teléfono, con idempotencia', async () => {
      requests.length = 0
      const id = randomUUID()
      await enqueue('tenant-a', 'owner-a', id, { ...message('+34600111222'), channel: 'whatsapp', template: 'confirmation' })
      await drain()
      const waId = (await db.admin.query('SELECT provider_message_id FROM llenamos.message_deliveries WHERE id=$1', [id])).rows[0].provider_message_id
      expect(requests.at(-1)!.url).toContain('graph.facebook.com')
      const reply = (from: string, mid: string) => {
        const body = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: '111' }, messages: [{ id: mid, from, timestamp: String(Math.floor(Date.now() / 1000)), interactive: { button_reply: { id: `${id}:cancel` } } }] } }] }] })
        return fetch(`${base}/v1/webhooks/whatsapp/tenant-a`, { method: 'POST', body, headers: { 'x-hub-signature-256': sign(body) } }).then(r => r.status)
      }
      expect(await reply('34600111222', 'wamid.reply1')).toBe(200)
      expect(await reply('34600111222', 'wamid.reply1')).toBe(200) // reintento del proveedor
      expect(await reply('34699999999', 'wamid.reply2')).toBe(200) // otro teléfono
      const handled = vi.fn(async () => undefined)
      await makeWorker([['mensaje.respuesta', handled]]).runOnce()
      await makeWorker([['mensaje.respuesta', handled]]).runOnce()
      const rows = (await db.admin.query("SELECT payload FROM llenamos.outbox WHERE kind='mensaje.respuesta'")).rows
      expect(rows).toHaveLength(1)
      expect(rows[0].payload).toMatchObject({ action: 'cancelled', phone: '+34600111222', deliveryId: id })
      expect(handled).toHaveBeenCalledTimes(1)
      expect(waId).toMatch(/^wamid\./)
    })
    it('cuerpo enorme se corta y el límite por restaurante frena el abuso antes de abrir credenciales', async () => {
      const big = 'x'.repeat(300_000)
      expect((await fetch(`${base}/v1/webhooks/stripe/tenant-a`, { method: 'POST', body: big, headers: { 'stripe-signature': 't=1,v1=00' } })).status).toBe(413)
      const limited = webhookReceiver(db.webhook, vault, { perMinute: 2, handled: new Set(['webhook.stripe']) })
      const small = apiServer(db.app, async () => token('owner-a'), () => undefined, { routes: [({ req, res, path }) => limited(req, res, path)] })
      await new Promise<void>(resolve => small.listen(0, '127.0.0.1', resolve))
      try {
        const url = `http://127.0.0.1:${(small.address() as { port: number }).port}/v1/webhooks/stripe/tenant-a`
        const statuses = []
        for (let i = 0; i < 4; i++) statuses.push((await fetch(url, { method: 'POST', body: '{}', headers: { 'stripe-signature': 'x' } })).status)
        expect(statuses).toEqual([401, 401, 429, 429])
      } finally { small.closeAllConnections(); await new Promise<void>(resolve => small.close(() => resolve())) }
    })
  })

  it('RetryLater con espera propia y mantenimiento de colas', async () => {
    const rid = 'tenant-a', id = randomUUID()
    await withIdentity(db.app, token('owner-a'), rid, client => enqueueOutbox(client, { id, restaurantId: rid, kind: 'prueba.espera', payload: {} }))
    await makeWorker([['prueba.espera', async () => { throw new RetryLater(900) }]]).runOnce()
    const row = (await db.admin.query("SELECT status,extract(epoch FROM available_at-now()) AS wait FROM llenamos.outbox WHERE id=$1", [id])).rows[0]
    expect(row.status).toBe('pending'); expect(Number(row.wait)).toBeGreaterThan(800)
    await db.admin.query("UPDATE llenamos.outbox SET status='done',finished_at=now()-interval '40 days' WHERE kind='prueba.cola'")
    const purged = await db.worker.query("SELECT llenamos.worker_purge_queues('30 days'::interval,1000) AS n")
    expect(purged.rows[0].n).toBeGreaterThanOrEqual(40)
    expect(stableUuid('a', 'b')).toBe(stableUuid('a', 'b'))
  })
})
