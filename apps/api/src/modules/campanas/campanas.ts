import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { campaignLink, renderMessage, type Campaign, type SegmentRule, type MarketingSettings, SegmentRuleSchema } from '@llenamos/core'
import { ApiError } from '../../errors.js'
import { emitEvent } from '../../events.js'
import { assertLocation, denied, failed, missing, type Scope } from '../comun/acceso.js'
import { loadMarketingSettings, loadRestaurant } from './audiencia.js'
import { publicAppOrigin } from './config.js'

export const newId = () => randomUUID()

export const CAMPAIGN_COLUMNS = `id,name,segment_id,channel,content,location_id,status,round(extract(epoch FROM scheduled_at)*1000)::bigint::text AS scheduled_ms,
  launched_by,rule_snapshot,stat_audience,stat_queued,stat_excluded,stat_sent,stat_failed,stat_cancelled,cursor::text AS cursor,revision`
export interface CampaignRow { id: string; name: string; segment_id: string; channel: 'email' | 'whatsapp'; content: Campaign['content']; location_id: string | null;
  status: Campaign['status']; scheduled_ms: string | null; launched_by: string | null; rule_snapshot: SegmentRule | null;
  stat_audience: number; stat_queued: number; stat_excluded: number; stat_sent: number; stat_failed: number; stat_cancelled: number; cursor: string | null; revision: number }
/** Forma del contrato `Campaign` (milisegundos para las fechas). */
export const campaignView = (r: CampaignRow): Campaign & { id: string } => ({
  id: r.id, name: r.name, segmentId: r.segment_id, channel: r.channel, content: r.content, locationId: r.location_id, status: r.status,
  scheduledAt: r.scheduled_ms === null ? null : Number(r.scheduled_ms), launchedBy: r.launched_by,
  stats: { audience: r.stat_audience, queued: r.stat_queued, excluded: r.stat_excluded, sent: r.stat_sent, failed: r.stat_failed, cancelled: r.stat_cancelled },
  cursor: r.cursor, revision: r.revision,
})

export function expectRevision(actual: number, expected: number | null) {
  if (actual !== expected) throw failed('El documento ha cambiado. Recarga antes de continuar.')
}

/** Campaña con bloqueo opcional y acceso al local: una campaña sin local solo la ve quien no tiene locales limitados. */
export async function scopedCampaign(client: PoolClient, rid: string, scope: Scope, id: string, lock = false): Promise<CampaignRow> {
  const { rows } = await client.query<CampaignRow>(`SELECT ${CAMPAIGN_COLUMNS} FROM llenamos.marketing_campaigns WHERE restaurant_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`, [rid, id])
  const row = rows[0]
  if (!row) throw missing()
  if (row.location_id) await assertLocation(client, rid, scope, row.location_id)
  else if (scope.locationIds.length) throw denied()
  return row
}

export async function loadSegment(client: PoolClient, rid: string, id: string, lock = false) {
  const { rows } = await client.query(`SELECT id,name,rule,revision FROM llenamos.marketing_segments WHERE restaurant_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`, [rid, id])
  if (!rows[0]) throw missing()
  return { id: rows[0].id as string, name: rows[0].name as string, rule: SegmentRuleSchema.parse(rows[0].rule), revision: rows[0].revision as number }
}

export async function emitCampaign(client: PoolClient, rid: string, id: string, locationId: string | null, status: string) {
  await emitEvent(client, { restaurantId: rid, locationId, topic: 'campanas.campana', entityId: id, payload: { status } })
}

/** Datos del mensaje de una campaña (la vista previa usa un token ficticio; los reales los crea `processCampaigns`). */
export function messageData(p: { restaurantName: string; slug: string; campaignId: string; campaign: Pick<Campaign, 'content' | 'channel'>; guestName: string; unsubscribeUrl: string }) {
  return {
    title: p.campaign.content.title, body: p.campaign.content.body, guestName: p.guestName, restaurantName: p.restaurantName,
    ctaUrl: p.campaign.content.includeBookingLink ? campaignLink(publicAppOrigin(), p.slug, p.campaignId, p.campaign.channel) : '',
    unsubscribeUrl: p.unsubscribeUrl,
  }
}
export function previewMessage(restaurant: { name: string; slug: string }, campaignId: string, campaign: Pick<Campaign, 'content' | 'channel'>) {
  const rendered = renderMessage({ template: 'marketing_campaign', channel: campaign.channel, language: 'es',
    data: messageData({ restaurantName: restaurant.name, slug: restaurant.slug, campaignId, campaign, guestName: 'Cliente', unsubscribeUrl: `${publicAppOrigin()}/baja/${restaurant.slug}?t=VISTA_PREVIA` }) })
  return { subject: rendered.subject, body: rendered.body }
}

export async function restaurantAndSettings(client: PoolClient, rid: string): Promise<{ restaurant: Awaited<ReturnType<typeof loadRestaurant>>; settings: MarketingSettings }> {
  const restaurant = await loadRestaurant(client, rid)
  return { restaurant, settings: await loadMarketingSettings(client, rid, restaurant.name) }
}
export { ApiError }
