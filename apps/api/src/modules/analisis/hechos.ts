import type { PoolClient } from 'pg'
import * as core from '@llenamos/core'
import type { AnalyticsFactsPort, AnalyticsReservationsPort, DayFacts } from './puertos.js'

const DAY = 86_400_000
/** Una cuenta puede abrirse días antes de cobrarse; se buscan las abiertas hasta 3 días antes del día (por el índice de estado y apertura). */
const OPEN_LOOKBACK = 3 * DAY

const dayRange = (date: string, tz: string) => {
  const start = core.instanteDeHoraLocal(date, 0, tz) ?? Date.parse(date)
  return { start, end: core.instanteDeHoraLocal(core.sumarDias(date, 1), 0, tz) ?? start + DAY }
}

/**
 * Hechos de UN local y UN día local leídos de lo que ya guardan caja (`pos_bills`, `pos_payments`), sala (mesas, líneas, carta),
 * reservas (reservas, mesas, horarios) e inventario (costes congelados). Cada consulta es por local y día con su índice y las
 * demás por clave primaria de las cuentas del día: nunca se lee un histórico. Es el equivalente a `facts()` del original.
 * Límite: una cuenta abierta hace más de 3 días y cobrada hoy no entra en el día (caso muy raro).
 */
export async function postgresDayFacts(client: PoolClient, rid: string, lid: string, date: string, tz: string): Promise<DayFacts> {
  const { start, end } = dayRange(date, tz)
  const bills = (await client.query<{ id: string; data: core.Bill }>(
    `SELECT id,data FROM llenamos.pos_bills WHERE restaurant_id=$1 AND location_id=$2 AND status='settled' AND opened_at>=$3 AND opened_at<$4
       AND (data->>'settledAt')::bigint>=$5 AND (data->>'settledAt')::bigint<$6 ORDER BY id LIMIT 5000`,
    [rid, lid, new Date(start - OPEN_LOOKBACK), new Date(end), start, end])).rows
  const sessionIds = bills.filter(b => b.data.target.kind === 'session').map(b => b.data.target.id)
  const sessions = new Map((sessionIds.length ? (await client.query<{ id: string; doc: { openedAt?: number; closedAt?: number | null; guests?: number } }>(
    'SELECT id,doc FROM llenamos.sala_table_sessions WHERE restaurant_id=$1 AND location_id=$2 AND id=ANY($3)', [rid, lid, sessionIds])).rows : []).map(r => [r.id, r.doc]))
  const paid = bills.length ? (await client.query<{ bill_id: string; tip: string }>(
    "SELECT bill_id,sum((data->>'tipCents')::bigint)::text AS tip FROM llenamos.pos_payments WHERE restaurant_id=$1 AND location_id=$2 AND bill_id=ANY($3) AND kind='charge' AND status='succeeded' GROUP BY bill_id",
    [rid, lid, bills.map(b => b.id)])).rows : []
  const tips = new Map(paid.map(r => [r.bill_id, Number(r.tip)]))
  const factBills: core.BillFact[] = [], sold: core.SoldLineFact[] = [], lineIds: string[] = []
  const netByBill = new Map<string, core.BillLine[]>()
  for (const b of bills) {
    const bill = b.data, net = core.netBillLines(bill.lines, bill.adjustments), session = bill.target.kind === 'session' ? sessions.get(bill.target.id) : undefined
    netByBill.set(b.id, net)
    const adj = (kind: string) => bill.adjustments.filter(a => a.kind === kind).reduce((sum, a) => sum + a.amountCents, 0)
    factBills.push({
      billId: b.id, locationId: lid, kind: bill.target.kind, openedAt: session?.openedAt ?? bill.openedAt, settledAt: bill.settledAt!, closedAt: session?.closedAt ?? bill.settledAt,
      orderedCents: bill.lines.reduce((sum, l) => sum + l.grossCents, 0), invitationCents: adj('invitation'), voidCents: adj('void'), discountCents: adj('discount'),
      totalCents: bill.totalCents, netCents: net.reduce((sum, l) => sum + core.netOfGross(l.grossCents, l.taxRate), 0), tipCents: tips.get(b.id) ?? 0, guests: session?.guests ?? 0,
    })
    lineIds.push(...net.map(l => l.lineId))
  }
  const orderLines = new Map((lineIds.length ? (await client.query<{ id: string; doc: { itemId?: string | null; status?: string; kind?: 'item' | 'menu_component' | 'menu'; quantity?: number } }>(
    'SELECT id,doc FROM llenamos.sala_order_lines WHERE restaurant_id=$1 AND location_id=$2 AND id=ANY($3)', [rid, lid, lineIds])).rows : []).map(r => [r.id, r.doc]))
  for (const net of netByBill.values()) for (const l of net) {
    const order = orderLines.get(l.lineId)
    if (!order?.itemId || order.status === 'cancelled' || order.kind === 'menu') continue
    sold.push({ itemId: order.itemId, kind: order.kind ?? 'item', quantity: order.quantity ?? 1, netOfAdjustmentsCents: l.grossCents })
  }
  const costs = lineIds.length ? (await client.query<{ doc: core.LineCost }>('SELECT doc FROM llenamos.inv_line_costs WHERE restaurant_id=$1 AND location_id=$2 AND id=ANY($3)', [rid, lid, lineIds])).rows.map(r => r.doc) : []

  // Devoluciones del día (por la fecha del cobro de devolución), con la base sin IVA proporcional a la de su cuenta.
  const refundRows = (await client.query<{ bill_id: string; at: Date; data: { amountCents: number } }>(
    "SELECT bill_id,at,data FROM llenamos.pos_payments WHERE restaurant_id=$1 AND location_id=$2 AND kind='refund' AND status='succeeded' AND at>=$3 AND at<$4 LIMIT 5000", [rid, lid, new Date(start), new Date(end)])).rows
  const refundBills = new Map<string, core.Bill>()
  const missing = [...new Set(refundRows.map(r => r.bill_id))].filter(id => !bills.some(b => b.id === id))
  for (const b of bills) refundBills.set(b.id, b.data)
  if (missing.length) for (const r of (await client.query<{ id: string; data: core.Bill }>('SELECT id,data FROM llenamos.pos_bills WHERE restaurant_id=$1 AND location_id=$2 AND id=ANY($3)', [rid, lid, missing])).rows) refundBills.set(r.id, r.data)
  const refunds: core.RefundFact[] = refundRows.map(r => {
    const bill = refundBills.get(r.bill_id)
    const net = bill ? core.netBillLines(bill.lines, bill.adjustments).reduce((sum, l) => sum + core.netOfGross(l.grossCents, l.taxRate), 0) : 0
    return { locationId: lid, at: r.at.getTime(), amountCents: r.data.amountCents, netCents: bill?.totalCents ? core.roundRatio(BigInt(net) * BigInt(r.data.amountCents), BigInt(bill.totalCents)) : 0 }
  })

  const reservations = (await client.query<{ start_at: Date; status: core.ReservationFact['status']; data: { partySize: number } }>(
    'SELECT start_at,status,data FROM llenamos.reservations WHERE restaurant_id=$1 AND location_id=$2 AND start_at>=$3 AND start_at<$4 AND NOT privacy_redacted ORDER BY start_at LIMIT 5000', [rid, lid, new Date(start), new Date(end)])).rows
    .map(r => ({ locationId: lid, startAt: r.start_at.getTime(), partySize: r.data.partySize, status: r.status }))

  const tables = (await client.query<{ data: { seats: number; enabled?: boolean } }>('SELECT data FROM llenamos.dining_tables WHERE restaurant_id=$1 AND location_id=$2', [rid, lid])).rows
  const config = (await client.query<{ data: unknown }>('SELECT data FROM llenamos.reservation_settings WHERE restaurant_id=$1 AND location_id=$2', [rid, lid])).rows[0]
  const settings = config ? core.ReservationSettingsSchema.parse(config.data) : null
  const open = new Set<number>()
  if (settings) {
    const day = core.turnosDelDia(core.settingsToConfiguracion(settings), date)
    for (const shift of day.turnos) { const r = core.rangoTurno(shift); for (let m = r.desde; m < r.ultimaEntrada + settings.duration.defaultMinutes; m++) open.add(m) }
  }
  const catalog = (await client.query<{ id: string; doc: { name: { es: string }; active: boolean } }>('SELECT id,doc FROM llenamos.sala_menu_items WHERE restaurant_id=$1 AND location_id=$2 ORDER BY id LIMIT 5000', [rid, lid])).rows
    .map(r => ({ itemId: r.id, name: r.doc.name.es, active: r.doc.active }))
  return {
    bills: factBills, refunds, reservations, sold, catalog, costs,
    capacity: { locationId: lid, seats: tables.filter(t => t.data.enabled !== false).reduce((sum, t) => sum + t.data.seats, 0), openMinutesByDate: { [date]: open.size } },
  }
}

export const postgresFactsPort: AnalyticsFactsPort = { dayFacts: postgresDayFacts }

/** Previsión de ocupación: plazas, minutos abiertos por día, mesas del historial (84 días) y reservas de los días pedidos de UN local. */
export const postgresReservationsPort: AnalyticsReservationsPort = {
  async forecastInputs(client, rid, lid, p) {
    const from = dayRange(p.historyFrom, p.timezone).start, to = dayRange(p.to, p.timezone).end
    const tables = (await client.query<{ data: { seats: number; enabled?: boolean } }>('SELECT data FROM llenamos.dining_tables WHERE restaurant_id=$1 AND location_id=$2', [rid, lid])).rows
    const config = (await client.query<{ data: unknown }>('SELECT data FROM llenamos.reservation_settings WHERE restaurant_id=$1 AND location_id=$2', [rid, lid])).rows[0]
    const settings = config ? core.ReservationSettingsSchema.parse(config.data) : null
    const openMinutesByDate: Record<string, number> = {}
    for (let date = p.historyFrom; date <= p.to; date = core.sumarDias(date, 1)) {
      const open = new Set<number>()
      if (settings) for (const shift of core.turnosDelDia(core.settingsToConfiguracion(settings), date).turnos) { const r = core.rangoTurno(shift); for (let m = r.desde; m < r.ultimaEntrada + settings.duration.defaultMinutes; m++) open.add(m) }
      openMinutesByDate[date] = open.size
    }
    const sessions = (await client.query<{ doc: { openedAt: number; closedAt: number | null; guests: number } }>(
      "SELECT doc FROM llenamos.sala_table_sessions WHERE restaurant_id=$1 AND location_id=$2 AND (doc->>'openedAt')::bigint>=$3 AND (doc->>'openedAt')::bigint<$4 LIMIT 20000", [rid, lid, from, to])).rows
      .map(r => ({ openedAt: r.doc.openedAt, closedAt: r.doc.closedAt ?? null, guests: r.doc.guests }))
    const reservations = (await client.query<{ start_at: Date; status: string; data: { partySize: number; durationMinutes?: number } }>(
      'SELECT start_at,status,data FROM llenamos.reservations WHERE restaurant_id=$1 AND location_id=$2 AND start_at>=$3 AND start_at<$4 AND NOT privacy_redacted LIMIT 20000',
      [rid, lid, new Date(dayRange(p.from, p.timezone).start), new Date(to)])).rows
      .map(r => ({ startAt: r.start_at.getTime(), durationMinutes: r.data.durationMinutes ?? settings?.duration.defaultMinutes ?? 90, partySize: r.data.partySize, status: r.status }))
    return { seats: tables.filter(t => t.data.enabled !== false).reduce((sum, t) => sum + t.data.seats, 0), openMinutesByDate, sessions, reservations }
  },
}
