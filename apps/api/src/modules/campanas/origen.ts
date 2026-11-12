import type { PoolClient } from 'pg'
import {
  classifyOrigin, hostOf, purposeForChannel, type OriginChannel, type OriginReportRow, type PublicMarketingOptIn,
  type ReservationAttributionInput, type ReservationSource,
} from '@llenamos/core'
import { recordConsent } from '../comun/clientes.js'
import { publicAppOrigin, reservationsWithoutOrigin } from './config.js'

export interface ReservationOriginInput {
  restaurantId: string
  locationId: string
  reservationId: string
  reservationSource: ReservationSource
  /** Lo que mandó la web (se limpia en core); null si la reserva no vino de un navegador. */
  attribution: ReservationAttributionInput | null
  /** Día de servicio local `YYYY-MM-DD` y comensales de la reserva. */
  serviceDate: string
  partySize: number
  restaurantHosts?: readonly string[]
}

/**
 * Para la creación de reservas (V3): llamar DENTRO de su transacción. Clasifica el origen con core
 * (último toque, sin URL completa ni valor de los clics de anuncios) y lo guarda. Repetir es inocuo.
 */
export async function recordReservationOrigin(client: PoolClient, o: ReservationOriginInput): Promise<void> {
  let ownHosts: string[] = []
  try { const host = hostOf(publicAppOrigin()); if (host) ownHosts = [host] } catch { /* sin origen configurado no hay dominio propio que excluir */ }
  const c = classifyOrigin({ reservationSource: o.reservationSource, attribution: o.attribution, ownHosts, ...(o.restaurantHosts ? { restaurantHosts: o.restaurantHosts } : {}) })
  await client.query(`INSERT INTO llenamos.reservation_origins(restaurant_id,location_id,reservation_id,channel,paid,source,medium,campaign,content,term,ad_id,campaign_id,click_ids,referrer_host,embed_host,reservation_source,service_date,party_size)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT(restaurant_id,reservation_id) DO NOTHING`,
    [o.restaurantId, o.locationId, o.reservationId, c.channel, c.paid, c.source, c.medium, c.campaign, c.content, c.term, c.adId, c.campaignId, c.clickIds, c.referrerHost, c.embedHost, c.reservationSource, o.serviceDate, o.partySize])
}

/** Casillas de marketing de la web pública (desmarcadas por defecto): una `granted` por casilla marcada, con la reserva como evidencia. */
export async function recordReservationConsents(client: PoolClient, p: { restaurantId: string; reservationId: string; customerId: string; optIn: PublicMarketingOptIn | undefined; at: number }): Promise<void> {
  for (const channel of ['email', 'whatsapp'] as const) {
    if (!p.optIn?.[channel]) continue
    await recordConsent(client, { restaurantId: p.restaurantId, id: `reservation.${p.reservationId}.${channel}`, customerId: p.customerId, purpose: purposeForChannel(channel),
      status: 'granted', policyVersion: p.optIn.policyVersion, at: p.at, source: 'public', evidenceId: p.reservationId })
  }
}

export type OriginStatus = 'pending' | 'confirmed' | 'seated' | 'finished' | 'cancelled' | 'no_show'
/** Para reservas (V3) y caja (V5): estado final, comensales y ventas cobradas (IVA incluido, netas de devoluciones) de la reserva. */
export async function updateOriginOutcome(client: PoolClient, rid: string, reservationId: string, outcome: { status?: OriginStatus; partySize?: number; salesCents?: number }): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE llenamos.reservation_origins SET final_status=coalesce($3,final_status),party_size=coalesce($4,party_size),sales_cents=coalesce($5,sales_cents) WHERE restaurant_id=$1 AND reservation_id=$2`,
    [rid, reservationId, outcome.status ?? null, outcome.partySize ?? null, outcome.salesCents ?? null])
  return rowCount === 1
}

/** Máximo de filas del informe (canal x campaña x anuncio) por consulta. */
export const ORIGIN_REPORT_MAX_ROWS = 500
const ORIGIN_CHANNELS_ORDER = (a: OriginReportRow, b: OriginReportRow) =>
  b.reservations - a.reservations || a.channel.localeCompare(b.channel) || (a.campaignId ?? '').localeCompare(b.campaignId ?? '') || (a.adId ?? '').localeCompare(b.adId ?? '')

/**
 * Informe de origen por agregados SQL sobre `reservation_origins` (índice por local y fecha). Reutilizable
 * por análisis (`exportarAnalisis` kind origins). `locationIds` ya resueltos y dentro del alcance de quien pide.
 * `withoutOrigin` sale del puerto de reservas (V3); sin puerto conectado vale 0.
 */
export async function originReportRows(client: PoolClient, rid: string, locationIds: readonly string[], from: string, to: string): Promise<{ rows: OriginReportRow[]; withoutOrigin: number }> {
  if (!locationIds.length) return { rows: [], withoutOrigin: 0 }
  const { rows } = await client.query<{ channel: OriginChannel; campaign_id: string | null; ad_id: string | null; reservations: number; covers: string; seated: number; no_shows: number; cancelled: number; sales: string }>(
    `SELECT channel,campaign_id,ad_id,count(*)::int AS reservations,sum(party_size)::text AS covers,
       count(*) FILTER (WHERE final_status IN ('seated','finished'))::int AS seated,count(*) FILTER (WHERE final_status='no_show')::int AS no_shows,
       count(*) FILTER (WHERE final_status='cancelled')::int AS cancelled,sum(sales_cents)::text AS sales
     FROM llenamos.reservation_origins WHERE restaurant_id=$1 AND location_id=ANY($2::text[]) AND service_date BETWEEN $3::date AND $4::date
     GROUP BY channel,campaign_id,ad_id ORDER BY count(*) DESC,channel,campaign_id NULLS FIRST,ad_id NULLS FIRST LIMIT $5`,
    [rid, [...locationIds], from, to, ORIGIN_REPORT_MAX_ROWS])
  const result = rows.map<OriginReportRow>(r => ({ channel: r.channel, campaignId: r.campaign_id, adId: r.ad_id, reservations: r.reservations, covers: Number(r.covers), seated: r.seated, noShows: r.no_shows, cancelled: r.cancelled, salesCents: Number(r.sales) }))
  result.sort(ORIGIN_CHANNELS_ORDER)
  return { rows: result, withoutOrigin: await reservationsWithoutOrigin().count(client, rid, locationIds, from, to) }
}
