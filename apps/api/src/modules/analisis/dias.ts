import type { PoolClient } from 'pg'
import * as core from '@llenamos/core'
import { ApiError } from '../../errors.js'
import { emitEvent } from '../../events.js'
import { factsPort, type DayFacts } from './puertos.js'
import { moduleActive, restaurantInfo } from './util.js'
import { insertAutomationEvent } from './eventos.js'

/** Versión del formato de `analytics_days`; súbela si cambia la forma de `hours`/`dishes` para poder recalcular. */
export const SOURCE_VERSION = 1
const MAX_DISH_ROWS = 3000
const MAX_ZERO = 500

export interface HourSlot { slot: string; guests: number; bills: number; salesCents: number; reservations: number; reservationCovers: number }
export interface DishRow { itemId: string; name: string; units: number; unitsInMenu: number; salesCents: number }
export interface MarginParts { netCents: number; coveredNetCents: number; costCents: number; wasteCostCents: number; units: number; coveredUnits: number }
export interface DayHours { slotMinutes: 15; slots: HourSlot[] }
export interface DayDishes { rows: DishRow[]; zero: { itemId: string; name: string }[] }
export interface DayRecord {
  locationId: string
  date: string
  totals: core.MetricTotals
  hours: DayHours
  dishes: DayDishes
  margin: MarginParts | null
  computedAt: number
}

/** Convierte los hechos de un local y un día en la fila resumen. Pura: no toca la base de datos. */
export function buildDay(facts: DayFacts, locationId: string, date: string, timezone: string): Omit<DayRecord, 'computedAt'> {
  const totals = core.computeTotals({ ...facts, from: date, to: date, timezone, locationIds: [locationId], capacity: [facts.capacity] })
  const hours = core.peakSlots({ bills: facts.bills, reservations: facts.reservations, timezone, slotMinutes: 15, from: date, to: date })
  const dishes = core.dishSales(facts.sold, facts.catalog)
  const parts = core.summarizeDishMargins(facts.costs).filter(r => !r.inMenu)
  const sum = (k: keyof MarginParts) => parts.reduce((s, r) => s + r[k], 0)
  return {
    locationId, date, totals,
    hours: { slotMinutes: 15, slots: hours.slots },
    dishes: { rows: dishes.rows.slice(0, MAX_DISH_ROWS), zero: dishes.zeroSales.slice(0, MAX_ZERO).map(x => ({ itemId: x.itemId, name: x.name })) },
    margin: parts.length ? { netCents: sum('netCents'), coveredNetCents: sum('coveredNetCents'), costCents: sum('costCents'), wasteCostCents: sum('wasteCostCents'), units: sum('units'), coveredUnits: sum('coveredUnits') } : null,
  }
}

const rowToDay = (r: any): DayRecord => ({
  locationId: r.location_id, date: r.date, totals: { ...core.emptyTotals(), ...r.totals },
  hours: r.hours ?? { slotMinutes: 15, slots: [] }, dishes: r.dishes ?? { rows: [], zero: [] }, margin: r.margin ?? null,
  computedAt: r.computed_at instanceof Date ? r.computed_at.getTime() : 0,
})

/** Lee las instantáneas de varios locales entre dos fechas: una consulta por clave primaria, sin tocar históricos de caja. */
export async function loadDays(client: PoolClient, rid: string, locationIds: readonly string[], from: string, to: string): Promise<DayRecord[]> {
  if (!locationIds.length) return []
  const { rows } = await client.query(`SELECT location_id,date::text AS date,totals,hours,dishes,margin,computed_at FROM llenamos.analytics_days
    WHERE restaurant_id=$1 AND location_id=ANY($2) AND date BETWEEN $3 AND $4 ORDER BY date,location_id`, [rid, [...locationIds], from, to])
  return rows.map(rowToDay)
}

/** Solo los totales (periodo anterior para la comparación). */
export async function loadTotals(client: PoolClient, rid: string, locationIds: readonly string[], from: string, to: string): Promise<core.MetricTotals[]> {
  if (!locationIds.length) return []
  const { rows } = await client.query<{ totals: core.MetricTotals }>(`SELECT totals FROM llenamos.analytics_days
    WHERE restaurant_id=$1 AND location_id=ANY($2) AND date BETWEEN $3 AND $4`, [rid, [...locationIds], from, to])
  return rows.map(r => ({ ...core.emptyTotals(), ...r.totals }))
}

export const sumTotals = (list: readonly core.MetricTotals[]) => list.reduce(core.addTotals, core.emptyTotals())

/** Suma tramos de 15 minutos de varios días y los agrupa en tramos de 15, 30 o 60 minutos. `peak`: más comensales, a igualdad el más temprano. */
export function combineHours(days: readonly Pick<DayRecord, 'hours'>[], slotMinutes: 15 | 30 | 60): { slots: HourSlot[]; peak: string | null } {
  const map = new Map<number, HourSlot>()
  for (const day of days) for (const s of day.hours.slots) {
    const start = Math.floor(core.horaAMinutos(s.slot) / slotMinutes) * slotMinutes
    const r = map.get(start) ?? { slot: core.minutosAHora(start), guests: 0, bills: 0, salesCents: 0, reservations: 0, reservationCovers: 0 }
    r.guests += s.guests; r.bills += s.bills; r.salesCents += s.salesCents; r.reservations += s.reservations; r.reservationCovers += s.reservationCovers
    map.set(start, r)
  }
  const slots = [...map.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r)
  const peak = slots.reduce<HourSlot | null>((best, r) => (r.guests > 0 && (best === null || r.guests > best.guests) ? r : best), null)
  return { slots, peak: peak?.slot ?? null }
}

/**
 * Suma los platos de varios días (ordenados de más antiguo a más reciente). Los platos con cero ventas son los activos
 * de la carta del ÚLTIMO día de cada local que no se vendieron en ningún día del periodo.
 */
export function combineDishes(days: readonly Pick<DayRecord, 'dishes' | 'date' | 'locationId'>[]): { rows: core.DishSalesRow[]; zeroSales: core.DishSalesRow[] } {
  const sorted = [...days].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.locationId < b.locationId ? -1 : 1))
  const lines: core.SoldLineFact[] = []
  const catalog: { itemId: string; name: string; active: boolean }[] = []
  const last = new Map<string, Pick<DayRecord, 'dishes'>>()
  for (const day of sorted) {
    last.set(day.locationId, day)
    for (const r of day.dishes.rows) {
      catalog.push({ itemId: r.itemId, name: r.name, active: false })
      lines.push({ itemId: r.itemId, kind: 'item', quantity: r.units, netOfAdjustmentsCents: r.salesCents })
      if (r.unitsInMenu > 0) lines.push({ itemId: r.itemId, kind: 'menu_component', quantity: r.unitsInMenu, netOfAdjustmentsCents: 0 })
    }
  }
  const zeroSeen = new Set<string>(); for (const day of last.values()) for (const z of day.dishes.zero) if (!zeroSeen.has(z.itemId)) { zeroSeen.add(z.itemId); catalog.push({ itemId: z.itemId, name: z.name, active: true }) }
  return core.dishSales(lines, catalog)
}

/** Margen del periodo a partir de las partes diarias; null si ningún día trae datos de coste. */
export function combineMargin(days: readonly Pick<DayRecord, 'margin'>[]): core.MarginTotals | null {
  const parts = days.map(d => d.margin).filter((m): m is MarginParts => m !== null)
  if (!parts.length) return null
  const sum = (k: keyof MarginParts) => parts.reduce((s, m) => s + m[k], 0)
  const ratio = (n: number, d: number) => (d > 0 ? core.roundRatio(BigInt(n) * 10_000n, BigInt(d)) : null)
  const covered = sum('coveredNetCents'), cost = sum('costCents')
  return { netCents: sum('netCents'), coveredNetCents: covered, costCents: cost, marginCents: covered - cost, marginBp: ratio(covered - cost, covered), coverageBp: ratio(sum('coveredUnits'), sum('units')), wasteCostCents: sum('wasteCostCents') }
}

/**
 * Calcula y guarda la instantánea de un día CERRADO (anterior a hoy) de un local. Idempotente: repetirla con los mismos
 * hechos deja la misma fila; el evento `day.closed` solo se crea la primera vez. Lo invoca el worker (trabajo
 * `analisis.agregar_dia`) dentro de una transacción del restaurante. Devuelve null si el módulo no está activo.
 */
export async function aggregateDay(client: PoolClient, rid: string, locationId: string, date: string, now = Date.now()): Promise<core.MetricTotals | null> {
  if (!(await moduleActive(client, rid, 'analytics'))) return null
  const { timezone } = await restaurantInfo(client, rid)
  if (date >= core.horaLocal(now, timezone).fecha) throw new ApiError(412, 'failed-precondition', 'Solo se agregan días ya cerrados.')
  const known = await client.query('SELECT 1 FROM llenamos.locations WHERE restaurant_id=$1 AND id=$2', [rid, locationId])
  if (!known.rowCount) throw new ApiError(404, 'not-found', 'No se encuentra el local.')
  const facts = await factsPort().dayFacts(client, rid, locationId, date, timezone)
  const day = buildDay(facts, locationId, date, timezone)
  await client.query(`INSERT INTO llenamos.analytics_days(restaurant_id,location_id,date,totals,hours,dishes,margin,source_version,computed_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT(restaurant_id,location_id,date) DO UPDATE SET totals=EXCLUDED.totals,hours=EXCLUDED.hours,dishes=EXCLUDED.dishes,margin=EXCLUDED.margin,
      source_version=EXCLUDED.source_version,computed_at=EXCLUDED.computed_at`,
  [rid, locationId, date, JSON.stringify(day.totals), JSON.stringify(day.hours), JSON.stringify(day.dishes), day.margin ? JSON.stringify(day.margin) : null, SOURCE_VERSION, new Date(now)])
  const prior = await loadTotals(client, rid, [locationId], core.sumarDias(date, -7), core.sumarDias(date, -7))
  const metrics = core.deriveMetrics(day.totals)
  await insertAutomationEvent(client, rid, {
    id: `day.closed.${locationId}.${date}`, type: 'day.closed', locationId, subject: date, at: now,
    data: { grossSalesCents: day.totals.grossSalesCents, salesDeltaBp: core.comparePeriods(day.totals, prior[0] ?? null).grossSalesCents.deltaBp ?? 0, noShowBp: metrics.noShowBp ?? 0, occupancyBp: metrics.occupancyBp ?? 0 },
  })
  await emitEvent(client, { restaurantId: rid, locationId, topic: 'analisis.dia', entityId: date, payload: { date } })
  return day.totals
}

/** Días sin instantánea de un local entre dos fechas (como mucho 366), del más antiguo al más reciente. Así se detecta qué rellenar. */
export async function missingDays(client: PoolClient, rid: string, locationId: string, from: string, to: string): Promise<string[]> {
  const { rows } = await client.query<{ d: string }>(`SELECT d::date::text AS d FROM generate_series($3::date,$4::date,'1 day') d
    WHERE NOT EXISTS(SELECT 1 FROM llenamos.analytics_days a WHERE a.restaurant_id=$1 AND a.location_id=$2 AND a.date=d::date) ORDER BY d LIMIT 366`, [rid, locationId, from, to])
  return rows.map(r => r.d)
}

/**
 * Rellena los días cerrados que faltan (como mucho `max` por llamada, del más antiguo al más nuevo). Es la vía para dar de
 * alta el histórico de un restaurante o recuperar días tras una caída del worker: el panel NO los inventa ni los calcula.
 */
export async function backfillDays(client: PoolClient, rid: string, locationId: string, from: string, to: string, now = Date.now(), max = 31): Promise<{ filled: string[]; remaining: number }> {
  const missing = await missingDays(client, rid, locationId, from, to)
  const filled: string[] = []
  for (const date of missing.slice(0, max)) { await aggregateDay(client, rid, locationId, date, now); filled.push(date) }
  return { filled, remaining: missing.length - filled.length }
}

/** Trabajo nocturno: recalcula los últimos `daysBack` días cerrados de cada local (recoge devoluciones y cobros tardíos). */
export async function aggregateRecentDays(client: PoolClient, rid: string, now = Date.now(), daysBack = 4): Promise<number> {
  if (!(await moduleActive(client, rid, 'analytics'))) return 0
  const { timezone } = await restaurantInfo(client, rid)
  const today = core.horaLocal(now, timezone).fecha
  const { rows } = await client.query<{ id: string }>('SELECT id FROM llenamos.locations WHERE restaurant_id=$1 ORDER BY id', [rid])
  let count = 0
  for (const l of rows) for (let n = 1; n <= daysBack; n++) { await aggregateDay(client, rid, l.id, core.sumarDias(today, -n), now); count++ }
  return count
}
