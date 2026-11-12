import { MessageRequestSchema, hasCurrentConsent, type Consent } from '@llenamos/core'
import type { PoolClient } from 'pg'
import { enqueueJob } from '../../jobs.js'
import { messageHandler, type ConsentCheck } from '../../worker/messages.js'
import { Defer, PermanentFailure, RetryLater, type WorkerHandler } from '../../worker/types.js'
import { loadConsents } from './audiencia.js'
import { JOB_KIND_PROCESS } from './config.js'
import { issueUnsubscribeUrl, markCampaignMessageOutcome, processCampaigns, resolveCampaignMessage, stableUuid, type CampaignMessagePayload, type MessageOutcome } from './proceso.js'

/** Permiso vigente de marketing de un cliente (para el worker de avisos: sin permiso, el mensaje no sale). */
export const marketingConsent: ConsentCheck = async (client, rid, customerId, purpose) => {
  const now = Date.now()
  const consents = await loadConsents(client, rid, purpose as Consent['purpose'], [customerId], now)
  return hasCurrentConsent(consents, customerId, purpose as Consent['purpose'], now)
}

const isPayload = (value: Record<string, unknown>): value is Record<string, unknown> & CampaignMessagePayload =>
  typeof value.campaignId === 'string' && typeof value.customerId === 'string' && typeof value.messageId === 'string'
  && (value.channel === 'email' || value.channel === 'whatsapp') && (value.purpose === 'marketing_email' || value.purpose === 'marketing_whatsapp')
  && typeof value.data === 'object' && value.data !== null

/**
 * `marketing.campaign_message`: vuelve a comprobar permiso, supresión y ventana de envío, crea el enlace de baja y delega el
 * envío en el manejador común de avisos (`messageHandler`), que registra la entrega, respeta las bajas y falla con
 * `not-configured` si el restaurante no tiene proveedor. El resultado se anota en el destinatario de la campaña.
 */
export function campaignMessageHandler(): WorkerHandler {
  const send = messageHandler({ consent: marketingConsent })
  return async ctx => {
    const { item } = ctx
    if (!isPayload(item.payload)) throw new PermanentFailure('payload-invalido')
    const payload = item.payload
    const rid = item.restaurantId
    const outcome = (client: PoolClient, value: MessageOutcome) => markCampaignMessageOutcome(client, rid, payload.campaignId, payload.customerId, value)
    const resolved = await ctx.tenant(client => resolveCampaignMessage(client, rid, payload))
    if (!resolved.ok) {
      if (resolved.reason === 'outside_window') throw new Defer(Math.max(60, Math.ceil(((resolved.retryAt ?? Date.now() + 3_600_000) - Date.now()) / 1000)))
      await ctx.tenant(client => outcome(client, 'cancelled'))
      return
    }
    const unsubscribeUrl = await ctx.tenant(client => issueUnsubscribeUrl(client, rid, payload, resolved.slug))
    const request = MessageRequestSchema.parse({
      channel: resolved.channel, to: resolved.to, template: 'marketing_campaign', language: resolved.language, data: { ...payload.data, unsubscribeUrl },
      reservationId: null, waitlistId: null, sendAt: Date.now(), purpose: payload.purpose, customerId: payload.customerId, campaignId: payload.campaignId,
    })
    try {
      await send({ ...ctx, item: { ...item, payload: request as unknown as Record<string, unknown> } })
    } catch (error) {
      if (error instanceof PermanentFailure) await ctx.tenant(client => outcome(client, error.code === 'not-configured' ? 'not_configured' : 'failed'))
      else if (error instanceof RetryLater && item.attempts >= 8) await ctx.tenant(client => outcome(client, 'failed'))
      throw error
    }
    const delivery = await ctx.tenant(async client => (await client.query<{ status: string }>('SELECT status FROM llenamos.message_deliveries WHERE id=$1', [item.id])).rows[0]?.status)
    await ctx.tenant(client => outcome(client, delivery === 'sent' ? 'sent' : 'cancelled'))
  }
}

/** Deja otro trabajo de proceso para más tarde; el ID lleva la hora, así que no choca con el que está en curso. */
async function reschedule(client: PoolClient, rid: string, campaignId: string | null, at: number) {
  const key = `${campaignId ?? 'todas'}:${at}`
  await enqueueJob(client, { id: stableUuid(`job:${JOB_KIND_PROCESS}:${rid}:${key}`), restaurantId: rid, kind: JOB_KIND_PROCESS, deduplicationKey: key, payload: campaignId ? { campaignId } : {}, scheduledAt: new Date(at) })
}

/** `marketing.procesar_campana`: prepara páginas de destinatarios (cada una en su transacción) hasta acabar o salir de la ventana de envío. */
export function processCampaignHandler(): WorkerHandler {
  return async ctx => {
    const rid = ctx.item.restaurantId
    const campaignId = typeof ctx.item.payload.campaignId === 'string' ? ctx.item.payload.campaignId : null
    for (let page = 0; page < 2000 && !ctx.signal.aborted; page++) {
      const result = await ctx.tenant(client => processCampaigns(client, rid, Date.now(), undefined, campaignId))
      if (result.retryAt !== null) { await ctx.tenant(client => reschedule(client, rid, campaignId, result.retryAt!)); return }
      if (!result.more) return
    }
    await ctx.tenant(client => reschedule(client, rid, campaignId, Date.now() + 5_000))
  }
}
