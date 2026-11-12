/**
 * Definiciones de las métricas del panel (fase 5). Una sola biblioteca para el panel, el resumen
 * diario, la exportación y las automatizaciones, así todas dicen lo mismo.
 *
 * Entran **proyecciones** que el servidor saca de lo que ya guardan las fases 1 a 4 (cuentas y
 * pagos de caja, mesas, reservas, plazas del plano y costes congelados de la fase 4); aquí no se lee
 * Firestore ni el reloj, y no se recalcula lo que ya existe (precios, totales, costes).
 *
 * Definiciones (todo en céntimos enteros; los cocientes, redondeados a la mitad hacia arriba):
 * - **Pedido** (`orderedCents`): suma de las líneas de las cuentas cobradas antes de invitaciones,
 *   anulaciones y descuentos, IVA incluido.
 * - **Ventas brutas** (`grossSalesCents`): total de las cuentas **cobradas** (liquidadas) en el
 *   periodo, tras invitaciones, anulaciones y descuentos, IVA incluido, sin propinas. Se cuentan en el
 *   día local de servicio en que se liquidan. Una cuenta abierta no es venta.
 * - **Devoluciones** (`refundCents`): devoluciones confirmadas, en el día en que se hacen.
 * - **Ventas netas** (`netSalesCents`): ventas brutas sin IVA menos devoluciones sin IVA.
 * - **Comensales** (`guests`): los de las mesas cobradas (los pedidos para llevar no cuentan).
 * - **Ticket medio**: ventas brutas / cuentas. **Gasto por comensal**: ventas brutas de mesas / comensales.
 * - **Rotación** (`rotationBp`): comensales / (plazas × días abiertos), en puntos básicos (15 000 = 1,5 vueltas).
 * - **Ingreso por plaza y hora** (`revenuePerSeatHourCents`): ventas brutas de mesas / (plazas × horas abiertas).
 * - **Ocupación** (`occupancyBp`): minutos de comensal sentado / (plazas × minutos abiertos), como mucho 10 000.
 * - **No presentados** (`noShowBp`): reservas `no_show` / reservas que debían llegar
 *   (confirmadas, sentadas, terminadas o no presentadas; no las canceladas ni las pendientes).
 * - **Margen**: el de la fase 4 (`summarizeDishMargins`) sobre las líneas con coste congelado.
 */
import { roundRatio } from "../caja/cuenta"
import type { LineCost } from "../inventario/modelo"
import { summarizeDishMargins } from "../inventario/margenes"
import { horaLocal, minutosAHora, sumarDias, type Fecha } from "../reservas/tiempo"

export interface BillFact {
  billId: string
  locationId: string
  kind: "session" | "takeaway"
  openedAt: number
  /** Cuándo se liquidó; solo cuentan las liquidadas. */
  settledAt: number
  /** Cierre de la mesa (o el cobro si falta), para la ocupación. */
  closedAt: number | null
  orderedCents: number
  invitationCents: number
  voidCents: number
  discountCents: number
  totalCents: number
  /** Total sin IVA (de la factura o de `netOfGross` por línea). */
  netCents: number
  tipCents: number
  guests: number
}

export interface RefundFact { locationId: string; at: number; amountCents: number; netCents: number }

export interface ReservationFact {
  locationId: string
  startAt: number
  partySize: number
  status: "pending" | "confirmed" | "seated" | "finished" | "cancelled" | "no_show"
}

/** Plazas habilitadas del local y minutos de apertura de cada día (de los horarios de la fase 1). */
export interface CapacityFact { locationId: string; seats: number; openMinutesByDate: Readonly<Record<Fecha, number>> }

export interface MetricTotals {
  bills: number
  sessionBills: number
  takeawayBills: number
  orderedCents: number
  invitationCents: number
  voidCents: number
  discountCents: number
  grossSalesCents: number
  netCents: number
  refundCents: number
  refundNetCents: number
  tipCents: number
  guests: number
  sessionGrossCents: number
  occupiedSeatMinutes: number
  seatMinutes: number
  seatDays: number
  openDays: number
  reservationsExpected: number
  reservationsSeated: number
  noShows: number
  noShowCovers: number
  cancelled: number
}

export function emptyTotals(): MetricTotals {
  return {
    bills: 0, sessionBills: 0, takeawayBills: 0, orderedCents: 0, invitationCents: 0, voidCents: 0, discountCents: 0,
    grossSalesCents: 0, netCents: 0, refundCents: 0, refundNetCents: 0, tipCents: 0, guests: 0, sessionGrossCents: 0,
    occupiedSeatMinutes: 0, seatMinutes: 0, seatDays: 0, openDays: 0, reservationsExpected: 0, reservationsSeated: 0,
    noShows: 0, noShowCovers: 0, cancelled: 0,
  }
}

export function addTotals(a: MetricTotals, b: MetricTotals): MetricTotals {
  const out = emptyTotals()
  for (const k of Object.keys(out) as (keyof MetricTotals)[]) out[k] = a[k] + b[k]
  return out
}

const inRange = (fecha: Fecha, from: Fecha, to: Fecha) => fecha >= from && fecha <= to

/**
 * Totales de un periodo (`from` a `to`, días locales incluidos) para un conjunto de locales.
 * Las facturas o pagos fuera del periodo se ignoran; las proyecciones de otros locales también.
 */
export function computeTotals(p: {
  from: Fecha
  to: Fecha
  timezone: string
  locationIds: readonly string[]
  bills: readonly BillFact[]
  refunds: readonly RefundFact[]
  reservations: readonly ReservationFact[]
  capacity: readonly CapacityFact[]
}): MetricTotals {
  if (p.from > p.to) throw new Error("El periodo está al revés.")
  const t = emptyTotals()
  const loc = new Set(p.locationIds)
  for (const b of p.bills) {
    if (!loc.has(b.locationId) || !inRange(horaLocal(b.settledAt, p.timezone).fecha, p.from, p.to)) continue
    if (b.totalCents !== b.orderedCents - b.invitationCents - b.voidCents - b.discountCents) throw new Error(`La cuenta ${b.billId} no cuadra.`)
    t.bills += 1
    if (b.kind === "session") t.sessionBills += 1
    else t.takeawayBills += 1
    t.orderedCents += b.orderedCents
    t.invitationCents += b.invitationCents
    t.voidCents += b.voidCents
    t.discountCents += b.discountCents
    t.grossSalesCents += b.totalCents
    t.netCents += b.netCents
    t.tipCents += b.tipCents
    if (b.kind === "session") {
      t.guests += b.guests
      t.sessionGrossCents += b.totalCents
      const minutes = Math.max(0, Math.round(((b.closedAt ?? b.settledAt) - b.openedAt) / 60_000))
      t.occupiedSeatMinutes += b.guests * minutes
    }
  }
  for (const r of p.refunds) {
    if (!loc.has(r.locationId) || !inRange(horaLocal(r.at, p.timezone).fecha, p.from, p.to)) continue
    t.refundCents += r.amountCents
    t.refundNetCents += r.netCents
  }
  for (const r of p.reservations) {
    if (!loc.has(r.locationId) || !inRange(horaLocal(r.startAt, p.timezone).fecha, p.from, p.to)) continue
    if (r.status === "cancelled") t.cancelled += 1
    if (r.status === "confirmed" || r.status === "seated" || r.status === "finished" || r.status === "no_show") t.reservationsExpected += 1
    if (r.status === "seated" || r.status === "finished") t.reservationsSeated += 1
    if (r.status === "no_show") { t.noShows += 1; t.noShowCovers += r.partySize }
  }
  for (const c of p.capacity) {
    if (!loc.has(c.locationId)) continue
    for (const [fecha, minutes] of Object.entries(c.openMinutesByDate)) {
      if (!inRange(fecha, p.from, p.to) || minutes <= 0) continue
      t.openDays += 1
      t.seatDays += c.seats
      t.seatMinutes += c.seats * minutes
    }
  }
  return t
}

const ratio = (n: number, d: number, scale = 1): number | null => (d > 0 ? roundRatio(BigInt(n) * BigInt(scale), BigInt(d)) : null)

export interface DerivedMetrics {
  grossSalesCents: number
  netSalesCents: number
  refundCents: number
  discountCents: number
  bills: number
  guests: number
  averageTicketCents: number | null
  averagePerGuestCents: number | null
  rotationBp: number | null
  revenuePerSeatHourCents: number | null
  occupancyBp: number | null
  noShowBp: number | null
  noShows: number
  noShowCovers: number
}

export function deriveMetrics(t: MetricTotals): DerivedMetrics {
  const occupancy = ratio(t.occupiedSeatMinutes, t.seatMinutes, 10_000)
  return {
    grossSalesCents: t.grossSalesCents,
    netSalesCents: t.netCents - t.refundNetCents,
    refundCents: t.refundCents,
    discountCents: t.discountCents + t.invitationCents,
    bills: t.bills,
    guests: t.guests,
    averageTicketCents: ratio(t.grossSalesCents, t.bills),
    averagePerGuestCents: ratio(t.sessionGrossCents, t.guests),
    rotationBp: ratio(t.guests, t.seatDays, 10_000),
    revenuePerSeatHourCents: ratio(t.sessionGrossCents, t.seatMinutes, 60),
    occupancyBp: occupancy === null ? null : Math.min(10_000, occupancy),
    noShowBp: ratio(t.noShows, t.reservationsExpected, 10_000),
    noShows: t.noShows,
    noShowCovers: t.noShowCovers,
  }
}

/* Comparativas --------------------------------------------------------------------- */

/** El periodo anterior de la misma longitud, justo antes. */
export function previousRange(from: Fecha, to: Fecha): { from: Fecha; to: Fecha } {
  let days = 0
  for (let f = from; f <= to; f = sumarDias(f, 1)) days += 1
  return { from: sumarDias(from, -days), to: sumarDias(from, -1) }
}

export interface MetricComparison { current: number | null; previous: number | null; delta: number | null; deltaBp: number | null }

/** Sin datos en el periodo anterior: comparación vacía (todo null), nunca un 0 % inventado. */
export function hasBase(t: MetricTotals | null): t is MetricTotals {
  return t !== null && (t.bills > 0 || t.reservationsExpected > 0 || t.refundCents > 0)
}

export function comparePeriods(current: MetricTotals, previous: MetricTotals | null): Record<keyof DerivedMetrics, MetricComparison> {
  const cur = deriveMetrics(current)
  const prev = hasBase(previous) ? deriveMetrics(previous) : null
  const out = {} as Record<keyof DerivedMetrics, MetricComparison>
  for (const k of Object.keys(cur) as (keyof DerivedMetrics)[]) {
    const c = cur[k]
    const p = prev === null ? null : prev[k]
    const delta = c === null || p === null ? null : c - p
    out[k] = { current: c, previous: p, delta, deltaBp: delta === null || p === null || p === 0 ? null : ratio(delta, Math.abs(p), 10_000) }
  }
  return out
}

export interface LocationComparisonRow { locationId: string; metrics: DerivedMetrics; salesShareBp: number | null }

/** Comparativa entre locales: métricas de cada uno y su parte de las ventas del conjunto. */
export function compareLocations(byLocation: Readonly<Record<string, MetricTotals>>): { rows: LocationComparisonRow[]; total: DerivedMetrics } {
  const ids = Object.keys(byLocation).sort()
  const total = ids.reduce((acc, id) => addTotals(acc, byLocation[id] as MetricTotals), emptyTotals())
  const rows = ids.map((locationId) => {
    const t = byLocation[locationId] as MetricTotals
    return { locationId, metrics: deriveMetrics(t), salesShareBp: ratio(t.grossSalesCents, total.grossSalesCents, 10_000) }
  })
  return { rows, total: deriveMetrics(total) }
}

/* Horas punta --------------------------------------------------------------------- */

export interface SlotRow { slot: string; guests: number; bills: number; salesCents: number; reservations: number; reservationCovers: number }

/**
 * Comensales, cuentas y ventas por tramo de la hora local en que se abrió la mesa, y reservas por
 * su hora de llegada. `slotMinutes` 15, 30 o 60. Solo devuelve tramos con algo; `peak` es el de más
 * comensales (empate: el más temprano), o null si no hay datos.
 */
export function peakSlots(p: { bills: readonly BillFact[]; reservations: readonly ReservationFact[]; timezone: string; slotMinutes: 15 | 30 | 60; from: Fecha; to: Fecha }): { slots: SlotRow[]; peak: SlotRow | null } {
  const map = new Map<number, SlotRow>()
  const row = (minutes: number) => {
    const start = Math.floor(minutes / p.slotMinutes) * p.slotMinutes
    let r = map.get(start)
    if (!r) { r = { slot: minutosAHora(start), guests: 0, bills: 0, salesCents: 0, reservations: 0, reservationCovers: 0 }; map.set(start, r) }
    return r
  }
  for (const b of p.bills) {
    if (b.kind !== "session") continue
    const settled = horaLocal(b.settledAt, p.timezone).fecha
    if (!inRange(settled, p.from, p.to)) continue
    const r = row(horaLocal(b.openedAt, p.timezone).minutos)
    r.guests += b.guests
    r.bills += 1
    r.salesCents += b.totalCents
  }
  for (const res of p.reservations) {
    const h = horaLocal(res.startAt, p.timezone)
    if (!inRange(h.fecha, p.from, p.to) || res.status === "cancelled") continue
    const r = row(h.minutos)
    r.reservations += 1
    r.reservationCovers += res.partySize
  }
  const slots = [...map.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r)
  const peak = slots.reduce<SlotRow | null>((best, r) => (r.guests > 0 && (best === null || r.guests > best.guests) ? r : best), null)
  return { slots, peak }
}

/* Platos --------------------------------------------------------------------- */

export interface SoldLineFact {
  itemId: string
  kind: "item" | "menu_component"
  quantity: number
  /** Lo cobrado por la línea tras sus ajustes; 0 en un plato de menú (va en el precio del menú). */
  netOfAdjustmentsCents: number
}

export interface DishSalesRow { itemId: string; name: string; units: number; unitsInMenu: number; salesCents: number }

/**
 * Platos más y menos vendidos del periodo, **incluidos los de cero ventas** de la carta activa.
 * Entran líneas no anuladas de cuentas cobradas.
 */
export function dishSales(lines: readonly SoldLineFact[], catalog: readonly { itemId: string; name: string; active: boolean }[]): { rows: DishSalesRow[]; zeroSales: DishSalesRow[] } {
  const names = new Map(catalog.map((c) => [c.itemId, c.name]))
  const map = new Map<string, DishSalesRow>()
  for (const l of lines) {
    const r = map.get(l.itemId) ?? { itemId: l.itemId, name: names.get(l.itemId) ?? l.itemId, units: 0, unitsInMenu: 0, salesCents: 0 }
    if (l.kind === "item") r.units += l.quantity
    else r.unitsInMenu += l.quantity
    r.salesCents += l.netOfAdjustmentsCents
    map.set(l.itemId, r)
  }
  const rows = [...map.values()].sort((a, b) => b.units + b.unitsInMenu - (a.units + a.unitsInMenu) || b.salesCents - a.salesCents || a.itemId.localeCompare(b.itemId))
  const zeroSales = catalog.filter((c) => c.active && !map.has(c.itemId)).map((c) => ({ itemId: c.itemId, name: c.name, units: 0, unitsInMenu: 0, salesCents: 0 })).sort((a, b) => a.name.localeCompare(b.name, "es"))
  return { rows, zeroSales }
}

/* Margen (fase 4) ------------------------------------------------------------------ */

export interface MarginTotals {
  netCents: number
  coveredNetCents: number
  costCents: number
  marginCents: number
  marginBp: number | null
  /** Parte de las unidades vendidas que tenía coste, en puntos básicos. */
  coverageBp: number | null
  wasteCostCents: number
}

/**
 * Margen del periodo con el coste congelado de cada línea (fase 4). Los platos de menú del día no
 * suman ingreso propio: se cuentan aparte en `summarizeDishMargins` y aquí se excluyen.
 */
export function marginTotals(lineCosts: readonly Pick<LineCost, "itemId" | "variantId" | "menuComponent" | "quantity" | "state" | "costCents" | "complete" | "grossCents" | "taxRate">[]): MarginTotals {
  const rows = summarizeDishMargins(lineCosts).filter((r) => !r.inMenu)
  const sum = (k: "netCents" | "coveredNetCents" | "costCents" | "wasteCostCents" | "units" | "coveredUnits") => rows.reduce((s, r) => s + r[k], 0)
  const coveredNet = sum("coveredNetCents")
  const cost = sum("costCents")
  return {
    netCents: sum("netCents"), coveredNetCents: coveredNet, costCents: cost, marginCents: coveredNet - cost,
    marginBp: ratio(coveredNet - cost, coveredNet, 10_000), coverageBp: ratio(sum("coveredUnits"), sum("units"), 10_000),
    wasteCostCents: sum("wasteCostCents"),
  }
}
