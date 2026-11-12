import type { PoolClient } from 'pg'
import * as core from '@llenamos/core'
import { enqueueOutbox } from '../../outbox.js'
import { emitEvent } from '../../events.js'
import { denied, failed, missing, type Scope } from '../comun/acceso.js'
import { buildDay, loadTotals, sumTotals } from './dias.js'
import { factsPort } from './puertos.js'
import { moduleActive, restaurantInfo, stableUuid } from './util.js'

/** Clase de trabajo del outbox que usa el resumen diario: la misma que el envío de avisos del worker (V2). */
export const MESSAGE_KIND = 'mensaje.enviar'

export function defaultAnalytics(): core.AnalyticsSettings {
  return { dailySummary: { enabled: false, hour: '09:00', channels: ['email'], recipientUids: ['owner'], covers: 'previous' }, forecast: { lowOccupancyBp: 3000, highOccupancyBp: 8500, daysAhead: 7 }, lapsedAfterDays: 60 }
}

export async function loadSettings(client: PoolClient, rid: string): Promise<core.AnalyticsSettings> {
  const { rows } = await client.query('SELECT settings FROM llenamos.analytics_settings WHERE restaurant_id=$1', [rid])
  return rows[0] ? core.AnalyticsSettingsSchema.parse(rows[0].settings) : defaultAnalytics()
}

interface Recipient { uid: string; role: string; active: boolean; location_ids: string[]; email: string }
async function recipients(client: PoolClient, rid: string, uids: readonly string[]): Promise<Map<string, Recipient>> {
  const { rows } = await client.query<Recipient>('SELECT uid,role,active,location_ids,email FROM llenamos.analytics_recipients($1,$2)', [rid, [...uids]])
  return new Map(rows.map(r => [r.uid, r]))
}

export async function saveSettings(client: PoolClient, rid: string, uid: string, settings: core.AnalyticsSettings): Promise<{ ok: true }> {
  const found = await recipients(client, rid, settings.dailySummary.recipientUids)
  for (const u of settings.dailySummary.recipientUids) {
    const m = found.get(u)
    if (!m || !m.active || !['owner', 'manager'].includes(m.role)) throw failed('El resumen solo lo recibe personal encargado activo.')
  }
  await client.query(`INSERT INTO llenamos.analytics_settings(restaurant_id,settings,updated_by) VALUES($1,$2,$3)
    ON CONFLICT(restaurant_id) DO UPDATE SET settings=EXCLUDED.settings,updated_by=EXCLUDED.updated_by,updated_at=now()`, [rid, JSON.stringify(settings), uid])
  await emitEvent(client, { restaurantId: rid, topic: 'analisis.ajustes', payload: {} })
  return { ok: true }
}

const channelIds = (rid: string, date: string, uid: string, channel: 'email' | 'whatsapp') => stableUuid(`${rid}:${core.dailySummaryMessageId(date, uid, channel)}`)

/**
 * Prepara el resumen diario del restaurante y lo deja en el outbox (`mensaje.enviar`, plantilla `daily_summary`); NUNCA envía.
 * Necesita el puerto de hechos (cifras de hoy y, si falta la instantánea, del día resumido). Idempotente: un resumen por día
 * y un id de outbox determinista por día, persona y canal. Lo invoca el worker cada 15 minutos (trabajo `analisis.resumen_diario`).
 * Devuelve cuántos destinos se han preparado (0 si no toca, ya existe o el módulo está apagado).
 */
export async function sendDailySummary(client: PoolClient, rid: string, now = Date.now()): Promise<number> {
  if (!(await moduleActive(client, rid, 'analytics'))) return 0
  const config = await loadSettings(client, rid)
  const { timezone, name } = await restaurantInfo(client, rid)
  const date = core.dailySummaryDate(now, timezone, config.dailySummary)
  if (!date) return 0
  if ((await client.query('SELECT 1 FROM llenamos.daily_summaries WHERE restaurant_id=$1 AND date=$2', [rid, date])).rowCount) return 0
  const locations = (await client.query<{ id: string }>('SELECT id FROM llenamos.locations WHERE restaurant_id=$1 ORDER BY id', [rid])).rows.map(r => r.id)
  const priorDate = core.sumarDias(date, -7), today = core.horaLocal(now, timezone).fecha
  const cache = new Map<string, ReturnType<typeof buildDay>>()
  const day = async (lid: string, d: string) => {
    const key = `${lid}|${d}`
    if (!cache.has(key)) cache.set(key, buildDay(await factsPort().dayFacts(client, rid, lid, d, timezone), lid, d, timezone))
    return cache.get(key)!
  }
  const totalsOf = async (d: string) => {
    const out: core.MetricTotals[] = []
    for (const lid of locations) {
      const snap = await loadTotals(client, rid, [lid], d, d)
      out.push(snap[0] ?? (await day(lid, d)).totals)
    }
    return sumTotals(out)
  }
  const totals = await totalsOf(date), previous = await totalsOf(priorDate)
  const reservations: core.ReservationFact[] = []
  for (const lid of locations) {
    const facts = await factsPort().dayFacts(client, rid, lid, today, timezone)
    reservations.push(...facts.reservations.filter(r => core.horaLocal(r.startAt, timezone).fecha === today && r.status !== 'cancelled'))
  }
  const alerts: string[] = []
  if ((await client.query("SELECT 1 FROM llenamos.recommendations WHERE restaurant_id=$1 AND status='open' LIMIT 1", [rid])).rowCount) alerts.push('Hay recomendaciones pendientes')
  const extra = await factsPort().openAlerts?.(client, rid, locations)
  if (extra) alerts.push(...extra)
  const text = core.renderDailySummary({
    date, restaurantName: name, totals, previous: core.hasBase(previous) ? previous : null,
    today: { reservations: reservations.length, covers: reservations.reduce((s, r) => s + r.partySize, 0), pending: reservations.filter(r => r.status === 'pending').length }, alerts,
  })
  const found = await recipients(client, rid, config.dailySummary.recipientUids)
  const sentTo: { uid: string; channel: 'email' | 'whatsapp'; status: string }[] = []
  const queue: { id: string; request: core.MessageRequest }[] = []
  for (const uid of config.dailySummary.recipientUids) {
    const m = found.get(uid)
    // El resumen es global: no se entrega a quien tenga el acceso limitado a locales.
    if (!m?.active || !['owner', 'manager'].includes(m.role) || m.location_ids.length) continue
    for (const channel of config.dailySummary.channels) {
      // `memberships` no guarda teléfono: por WhatsApp no hay contacto y queda `not_configured`, como el original sin dato.
      const contact = channel === 'email' ? m.email : null
      if (!contact) { sentTo.push({ uid, channel, status: 'not_configured' }); continue }
      queue.push({ id: channelIds(rid, date, uid, channel), request: core.MessageRequestSchema.parse({ channel, to: contact, template: 'daily_summary', language: 'es', data: { summaryText: text, restaurantName: name }, reservationId: null, waitlistId: null, sendAt: now }) })
      sentTo.push({ uid, channel, status: 'queued' })
    }
  }
  const inserted = await client.query('INSERT INTO llenamos.daily_summaries(restaurant_id,date,text,totals,sent_to) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
    [rid, date, text, JSON.stringify(totals), JSON.stringify(sentTo)])
  if (!inserted.rowCount) return 0
  for (const q of queue) await enqueueOutbox(client, { id: q.id, restaurantId: rid, kind: MESSAGE_KIND, payload: q.request, availableAt: new Date(now) })
  await emitEvent(client, { restaurantId: rid, topic: 'analisis.resumen', entityId: date, payload: { date } })
  return sentTo.length
}

const OUTBOX_STATUS: Record<string, string> = { pending: 'queued', leased: 'queued', done: 'sent', failed: 'failed', quarantined: 'failed' }

export async function viewSummary(client: PoolClient, rid: string, scope: Scope, d: { date: string }) {
  // Un resumen global no se entrega a un encargado limitado a un local.
  if (scope.locationIds.length) throw denied()
  const { rows } = await client.query('SELECT text,sent_to FROM llenamos.daily_summaries WHERE restaurant_id=$1 AND date=$2', [rid, d.date])
  if (!rows[0]) throw missing('No hay resumen guardado para esa fecha.')
  const stored = rows[0].sent_to as { uid: string; channel: 'email' | 'whatsapp'; status: string }[]
  const ids = stored.filter(s => s.status !== 'not_configured').map(s => channelIds(rid, d.date, s.uid, s.channel))
  const states = new Map<string, string>()
  // Por id determinista: nunca se recorre el outbox.
  if (ids.length) for (const r of (await client.query<{ id: string; status: string }>('SELECT id,status FROM llenamos.outbox WHERE restaurant_id=$1 AND id=ANY($2::uuid[])', [rid, ids])).rows) states.set(r.id, OUTBOX_STATUS[r.status] ?? r.status)
  return { date: d.date, text: rows[0].text as string, sentTo: stored.map(s => ({ ...s, status: s.status === 'not_configured' ? s.status : states.get(channelIds(rid, d.date, s.uid, s.channel)) ?? s.status })) }
}
