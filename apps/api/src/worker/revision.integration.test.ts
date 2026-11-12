import { createHmac, randomUUID } from 'node:crypto'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { checkWebhookRole, checkRuntimeRole, withIdentity } from '../database.js'
import { fileStore } from '../files/storage.js'
import { fileRoutes } from '../files/routes.js'
import { privacyRoutes } from '../privacy/routes.js'
import { enqueueOutbox } from '../outbox.js'
import { enqueueJob } from '../jobs.js'
import type { ModuleDefinition } from '../modules/types.js'
import { privacyModule } from '../modules/privacidad/index.js'
import { integrationVault, webhookSubset, WEBHOOK_PROVIDERS } from '../platform/integrations.js'
import { apiServer } from '../server.js'
import { webhookReceiver } from '../webhooks/receiver.js'
import { buildHandlers, createWorker, enqueueMessage, type WorkerHandler } from './index.js'
import { claim } from './queue.js'
import { testDatabase } from './harness.js'

const enabled = process.env.TEST_POSTGRES_API === '1' && !!process.env.TEST_POSTGRES_URL
const key = Buffer.alloc(32, 9), vault = integrationVault(key)
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 1)])

describe.skipIf(!enabled)('Revisión V2: separación de credenciales, cola, privacidad y restauración', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>, token: (uid: string) => import('../auth.js').IdentityToken
  let root: string, store: ReturnType<typeof fileStore>
  const sent: Array<{ url: string }> = []
  const fetchStub = (async (url: string | URL | Request) => { sent.push({ url: String(url) }); return new Response(JSON.stringify({ id: `re_${randomUUID()}` }), { status: 200 }) }) as unknown as typeof fetch
  const mk = (extra: { handlers?: ReadonlyArray<readonly [string, WorkerHandler]>; modules?: ModuleDefinition[]; open?: (rid: string, c: string | null) => any; lease?: number; timeout?: number } = {}) => createWorker({
    pool: db.worker, fetch: fetchStub, log: () => undefined, leaseSeconds: extra.lease, handlerTimeoutMs: extra.timeout,
    openCredentials: extra.open ?? ((rid, cipher) => vault.open(rid, cipher)),
    handlers: buildHandlers([{ name: 'prueba', operations: [], workerHandlers: extra.handlers ?? [] }, ...(extra.modules ?? [])], { files: store, privacyKey: key }),
  })
  const seedCredentials = async (rid: string, value: object) => {
    await db.admin.query('INSERT INTO llenamos.integration_secrets(restaurant_id,ciphertext) VALUES($1,$2) ON CONFLICT(restaurant_id) DO UPDATE SET ciphertext=EXCLUDED.ciphertext', [rid, vault.seal(rid, value)])
    for (const provider of WEBHOOK_PROVIDERS) {
      const sealed = vault.sealWebhook(rid, provider, webhookSubset(value, provider))
      if (sealed) await db.admin.query('INSERT INTO llenamos.integration_webhook_secrets(restaurant_id,provider,ciphertext) VALUES($1,$2,$3) ON CONFLICT(restaurant_id,provider) DO UPDATE SET ciphertext=EXCLUDED.ciphertext', [rid, provider, sealed])
    }
  }
  const emailMessage = () => ({ channel: 'email', to: 'cliente@example.test', template: 'confirmation', language: 'es', data: { guestName: 'Ana', restaurantName: 'Casa', reference: 'ABC123', startAt: Date.now() + 86_400_000, timezone: 'Europe/Madrid', partySize: 2, manageUrl: 'https://example.test/r/1' }, reservationId: 'res1', waitlistId: null, sendAt: Date.now() - 1000 })
  const queue = (rid: string, uid: string, id: string = randomUUID(), request: unknown = emailMessage()) => withIdentity(db.app, token(uid), rid, c => enqueueMessage(c, rid, id, request)).then(() => id)
  const row = async (id: string) => (await db.admin.query('SELECT status,attempts,last_error FROM llenamos.outbox WHERE id=$1', [id])).rows[0]
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

  beforeAll(async () => {
    db = await testDatabase('revision')
    token = await db.seed(['tenant-a', 'tenant-b'], [['tenant-a', 'owner-a', 'owner'], ['tenant-a', 'manager-loc', 'manager'], ['tenant-b', 'owner-b', 'owner'], ['tenant-a', 'operator', 'owner']])
    await db.admin.query("UPDATE llenamos.memberships SET location_ids=ARRAY['loc1'] WHERE uid='manager-loc'")
    root = await mkdtemp(path.join(os.tmpdir(), 'llenamos-rev-')); store = fileStore(root)
    await seedCredentials('tenant-a', { email: { apiKey: 'key-a', from: 'a@example.test' }, whatsapp: { token: 't', phoneNumberId: '111', appSecret: 'shared-meta-secret', verifyToken: 'v-a' }, stripe: { secretKey: 'sk', webhookSecret: 'whsec_a' } })
    await seedCredentials('tenant-b', { whatsapp: { token: 't', phoneNumberId: '222', appSecret: 'shared-meta-secret', verifyToken: 'v-b' }, stripe: { secretKey: 'sk', webhookSecret: 'whsec_b' } })
  }, 60_000)
  afterAll(async () => { await db?.close(); await rm(root, { recursive: true, force: true }) })

  describe('1. la API no abre credenciales ajenas ni anota eventos', () => {
    it('el rol de la API no puede ejecutar las funciones de credenciales, firma ni anotación', async () => {
      for (const sql of ["SELECT llenamos.worker_integration_ciphertext('tenant-a')", "SELECT llenamos.webhook_signing_secret('tenant-a','stripe')",
        "SELECT llenamos.webhook_accept('tenant-a','stripe','evt_x',gen_random_uuid(),'webhook.stripe','{}')"])
        await expect(db.app.query(sql), sql).rejects.toMatchObject({ code: '42501' })
      await expect(db.app.query('SELECT * FROM llenamos.integration_secrets')).rejects.toMatchObject({ code: '42501' })
      await expect(db.app.query('SELECT * FROM llenamos.integration_webhook_secrets')).rejects.toMatchObject({ code: '42501' })
      expect(Number((await db.admin.query("SELECT count(*) AS n FROM llenamos.webhook_events WHERE event_id='evt_x'")).rows[0].n)).toBe(0)
    })
    it('el receptor tiene login propio: solo ve secretos de firma y puede anotar, nada más', async () => {
      await expect(checkWebhookRole(db.webhook)).resolves.toBeUndefined()
      await expect(checkWebhookRole(db.app)).rejects.toThrow()
      await expect(checkWebhookRole(db.worker)).rejects.toThrow()
      await expect(checkRuntimeRole(db.webhook)).rejects.toThrow()
      const signing = (await db.webhook.query("SELECT llenamos.webhook_signing_secret('tenant-a','stripe') AS c")).rows[0].c as string
      expect(vault.openWebhook('tenant-a', 'stripe', signing)).toEqual({ webhookSecret: 'whsec_a' })
      expect(JSON.stringify(vault.openWebhook('tenant-a', 'stripe', signing))).not.toContain('sk') // la clave API no está ahí
      expect(() => vault.openWebhook('tenant-b', 'stripe', signing)).toThrow() // AAD por restaurante
      expect(() => vault.openWebhook('tenant-a', 'whatsapp', signing)).toThrow() // AAD por proveedor
      for (const sql of ["SELECT llenamos.worker_integration_ciphertext('tenant-a')", "SELECT llenamos.worker_claim_outbox(1,60,3)", 'SELECT * FROM llenamos.integration_secrets', 'SELECT * FROM llenamos.outbox', 'SELECT * FROM llenamos.integration_webhook_secrets'])
        await expect(db.webhook.query(sql), sql).rejects.toMatchObject({ code: '42501' })
      // el nombre del evento y el tipo deben cuadrar con el proveedor
      await expect(db.webhook.query("SELECT llenamos.webhook_accept('tenant-a','stripe','evt_y',gen_random_uuid(),'webhook.whatsapp','{}')")).rejects.toThrow()
    })
    it('el worker no usa los secretos de firma separados desde la API; guardar APIs los refresca por proveedor', async () => {
      await db.admin.query("INSERT INTO llenamos.platform_restaurants(restaurant_id,name,slug,plan_id,owner_email) VALUES('tenant-a','A','tenant-a','sala','a@example.test') ON CONFLICT DO NOTHING")
      await db.admin.query("UPDATE llenamos.identities SET platform_operator=true WHERE uid='operator'")
      const sealed = vault.sealWebhook('tenant-a', 'stripe', { webhookSecret: 'whsec_nuevo' })
      await withIdentity(db.app, token('operator'), null, c => c.query("SELECT llenamos.platform_webhook_secrets('tenant-a','stripe',$1)", [sealed]))
      const stored = (await db.webhook.query("SELECT llenamos.webhook_signing_secret('tenant-a','stripe') AS c")).rows[0].c
      expect(vault.openWebhook('tenant-a', 'stripe', stored)).toEqual({ webhookSecret: 'whsec_nuevo' })
      await withIdentity(db.app, token('operator'), null, c => c.query("SELECT llenamos.platform_webhook_secrets('tenant-a','stripe',NULL)"))
      expect((await db.webhook.query("SELECT llenamos.webhook_signing_secret('tenant-a','stripe') AS c")).rows[0].c).toBeNull()
      await expect(withIdentity(db.app, token('owner-a'), 'tenant-a', c => c.query("SELECT llenamos.platform_webhook_secrets('tenant-a','stripe',$1)", [sealed]))).rejects.toThrow() // solo plataforma
      await db.admin.query("UPDATE llenamos.identities SET platform_operator=false WHERE uid='operator'")
      await seedCredentials('tenant-a', { email: { apiKey: 'key-a', from: 'a@example.test' }, whatsapp: { token: 't', phoneNumberId: '111', appSecret: 'shared-meta-secret', verifyToken: 'v-a' }, stripe: { secretKey: 'sk', webhookSecret: 'whsec_a' } })
    })
  })

  describe('2. procesarMensajesPendientes no adelanta avisos futuros', () => {
    it('solo cuenta lo vencido y deja intacta la hora de los programados', async () => {
      const future = await queue('tenant-a', 'owner-a', randomUUID(), { ...emailMessage(), sendAt: Date.now() + 86_400_000 })
      const due = await queue('tenant-a', 'owner-a', randomUUID(), emailMessage())
      const before = (await db.admin.query('SELECT available_at FROM llenamos.outbox WHERE id=$1', [future])).rows[0].available_at
      const server = apiServer(db.app, async value => token(value), () => undefined)
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      try {
        const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1/operations/procesarMensajesPendientes`, { method: 'POST', headers: { Authorization: 'Bearer owner-a', 'Content-Type': 'application/json' }, body: JSON.stringify({ data: { restaurantId: 'tenant-a' } }) })
        expect(response.status).toBe(200)
        expect((await response.json() as any).result.processed).toBeGreaterThanOrEqual(1)
        expect((await db.admin.query('SELECT available_at FROM llenamos.outbox WHERE id=$1', [future])).rows[0].available_at).toEqual(before)
        expect((await row(future)).status).toBe('pending')
        const other = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1/operations/procesarMensajesPendientes`, { method: 'POST', headers: { Authorization: 'Bearer owner-b', 'Content-Type': 'application/json' }, body: JSON.stringify({ data: { restaurantId: 'tenant-a' } }) })
        expect(other.status).toBe(403)
      } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
      await mk().runOnce(8)
      expect((await row(future)).status).toBe('pending') // el worker tampoco lo toca hasta su hora
      expect((await row(due)).status).toBe('done')
      await db.admin.query("DELETE FROM llenamos.outbox WHERE id=$1", [future])
    })
  })

  describe('5. cola: lease, tiempo agotado y reparto', () => {
    it('un manejador largo conserva su lease con latidos: nadie más lo reclama ni se duplica', async () => {
      const id = randomUUID()
      await withIdentity(db.app, token('owner-a'), 'tenant-a', c => enqueueOutbox(c, { id, restaurantId: 'tenant-a', kind: 'prueba.larga', payload: {} }))
      const runs = vi.fn(async () => { await sleep(7500) })
      const running = mk({ handlers: [['prueba.larga', runs]], lease: 5 }).runOnce()
      await sleep(6200) // más que el lease original: sin renovar ya estaría vencido
      expect(await claim(db.worker, 'outbox', 5, 5)).toEqual([])
      await running
      expect(runs).toHaveBeenCalledTimes(1)
      expect((await row(id)).status).toBe('done')
    }, 20_000)
    it('al agotarse el tiempo se aborta la señal y no se libera hasta que el manejador termina de verdad', async () => {
      const id = randomUUID()
      await withIdentity(db.app, token('owner-a'), 'tenant-a', c => enqueueOutbox(c, { id, restaurantId: 'tenant-a', kind: 'prueba.timeout', payload: {} }))
      let settled = false, statusWhileRunning = ''
      const handler: WorkerHandler = async ctx => {
        await new Promise<void>(resolve => ctx.signal.addEventListener('abort', () => resolve(), { once: true }))
        await sleep(300)
        statusWhileRunning = (await row(id)).status
        settled = true
      }
      await mk({ handlers: [['prueba.timeout', handler]], timeout: 300 }).runOnce()
      expect(settled).toBe(true)
      expect(statusWhileRunning).toBe('leased') // seguía reservado mientras trabajaba
      expect(await row(id)).toMatchObject({ status: 'pending', attempts: 1, last_error: 'timeout' })
      await db.admin.query('DELETE FROM llenamos.outbox WHERE id=$1', [id])
    })
    it('si el lease se pierde antes del efecto externo, no se envía', async () => {
      sent.length = 0
      const id = await queue('tenant-a', 'owner-a')
      // el lease cambia de manos justo cuando se abren las credenciales, antes del envío
      const pool = new Proxy(db.worker, { get(target, property) {
        const value = Reflect.get(target, property) as unknown
        if (property === 'query') return async (...args: unknown[]) => {
          if (String(args[0]).includes('worker_integration_ciphertext')) await db.admin.query('UPDATE llenamos.outbox SET lease_id=gen_random_uuid() WHERE id=$1', [id])
          return (target.query as (...a: unknown[]) => unknown)(...args)
        }
        return typeof value === 'function' ? value.bind(target) : value
      } })
      const tampering = createWorker({ pool, fetch: fetchStub, log: () => undefined, openCredentials: (rid, cipher) => vault.open(rid, cipher), handlers: buildHandlers([]) })
      await tampering.runOnce()
      expect(sent).toHaveLength(0)
      expect((await row(id)).status).toBe('leased') // el dueño nuevo del lease sigue siendo otro
      await db.admin.query('DELETE FROM llenamos.outbox WHERE id=$1', [id])
    })
    it('una pasada nunca reclama más elementos que carriles', async () => {
      const ids = Array.from({ length: 10 }, () => randomUUID())
      await withIdentity(db.app, token('owner-a'), 'tenant-a', async c => { for (const id of ids) await enqueueOutbox(c, { id, restaurantId: 'tenant-a', kind: 'prueba.carril', payload: {} }) })
      const done = vi.fn(async () => undefined)
      expect(await mk({ handlers: [['prueba.carril', done]] }).runOnce(2)).toBe(2)
      expect(Number((await db.admin.query("SELECT count(*) AS n FROM llenamos.outbox WHERE kind='prueba.carril' AND status='pending'")).rows[0].n)).toBe(8)
      await db.admin.query("DELETE FROM llenamos.outbox WHERE kind='prueba.carril'")
    })
    it('el reparto es justo entre restaurantes: un restaurante con mucha cola no deja sin turno a otro', async () => {
      await db.admin.query("INSERT INTO llenamos.outbox(id,restaurant_id,kind,payload,available_at) SELECT gen_random_uuid(),'tenant-a','prueba.justo','{}',now()-interval '1 hour'+ (g||' seconds')::interval FROM generate_series(1,30) g")
      await db.admin.query("INSERT INTO llenamos.outbox(id,restaurant_id,kind,payload,available_at) VALUES(gen_random_uuid(),'tenant-b','prueba.justo','{}',now()-interval '1 minute')")
      const first = await claim(db.worker, 'outbox', 4)
      expect(first.map(c => c.item.restaurantId)).toContain('tenant-b')
      await db.admin.query("DELETE FROM llenamos.outbox WHERE kind='prueba.justo'")
    })
    it('esperar un manejador que aún no existe no gasta intentos y el elemento no se pierde', async () => {
      const id = randomUUID()
      await withIdentity(db.app, token('owner-a'), 'tenant-a', c => enqueueOutbox(c, { id, restaurantId: 'tenant-a', kind: 'prueba.huerfano', payload: {} }))
      for (let i = 0; i < 12; i++) { await mk().runOnce(); await db.admin.query('UPDATE llenamos.outbox SET available_at=now() WHERE id=$1', [id]) }
      expect(await row(id)).toMatchObject({ status: 'pending', attempts: 0, last_error: 'sin-manejador' })
      const handled = vi.fn(async () => undefined)
      await mk({ handlers: [['prueba.huerfano', handled]] }).runOnce()
      expect(handled).toHaveBeenCalledTimes(1)
      expect((await row(id)).status).toBe('done')
    })
    it('el latido del worker se emite al sondear la cola', async () => {
      const worker = mk(), beat = vi.fn()
      worker.onBeat(beat)
      const running = worker.start({ pollMs: 50, concurrency: 1 })
      await sleep(300)
      await running.stop()
      expect(beat).toHaveBeenCalled()
    })
  })

  describe('6 y 9. webhooks de WhatsApp y Stripe', () => {
    let server: ReturnType<typeof apiServer>, base: string
    const handled = new Set(['webhook.whatsapp'])
    const sign = (body: string, secret = 'shared-meta-secret') => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
    const wa = (rid: string, phone: string, id: string, extra: { ts?: number; from?: string; text?: string } = {}) => {
      const body = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: phone }, messages: [{ id, from: extra.from ?? '34600111222', timestamp: String(Math.floor((extra.ts ?? Date.now()) / 1000)), text: { body: extra.text ?? 'hola' } }] } }] }] })
      return fetch(`${base}/v1/webhooks/whatsapp/${rid}`, { method: 'POST', body, headers: { 'x-hub-signature-256': sign(body) } }).then(r => r.status)
    }
    const stripeSign = (body: string, secret: string, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`
    beforeAll(async () => {
      const full = webhookReceiver(db.webhook, vault, { handled }) // al principio, sin manejador de Stripe
      server = apiServer(db.app, async () => token('owner-a'), () => undefined, { routes: [({ req, res, path }) => full(req, res, path)] })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    })
    afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })

    it('una app de Meta compartida: un cuerpo firmado para el número de A no se procesa en B', async () => {
      expect(await wa('tenant-b', '111', 'wamid.cross1')).toBe(403)
      expect(await wa('tenant-a', '222', 'wamid.cross2')).toBe(403)
      expect(Number((await db.admin.query("SELECT count(*) AS n FROM llenamos.webhook_events WHERE event_id IN ('wamid.cross1','wamid.cross2')")).rows[0].n)).toBe(0)
      expect(await wa('tenant-b', '222', 'wamid.ok-b')).toBe(200)
      expect((await db.admin.query("SELECT restaurant_id FROM llenamos.webhook_events WHERE event_id='wamid.ok-b'")).rows).toEqual([{ restaurant_id: 'tenant-b' }])
    })
    it('rechaza mensajes fuera de la ventana de tiempo (repetición tardía o fecha futura)', async () => {
      expect(await wa('tenant-a', '111', 'wamid.old', { ts: Date.now() - 8 * 86_400_000 })).toBe(400)
      expect(await wa('tenant-a', '111', 'wamid.future', { ts: Date.now() + 3_600_000 })).toBe(400)
      expect(await wa('tenant-a', '111', 'wamid.recent', { ts: Date.now() - 3 * 86_400_000 })).toBe(200)
    })
    it('firmas intercambiadas entre dos restaurantes con secretos distintos se rechazan', async () => {
      const body = JSON.stringify({ id: 'evt_swap', type: 'x', data: { object: {} } })
      const post = (rid: string, secret: string) => fetch(`${base}/v1/webhooks/stripe/${rid}`, { method: 'POST', body, headers: { 'stripe-signature': stripeSign(body, secret) } }).then(r => r.status)
      handled.add('webhook.stripe')
      try {
        expect(await post('tenant-b', 'whsec_a')).toBe(401)
        expect(await post('tenant-a', 'whsec_b')).toBe(401)
        expect(await post('tenant-a', 'whsec_a')).toBe(200) // control: la propia firma sí vale
      } finally { handled.delete('webhook.stripe') }
    })
    it('Stripe sin manejador registrado responde 503 y no anota el evento (el proveedor reintentará)', async () => {
      const body = JSON.stringify({ id: 'evt_sinmanejador', type: 'checkout.session.completed', data: { object: { id: 'cs' } } })
      const response = await fetch(`${base}/v1/webhooks/stripe/tenant-a`, { method: 'POST', body, headers: { 'stripe-signature': stripeSign(body, 'whsec_a') } })
      expect(response.status).toBe(503)
      expect(Number((await db.admin.query("SELECT count(*) AS n FROM llenamos.webhook_events WHERE event_id='evt_sinmanejador'")).rows[0].n)).toBe(0)
    })
    it('la baja por WhatsApp se cumple siempre; confirmar o cancelar sin manejador de reservas espera sin perderse', async () => {
      // un marketing en cola hacia ese teléfono
      const queued = randomUUID()
      await db.admin.query("INSERT INTO llenamos.outbox(id,restaurant_id,kind,payload,available_at) VALUES($1,'tenant-a','mensaje.enviar',$2,now()+interval '1 hour')", [queued, { channel: 'whatsapp', to: '+34600777888', purpose: 'marketing_whatsapp', customerId: 'cus9' }])
      expect(await wa('tenant-a', '111', 'wamid.stop1', { from: '34600777888', text: 'BAJA' })).toBe(200)
      const confirmed = randomUUID()
      await db.admin.query("INSERT INTO llenamos.message_deliveries(id,restaurant_id,channel,template,recipient,status,provider_message_id) VALUES($1,'tenant-a','whatsapp','confirmation','+34600111222','sent','wamid.sent9')", [confirmed])
      const body = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: '111' }, messages: [{ id: 'wamid.conf1', from: '34600111222', timestamp: String(Math.floor(Date.now() / 1000)), interactive: { button_reply: { id: `${confirmed}:confirm` } } }] } }] }] })
      expect((await fetch(`${base}/v1/webhooks/whatsapp/tenant-a`, { method: 'POST', body, headers: { 'x-hub-signature-256': sign(body) } })).status).toBe(200)
      const worker = mk()
      for (let i = 0; i < 4; i++) await worker.runOnce(8)
      expect((await db.admin.query("SELECT 1 FROM llenamos.message_optouts WHERE restaurant_id='tenant-a' AND recipient='+34600777888'")).rows).toHaveLength(1)
      expect(await row(queued)).toMatchObject({ status: 'failed', last_error: 'baja' })
      const reply = (await db.admin.query("SELECT status,attempts,last_error FROM llenamos.outbox WHERE kind='mensaje.respuesta' AND payload->>'action'='confirmed'")).rows[0]
      expect(reply).toMatchObject({ status: 'pending', attempts: 0 })
      // el marketing posterior a ese teléfono ya no sale
      sent.length = 0
      const later = await queue('tenant-a', 'owner-a', randomUUID(), { ...emailMessage(), channel: 'whatsapp', to: '+34600777888', purpose: 'marketing_whatsapp', customerId: 'cus9', template: 'marketing_campaign' })
      await mk({ modules: [{ name: 'clientes', operations: [], marketingConsent: async () => true }] }).runOnce(8)
      expect(sent).toHaveLength(0)
      expect((await db.admin.query('SELECT status,last_error FROM llenamos.message_deliveries WHERE id=$1', [later])).rows[0]).toEqual({ status: 'cancelled', last_error: 'baja' })
    })
    it('el límite global del proveedor no se esquiva cambiando el ID de restaurante', async () => {
      const limited = webhookReceiver(db.webhook, vault, { perMinute: 100, globalPerMinute: 3, handled: new Set(['webhook.stripe']) })
      const small = apiServer(db.app, async () => token('owner-a'), () => undefined, { routes: [({ req, res, path }) => limited(req, res, path)] })
      await new Promise<void>(resolve => small.listen(0, '127.0.0.1', resolve))
      try {
        const port = (small.address() as { port: number }).port, codes = []
        for (let i = 0; i < 5; i++) codes.push((await fetch(`http://127.0.0.1:${port}/v1/webhooks/stripe/inventado-${i}`, { method: 'POST', body: '{}', headers: { 'stripe-signature': 'x' } })).status)
        expect(codes).toEqual([401, 401, 401, 429, 429])
      } finally { small.closeAllConnections(); await new Promise<void>(resolve => small.close(() => resolve())) }
    })
  })

  describe('7, 8 y menores: privacidad, ubicaciones y archivos', () => {
    let server: ReturnType<typeof apiServer>, base: string, registry: ModuleDefinition[] = [], original: ModuleDefinition[] = []
    const customers = new Map([['cus1', 'Ana'], ['cus2', 'Luis']])
    const covered: ModuleDefinition = { name: 'clientes', operations: [], personalData: ['customers'],
      privacy: { subjectExists: async (_c, _r, s) => customers.has(s), exportData: async (_c, _r, s) => ({ clientes: [{ nombre: customers.get(s) ?? null }] }), erase: async (_c, _r, s) => (customers.delete(s) ? 1 : 0) } }
    const call = (name: string, user: string, data: unknown) => fetch(`${base}/v1/operations/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${user}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) })
    let seq = 0
    const cmd = (p: string) => `rev_${p}_${++seq}`.padEnd(24, '0')
    const evidence = (id: string, subject: string) => db.admin.query("INSERT INTO llenamos.privacy_evidence(id,restaurant_id,subject_id,method,expires_at,recorded_by) VALUES($1,'tenant-a',$2,'in_person',now()+interval '1 day','owner-a')", [id, subject])
    beforeAll(async () => {
      const { MODULES } = await import('../modules/index.js')
      registry = MODULES as ModuleDefinition[]; original = [...registry]
      registry.splice(0, registry.length, ...original.filter(m => m.name !== 'privacidad'), privacyModule(() => [covered, ...extraModules]))
      process.env.PUBLIC_APP_URL = 'https://app.example.test'
      server = apiServer(db.app, async value => token(value), () => undefined, { routes: [fileRoutes(store), privacyRoutes(store, key)] })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    })
    afterAll(async () => { registry.splice(0, registry.length, ...original); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
    const extraModules: ModuleDefinition[] = []

    it('un módulo con datos personales y sin adaptador bloquea exportaciones y borrados en vez de completarlos', async () => {
      const uncovered: ModuleDefinition = { name: 'fidelizacion', operations: [], personalData: ['loyalty_cards'] }
      for (const kind of ['export', 'erase'] as const) {
        const requested = await (await call('solicitarPrivacidad', 'owner-a', { restaurantId: 'tenant-a', requestId: cmd('inc'), customerId: 'cus1', kind, reason: 'Petición' })).json() as any
        const evId = `ev-inc-${kind}`
        await evidence(evId, 'cus1')
        expect((await call('verificarSolicitudPrivacidad', 'owner-a', { restaurantId: 'tenant-a', requestId: cmd('ver'), jobId: requested.result.jobId, evidenceId: evId })).status).toBe(200)
        await mk({ modules: [covered, uncovered] }).runOnce(8)
        expect((await db.admin.query('SELECT status,error FROM llenamos.privacy_requests WHERE id::text=$1', [requested.result.jobId])).rows[0]).toEqual({ status: 'blocked', error: 'Faltan adaptadores de privacidad en: fidelizacion.' })
      }
      expect(customers.has('cus1')).toBe(true) // no se tocó nada
    })
    it('quien tiene el permiso pero está limitado a locales no puede pedir, verificar, listar ni descargar', async () => {
      const input = { restaurantId: 'tenant-a', requestId: cmd('loc'), customerId: 'cus2', kind: 'export', reason: 'Petición' }
      expect((await call('solicitarPrivacidad', 'manager-loc', input)).status).toBe(403)
      expect((await call('listarSolicitudesPrivacidad', 'manager-loc', { restaurantId: 'tenant-a' })).status).toBe(403)
      expect((await call('verificarSolicitudPrivacidad', 'manager-loc', { restaurantId: 'tenant-a', requestId: cmd('l2'), jobId: randomUUID(), evidenceId: 'x' })).status).toBe(403)
      expect((await call('descargarExportacionPrivacidad', 'manager-loc', { restaurantId: 'tenant-a', jobId: randomUUID() })).status).toBe(403)
      await db.admin.query("UPDATE llenamos.memberships SET location_ids='{}' WHERE uid='manager-loc'")
      expect((await call('solicitarPrivacidad', 'manager-loc', input)).status).toBe(200) // sin restricción, sí
      await db.admin.query("UPDATE llenamos.memberships SET location_ids=ARRAY['loc1'] WHERE uid='manager-loc'")
    })
    it('la ruta de descarga también exige todos los locales y un fallo al descifrar no quema el ticket', async () => {
      const requested = await (await call('solicitarPrivacidad', 'owner-a', { restaurantId: 'tenant-a', requestId: cmd('dl'), customerId: 'cus2', kind: 'export', reason: 'Petición' })).json() as any
      await evidence('ev-dl', 'cus2')
      await call('verificarSolicitudPrivacidad', 'owner-a', { restaurantId: 'tenant-a', requestId: cmd('v'), jobId: requested.result.jobId, evidenceId: 'ev-dl' })
      await mk({ modules: [covered] }).runOnce(8)
      const link = (await (await call('descargarExportacionPrivacidad', 'owner-a', { restaurantId: 'tenant-a', jobId: requested.result.jobId })).json() as any).result.url.replace('https://app.example.test/api', base) as string
      expect((await fetch(link, { headers: { Authorization: 'Bearer manager-loc' } })).status).toBe(403)
      const fileId = (await db.admin.query('SELECT artifact_file_id AS id FROM llenamos.privacy_requests WHERE id::text=$1', [requested.result.jobId])).rows[0].id as string
      const original = store.locate('tenant-a', fileId)
      const { readFile, rename } = await import('node:fs/promises')
      await rename(original, `${original}.bak`)
      expect((await fetch(link, { headers: { Authorization: 'Bearer owner-a' } })).status).toBe(404) // bytes ausentes
      expect((await db.admin.query('SELECT used FROM llenamos.privacy_downloads ORDER BY expires_at DESC LIMIT 1')).rows[0].used).toBe(false)
      await rename(`${original}.bak`, original)
      expect((await fetch(link, { headers: { Authorization: 'Bearer owner-a' } })).status).toBe(200) // el mismo ticket aún vale
      expect((await fetch(link, { headers: { Authorization: 'Bearer owner-a' } })).status).toBe(403)
      void readFile
    })
    it('la foto pública solo existe para carta_foto con servicio vigente; un archivo activo no se borra por un trabajo mal formado', async () => {
      const put = (purpose: string, type: string, body: Buffer) => fetch(`${base}/v1/restaurants/tenant-a/files?purpose=${purpose}`, { method: 'PUT', headers: { Authorization: 'Bearer owner-a', 'Content-Type': type }, body: new Uint8Array(body) })
      const photo = (await (await put('carta_foto', 'image/jpeg', jpeg)).json() as any).result.id as string
      expect((await fetch(`${base}/v1/public/files/tenant-a/${photo}`)).status).toBe(200)
      // el propósito se decide en SQL: cambiarlo a documento lo oculta aunque el código lo permitiera
      await db.admin.query("UPDATE llenamos.files SET purpose='documento' WHERE id=$1", [photo])
      expect((await fetch(`${base}/v1/public/files/tenant-a/${photo}`)).status).toBe(404)
      await db.admin.query("UPDATE llenamos.files SET purpose='carta_foto' WHERE id=$1", [photo])
      await db.admin.query("UPDATE llenamos.restaurants SET entitlement_version=1,access_valid_until=now()-interval '1 hour' WHERE id='tenant-a'")
      expect((await fetch(`${base}/v1/public/files/tenant-a/${photo}`)).status).toBe(404) // servicio vencido
      await db.admin.query("UPDATE llenamos.restaurants SET entitlement_version=NULL,access_valid_until=NULL WHERE id='tenant-a'")
      expect((await fetch(`${base}/v1/public/files/tenant-a/${photo}`)).status).toBe(200)
      // trabajo `archivo.borrar` hacia un archivo activo: falla sin tocar los bytes
      const jobId = randomUUID()
      await withIdentity(db.app, token('owner-a'), 'tenant-a', c => enqueueJob(c, { id: jobId, restaurantId: 'tenant-a', kind: 'archivo.borrar', deduplicationKey: `mal-${photo}`, payload: { fileId: photo } }))
      await mk().runOnce(8)
      expect((await db.admin.query('SELECT status,last_error FROM llenamos.jobs WHERE id=$1', [jobId])).rows[0]).toEqual({ status: 'failed', last_error: 'archivo-activo' })
      expect(existsSync(store.locate('tenant-a', photo))).toBe(true)
      expect(await readdir(path.join(root, '.tmp'))).toEqual([])
    })
  })

  describe('4. restauración: borrados posteriores a la copia', () => {
    it('reaplica el borrado de una persona con huella posterior y el worker lo completa; no repite lo ya borrado', async () => {
      let erased = 0
      const modules: ModuleDefinition[] = [{ name: 'clientes', operations: [], personalData: ['customers'], privacy: { exportData: async () => ({}), erase: async () => { erased++; return 1 } } }]
      expect((await db.admin.query("SELECT llenamos.restore_reapply_erasure('tenant-a','cus-restaurado') AS ok")).rows[0].ok).toBe(true)
      expect((await db.admin.query("SELECT llenamos.restore_reapply_erasure('tenant-a','cus-restaurado') AS ok")).rows[0].ok).toBe(true) // idempotente: no duplica
      expect((await db.admin.query("SELECT llenamos.restore_reapply_erasure('no-existe','x') AS ok")).rows[0].ok).toBe(false)
      expect(Number((await db.admin.query("SELECT count(*) AS n FROM llenamos.privacy_requests WHERE subject_id='cus-restaurado'")).rows[0].n)).toBe(1)
      await mk({ modules }).runOnce(8)
      expect(erased).toBe(1)
      expect((await db.admin.query("SELECT status FROM llenamos.privacy_requests WHERE subject_id='cus-restaurado'")).rows[0].status).toBe('completed')
      expect((await db.admin.query("SELECT 1 FROM llenamos.privacy_tombstones WHERE restaurant_id='tenant-a'")).rows.length).toBeGreaterThan(0)
      expect((await db.admin.query("SELECT llenamos.restore_reapply_erasure('tenant-a','cus-restaurado') AS ok")).rows[0].ok).toBe(false) // ya completado
      await expect(db.app.query("SELECT llenamos.restore_reapply_erasure('tenant-a','x')")).rejects.toMatchObject({ code: '42501' })
    })
  })
})
