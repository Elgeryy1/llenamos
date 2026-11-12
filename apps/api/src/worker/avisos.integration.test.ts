import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as core from '@llenamos/core'
import { integrationVault } from '../platform/integrations.js'
import { withIdentity } from '../database.js'
import { MODULES } from '../modules/index.js'
import { seal } from '../modules/sala/secrets.js'
import { stableUuid } from '../ids.js'
import { enqueueOutbox } from '../outbox.js'
import { withTenant } from './tenant.js'
import { queueMessage, stableId } from '../modules/reservas/notices.js'
import { buildHandlers, createWorker, enqueueMessage } from './index.js'
import { testDatabase } from './harness.js'

const enabled = process.env.TEST_POSTGRES_API === '1' && !!process.env.TEST_POSTGRES_URL
const key = Buffer.alloc(32, 9), vault = integrationVault(key)
const lid = 'centro'

describe.skipIf(!enabled)('Avisos aviso.mensaje y aviso.recogida con el worker real sobre PostgreSQL', () => {
  process.env.SALA_SECRET_KEY = 'cd'.repeat(32)
  process.env.PUBLIC_APP_URL = 'https://app.example.test'
  let db: Awaited<ReturnType<typeof testDatabase>>, token: (uid: string) => import('../auth.js').IdentityToken
  const requests: Array<{ url: string; body: any }> = []
  let providerStatus = 200, sequence = 0
  const fetchStub = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init!.body)) })
    if (providerStatus !== 200) return new Response('{}', { status: providerStatus })
    return new Response(JSON.stringify(String(url).includes('resend') ? { id: `re_${++sequence}` } : { messages: [{ id: `wamid.${++sequence}` }] }), { status: 200 })
  }) as unknown as typeof fetch
  // El worker real: createWorker con los manejadores de todos los módulos registrados.
  const worker = () => createWorker({ pool: db.worker, fetch: fetchStub, log: entry => { if (process.env.DEBUG_WORKER) console.log(JSON.stringify(entry)) }, openCredentials: (rid, cipher) => vault.open(rid, cipher), handlers: buildHandlers(MODULES) })
  const drain = async () => { const w = worker(); for (let i = 0; i < 6; i++) if (!await w.runOnce()) break }
  const setCredentials = async (rid: string, value: object | null) => {
    await db.admin.query('DELETE FROM llenamos.integration_secrets WHERE restaurant_id=$1', [rid])
    if (value) await db.admin.query('INSERT INTO llenamos.integration_secrets(restaurant_id,ciphertext) VALUES($1,$2)', [rid, vault.seal(rid, value)])
  }
  const full = { email: { apiKey: 'key-a', from: 'a@example.test' }, whatsapp: { token: 'wa', phoneNumberId: '111', appSecret: 's', verifyToken: 'v', templateTakeawayAccepted: 'recogida_aceptada', templateTakeawayReady: 'recogida_lista' } }

  /** Pedido para llevar con el secreto de seguimiento guardado como lo hace sala. */
  async function takeaway(rid: string, over: Partial<core.Takeaway> = {}, secret: 'ok' | 'otro' | 'ninguno' = 'ok') {
    const id = randomUUID(), tracking = core.linkToken(randomBytes(32))
    const doc: core.Takeaway = { guestName: 'Ana Prueba', phone: '+34600000001', email: 'ana@example.test', language: 'es', customerId: 'a1b2c3d4e5f6a7b8c9d0', pickupAt: Date.now() + 3_600_000, status: 'accepted',
      reference: core.reservationReference(randomBytes(16)), manageTokenHash: core.sha256Hex(tracking), source: 'web', notes: '', totalCents: 1250, orderIds: [], readyAt: null, pickedUpAt: null, cancelReason: null, history: [], createdBy: null, ...over }
    await db.admin.query('INSERT INTO llenamos.sala_takeaways(restaurant_id,location_id,id,doc) VALUES($1,$2,$3,$4)', [rid, lid, id, JSON.stringify(doc)])
    if (secret !== 'ninguno') await db.admin.query("INSERT INTO llenamos.sala_private(restaurant_id,location_id,kind,id,doc) VALUES($1,$2,'takeawaySecrets',$3,$4)", [rid, lid, id, JSON.stringify({ tokenSecret: seal(rid, secret === 'ok' ? tracking : 'otro-token') })])
    return { id, doc, tracking }
  }
  const notice = async (rid: string, takeawayId: string, template: 'takeaway_accepted' | 'takeaway_ready' = 'takeaway_accepted', channel: 'email' | 'whatsapp' = 'email') => {
    const id = stableUuid(`takeaway:${lid}:${takeawayId}:${template}:${channel}:${randomUUID()}`)
    await db.admin.query("INSERT INTO llenamos.outbox(id,restaurant_id,kind,payload) VALUES($1,$2,'aviso.recogida',$3)", [id, rid, JSON.stringify({ locationId: lid, takeawayId, template, channel })])
    return id
  }
  const delivery = async (id: string) => (await db.admin.query('SELECT status,last_error,recipient,provider_message_id FROM llenamos.message_deliveries WHERE id=$1', [id])).rows[0]
  const queue = async (id: string) => (await db.admin.query('SELECT status,last_error,payload FROM llenamos.outbox WHERE id=$1', [id])).rows[0]
  const reservationNotice = (extra: object = {}) => ({ channel: 'email', to: 'cliente@example.test', template: 'confirmation', language: 'es', reservationId: 'res1', waitlistId: null, sendAt: Date.now() - 1000,
    data: { guestName: 'Ana', restaurantName: 'Casa', reference: 'ABC123', startAt: Date.now() + 86_400_000, timezone: 'Europe/Madrid', partySize: 2, manageUrl: 'https://app.example.test/r/casa/reserva/ABC123?t=SECRETO-DE-RESERVA', offerUrl: 'https://app.example.test/o?t=SECRETO-OFERTA' }, ...extra })
  /** `aviso.mensaje` es el tipo real que encolan las reservas (con la misma función); `mensaje.enviar` es el de campañas. */
  const enqueue = async (rid: string, id: string, request: object, kind: 'aviso.mensaje' | 'mensaje.enviar' = 'aviso.mensaje') => {
    if (kind === 'mensaje.enviar') { await withIdentity(db.app, token('owner-a'), rid, client => enqueueMessage(client, rid, id, request)); return id }
    await withIdentity(db.app, token('owner-a'), rid, client => queueMessage(client, rid, request as never, id))
    return stableId(rid, id)
  }

  beforeAll(async () => {
    db = await testDatabase('avisos')
    token = await db.seed(['tenant-a', 'tenant-b'], [['tenant-a', 'owner-a', 'owner'], ['tenant-b', 'owner-b', 'owner']])
    for (const rid of ['tenant-a', 'tenant-b']) await db.admin.query('INSERT INTO llenamos.locations(restaurant_id,id,name,slug,address,phone) VALUES($1,$2,$2,$2,$3,$4)', [rid, lid, 'Calle Mayor 1', '910000000'])
  }, 60_000)
  afterAll(async () => { await db?.close() })
  beforeEach(async () => {
    requests.length = 0; providerStatus = 200; process.env.PUBLIC_APP_URL = 'https://app.example.test'
    await setCredentials('tenant-a', full)
  })

  it('aviso.recogida envía el enlace de seguimiento real con ?t= y los datos del local', async () => {
    const t = await takeaway('tenant-a'), id = await notice('tenant-a', t.id)
    await drain()
    expect(await delivery(id)).toMatchObject({ status: 'sent', recipient: 'ana@example.test' })
    expect(requests).toHaveLength(1)
    const text = requests[0]!.body.text as string
    expect(text).toContain(`https://app.example.test/r/tenant-a/para-llevar/${t.doc.reference}?t=${t.tracking}`)
    expect(text).not.toContain('/recogida/')
    expect(text).toContain('Calle Mayor 1')
    expect(await queue(id)).toMatchObject({ status: 'done' })
  })

  it('por WhatsApp usa la plantilla aprobada, la hora en la zona del local y el mismo enlace', async () => {
    const t = await takeaway('tenant-a', { pickupAt: Date.UTC(2031, 5, 1, 18, 30) }), id = await notice('tenant-a', t.id, 'takeaway_ready', 'whatsapp')
    await db.admin.query("UPDATE llenamos.sala_takeaways SET doc=jsonb_set(doc,'{status}','\"ready\"') WHERE id=$1", [t.id])
    await drain()
    expect(await delivery(id)).toMatchObject({ status: 'sent', recipient: '+34600000001' })
    const parameters = requests[0]!.body.template.components[0].parameters.map((p: any) => p.text)
    expect(requests[0]!.body.template.name).toBe('recogida_lista')
    expect(parameters[3]).toMatch(/1 jun 2031.*20:30/)
    expect(parameters[5]).toBe(`https://app.example.test/r/tenant-a/para-llevar/${t.doc.reference}?t=${t.tracking}`)
  })

  it('sin proveedores termina en not_configured con su código y no envía', async () => {
    await setCredentials('tenant-a', null)
    const t = await takeaway('tenant-a'), id = await notice('tenant-a', t.id)
    await drain()
    expect(await delivery(id)).toMatchObject({ status: 'not_configured', last_error: 'not-configured' })
    expect(await queue(id)).toMatchObject({ status: 'failed', last_error: 'not-configured' })
    expect(requests).toHaveLength(0)
  })

  it('si el secreto no casa con el hash del pedido, o falta, no se envía nada', async () => {
    for (const secret of ['otro', 'ninguno'] as const) {
      const t = await takeaway('tenant-a', {}, secret), id = await notice('tenant-a', t.id)
      await drain()
      expect(await delivery(id)).toMatchObject({ status: 'failed', last_error: 'enlace-no-valido' })
      expect(await queue(id)).toMatchObject({ status: 'failed' })
    }
    expect(requests).toHaveLength(0)
  })

  it('un secreto de otro restaurante no se abre (custodia ligada al restaurante)', async () => {
    const t = await takeaway('tenant-a', {}, 'ninguno'), id = await notice('tenant-a', t.id)
    await db.admin.query("INSERT INTO llenamos.sala_private(restaurant_id,location_id,kind,id,doc) VALUES('tenant-a',$1,'takeawaySecrets',$2,$3)", [lid, t.id, JSON.stringify({ tokenSecret: seal('tenant-b', t.tracking) })])
    await drain()
    expect(await delivery(id)).toMatchObject({ status: 'failed', last_error: 'enlace-no-valido' })
    expect(requests).toHaveLength(0)
  })

  it('sin dirección pública configurada falla con app-url-no-configurada y no usa un dominio inventado', async () => {
    delete process.env.PUBLIC_APP_URL
    const t = await takeaway('tenant-a'), id = await notice('tenant-a', t.id)
    await drain()
    expect(await delivery(id)).toMatchObject({ status: 'failed', last_error: 'app-url-no-configurada' })
    expect(requests).toHaveLength(0)
  })

  it('si el pedido ya no está aceptado o listo, el aviso se cancela', async () => {
    for (const status of ['cancelled', 'picked_up', 'pending'] as const) {
      const t = await takeaway('tenant-a', { status }), id = await notice('tenant-a', t.id)
      await drain()
      expect(await delivery(id)).toMatchObject({ status: 'cancelled', last_error: 'estado-no-vigente' })
    }
    // El aviso de «listo» tampoco sale si el pedido volvió a preparación.
    const back = await takeaway('tenant-a', { status: 'accepted' }), id = await notice('tenant-a', back.id, 'takeaway_ready')
    await drain()
    expect(await delivery(id)).toMatchObject({ status: 'cancelled' })
    expect(requests).toHaveLength(0)
  })

  it('sin destinatario en el canal deja rastro cancelado en message_deliveries', async () => {
    const t = await takeaway('tenant-a', { email: null }), id = await notice('tenant-a', t.id, 'takeaway_accepted', 'email')
    await drain()
    expect(await delivery(id)).toMatchObject({ status: 'cancelled', last_error: 'sin-destinatario', recipient: '' })
    expect(await queue(id)).toMatchObject({ status: 'done' })
    expect(requests).toHaveLength(0)
  })

  it('un pedido inexistente falla con rastro y otro restaurante no ve los pedidos ajenos', async () => {
    const mine = await takeaway('tenant-a')
    const foreign = await notice('tenant-b', mine.id)
    await drain()
    expect(await delivery(foreign)).toMatchObject({ status: 'failed', last_error: 'takeaway-no-encontrado' })
    expect(requests).toHaveLength(0)
  })

  it('un fallo transitorio reintenta con el mismo enlace y no repite el envío ya hecho', async () => {
    const t = await takeaway('tenant-a'), id = await notice('tenant-a', t.id)
    providerStatus = 503
    await drain()
    expect(await queue(id)).toMatchObject({ status: 'pending' })
    expect(await delivery(id)).toBeUndefined()
    providerStatus = 200
    await db.admin.query("UPDATE llenamos.outbox SET available_at=now() WHERE id=$1", [id])
    await drain()
    expect(await delivery(id)).toMatchObject({ status: 'sent' })
    // Entrega repetida tras el envío (lease perdido): no sale otro correo.
    const before = requests.length
    await db.admin.query("UPDATE llenamos.outbox SET status='pending',available_at=now(),lease_id=NULL,lease_until=NULL WHERE id=$1", [id])
    await drain()
    expect(requests.length).toBe(before)
  })

  it('sin la clave de custodia reintenta con espera y, en el último intento, apunta el aviso como fallido', async () => {
    const t = await takeaway('tenant-a'), id = await notice('tenant-a', t.id)
    const saved = process.env.SALA_SECRET_KEY
    delete process.env.SALA_SECRET_KEY
    try {
      await drain()
      expect(await queue(id)).toMatchObject({ status: 'pending', last_error: 'unexpected' }) // reintento, nada definitivo
      expect(await delivery(id)).toBeUndefined()
      await db.admin.query('UPDATE llenamos.outbox SET attempts=7,available_at=now() WHERE id=$1', [id])
      await drain()
    } finally { process.env.SALA_SECRET_KEY = saved }
    expect(await delivery(id)).toMatchObject({ status: 'failed', last_error: 'custodia-no-configurada' })
    expect(await queue(id)).toMatchObject({ status: 'failed' })
    expect(requests).toHaveLength(0)
  })

  it('la cuarentena por lease agotado de un aviso.recogida no pierde el elemento ni lo envía', async () => {
    const t = await takeaway('tenant-a'), id = await notice('tenant-a', t.id)
    await db.admin.query("UPDATE llenamos.outbox SET status='leased',attempts=8,lease_id=gen_random_uuid(),lease_until=now()-interval '1 second' WHERE id=$1", [id])
    await worker().runOnce()
    expect(await queue(id)).toMatchObject({ status: 'quarantined', last_error: 'lease-agotado' })
    expect(requests).toHaveLength(0)
  })

  it('un aviso que necesita su enlace no sale sin él (p. ej. fila ya limpiada y reencolada a mano)', async () => {
    const request = reservationNotice({ template: 'waitlist_offer', reservationId: null, waitlistId: 'wl1' })
    delete (request.data as Record<string, unknown>).offerUrl
    const id = await enqueue('tenant-a', randomUUID(), request)
    await drain()
    expect(await delivery(id)).toMatchObject({ status: 'failed', last_error: 'enlace-ausente' })
    expect(requests).toHaveLength(0)
  })

  it('el worker ve y puede limpiar los avisos de reserva (la política de lectura de owner y manager no lo deja fuera)', async () => {
    const id = await enqueue('tenant-a', randomUUID(), reservationNotice())
    const seen = await withTenant(db.worker, 'tenant-a', async client => {
      const read = (await client.query('SELECT 1 FROM llenamos.outbox WHERE id=$1', [id])).rowCount
      const cleaned = (await client.query("UPDATE llenamos.outbox SET payload=payload #- '{data,manageUrl}' WHERE id=$1", [id])).rowCount
      return { read, cleaned }
    })
    expect(seen).toEqual({ read: 1, cleaned: 1 })
    // Y un camarero, sin ser owner ni manager, sigue sin leerlos por HTTP.
    await db.admin.query("INSERT INTO llenamos.identities(uid,session_version,tokens_valid_after,locked) VALUES('waiter-x',repeat('c',32),to_timestamp(100),false) ON CONFLICT DO NOTHING")
    await db.admin.query("INSERT INTO llenamos.memberships(restaurant_id,uid,role,active,display_name,email) VALUES('tenant-a','waiter-x','waiter',true,'waiter-x','w@example.test') ON CONFLICT DO NOTHING")
    const waiter = { uid: 'waiter-x', sessionVersion: 'c'.repeat(32), authTime: 100, platformClaim: false }
    expect(await withIdentity(db.app, waiter, 'tenant-a', async client => (await client.query('SELECT 1 FROM llenamos.outbox WHERE id=$1', [id])).rowCount)).toBe(0)
    await drain() // no deja el aviso pendiente para las pruebas siguientes
  })

  describe('el token claro no se queda en el outbox', () => {
    const noLinks = (payload: any) => { const text = JSON.stringify(payload); expect(text).not.toContain('SECRETO'); expect(payload.data.manageUrl).toBeUndefined(); expect(payload.data.offerUrl).toBeUndefined() }

    it('tras enviar (sent)', async () => {
      const id = await enqueue('tenant-a', randomUUID(), reservationNotice())
      expect(JSON.stringify((await queue(id)).payload)).toContain('SECRETO-DE-RESERVA')
      await drain()
      expect(await delivery(id)).toMatchObject({ status: 'sent' })
      expect(requests[0]!.body.text).toContain('SECRETO-DE-RESERVA')
      noLinks((await queue(id)).payload)
    })

    it('tras not_configured', async () => {
      await setCredentials('tenant-a', null)
      const id = await enqueue('tenant-a', randomUUID(), reservationNotice())
      await drain()
      expect(await delivery(id)).toMatchObject({ status: 'not_configured' })
      noLinks((await queue(id)).payload)
    })

    it('tras un rechazo definitivo del proveedor (failed)', async () => {
      providerStatus = 400
      const id = await enqueue('tenant-a', randomUUID(), reservationNotice())
      await drain()
      expect(await delivery(id)).toMatchObject({ status: 'failed', last_error: 'provider-400' })
      noLinks((await queue(id)).payload)
    })

    it('tras cancelarse por baja de marketing (cancelled)', async () => {
      await db.admin.query("INSERT INTO llenamos.message_optouts(restaurant_id,channel,recipient) VALUES('tenant-a','email','baja@example.test') ON CONFLICT DO NOTHING")
      const id = await enqueue('tenant-a', randomUUID(), reservationNotice({ to: 'baja@example.test', template: 'marketing_campaign', purpose: 'marketing_email', customerId: 'cliente1', campaignId: 'camp1', reservationId: null }), 'mensaje.enviar')
      await drain()
      expect(await delivery(id)).toMatchObject({ status: 'cancelled', last_error: 'baja' })
      noLinks((await queue(id)).payload)
      expect(requests).toHaveLength(0)
    })

    it('mientras hay reintentos por delante el enlace sigue en la cola, y se borra al agotarse', async () => {
      providerStatus = 503
      const id = await enqueue('tenant-a', randomUUID(), reservationNotice())
      await drain()
      expect(await queue(id)).toMatchObject({ status: 'pending' })
      expect(JSON.stringify((await queue(id)).payload)).toContain('SECRETO-DE-RESERVA')
      await db.admin.query("UPDATE llenamos.outbox SET attempts=7,available_at=now() WHERE id=$1", [id])
      await drain()
      expect(await delivery(id)).toMatchObject({ status: 'failed' })
      noLinks((await queue(id)).payload)
    })

    it('la cuarentena (lease agotado) también limpia el payload, por disparador', async () => {
      const id = await enqueue('tenant-a', randomUUID(), reservationNotice())
      await db.admin.query("UPDATE llenamos.outbox SET status='leased',attempts=8,lease_id=gen_random_uuid(),lease_until=now()-interval '1 second' WHERE id=$1", [id])
      await worker().runOnce()
      expect(await queue(id)).toMatchObject({ status: 'quarantined' })
      noLinks((await queue(id)).payload)
    })

    it('no toca otros datos del payload ni los avisos de otros tipos', async () => {
      const id = randomUUID()
      await withIdentity(db.app, token('owner-a'), 'tenant-a', client => enqueueOutbox(client, { id, restaurantId: 'tenant-a', kind: 'prueba.otro', payload: { data: { manageUrl: 'conservado' } } }))
      await db.admin.query("UPDATE llenamos.outbox SET status='done' WHERE id=$1", [id])
      expect((await queue(id)).payload.data.manageUrl).toBe('conservado')
    })
  })
})
