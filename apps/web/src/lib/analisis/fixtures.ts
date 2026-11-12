/** Fixtures explícitas para revisar el diseño sin backend. Nunca confirman operaciones. */
import { CALLABLE_SCHEMAS, addTotals, compareLocations, comparePeriods, deriveMetrics, dishSales, emptyTotals, forecastDay, peakSlots, renderDailySummary, sumarDias, type CallableOutput, type MetricTotals, type Recommendation } from "@llenamos/core"

export function panelEjemplo(from: string, to: string, locationIds: string[], slotMinutes: 15 | 30 | 60): CallableOutput<"panelAnalisis"> {
  const totals: MetricTotals[] = []
  const byDay = []
  for (let date = from, i = 0; date <= to; date = sumarDias(date, 1), i++) {
    const bills = 24 + (i % 7) * 3
    const t = { ...emptyTotals(), bills, sessionBills: bills, grossSalesCents: bills * 3650, netCents: bills * 3318, sessionGrossCents: bills * 3650, guests: bills * 2, occupiedSeatMinutes: bills * 2 * 75, seatMinutes: 48 * 480, seatDays: 48, openDays: 1, reservationsExpected: bills, noShows: i % 3, noShowCovers: (i % 3) * 2 }
    totals.push(t); byDay.push({ date, metrics: deriveMetrics(t) })
  }
  const localTotal = totals.reduce(addTotals, emptyTotals())
  const locations = compareLocations(Object.fromEntries(locationIds.map((id) => [id, localTotal])))
  const total = locationIds.reduce((sum) => addTotals(sum, localTotal), emptyTotals())
  byDay.forEach((day, i) => { day.metrics = deriveMetrics(locationIds.reduce((sum) => addTotals(sum, totals[i]!), emptyTotals())) })
  const previous = { ...total, grossSalesCents: Math.round(total.grossSalesCents * 0.88), netCents: Math.round(total.netCents * 0.88) }
  const dishes = dishSales([
    { itemId: "croquetas", kind: "item", quantity: 92, netOfAdjustmentsCents: 82800 },
    { itemId: "arroz", kind: "item", quantity: 54, netOfAdjustmentsCents: 97200 },
    { itemId: "arroz", kind: "menu_component", quantity: 16, netOfAdjustmentsCents: 0 },
    { itemId: "tarta", kind: "item", quantity: 12, netOfAdjustmentsCents: 7800 },
  ], [{ itemId: "croquetas", name: "Croquetas de la casa", active: true }, { itemId: "arroz", name: "Arroz de temporada", active: true }, { itemId: "tarta", name: "Tarta de queso", active: true }, { itemId: "ensalada", name: "Ensalada de la huerta", active: true }])
  const at = (h: number) => Date.parse(`${from}T${String(h).padStart(2, "0")}:00:00+01:00`)
  const hours = peakSlots({ bills: [13, 14, 15, 20, 21, 22].map((h, i) => ({ billId: `b${i}`, locationId: "ejemplo", kind: "session", openedAt: at(h), settledAt: at(h + 1), closedAt: at(h + 1), orderedCents: 12000, invitationCents: 0, voidCents: 0, discountCents: 0, totalCents: 12000, netCents: 10909, tipCents: 0, guests: [12, 32, 18, 24, 42, 22][i]! })), reservations: [], timezone: "Europe/Madrid", slotMinutes, from, to })
  return CALLABLE_SCHEMAS.panelAnalisis.output.parse({ from, to, total: deriveMetrics(total), comparison: comparePeriods(total, previous), byDay, byLocation: locations.rows, hours: { slots: hours.slots, peak: hours.peak?.slot ?? null }, dishes: { top: dishes.rows, bottom: [...dishes.rows].reverse(), zeroSales: dishes.zeroSales }, margin: { netCents: total.netCents, coveredNetCents: total.netCents, costCents: Math.round(total.netCents * 0.32), marginCents: total.netCents - Math.round(total.netCents * 0.32), marginBp: 6800, coverageBp: 10000, wasteCostCents: 1250 }, computedAt: Date.parse(`${to}T20:00:00Z`) })
}
export function previsionEjemplo(from: string, days: number): CallableOutput<"previsionOcupacion"> {
  return CALLABLE_SCHEMAS.previsionOcupacion.output.parse({ seats: 48, days: Array.from({ length: days }, (_, i) => {
    const date = sumarDias(from, i)
    const forecast = forecastDay({ date, seats: 48, history: Array.from({ length: 12 }, (_, k) => ({ date: sumarDias(date, -7 * (k + 1)), open: true, slots: { 780: 12 + k % 3, 795: 22 + k % 4, 810: 32, 825: 38, 840: 40, 855: 30, 870: 24, 885: 12 } })), booked: { 780: 14, 795: 16, 810: 20, 825: 22, 840: 28, 855: 18, 870: 10, 885: 4 } })
    return { ...forecast, peak: forecast.peak?.slot ?? null }
  }) })
}

export function resumenEjemplo(date: string) {
  const totals = { ...emptyTotals(), bills: 34, guests: 76, grossSalesCents: 128540, reservationsExpected: 22, noShows: 2, occupiedSeatMinutes: 5700, seatMinutes: 23040 }
  return renderDailySummary({ date, restaurantName: "Restaurante de ejemplo", totals, previous: null, today: { reservations: 28, covers: 82, pending: 3 }, alerts: ["Dos recomendaciones por revisar."] })
}
export function recomendacionEjemplo(now: number): Recommendation & { id: string } {
  return { id: "fixture-regla.evento", ruleId: "fixture-regla", eventId: "fixture-evento", eventType: "reservation.no_show", locationId: null, subject: "Reserva de ejemplo", kind: "require_deposit", text: "Valorar una señal en la próxima reserva de este cliente.", evidence: { customerNoShows: 2, partySize: 4, hasDeposit: false }, status: "open", createdAt: now, expiresAt: now + 86_400_000, decidedBy: null, decidedAt: null, note: null }
}
