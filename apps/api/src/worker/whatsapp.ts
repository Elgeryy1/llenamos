import { isUnsubscribeReply } from '@llenamos/core'
import { enqueueOutbox } from '../outbox.js'
import { stableUuid } from '../ids.js'
import { Defer, PermanentFailure, type WorkerHandler } from './types.js'

export const REPLY_KIND = 'mensaje.respuesta'

/**
 * Manejador mínimo de `mensaje.respuesta`: la baja (STOP) siempre se cumple aquí: se apunta en
 * `message_optouts` y se cancela el marketing de WhatsApp en cola hacia ese teléfono. Confirmar o cancelar una
 * reserva es de V3; si ningún módulo lo atiende, el hecho espera sin gastar intentos (no se pierde).
 */
export const replyHandler = (otherHandlers: boolean): WorkerHandler => async ctx => {
  const payload = ctx.item.payload as { action?: string; phone?: string }
  if (payload.action !== 'unsubscribe') {
    if (!otherHandlers) throw new Defer(900, 'sin-manejador-de-reserva')
    return
  }
  if (typeof payload.phone !== 'string') throw new PermanentFailure('payload-invalido')
  const phone = payload.phone
  await ctx.tenant(async client => {
    await client.query("INSERT INTO llenamos.message_optouts(restaurant_id,channel,recipient) VALUES($1,'whatsapp',$2) ON CONFLICT DO NOTHING", [ctx.item.restaurantId, phone])
    await client.query(`UPDATE llenamos.outbox SET status='failed',finished_at=now(),last_error='baja'
      WHERE restaurant_id=$1 AND kind='mensaje.enviar' AND status='pending' AND payload->>'to'=$2 AND payload->>'purpose'='marketing_whatsapp'`, [ctx.item.restaurantId, phone])
  })
}

export interface WhatsAppInbound { messageId: string; from: string; contextId: string | null; replyId: string | null; text: string }

/** Acción que pide una respuesta entrante, o null si no es una de las que entendemos. */
export function replyAction(inbound: WhatsAppInbound): 'confirmed' | 'cancelled' | 'unsubscribe' | null {
  if (isUnsubscribeReply(inbound.text)) return 'unsubscribe'
  if (inbound.replyId?.endsWith(':cancel')) return 'cancelled'
  if (inbound.replyId?.endsWith(':confirm')) return 'confirmed'
  if (/^(cancelar|cancel·lar|cancel)$/i.test(inbound.text)) return 'cancelled'
  if (/^(confirmo|confirm)$/i.test(inbound.text)) return 'confirmed'
  return null
}

/**
 * Convierte una respuesta de WhatsApp en un hecho `mensaje.respuesta` ligado al aviso que la originó
 * (por botón o por el `context.id` de Meta) y al mismo teléfono. Quien modifica reservas o permisos registra
 * su manejador de `mensaje.respuesta`; aquí no se toca ninguna reserva ni consentimiento.
 */
export const whatsappInboundHandler: WorkerHandler = async ctx => {
  const inbound = ctx.item.payload as unknown as WhatsAppInbound
  if (typeof inbound?.messageId !== 'string' || typeof inbound.from !== 'string') throw new PermanentFailure('payload-invalido')
  const action = replyAction(inbound)
  if (!action) return
  const phone = `+${inbound.from.replace(/^\+/, '')}`
  await ctx.tenant(async client => {
    const deliveryId = inbound.replyId?.split(':')[0]
    const { rows } = await client.query<{ id: string; recipient: string; context: Record<string, unknown> }>(
      `SELECT id,recipient,context FROM llenamos.message_deliveries WHERE channel='whatsapp' AND status='sent'
         AND (provider_message_id=$1 OR id::text=$2) AND recipient=$3 LIMIT 1`, [inbound.contextId ?? '', deliveryId ?? '', phone])
    const delivery = rows[0]
    // Una baja sirve aunque no se reconozca el aviso; confirmar o cancelar exige el aviso y el mismo teléfono.
    if (!delivery && action !== 'unsubscribe') return
    await enqueueOutbox(client, { id: stableUuid('mensaje.respuesta', ctx.item.restaurantId, inbound.messageId), restaurantId: ctx.item.restaurantId, kind: REPLY_KIND,
      payload: { action, phone, messageId: inbound.messageId, deliveryId: delivery?.id ?? null, context: delivery?.context ?? {} } })
  })
}
