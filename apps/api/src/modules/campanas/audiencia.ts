import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { planCampaignAudience, defaultMarketingSettings, MarketingSettingsSchema, purposeForChannel,
  type AudienceCandidate, type AudiencePlan, type CampaignChannel, type CampaignExclusion, type Consent, type MarketingSettings, type SegmentRule, type SendLogEntry } from '@llenamos/core'
import { ApiError } from '../../errors.js'
import { AUDIENCE_PAGE_SIZE, MAX_CAMPAIGN_AUDIENCE, SAMPLE_SIZE, loyaltyPointsPort } from './config.js'

const DAY_MS = 86_400_000

export interface RestaurantInfo { name: string; slug: string; timezone: string }
export async function loadRestaurant(client: PoolClient, rid: string): Promise<RestaurantInfo> {
  const { rows } = await client.query('SELECT name,slug,timezone FROM llenamos.restaurants WHERE id=$1', [rid])
  if (!rows[0]) throw new ApiError(404, 'not-found', 'No se encuentra el restaurante.')
  return { name: rows[0].name, slug: rows[0].slug, timezone: rows[0].timezone }
}
export async function loadMarketingSettings(client: PoolClient, rid: string, restaurantName?: string): Promise<MarketingSettings> {
  const { rows } = await client.query('SELECT settings FROM llenamos.marketing_settings WHERE restaurant_id=$1', [rid])
  if (rows[0]) return MarketingSettingsSchema.parse(rows[0].settings)
  return defaultMarketingSettings(restaurantName ?? (await loadRestaurant(client, rid)).name)
}

export const contactHash = (contact: string) => createHash('sha256').update(contact.trim().toLowerCase()).digest('hex')

/** Filtros del segmento traducidos a SQL (superconjunto exacto de `matchesSegment`; core vuelve a comprobar cada página). */
export function segmentWhere(rule: SegmentRule, now: number, firstParam: number): { sql: string; params: unknown[] } {
  const params: unknown[] = []
  const p = (value: unknown) => { params.push(value); return `$${firstParam + params.length - 1}` }
  const at = (ms: number) => `to_timestamp(${p(ms)}::bigint/1000.0)`
  const parts: string[] = []
  if (rule.minVisits !== null) parts.push(`cm.visits>=${p(rule.minVisits)}`)
  if (rule.maxVisits !== null) parts.push(`cm.visits<=${p(rule.maxVisits)}`)
  const visited: string[] = ['cm.last_visit_at IS NOT NULL']
  if (rule.lastVisitAtLeastDaysAgo !== null) visited.push(`cm.last_visit_at<=${at(now - rule.lastVisitAtLeastDaysAgo * DAY_MS)}`)
  if (rule.lastVisitAtMostDaysAgo !== null) visited.push(`cm.last_visit_at>${at(now - (rule.lastVisitAtMostDaysAgo + 1) * DAY_MS)}`)
  parts.push(`(${rule.includeNeverVisited ? 'cm.last_visit_at IS NULL OR ' : ''}(${visited.join(' AND ')}))`)
  if (rule.maxNoShows !== null) parts.push(`cm.no_shows<=${p(rule.maxNoShows)}`)
  if (rule.minSpentCents !== null) parts.push(`cm.spent_cents>=${p(rule.minSpentCents)}`)
  if (rule.tagsAny.length) parts.push(`EXISTS(SELECT 1 FROM unnest(cm.tags) t WHERE lower(t)=ANY(${p(rule.tagsAny.map(t => t.toLowerCase()))}::text[]))`)
  if (rule.tagsNone.length) parts.push(`NOT EXISTS(SELECT 1 FROM unnest(cm.tags) t WHERE lower(t)=ANY(${p(rule.tagsNone.map(t => t.toLowerCase()))}::text[]))`)
  if (rule.languages.length) parts.push(`cm.language=ANY(${p(rule.languages)}::text[])`)
  return { sql: parts.length ? parts.join(' AND ') : 'true', params }
}

/** Clientes del segmento, con tope: devuelve como mucho MAX+1 para saber si se supera sin contar todo. */
export async function countSegment(client: PoolClient, rid: string, rule: SegmentRule, now: number): Promise<number> {
  const where = segmentWhere(rule, now, 3)
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM (SELECT 1 FROM llenamos.customer_marketing cm WHERE cm.restaurant_id=$1 AND ${where.sql} LIMIT $2) x`,
    [rid, MAX_CAMPAIGN_AUDIENCE + 1, ...where.params])
  return rows[0]!.n
}
export async function assertAudienceWithinCap(client: PoolClient, rid: string, rule: SegmentRule, now: number) {
  if (await countSegment(client, rid, rule, now) > MAX_CAMPAIGN_AUDIENCE)
    throw new ApiError(412, 'failed-precondition', `El segmento supera el máximo de ${MAX_CAMPAIGN_AUDIENCE.toLocaleString('es-ES')} clientes por campaña. Afina las condiciones.`)
}

export interface CustomerRow { customer_id: string; name: string; phone: string | null; email: string | null; language: 'es' | 'ca' | 'en'; visits: number; no_shows: number; last_visit_ms: string | null; spent_cents: string; tags: string[]; redacted: boolean }
export async function segmentPage(client: PoolClient, rid: string, rule: SegmentRule, now: number, after: string | null, limit: number): Promise<CustomerRow[]> {
  const where = segmentWhere(rule, now, 4)
  const { rows } = await client.query<CustomerRow>(
    `SELECT cm.customer_id::text,cm.name,cm.phone,cm.email,cm.language,cm.visits,cm.no_shows,
       round(extract(epoch FROM cm.last_visit_at)*1000)::bigint::text AS last_visit_ms,cm.spent_cents::text,cm.tags,cm.redacted
     FROM llenamos.customer_marketing cm WHERE cm.restaurant_id=$1 AND ($2::text IS NULL OR cm.customer_id>$2::bpchar) AND ${where.sql}
     ORDER BY cm.customer_id LIMIT $3`, [rid, after, limit, ...where.params])
  return rows
}

/** Último instante de permiso por cliente y propósito. Basta eso: lo anterior no cambia `hasCurrentConsent` ni «retiró» frente a «nunca dio». */
export async function loadConsents(client: PoolClient, rid: string, purpose: Consent['purpose'], ids: readonly string[], now: number): Promise<Consent[]> {
  const res = await client.query<{ customer_id: string; status: 'granted' | 'withdrawn'; at: string; source: 'public' | 'staff' | 'import' }>(
    `SELECT c.customer_id::text,c.status,round(extract(epoch FROM c.at)*1000)::bigint::text AS at,c.source FROM llenamos.marketing_consents c
     WHERE c.restaurant_id=$1 AND c.purpose=$2 AND c.customer_id=ANY($3::bpchar[]) AND c.at<=to_timestamp($4::bigint/1000.0)
       AND c.at=(SELECT max(m.at) FROM llenamos.marketing_consents m WHERE m.restaurant_id=c.restaurant_id AND m.customer_id=c.customer_id AND m.purpose=c.purpose AND m.at<=to_timestamp($4::bigint/1000.0))`,
    [rid, purpose, [...ids], now])
  return res.rows.map(r => ({ customerId: r.customer_id, purpose, status: r.status, policyVersion: 'x', at: Number(r.at), source: r.source, evidenceId: 'x' }))
}

export interface PageContext { rid: string; rule: SegmentRule; channel: CampaignChannel; settings: MarketingSettings; now: number; ignoreCampaign: string | null }
export interface PageResult { plan: AudiencePlan; rows: Map<string, CustomerRow> }

/** Un contacto ya usado por un destinatario de páginas anteriores: se consulta por hash, nunca se cargan todos. */
export type SeenLookup = (hashes: readonly string[]) => Promise<ReadonlySet<string>>

/** Permiso vigente y envíos recientes de los clientes de la página, y la audiencia con las funciones puras de core. */
export async function evaluatePage(client: PoolClient, ctx: PageContext, customers: readonly CustomerRow[], seen: SeenLookup): Promise<PageResult> {
  const ids = customers.map(c => c.customer_id)
  const purpose = purposeForChannel(ctx.channel)
  const consents = ids.length ? await loadConsents(client, ctx.rid, purpose, ids, ctx.now) : []
  const sendLog = new Map<string, SendLogEntry[]>()
  if (ids.length) {
    const res = await client.query<{ customer_id: string; at: string; campaign_id: string }>(
      `SELECT customer_id::text,round(extract(epoch FROM at)*1000)::bigint::text AS at,campaign_id FROM llenamos.marketing_send_log
       WHERE restaurant_id=$1 AND customer_id=ANY($2::bpchar[]) AND at>to_timestamp(($3::bigint-$4::bigint)/1000.0) AND ($5::text IS NULL OR campaign_id<>$5)`,
      [ctx.rid, ids, ctx.now, 30 * DAY_MS, ctx.ignoreCampaign])
    for (const r of res.rows) sendLog.set(r.customer_id, [...(sendLog.get(r.customer_id) ?? []), { at: Number(r.at), campaignId: r.campaign_id }])
  }
  let points = new Map<string, number>()
  if (ctx.rule.minPoints !== null && ctx.rule.minPoints > 0) points = new Map(await loyaltyPointsPort().balances(client, ctx.rid, ids))
  else if (ctx.rule.minPoints !== null && ids.length) { /* minPoints 0 siempre se cumple */ }
  const candidates: AudienceCandidate[] = customers.map(c => ({
    customerId: c.customer_id, visits: c.visits, noShows: c.no_shows, lastVisitAt: c.last_visit_ms === null ? null : Number(c.last_visit_ms),
    spentCents: Number(c.spent_cents), tags: c.tags, language: c.language, points: ctx.rule.minPoints === null ? null : points.get(c.customer_id) ?? 0,
    phone: c.phone, email: c.email, suppressed: c.redacted,
  }))
  const plan = planCampaignAudience({ candidates, rule: ctx.rule, channel: ctx.channel, consents, sendLog, settings: ctx.settings, now: ctx.now })
  const rows = new Map(customers.map(c => [c.customer_id, c]))
  // Contactos repetidos con páginas anteriores: la repetición se decide antes que la frecuencia, como en core.
  const contactOf = (id: string) => (ctx.channel === 'email' ? rows.get(id)!.email : rows.get(id)!.phone)!
  const candidatesForSeen = [...plan.recipients.map(r => r.customerId), ...plan.excluded.filter(e => e.reason === 'frequency').map(e => e.customerId)]
  if (candidatesForSeen.length) {
    const used = await seen([...new Set(candidatesForSeen.map(id => contactHash(contactOf(id))))])
    const duplicates = new Set(candidatesForSeen.filter(id => used.has(contactHash(contactOf(id)))))
    if (duplicates.size) {
      for (const r of plan.recipients) if (duplicates.has(r.customerId)) { plan.counts.recipients -= 1; plan.counts.duplicate_contact += 1; plan.excluded.push({ customerId: r.customerId, reason: 'duplicate_contact' }) }
      plan.recipients = plan.recipients.filter(r => !duplicates.has(r.customerId))
      for (const e of plan.excluded) if (e.reason === 'frequency' && duplicates.has(e.customerId)) { plan.counts.frequency -= 1; plan.counts.duplicate_contact += 1; e.reason = 'duplicate_contact' }
    }
  }
  return { plan, rows }
}

export interface AudienceSummary { counts: AudiencePlan['counts']; sample: { customerId: string; name: string }[] }
/** Recorre todo el segmento por páginas con cursor (tope MAX_CAMPAIGN_AUDIENCE) y agrega recuentos y una muestra. */
export async function summarizeAudience(client: PoolClient, ctx: PageContext): Promise<AudienceSummary> {
  await assertAudienceWithinCap(client, ctx.rid, ctx.rule, ctx.now)
  const counts: AudiencePlan['counts'] = { no_contact: 0, no_consent: 0, withdrawn: 0, suppressed: 0, frequency: 0, duplicate_contact: 0, audience: 0, recipients: 0 }
  const sample: AudienceSummary['sample'] = []
  const used = new Set<string>()
  let after: string | null = null
  for (;;) {
    const page = await segmentPage(client, ctx.rid, ctx.rule, ctx.now, after, AUDIENCE_PAGE_SIZE)
    if (!page.length) break
    const { plan, rows } = await evaluatePage(client, ctx, page, async hashes => new Set(hashes.filter(h => used.has(h))))
    for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] += plan.counts[key]
    for (const r of plan.recipients) {
      used.add(contactHash(r.to))
      if (sample.length < SAMPLE_SIZE) sample.push({ customerId: r.customerId, name: rows.get(r.customerId)!.name })
    }
    after = page[page.length - 1]!.customer_id
    if (page.length < AUDIENCE_PAGE_SIZE) break
  }
  return { counts, sample }
}
export type { CampaignExclusion }
