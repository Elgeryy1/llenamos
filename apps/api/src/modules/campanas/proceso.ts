import { createHash, randomBytes } from 'node:crypto'
import type { PoolClient } from 'pg'
import { campaignMessageId, hasCurrentConsent, nextSendTime, purposeForChannel, type CampaignExclusion, type SegmentRule } from '@llenamos/core'
import { ApiError } from '../../errors.js'
import { emitEvent } from '../../events.js'
import { enqueueOutbox } from '../../outbox.js'
import { requireModules } from '../comun/acceso.js'
import { assertAudienceWithinCap, contactHash, evaluatePage, loadConsents, loadMarketingSettings, loadRestaurant, segmentPage, type PageContext } from './audiencia.js'
import { CAMPAIGN_COLUMNS, emitCampaign, messageData, type CampaignRow } from './campanas.js'
import { CAMPAIGN_PAGE_SIZE, MAX_CAMPAIGNS_PER_RUN, OUTBOX_KIND_MESSAGE, UNSUBSCRIBE_TOKEN_RETENTION_MS, publicAppOrigin } from './config.js'

const DAY_MS = 86_400_000
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
/** UUID estable (forma v5) derivado de un texto: el ID del mensaje en el outbox. */
export function stableUuid(value: string): string {
  const h = sha256(value)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}
export const campaignOutboxId = (campaignId: string, customerId: string) => stableUuid(campaignMessageId(campaignId, customerId))

/**
 * Contenido del mensaje en el outbox. Sin teléfono, correo ni token de baja: el worker resuelve el contacto con
 * `resolveCampaignMessage` y crea el enlace de baja (`issueUnsubscribeUrl`) justo al enviar. `guestName` es lo único personal y se
 * sustituye en un borrado de privacidad.
 */
export interface CampaignMessagePayload {
  campaignId: string; customerId: string; channel: 'email' | 'whatsapp'; purpose: 'marketing_email' | 'marketing_whatsapp'
  template: 'marketing_campaign'; language: 'es' | 'ca' | 'en'; messageId: string
  data: { title: string; body: string; guestName: string; restaurantName: string; ctaUrl: string; unsubscribeUrl: string }
}

export interface CampaignRun { campaignId: string; status: 'sending' | 'sent' | 'cancelled'; queued: number; excluded: number }
export interface ProcessResult {
  /** Mensajes puestos en el outbox en esta llamada. */
  queued: number
  campaigns: CampaignRun[]
  /** Quedan páginas por preparar: el worker debe volver a llamar (mismo job). */
  more: boolean
  /** Fuera de la ventana de envío: instante a partir del cual volver a intentarlo. */
  retryAt: number | null
}

/**
 * Prepara una página (hasta `pageSize` clientes) de cada campaña programada o en curso. El worker (V2) la llama
 * dentro de una transacción con el contexto del restaurante, hasta que `more` sea false. Nunca envía: por cada
 * destinatario escribe, en la misma transacción, su fila, el token de baja, el registro de frecuencia y el outbox
 * (`marketing.campaign_message`, id uuid determinista). Un reintento no duplica nada (clave primaria + ON CONFLICT).
 * Si `campaignId` viene, solo esa campaña.
 */
export async function processCampaigns(client: PoolClient, rid: string, now: number = Date.now(), pageSize: number = CAMPAIGN_PAGE_SIZE, campaignId: string | null = null): Promise<ProcessResult> {
  const result: ProcessResult = { queued: 0, campaigns: [], more: false, retryAt: null }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw new ApiError(400, 'invalid-argument', 'Tamaño de página no válido.')
  try { await requireModules(client, rid, ['marketing']) } catch (error) { if (error instanceof ApiError && error.status === 403) return result; throw error }
  const restaurant = await loadRestaurant(client, rid)
  const settings = await loadMarketingSettings(client, rid, restaurant.name)
  const allowedAt = nextSendTime(now, restaurant.timezone, settings.sendWindow)
  const { rows } = await client.query<CampaignRow>(
    `SELECT ${CAMPAIGN_COLUMNS} FROM llenamos.marketing_campaigns WHERE restaurant_id=$1 AND status IN ('scheduled','sending')
       AND scheduled_at<=to_timestamp($2::bigint/1000.0) AND ($3::text IS NULL OR id=$3) ORDER BY scheduled_at,id LIMIT $4 FOR UPDATE SKIP LOCKED`,
    [rid, now, campaignId, MAX_CAMPAIGNS_PER_RUN])
  if (allowedAt !== now) { result.retryAt = rows.length ? allowedAt : null; result.more = rows.length > 0; return result }
  for (const campaign of rows) {
    const run = await processOne(client, rid, campaign, restaurant, settings, now, pageSize)
    result.campaigns.push(run); result.queued += run.queued
    if (run.status === 'sending') result.more = true
  }
  return result
}

async function processOne(client: PoolClient, rid: string, campaign: CampaignRow, restaurant: { name: string; slug: string }, settings: PageContext['settings'], now: number, pageSize: number): Promise<CampaignRun> {
  const rule = campaign.rule_snapshot as SegmentRule
  if (campaign.cursor === null) {
    try { await assertAudienceWithinCap(client, rid, rule, now) } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 412) throw error
      // Los clientes crecieron por encima del tope tras lanzar: se detiene en vez de enviar a medias.
      await client.query("UPDATE llenamos.marketing_campaigns SET status='cancelled',revision=revision+1,updated_at=now() WHERE restaurant_id=$1 AND id=$2", [rid, campaign.id])
      await emitCampaign(client, rid, campaign.id, campaign.location_id, 'cancelled')
      return { campaignId: campaign.id, status: 'cancelled', queued: 0, excluded: 0 }
    }
  }
  const page = await segmentPage(client, rid, rule, now, campaign.cursor, pageSize)
  const ctx: PageContext = { rid, rule, channel: campaign.channel, settings, now, ignoreCampaign: campaign.id }
  const ids = page.map(c => c.customer_id)
  const seen = async (hashes: readonly string[]) => {
    const { rows } = await client.query<{ contact_hash: string }>(
      'SELECT contact_hash FROM llenamos.marketing_campaign_recipients WHERE restaurant_id=$1 AND campaign_id=$2 AND contact_hash=ANY($3::text[]) AND customer_id<>ALL($4::bpchar[])', [rid, campaign.id, [...hashes], ids])
    return new Set(rows.map(r => r.contact_hash))
  }
  const { plan, rows: byId } = await evaluatePage(client, ctx, page, seen)
  const purpose = purposeForChannel(campaign.channel) as CampaignMessagePayload['purpose']
  let queued = 0, excluded = 0
  const reasonOf = new Map<string, CampaignExclusion>(plan.excluded.map(e => [e.customerId, e.reason]))
  const recipientOf = new Map(plan.recipients.map(r => [r.customerId, r]))
  for (const customer of page) {
    const id = customer.customer_id
    const recipient = recipientOf.get(id)
    if (!recipient) {
      // Quien no cumple la regla tras la comprobación de core no entra en ninguna cuenta; solo se guardan exclusiones.
      const reason = reasonOf.get(id)
      if (!reason) continue
      const inserted = await client.query(`INSERT INTO llenamos.marketing_campaign_recipients(restaurant_id,campaign_id,customer_id,status,excluded_reason,at) VALUES($1,$2,$3,'excluded',$4,to_timestamp($5::bigint/1000.0)) ON CONFLICT DO NOTHING`, [rid, campaign.id, id, reason, now])
      excluded += inserted.rowCount ?? 0
      continue
    }
    const messageId = campaignOutboxId(campaign.id, id)
    const inserted = await client.query(`INSERT INTO llenamos.marketing_campaign_recipients(restaurant_id,campaign_id,customer_id,status,message_id,contact_hash,at) VALUES($1,$2,$3,'queued',$4,$5,to_timestamp($6::bigint/1000.0)) ON CONFLICT DO NOTHING`,
      [rid, campaign.id, id, messageId, contactHash(recipient.to), now])
    if (!inserted.rowCount) continue
    await client.query(`INSERT INTO llenamos.marketing_send_log(restaurant_id,customer_id,campaign_id,at) VALUES($1,$2,$3,to_timestamp($4::bigint/1000.0)) ON CONFLICT(restaurant_id,customer_id,campaign_id) DO UPDATE SET at=EXCLUDED.at`, [rid, id, campaign.id, now])
    const payload: CampaignMessagePayload = {
      campaignId: campaign.id, customerId: id, channel: campaign.channel, purpose, template: 'marketing_campaign', language: recipient.language, messageId,
      data: messageData({ restaurantName: restaurant.name, slug: restaurant.slug, campaignId: campaign.id, campaign: { channel: campaign.channel, content: campaign.content },
        guestName: byId.get(id)!.name || 'Cliente', unsubscribeUrl: '' }),
    }
    await enqueueOutbox(client, { id: messageId, restaurantId: rid, kind: OUTBOX_KIND_MESSAGE, payload: payload as unknown as Record<string, unknown>, availableAt: new Date(now) })
    queued += 1
  }
  // El registro de frecuencia solo importa 30 días: se poda por clientes de la página.
  if (ids.length) await client.query('DELETE FROM llenamos.marketing_send_log WHERE restaurant_id=$1 AND customer_id=ANY($2::bpchar[]) AND at<=to_timestamp(($3::bigint-$4::bigint)/1000.0)', [rid, ids, now, 30 * DAY_MS])
  const done = page.length < pageSize
  const cursor = page.length ? page[page.length - 1]!.customer_id : campaign.cursor
  const status = done ? 'sent' : 'sending'
  await client.query(`UPDATE llenamos.marketing_campaigns SET status=$3,cursor=$4,stat_audience=stat_audience+$5,stat_queued=stat_queued+$6,stat_excluded=stat_excluded+$7,revision=revision+1,updated_at=now() WHERE restaurant_id=$1 AND id=$2`,
    [rid, campaign.id, status, cursor, plan.counts.audience, queued, excluded])
  await emitEvent(client, { restaurantId: rid, locationId: campaign.location_id, topic: 'campanas.campana', entityId: campaign.id, payload: { status } })
  return { campaignId: campaign.id, status, queued, excluded }
}

/**
 * Crea el enlace de baja de un mensaje en el momento de enviarlo: el token solo existe en memoria del worker y en el correo;
 * en la base queda su hash. Reintentar crea otro token válido (el anterior nunca salió del worker).
 */
export async function issueUnsubscribeUrl(client: PoolClient, rid: string, p: Pick<CampaignMessagePayload, 'campaignId' | 'customerId' | 'purpose' | 'messageId'>, slug: string, now: number = Date.now()): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  await client.query(`INSERT INTO llenamos.marketing_unsubscribe_tokens(restaurant_id,token_hash,customer_id,purpose,message_id,campaign_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7::bigint/1000.0))`,
    [rid, sha256(token), p.customerId, p.purpose, p.messageId, p.campaignId, now + UNSUBSCRIBE_TOKEN_RETENTION_MS])
  return `${publicAppOrigin()}/baja/${slug}?t=${token}`
}

export type MessageOutcome = 'sent' | 'failed' | 'not_configured' | 'cancelled'
/**
 * Para el worker (V2): estado final de un mensaje de campaña. `not_configured` es el resultado cuando no hay proveedor
 * (WhatsApp sin cuenta verificada, correo sin clave); nunca se simula un envío. Idempotente: solo cambia lo que sigue en cola.
 */
export async function markCampaignMessageOutcome(client: PoolClient, rid: string, campaignId: string, customerId: string, outcome: MessageOutcome): Promise<boolean> {
  const { rowCount } = await client.query("UPDATE llenamos.marketing_campaign_recipients SET status=$4 WHERE restaurant_id=$1 AND campaign_id=$2 AND customer_id=$3 AND status='queued'", [rid, campaignId, customerId, outcome])
  if (!rowCount) return false
  const column = ({ sent: 'stat_sent', failed: 'stat_failed', cancelled: 'stat_cancelled', not_configured: null } as const)[outcome]
  await client.query(`UPDATE llenamos.marketing_campaigns SET stat_queued=greatest(stat_queued-1,0)${column ? `,${column}=${column}+1` : ''},updated_at=now() WHERE restaurant_id=$1 AND id=$2`, [rid, campaignId])
  return true
}

export type ResolvedMessage =
  | { ok: true; to: string; channel: 'email' | 'whatsapp'; language: 'es' | 'ca' | 'en'; slug: string }
  | { ok: false; reason: 'module_off' | 'campaign_cancelled' | 'no_consent' | 'suppressed' | 'no_contact' | 'outside_window'; retryAt?: number }

/**
 * Para el worker (V2): antes de enviar un `marketing.campaign_message` hay que volver a comprobar permiso, supresión y
 * ventana (un permiso retirado después de reclamar el mensaje ya no pudo cancelarlo). Devuelve el contacto actual.
 * Si no es `ok`, el worker no envía y marca `markCampaignMessageOutcome(..., 'cancelled')` salvo `outside_window`
 * (reintentar en `retryAt`).
 */
export async function resolveCampaignMessage(client: PoolClient, rid: string, payload: Pick<CampaignMessagePayload, 'campaignId' | 'customerId' | 'purpose' | 'channel'>, now: number = Date.now()): Promise<ResolvedMessage> {
  try { await requireModules(client, rid, ['marketing']) } catch (error) { if (error instanceof ApiError && error.status === 403) return { ok: false, reason: 'module_off' }; throw error }
  const campaign = await client.query<{ status: string }>('SELECT status FROM llenamos.marketing_campaigns WHERE restaurant_id=$1 AND id=$2', [rid, payload.campaignId])
  if (!campaign.rows[0] || campaign.rows[0].status === 'cancelled') return { ok: false, reason: 'campaign_cancelled' }
  const consents = await loadConsents(client, rid, payload.purpose, [payload.customerId], now)
  if (!hasCurrentConsent(consents, payload.customerId, payload.purpose, now)) return { ok: false, reason: 'no_consent' }
  const customer = await client.query<{ phone: string | null; email: string | null; language: 'es' | 'ca' | 'en'; redacted: boolean }>(
    'SELECT phone,email,language,redacted FROM llenamos.customer_marketing WHERE restaurant_id=$1 AND customer_id=$2', [rid, payload.customerId])
  const c = customer.rows[0]
  if (!c || c.redacted) return { ok: false, reason: 'suppressed' }
  const to = payload.channel === 'email' ? c.email : c.phone
  if (!to) return { ok: false, reason: 'no_contact' }
  const restaurant = await loadRestaurant(client, rid)
  const settings = await loadMarketingSettings(client, rid, restaurant.name)
  const allowedAt = nextSendTime(now, restaurant.timezone, settings.sendWindow)
  if (allowedAt !== now) return { ok: false, reason: 'outside_window', retryAt: allowedAt }
  return { ok: true, to, channel: payload.channel, language: c.language, slug: restaurant.slug }
}
