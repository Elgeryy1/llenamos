import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { Pool } from 'pg'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { stableUuid } from '../ids.js'
import type { IntegrationVault } from '../platform/integrations.js'
import { verifyStripe, verifyWhatsApp } from './signatures.js'

const bodyLimit = 256_000
const restaurantId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const route = /^\/v1\/webhooks\/(stripe|whatsapp)\/([A-Za-z0-9_-]{1,128})$/

// Los mensajes entrantes admitidos: de los últimos 7 días (Meta reintenta hasta entonces) y sin fecha futura.
const REPLAY_WINDOW_MS = 7 * 86_400_000
const whatsappBody = z.object({ entry: z.array(z.object({ changes: z.array(z.object({ value: z.object({ metadata: z.object({ phone_number_id: z.string().min(1).max(64) }), messages: z.array(z.object({
  id: z.string().min(1).max(200), from: z.string().regex(/^\d{6,20}$/), timestamp: z.string().regex(/^\d{9,12}$/), context: z.object({ id: z.string().max(200) }).optional(),
  interactive: z.object({ button_reply: z.object({ id: z.string().max(300) }) }).optional(),
  button: z.object({ text: z.string().max(300), payload: z.string().max(300) }).optional(),
  text: z.object({ body: z.string().max(2000) }).optional(),
})).optional() }) })) })) })
const stripeBody = z.object({ id: z.string().regex(/^evt_[A-Za-z0-9_]{1,190}$/), type: z.string().min(1).max(100), created: z.number().optional(),
  livemode: z.boolean().optional(), account: z.string().max(100).optional(), data: z.object({ object: z.record(z.string(), z.unknown()) }) })

const METADATA_KEYS = ['kind', 'reservationId', 'locationId', 'restaurantId', 'checkoutId', 'amountCents', 'tipCents']
/** Del objeto de Stripe se guardan solo id, estado de pago, importe, moneda y los metadatos propios de Llenamos. */
export function stripeObject(object: Record<string, unknown>) {
  const metadata = typeof object.metadata === 'object' && object.metadata ? object.metadata as Record<string, unknown> : {}
  return {
    id: typeof object.id === 'string' ? object.id : null,
    payment_status: typeof object.payment_status === 'string' ? object.payment_status : null,
    amount_total: typeof object.amount_total === 'number' ? object.amount_total : null,
    currency: typeof object.currency === 'string' ? object.currency : null,
    metadata: Object.fromEntries(METADATA_KEYS.flatMap(key => typeof metadata[key] === 'string' ? [[key, (metadata[key] as string).slice(0, 200)]] : [])),
  }
}

/** Límite por proveedor y restaurante antes de abrir credenciales: un bucle simple en memoria por proceso. */
function limiter(perMinute: number, now: () => number) {
  const buckets = new Map<string, { since: number; count: number }>()
  return (key: string) => {
    const t = now(), bucket = buckets.get(key)
    if (!bucket || t - bucket.since >= 60_000) {
      if (buckets.size >= 10_000) {
        // Primero se retiran las ventanas vencidas; si aun así está lleno, la más antigua (orden de inserción).
        for (const [name, value] of buckets) if (t - value.since >= 60_000) buckets.delete(name)
        if (buckets.size >= 10_000) buckets.delete(buckets.keys().next().value!)
      }
      buckets.delete(key); buckets.set(key, { since: t, count: 1 }); return true
    }
    return ++bucket.count <= perMinute
  }
}
const same = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())

function rawBody(req: IncomingMessage): Promise<Buffer> {
  const length = req.headers['content-length']
  if (length && (!/^\d+$/.test(length) || Number(length) > bodyLimit)) { req.resume(); throw new ApiError(413, 'resource-exhausted', 'Cuerpo demasiado grande.') }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => { size += chunk.length; if (size > bodyLimit) { reject(new ApiError(413, 'resource-exhausted', 'Cuerpo demasiado grande.')); req.destroy() } else chunks.push(chunk) })
    req.once('end', () => resolve(Buffer.concat(chunks)))
    req.once('error', () => reject(new ApiError(400, 'invalid-argument', 'No se pudo leer la petición.')))
  })
}

/**
 * `pool` debe ser el login `llenamos_webhook` (no miembro de `llenamos_app`). `handled` son los tipos de outbox
 * (`webhook.stripe`…) que algún manejador atiende: sin él, el proveedor recibe 503 y reintenta más tarde
 * en vez de que el evento se anote y se pierda.
 */
export function webhookReceiver(pool: Pool, vault: IntegrationVault, options: { perMinute?: number; globalPerMinute?: number; now?: () => number; handled?: ReadonlySet<string> } = {}) {
  const clock = options.now ?? Date.now
  const allowed = limiter(options.perMinute ?? 300, clock)
  // Cambiar de ID de restaurante no esquiva este tope: cuenta todas las peticiones del proveedor.
  const allowedGlobal = limiter(options.globalPerMinute ?? 3000, clock)
  const reply = (res: ServerResponse, status: number, text: string) => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(text)
  }
  async function secrets(rid: string, provider: 'stripe' | 'whatsapp') {
    const { rows } = await pool.query<{ ciphertext: string | null }>('SELECT llenamos.webhook_signing_secret($1,$2) AS ciphertext', [rid, provider])
    return vault.openWebhook(rid, provider, rows[0]?.ciphertext ?? null)
  }
  async function accept(rid: string, provider: 'stripe' | 'whatsapp', eventId: string, payload: unknown) {
    const kind = `webhook.${provider}`
    const { rows } = await pool.query<{ accepted: boolean }>('SELECT llenamos.webhook_accept($1,$2,$3,$4,$5,$6) AS accepted',
      [rid, provider, eventId, stableUuid('webhook', rid, provider, eventId), kind, payload])
    return rows[0]?.accepted === true
  }
  /** Devuelve true si la ruta era de webhooks (y ya respondió). */
  return async function handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    const match = route.exec(path)
    if (!match) return false
    const provider = match[1] as 'stripe' | 'whatsapp', rid = restaurantId.parse(match[2])
    try {
      if (!allowedGlobal(provider) || !allowed(`${provider}:${rid}`)) { req.resume(); return reply(res, 429, 'Demasiadas peticiones.'), true }
      if (req.method === 'GET' && provider === 'whatsapp') {
        const url = new URL(req.url ?? '/', 'http://api.invalid')
        const verify = (await secrets(rid, provider)).verifyToken
        if (verify && url.searchParams.get('hub.mode') === 'subscribe' && same(url.searchParams.get('hub.verify_token') ?? '', verify)) reply(res, 200, url.searchParams.get('hub.challenge') ?? '')
        else reply(res, 403, 'Verificación incorrecta.')
        return true
      }
      if (req.method !== 'POST') { req.resume(); res.setHeader('Allow', provider === 'whatsapp' ? 'GET, POST' : 'POST'); reply(res, 405, 'Método no permitido.'); return true }
      if (options.handled && !options.handled.has(`webhook.${provider}`)) { req.resume(); reply(res, 503, 'Aún no hay quien atienda este evento; reintenta más tarde.'); return true }
      const raw = await rawBody(req)
      const credentials = await secrets(rid, provider)
      if (provider === 'whatsapp') {
        if (!verifyWhatsApp(raw, String(req.headers['x-hub-signature-256'] ?? ''), credentials.appSecret ?? '')) { reply(res, 401, 'Firma incorrecta.'); return true }
        const body = whatsappBody.safeParse(safeJson(raw))
        if (!body.success) { reply(res, 400, 'Evento no válido.'); return true }
        // Una app de Meta puede servir a varios restaurantes: el cuerpo debe ir dirigido al número de ESTE restaurante.
        const expected = credentials.phoneNumberId
        if (!expected || body.data.entry.some(entry => entry.changes.some(change => change.value.metadata.phone_number_id !== expected))) { reply(res, 403, 'El evento no es para este restaurante.'); return true }
        const now = clock()
        if (body.data.entry.some(entry => entry.changes.some(change => (change.value.messages ?? []).some(message => { const at = Number(message.timestamp) * 1000; return at > now + 300_000 || at < now - REPLAY_WINDOW_MS })))) { reply(res, 400, 'Evento fuera de ventana.'); return true }
        for (const entry of body.data.entry) for (const change of entry.changes) for (const message of change.value.messages ?? [])
          await accept(rid, provider, message.id, {
            messageId: message.id, from: message.from, contextId: message.context?.id ?? null,
            replyId: message.interactive?.button_reply.id ?? message.button?.payload ?? null,
            text: (message.text?.body ?? message.button?.text ?? '').slice(0, 300),
          })
      } else {
        const secretsList = [credentials.webhookSecret, credentials.mobileWebhookSecret].filter((value): value is string => !!value)
        const signature = String(req.headers['stripe-signature'] ?? '')
        if (!secretsList.some(secret => verifyStripe(raw, signature, secret))) { reply(res, 401, 'Firma incorrecta.'); return true }
        const event = stripeBody.safeParse(safeJson(raw))
        if (!event.success) { reply(res, 400, 'Evento no válido.'); return true }
        // Solo lo necesario para aplicar el pago: nada de customer_details, correo ni dirección del pagador.
        await accept(rid, provider, event.data.id, { eventId: event.data.id, type: event.data.type, created: event.data.created ?? null,
          livemode: event.data.livemode ?? false, account: event.data.account ?? null, object: stripeObject(event.data.data.object) })
      }
      // Duplicado o nuevo, el proveedor recibe 200: no hay que reenviar nada.
      reply(res, 200, 'OK')
    } catch (error) {
      req.resume()
      if (error instanceof ApiError) reply(res, error.status, error.message)
      else reply(res, 503, 'No se ha podido procesar el evento.')
    }
    return true
  }
}
function safeJson(raw: Buffer): unknown { try { return JSON.parse(raw.toString('utf8')) } catch { return null } }
