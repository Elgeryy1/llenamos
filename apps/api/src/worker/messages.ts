import { MessageRequestSchema, MessageSchema, queuedMessage, type Message, TakeawaySchema, publicAppOrigin, sha256Hex, takeawayTrackPath } from '@llenamos/core'
import type { PoolClient } from 'pg'
import { ApiError } from '../errors.js'
import { open } from '../modules/sala/secrets.js'
import { enqueueOutbox } from '../outbox.js'
import { sendMessage } from './providers.js'
import { MAX_ATTEMPTS } from './queue.js'
import { PermanentFailure, RetryLater, type WorkerContext, type WorkerHandler } from './types.js'

export const MESSAGE_KIND = 'mensaje.enviar'

/** Comprobación de consentimiento de marketing (la aporta el módulo de clientes). Sin ella, no sale marketing. */
export type ConsentCheck = (client: PoolClient, restaurantId: string, customerId: string, purpose: string) => Promise<boolean>

/**
 * Encola un aviso dentro de la transacción del hecho. El ID es estable: si la operación se repite con la
 * misma clave, no se genera un segundo envío. La hora de salida va en `availableAt` del outbox.
 */
export async function enqueueMessage(client: PoolClient, restaurantId: string, id: string, request: unknown): Promise<void> {
  const parsed = MessageRequestSchema.parse(request)
  MessageSchema.parse(queuedMessage(parsed))
  await enqueueOutbox(client, { id, restaurantId, kind: MESSAGE_KIND, payload: parsed, availableAt: new Date(parsed.sendAt) })
}

/** Lo mínimo para dejar rastro de un aviso, tenga o no destinatario o mensaje completo. */
interface Trace { channel: 'email' | 'whatsapp'; template: string; to: string; language: string; purpose?: string | null
  context: { reservationId?: string | null; waitlistId?: string | null; customerId?: string | null; campaignId?: string | null; takeawayId?: string | null } }
const traceOf = (message: Message): Trace => ({ channel: message.channel, template: message.template, to: message.to, language: message.language, purpose: message.purpose,
  context: { reservationId: message.reservationId, waitlistId: message.waitlistId, customerId: message.customerId ?? null, campaignId: message.campaignId ?? null, takeawayId: message.takeawayId ?? null } })

interface Values { status: 'sent' | 'not_configured' | 'failed' | 'cancelled'; provider: string | null; providerMessageId: string | null; subject: string | null; error: string | null; attempts: number }

async function record(client: PoolClient, rid: string, id: string, trace: Trace, values: Values) {
  await client.query(`INSERT INTO llenamos.message_deliveries(id,restaurant_id,channel,template,recipient,language,status,provider,provider_message_id,context,purpose,rendered_subject,attempts,last_error)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,provider=EXCLUDED.provider,provider_message_id=coalesce(EXCLUDED.provider_message_id,llenamos.message_deliveries.provider_message_id),
      attempts=EXCLUDED.attempts,last_error=EXCLUDED.last_error,rendered_subject=EXCLUDED.rendered_subject,updated_at=now()`,
  [id, rid, trace.channel, trace.template, trace.to, trace.language, values.status, values.provider, values.providerMessageId,
    { reservationId: trace.context.reservationId ?? null, waitlistId: trace.context.waitlistId ?? null, customerId: trace.context.customerId ?? null, campaignId: trace.context.campaignId ?? null, takeawayId: trace.context.takeawayId ?? null },
    trace.purpose ?? null, values.subject, values.attempts, values.error])
}

/**
 * Resultado definitivo de un aviso (enviado, fallido, no configurado o cancelado): se apunta y, en la misma
 * transacción, se borran del payload del outbox los enlaces con token. Mientras haya reintentos por delante,
 * el enlace sigue en la cola; después ya no queda ningún token en claro.
 */
async function finalize(ctx: WorkerContext, trace: Trace, values: Values) {
  await ctx.tenant(async client => {
    await record(client, ctx.item.restaurantId, ctx.item.id, trace, values)
    await client.query(`UPDATE llenamos.outbox SET payload=payload #- '{data,manageUrl}' #- '{data,offerUrl}' #- '{data,paymentUrl}' #- '{data,trackUrl}'
      WHERE id=$1 AND restaurant_id=$2 AND payload ? 'data'`, [ctx.item.id, ctx.item.restaurantId])
  })
}
const cancel = (ctx: WorkerContext, trace: Trace, error: string) =>
  finalize(ctx, trace, { status: 'cancelled', provider: null, providerMessageId: null, subject: null, error, attempts: ctx.item.attempts })

/** ¿Ya hay un resultado definitivo de este aviso? (una entrega repetida no lo envía otra vez). */
const alreadyDone = (ctx: WorkerContext) => ctx.tenant(async client => {
  const status = (await client.query<{ status: string }>('SELECT status FROM llenamos.message_deliveries WHERE id=$1', [ctx.item.id])).rows[0]?.status
  return status === 'sent' || status === 'cancelled'
})

/**
 * Plantillas cuyo aviso no tiene sentido sin su enlace (oferta de espera, petición de señal, recogida). Si el enlace
 * falta (p. ej. el payload ya se limpió y alguien reencoló la fila), no se envía un aviso sin enlace.
 */
const needsLink = (message: Message) => message.template === 'waitlist_offer' ? !message.data.offerUrl
  : message.template === 'deposit_request' ? !message.data.paymentUrl && !message.data.manageUrl
  : message.template === 'takeaway_accepted' || message.template === 'takeaway_ready' ? !message.data.manageUrl : false

/** Envío y registro comunes a todos los avisos: credenciales, lease, proveedor y resultado definitivo. */
async function deliver(ctx: WorkerContext, message: Message): Promise<void> {
  const { item } = ctx, trace = traceOf(message)
  if (needsLink(message)) {
    await finalize(ctx, trace, { status: 'failed', provider: null, providerMessageId: null, subject: null, error: 'enlace-ausente', attempts: item.attempts })
    throw new PermanentFailure('enlace-ausente')
  }
  let result
  try {
    const credentials = await ctx.credentials()
    // Último paso antes del efecto externo: si el lease ya no es nuestro, otro worker se ocupa y no se envía.
    if (!await ctx.extendLease()) throw new RetryLater(0, 'lease-perdido')
    result = await sendMessage(message, item.id, credentials, ctx.fetch, ctx.signal)
  }
  catch (error) {
    if (error instanceof PermanentFailure)
      await finalize(ctx, trace, { status: 'failed', provider: null, providerMessageId: null, subject: null, error: error.code, attempts: item.attempts })
    else if (error instanceof RetryLater && item.attempts >= MAX_ATTEMPTS)
      await finalize(ctx, trace, { status: 'failed', provider: null, providerMessageId: null, subject: null, error: error.message.slice(0, 100), attempts: item.attempts })
    throw error
  }
  await finalize(ctx, trace, { status: result.status, provider: result.provider, providerMessageId: result.providerMessageId, subject: result.subject, error: result.status === 'sent' ? null : 'not-configured', attempts: item.attempts })
  // Sin proveedor configurado la operación falla con su código; no se da por enviada.
  if (result.status === 'not_configured') throw new PermanentFailure('not-configured', 'El canal no está configurado para este restaurante.')
}

export function messageHandler(options: { consent?: ConsentCheck } = {}): WorkerHandler {
  return async ctx => {
    const { item } = ctx
    const parsed = MessageRequestSchema.safeParse(item.payload)
    if (!parsed.success) throw new PermanentFailure('payload-invalido')
    const message = MessageSchema.parse(queuedMessage(parsed.data))
    if (await alreadyDone(ctx)) return
    if (message.purpose) {
      const optedOut = await ctx.tenant(async client => (await client.query('SELECT 1 FROM llenamos.message_optouts WHERE restaurant_id=$1 AND channel=$2 AND recipient=$3', [item.restaurantId, message.channel, message.to])).rowCount === 1)
      if (optedOut) return cancel(ctx, traceOf(message), 'baja')
      const allowed = message.customerId && options.consent
        ? await ctx.tenant(client => options.consent!(client, item.restaurantId, message.customerId!, message.purpose!)) : false
      if (!allowed) return cancel(ctx, traceOf(message), 'sin-consentimiento')
    }
    await deliver(ctx, message)
  }
}

/** Estados en los que un aviso de recogida todavía tiene sentido para cada plantilla. */
const NOTICE_STATES: Record<string, readonly string[]> = { takeaway_accepted: ['accepted', 'ready'], takeaway_ready: ['ready'] }

/**
 * Aviso de recogida: lee el pedido al enviar (no viaja nada personal por la cola), comprueba que sigue
 * vigente y construye el enlace de seguimiento con el secreto guardado. Sin secreto que cuadre con el
 * hash del pedido, no se envía.
 */
export function takeawayNoticeHandler(): WorkerHandler {
  return async ctx => {
    const { item } = ctx
    const payload = item.payload as { locationId?: string; takeawayId?: string; template?: string; channel?: string }
    if (!payload?.locationId || !payload?.takeawayId || !payload?.template || !payload?.channel) throw new PermanentFailure('payload-invalido')
    const { locationId, takeawayId, template, channel } = payload
    if (channel !== 'email' && channel !== 'whatsapp') throw new PermanentFailure('canal-invalido')
    if (!(template in NOTICE_STATES)) throw new PermanentFailure('plantilla-invalida')
    const rid = item.restaurantId
    const bare: Trace = { channel, template, to: '', language: 'es', context: { takeawayId } }
    const fail = async (code: string): Promise<never> => {
      await finalize(ctx, bare, { status: 'failed', provider: null, providerMessageId: null, subject: null, error: code, attempts: item.attempts })
      throw new PermanentFailure(code)
    }
    if (await alreadyDone(ctx)) return

    const data = await ctx.tenant(async client => {
      const takeaway = (await client.query<{ doc: unknown }>('SELECT doc FROM llenamos.sala_takeaways WHERE restaurant_id=$1 AND location_id=$2 AND id=$3', [rid, locationId, takeawayId])).rows[0]
      if (!takeaway) return null
      const place = (await client.query<{ name: string; slug: string; timezone: string; location_name: string | null; address: string | null; phone: string | null; reservation_timezone: string | null }>(
        `SELECT r.name,r.slug,r.timezone,l.name AS location_name,l.address,l.phone,
           (SELECT s.doc->>'timezone' FROM llenamos.sala_settings s WHERE s.restaurant_id=r.id AND s.location_id=$2 AND s.kind='reservations') AS reservation_timezone
         FROM llenamos.restaurants r LEFT JOIN llenamos.locations l ON l.restaurant_id=r.id AND l.id=$2 WHERE r.id=$1`, [rid, locationId])).rows[0]
      const secret = (await client.query<{ doc: { tokenSecret?: unknown } }>("SELECT doc FROM llenamos.sala_private WHERE restaurant_id=$1 AND location_id=$2 AND kind='takeawaySecrets' AND id=$3", [rid, locationId, takeawayId])).rows[0]
      return { takeaway: TakeawaySchema.safeParse(takeaway.doc), place, sealed: secret?.doc?.tokenSecret }
    })
    if (!data?.place) return fail('takeaway-no-encontrado')
    if (!data.takeaway.success) return fail('pedido-invalido')
    const { place } = data, takeaway = data.takeaway.data
    const trace: Trace = { ...bare, to: (channel === 'email' ? takeaway.email : takeaway.phone) ?? '', language: takeaway.language }

    // Si el pedido ya no está en un estado que justifique el aviso (cancelado, recogido…), no sale.
    if (!NOTICE_STATES[template]!.includes(takeaway.status)) return cancel(ctx, trace, 'estado-no-vigente')
    if (!trace.to) return cancel(ctx, trace, 'sin-destinatario')

    let token: string
    try {
      if (typeof data.sealed !== 'string') throw new Error('sin-secreto')
      token = open(rid, data.sealed)
    } catch (error) {
      // Sin la clave de custodia (que el operador puede poner) se reintenta; en el último intento queda apuntado como fallido.
      if (error instanceof ApiError && error.code === 'failed-precondition') {
        if (item.attempts >= MAX_ATTEMPTS) return fail('custodia-no-configurada')
        throw new RetryLater(300, 'custodia-no-configurada')
      }
      return fail('enlace-no-valido')
    }
    if (sha256Hex(token) !== takeaway.manageTokenHash) return fail('enlace-no-valido')

    let origin: string
    try { origin = publicAppOrigin(process.env.PUBLIC_APP_URL, false) }
    catch { return fail('app-url-no-configurada') }

    const message = MessageSchema.parse(queuedMessage({
      channel, to: trace.to, template: template as 'takeaway_accepted' | 'takeaway_ready', language: takeaway.language,
      takeawayId, reservationId: null, waitlistId: null, sendAt: Date.now(),
      data: {
        guestName: takeaway.guestName, restaurantName: place.name, locationName: place.location_name ?? '',
        address: place.address ?? '', phone: place.phone ?? '', timezone: place.reservation_timezone ?? place.timezone,
        startAt: takeaway.pickupAt, reference: takeaway.reference, totalCents: takeaway.totalCents, slug: place.slug,
        manageUrl: new URL(takeawayTrackPath(place.slug, takeaway.reference, token), origin).href,
      },
    }))
    await deliver(ctx, message)
  }
}
