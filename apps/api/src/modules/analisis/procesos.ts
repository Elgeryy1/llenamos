import type { PoolClient } from 'pg'
import * as core from '@llenamos/core'
import { emitEvent } from '../../events.js'
import { computeForecast } from './panel.js'
import { loadSettings } from './resumen.js'
import { insertAutomationEvent } from './eventos.js'
import { isPortUnavailable, RESERVATIONS_UNAVAILABLE } from './puertos.js'
import { moduleActive, restaurantInfo } from './util.js'

const DAY = 86_400_000
/** Tope de recomendaciones nuevas por pasada de `evaluateAutomations`. */
export const MAX_RECOMMENDATIONS_PER_RUN = 200
/** Eventos que se leen por página al evaluar una regla. */
const EVENT_PAGE = 500
/** Clientes que se revisan como máximo por pasada de `dailyEvents` (más recientes primero). */
export const MAX_LAPSED_PER_RUN = 2000
const LAPSED_PAGE = 250
/** Los eventos de automatización se conservan 100 días (las reglas miran 92). */
export const EVENT_RETENTION_DAYS = 100

/**
 * Evalúa las reglas activas contra los eventos nuevos y crea recomendaciones (como mucho 200 por pasada). Cada regla guarda
 * el punto hasta donde ha evaluado (`cursor_at`, con 10 minutos de solape; las recomendaciones tienen id determinista, así
 * que repetir no duplica) y solo lee eventos de su tipo de los últimos 92 días, por el índice (restaurante, tipo, fecha).
 * Trabajo `analisis.evaluar`: tras crear eventos o cada pocos minutos.
 */
export async function evaluateAutomations(client: PoolClient, rid: string, now = Date.now()): Promise<number> {
  if (!(await moduleActive(client, rid, 'analytics'))) return 0
  const rules = (await client.query('SELECT id,rule,cursor_at FROM llenamos.automation_rules WHERE restaurant_id=$1 ORDER BY id LIMIT 100', [rid])).rows
  const horizon = now - 92 * DAY
  let created = 0
  for (const row of rules) {
    if (created >= MAX_RECOMMENDATIONS_PER_RUN) break
    const parsed = core.AutomationRuleInputSchema.safeParse(row.rule)
    if (!parsed.success || !parsed.data.enabled) continue
    const rule = parsed.data
    let afterAt = Math.max(horizon, (row.cursor_at ? row.cursor_at.getTime() : horizon) - 10 * 60_000), afterId = ''
    let processedAt: number | null = null
    scan: for (;;) {
      const page = (await client.query(`SELECT id,type,location_id,subject,at,data FROM llenamos.automation_events
        WHERE restaurant_id=$1 AND type=$2 AND NOT redacted AND (at,id)>($3,$4) AND at<=$5 ORDER BY at,id LIMIT $6`,
      [rid, rule.event, new Date(afterAt), afterId, new Date(now), EVENT_PAGE])).rows
      if (!page.length) break
      const lastRows = await client.query<{ subject: string; at: Date }>('SELECT subject,max(created_at) AS at FROM llenamos.recommendations WHERE restaurant_id=$1 AND rule_id=$2 AND subject=ANY($3) GROUP BY subject',
        [rid, row.id, [...new Set(page.map(e => e.subject as string))]])
      const last = new Map(lastRows.rows.map(r => [r.subject, r.at.getTime()]))
      for (const e of page) {
        const event = core.AutomationEventInstanceSchema.parse({ id: e.id, type: e.type, locationId: e.location_id, subject: e.subject, at: e.at.getTime(), data: e.data })
        const id = core.automationFiringId(row.id, event.id)
        if (id.length <= 300 && core.evaluateRule(rule, event, last.get(event.subject) ?? null).fire) {
          const inserted = await client.query(`INSERT INTO llenamos.recommendations(restaurant_id,id,rule_id,event_id,event_type,location_id,subject,kind,text,evidence,created_at,expires_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
          [rid, id, row.id, event.id, event.type, event.locationId, event.subject, rule.recommendation.kind, rule.recommendation.note ?? core.RECOMMENDATION_LABEL[rule.recommendation.kind], JSON.stringify(event.data), new Date(event.at), new Date(now + 7 * DAY)])
          if (inserted.rowCount) { created++; last.set(event.subject, event.at) }
        }
        processedAt = event.at
        if (created >= MAX_RECOMMENDATIONS_PER_RUN) break scan
      }
      const tail = page[page.length - 1]
      afterAt = tail.at.getTime(); afterId = tail.id
      if (page.length < EVENT_PAGE) break
    }
    if (processedAt !== null) await client.query('UPDATE llenamos.automation_rules SET cursor_at=$3 WHERE restaurant_id=$1 AND id=$2', [rid, row.id, new Date(processedAt)])
  }
  if (created) await emitEvent(client, { restaurantId: rid, topic: 'analisis.recomendacion', payload: { created } })
  return created
}

/** Caduca las recomendaciones abiertas pasadas de fecha, en lotes con LIMIT (trabajo diario `analisis.caducar`). */
export async function expireRecommendations(client: PoolClient, rid: string, now = Date.now(), batch = 500, maxBatches = 20): Promise<number> {
  let total = 0
  for (let i = 0; i < maxBatches; i++) {
    const r = await client.query(`UPDATE llenamos.recommendations SET status='expired' WHERE restaurant_id=$1 AND id IN
      (SELECT id FROM llenamos.recommendations WHERE restaurant_id=$1 AND status='open' AND expires_at<=$2 ORDER BY expires_at,id LIMIT $3)`, [rid, new Date(now), batch])
    total += r.rowCount ?? 0
    if ((r.rowCount ?? 0) < batch) break
  }
  if (total) await emitEvent(client, { restaurantId: rid, topic: 'analisis.recomendacion', payload: { expired: total } })
  return total
}

/** Borra por lotes los eventos de automatización con más de 100 días. */
export async function purgeAutomationEvents(client: PoolClient, rid: string, now = Date.now(), batch = 1000, maxBatches = 20): Promise<number> {
  let total = 0
  for (let i = 0; i < maxBatches; i++) {
    const r = await client.query(`DELETE FROM llenamos.automation_events WHERE restaurant_id=$1 AND id IN
      (SELECT id FROM llenamos.automation_events WHERE restaurant_id=$1 AND at<$2 ORDER BY at LIMIT $3)`, [rid, new Date(now - EVENT_RETENTION_DAYS * DAY), batch])
    total += r.rowCount ?? 0
    if ((r.rowCount ?? 0) < batch) break
  }
  return total
}

/**
 * Eventos diarios: `customer.lapsed` (desde `customer_marketing`, páginas con cursor por última visita, los más recientes
 * primero y como mucho 2000 por pasada) y los de previsión (puerto de reservas; si no está conectado se omiten y se avisa).
 * Ids deterministas con la fecha: repetir el mismo día no duplica. Trabajo diario `analisis.eventos_diarios`.
 */
export async function dailyEvents(client: PoolClient, rid: string, now = Date.now()): Promise<{ lapsed: number; truncated: boolean; forecast: number; forecastSkipped: boolean }> {
  const out = { lapsed: 0, truncated: false, forecast: 0, forecastSkipped: false }
  if (!(await moduleActive(client, rid, 'analytics'))) return out
  const config = await loadSettings(client, rid)
  const { timezone } = await restaurantInfo(client, rid)
  const date = core.horaLocal(now, timezone).fecha
  const cutoff = new Date(now - config.lapsedAfterDays * DAY)
  let cursorAt = new Date(now + DAY), cursorId = 'g', scanned = 0
  while (scanned < MAX_LAPSED_PER_RUN) {
    const { rows } = await client.query(`SELECT customer_id,visits,spent_cents,last_visit_at FROM llenamos.customer_marketing
      WHERE restaurant_id=$1 AND NOT redacted AND last_visit_at IS NOT NULL AND last_visit_at<=$2 AND (last_visit_at,customer_id)<($3,$4)
      ORDER BY last_visit_at DESC,customer_id DESC LIMIT $5`, [rid, cutoff, cursorAt, cursorId, LAPSED_PAGE])
    for (const c of rows) {
      const days = Math.floor((now - c.last_visit_at.getTime()) / DAY)
      if (await insertAutomationEvent(client, rid, { id: `customer.lapsed.${c.customer_id}.${date}`, type: 'customer.lapsed', locationId: null, subject: c.customer_id, at: now, data: { daysSinceVisit: days, visits: Number(c.visits), spentCents: Number(c.spent_cents) } })) out.lapsed++
    }
    scanned += rows.length
    if (rows.length < LAPSED_PAGE) break
    const tail = rows[rows.length - 1]
    cursorAt = tail.last_visit_at; cursorId = tail.customer_id
    if (scanned >= MAX_LAPSED_PER_RUN) out.truncated = true
  }
  if (await moduleActive(client, rid, 'reservations')) {
    const locations = (await client.query<{ id: string }>('SELECT id FROM llenamos.locations WHERE restaurant_id=$1 ORDER BY id', [rid])).rows
    try {
      for (const l of locations) {
        const forecast = await computeForecast(client, rid, l.id, date, config.forecast.daysAhead, now)
        for (const day of forecast.days) {
          const occupancyBp = Math.max(0, ...day.slots.map(s => s.occupancyBp ?? 0))
          const type = occupancyBp < config.forecast.lowOccupancyBp ? 'forecast.low_occupancy' : occupancyBp > config.forecast.highOccupancyBp ? 'forecast.high_occupancy' : null
          if (!type) continue
          if (await insertAutomationEvent(client, rid, { id: `${type}.${l.id}.${day.date}.${date}`, type, locationId: l.id, subject: day.date, at: now, data: { occupancyBp, daysAhead: Math.round((Date.parse(day.date) - Date.parse(date)) / DAY), confidence: day.confidence } })) out.forecast++
        }
      }
    } catch (error) {
      if (!isPortUnavailable(error, RESERVATIONS_UNAVAILABLE)) throw error
      out.forecastSkipped = true
    }
  }
  return out
}

/**
 * Evento de una reserva que no se presenta o se cancela. Lo llama el módulo de reservas (V3) dentro de la transacción que
 * cambia el estado, con los datos ya leídos (aquí no hay tabla de reservas). Id determinista: una vez por reserva y tipo.
 */
export async function recordReservationEvent(client: PoolClient, rid: string, r: { locationId: string; reservationId: string; status: string; partySize: number; customerId: string | null; customerNoShows: number; hasDeposit: boolean; startAt: number }, now = Date.now()): Promise<boolean> {
  if (!['no_show', 'cancelled'].includes(r.status) || !(await moduleActive(client, rid, 'analytics'))) return false
  const type = r.status === 'no_show' ? 'reservation.no_show' : 'reservation.cancelled'
  return insertAutomationEvent(client, rid, {
    id: `${type}.${r.locationId}.${r.reservationId}`, type, locationId: r.locationId, subject: r.customerId ?? r.reservationId, at: now,
    data: type === 'reservation.no_show' ? { partySize: r.partySize, customerNoShows: r.customerNoShows, hasDeposit: r.hasDeposit } : { partySize: r.partySize, hoursBeforeStart: Math.max(0, Math.floor((r.startAt - now) / 3_600_000)) },
  })
}

/** Evento de existencias bajo mínimos. Lo llama inventario (V6) al abrir una alerta; `occurrence` distingue aperturas sucesivas. */
export async function recordStockLowEvent(client: PoolClient, rid: string, s: { locationId: string; alertId: string; occurrence: string; level: string }, now = Date.now()): Promise<boolean> {
  if (!(await moduleActive(client, rid, 'analytics'))) return false
  return insertAutomationEvent(client, rid, { id: `stock.low.${s.locationId}.${s.alertId}.${s.occurrence}`, type: 'stock.low', locationId: s.locationId, subject: s.alertId, at: now, data: { level: s.level, daysToRunOut: 0 } })
}
