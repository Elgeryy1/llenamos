import type { PoolClient } from 'pg'
import * as core from '@llenamos/core'
import { ApiError } from '../../errors.js'
import { assertLocation, visibleLocations, type Scope } from '../comun/acceso.js'
import { buildDay, combineDishes, combineHours, combineMargin, loadDays, loadTotals, sumTotals, type DayRecord } from './dias.js'
import { factsPort, FACTS_UNAVAILABLE, isPortUnavailable, originsPort, reservationsPort } from './puertos.js'
import { dates, moduleActive, restaurantInfo } from './util.js'

type PanelInput = core.CallableInput<'panelAnalisis'>
type PanelOutput = core.CallableOutput<'panelAnalisis'>

/**
 * Panel de análisis. Lee SOLO filas de `analytics_days` del rango pedido (y del anterior para comparar), por clave
 * primaria, más el cálculo vivo de HOY mediante el puerto de hechos. Los días cerrados sin instantánea cuentan como vacíos:
 * no se inventan ni se calculan aquí; se rellenan con `backfillDays` / `aggregateRecentDays` (trabajo `analisis.agregar_dia`).
 * Los días futuros tampoco tienen datos. Si el puerto de hechos aún no está conectado, el panel sigue con las instantáneas y
 * `computedAt` indica hasta cuándo llegan.
 */
export async function buildPanel(client: PoolClient, rid: string, scope: Scope, d: PanelInput, now = Date.now()): Promise<{ output: PanelOutput; dishes: { rows: core.DishSalesRow[]; zeroSales: core.DishSalesRow[] } }> {
  const ids = await visibleLocations(client, rid, scope, d.locationIds)
  const { timezone } = await restaurantInfo(client, rid)
  const today = core.horaLocal(now, timezone).fecha
  const records: DayRecord[] = await loadDays(client, rid, ids, d.from, d.to)
  let live = false
  if (today >= d.from && today <= d.to) {
    try {
      const fresh: DayRecord[] = []
      for (const lid of ids) fresh.push({ ...buildDay(await factsPort().dayFacts(client, rid, lid, today, timezone), lid, today, timezone), computedAt: now })
      for (const record of fresh) {
        const at = records.findIndex(r => r.locationId === record.locationId && r.date === today)
        if (at >= 0) records[at] = record; else records.push(record)
      }
      live = true
    } catch (error) {
      if (!isPortUnavailable(error, FACTS_UNAVAILABLE)) throw error
    }
  }
  const prev = core.previousRange(d.from, d.to)
  const previous = (d.compare ?? "previous") === "previous" ? sumTotals(await loadTotals(client, rid, ids, prev.from, prev.to)) : null
  const ds = dates(d.from, d.to)
  const total = sumTotals(records.map(r => r.totals))
  const byLocation = Object.fromEntries(ids.map(id => [id, sumTotals(records.filter(r => r.locationId === id).map(r => r.totals))]))
  const dishes = combineDishes(records)
  const hours = combineHours(records, d.slotMinutes ?? 60)
  const margin = core.can(scope.role as core.Role, 'costes.ver') && await moduleActive(client, rid, 'inventory') ? combineMargin(records) : null
  const computedAt = live ? now : records.reduce((m, r) => Math.max(m, r.computedAt), 0)
  const output: PanelOutput = {
    from: d.from, to: d.to, total: core.deriveMetrics(total),
    comparison: previous ? core.comparePeriods(total, previous) : null,
    byLocation: core.compareLocations(byLocation).rows,
    byDay: ds.map(date => ({ date, metrics: core.deriveMetrics(sumTotals(records.filter(r => r.date === date).map(r => r.totals))) })),
    hours: { slots: hours.slots, peak: hours.peak },
    dishes: {
      top: dishes.rows.slice(0, 20), bottom: [...dishes.rows].reverse().slice(0, 20),
      zeroSales: dishes.zeroSales.slice(0, 200).map(x => ({ itemId: x.itemId, name: x.name })),
    },
    margin, computedAt,
  }
  return { output, dishes }
}

const LABELS: Record<string, string> = {
  fecha: 'Fecha', date: 'Fecha', locationId: 'Local', itemId: 'Id de plato', name: 'Plato', units: 'Unidades', unitsInMenu: 'Unidades en menú', salesCents: 'Ventas (€)',
  grossSalesCents: 'Ventas brutas (€)', netSalesCents: 'Ventas netas (€)', refundCents: 'Devoluciones (€)', discountCents: 'Descuentos (€)', bills: 'Cuentas', guests: 'Comensales',
  averageTicketCents: 'Ticket medio (€)', averagePerGuestCents: 'Gasto por comensal (€)', rotationBp: 'Rotación (%)', revenuePerSeatHourCents: 'Ingreso por plaza y hora (€)',
  occupancyBp: 'Ocupación (%)', noShowBp: 'No presentados (%)', noShows: 'No presentados', noShowCovers: 'Comensales no presentados', salesShareBp: 'Parte de ventas (%)',
  slot: 'Hora', reservations: 'Reservas', reservationCovers: 'Comensales reservados', channel: 'Canal', campaignId: 'Campaña', adId: 'Anuncio', covers: 'Comensales', seated: 'Presentados', cancelled: 'Canceladas',
}

export async function exportCsv(client: PoolClient, rid: string, scope: Scope, d: core.CallableInput<'exportarAnalisis'>, now = Date.now()) {
  let rows: Record<string, core.CsvCell>[]
  if (d.kind === 'origins') {
    if (!(await moduleActive(client, rid, 'marketing'))) throw new ApiError(403, 'permission-denied', 'Este módulo no está activo en el plan del restaurante.')
    const ids = await visibleLocations(client, rid, scope, d.locationIds)
    rows = (await originsPort().originReportRows(client, rid, { from: d.from, to: d.to, locationIds: ids })).map(r => ({ ...r }))
  } else {
    const { output: panel, dishes } = await buildPanel(client, rid, scope, { restaurantId: rid, from: d.from, to: d.to, locationIds: d.locationIds, compare: 'none', slotMinutes: 60 }, now)
    if (d.kind === 'sales_by_day') rows = panel.byDay.map(x => ({ date: x.date, ...x.metrics }))
    else if (d.kind === 'locations') rows = panel.byLocation.map(x => ({ locationId: x.locationId, ...x.metrics, salesShareBp: x.salesShareBp }))
    else if (d.kind === 'hours') rows = panel.hours.slots.map(x => ({ ...x }))
    else rows = [...dishes.rows, ...dishes.zeroSales].map(x => ({ ...x }))
  }
  const keys = rows.length ? Object.keys(rows[0]!) : ['fecha']
  const csv = core.toCsv(rows, keys.map(k => ({ header: LABELS[k] ?? k, value: (r: Record<string, core.CsvCell>) => r[k] ?? null, kind: k.endsWith('Cents') ? 'cents' as const : k.endsWith('Bp') ? 'bp' as const : 'text' as const })))
  if (csv.length > 4_900_000) throw new ApiError(412, 'failed-precondition', 'La exportación es demasiado grande. Elige un periodo más corto o menos locales.')
  return { filename: core.csvFilename(d.kind, d.from, d.to), csv, rows: rows.length }
}

/** Previsión de ocupación de un local. Historial acotado a 84 días más los días pedidos, siempre por el puerto de reservas. */
export async function computeForecast(client: PoolClient, rid: string, locationId: string, from: string, days: number, now = Date.now()) {
  const { timezone } = await restaurantInfo(client, rid)
  const historyFrom = core.sumarDias(from, -84), to = core.sumarDias(from, days - 1)
  const inputs = await reservationsPort().forecastInputs(client, rid, locationId, { historyFrom, from, to, timezone })
  const snap = await client.query<{ d: string }>('SELECT date::text AS d FROM llenamos.analytics_days WHERE restaurant_id=$1 AND location_id=$2 AND date BETWEEN $3 AND $4', [rid, locationId, historyFrom, to])
  // Tener un horario hoy no demuestra doce semanas de servicio: solo cuentan los días con mesas o instantánea.
  const observed = new Set([...inputs.sessions.map(s => core.horaLocal(s.openedAt, timezone).fecha), ...snap.rows.map(r => r.d)])
  const today = core.horaLocal(now, timezone).fecha
  const history = dates(historyFrom, to).filter(date => observed.has(date) && date < today)
    .map(date => ({ date, open: (inputs.openMinutesByDate[date] ?? 0) > 0, slots: core.presenceBySlot(inputs.sessions, date, timezone, now) }))
  const live = inputs.reservations.filter(r => ['confirmed', 'pending', 'seated'].includes(r.status))
    .map(r => ({ openedAt: r.startAt, closedAt: r.startAt + r.durationMinutes * 60000, guests: r.partySize }))
  return {
    seats: inputs.seats,
    days: dates(from, to).map(date => {
      const day = core.forecastDay({ date, history, seats: inputs.seats, booked: core.presenceBySlot(live, date, timezone, now) })
      return { ...day, peak: day.peak?.slot ?? null }
    }),
  }
}

export async function forecastFor(client: PoolClient, rid: string, scope: Scope, d: core.CallableInput<'previsionOcupacion'>, now = Date.now()) {
  await assertLocation(client, rid, scope, d.locationId)
  return computeForecast(client, rid, d.locationId, d.from, d.days, now)
}
