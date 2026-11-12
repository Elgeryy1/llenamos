import { describe, expect, it } from "vitest"
import {
  AutomationRuleInputSchema, compareLocations, comparePeriods, computeTotals, dailySummaryDate, dailySummaryMessageId, deriveMetrics, dishSales,
  emptyTotals, evaluateRule, forecastDay, marginTotals, peakSlots, presenceBySlot, previousRange, renderDailySummary, simulateRule, toCsv,
  type AutomationEventInstance, type BillFact, type CapacityFact, type DayPresence, type ReservationFact,
} from "../index"

const TZ = "Europe/Madrid"
// 10 de noviembre de 2026: Madrid está en UTC+1.
const at = (day: number, hh: number, mm = 0) => Date.UTC(2026, 10, day, hh - 1, mm)

function bill(id: string, over: Partial<BillFact> = {}): BillFact {
  return {
    billId: id, locationId: "centro", kind: "session", openedAt: at(10, 21), settledAt: at(10, 22, 30), closedAt: at(10, 22, 30),
    orderedCents: 10000, invitationCents: 0, voidCents: 0, discountCents: 0, totalCents: 10000, netCents: 9091, tipCents: 300, guests: 4, ...over,
  }
}
const capacity: CapacityFact[] = [{ locationId: "centro", seats: 40, openMinutesByDate: { "2026-11-10": 300, "2026-11-11": 300, "2026-11-12": 0 } }]

describe("definiciones de métricas", () => {
  const bills = [
    bill("b1"),
    bill("b2", { orderedCents: 6000, invitationCents: 500, discountCents: 500, totalCents: 5000, netCents: 4545, guests: 2, openedAt: at(10, 13), settledAt: at(10, 14, 30), closedAt: at(10, 14, 30) }),
    bill("t1", { kind: "takeaway", orderedCents: 2000, totalCents: 2000, netCents: 1818, guests: 0, tipCents: 0 }),
    bill("fuera", { settledAt: at(13, 22) }),
    bill("otro", { locationId: "playa" }),
  ]
  const reservations: ReservationFact[] = [
    { locationId: "centro", startAt: at(10, 21), partySize: 4, status: "finished" },
    { locationId: "centro", startAt: at(10, 21, 30), partySize: 2, status: "no_show" },
    { locationId: "centro", startAt: at(10, 13), partySize: 2, status: "seated" },
    { locationId: "centro", startAt: at(10, 20), partySize: 6, status: "cancelled" },
    { locationId: "centro", startAt: at(10, 20), partySize: 6, status: "pending" },
  ]
  const totals = computeTotals({ from: "2026-11-10", to: "2026-11-11", timezone: TZ, locationIds: ["centro"], bills, refunds: [{ locationId: "centro", at: at(11, 12), amountCents: 1000, netCents: 909 }], reservations, capacity })
  it("ventas brutas, netas, devoluciones y descuentos", () => {
    expect(totals).toMatchObject({ bills: 3, sessionBills: 2, takeawayBills: 1, orderedCents: 18000, grossSalesCents: 17000, netCents: 15454, refundCents: 1000, tipCents: 600 })
    const m = deriveMetrics(totals)
    expect(m.netSalesCents).toBe(15454 - 909)
    expect(m.discountCents).toBe(1000)
  })
  it("comensales, ticket medio, rotación, ingreso por plaza y hora, ocupación y no presentados", () => {
    const m = deriveMetrics(totals)
    expect(m.guests).toBe(6)
    expect(m.averageTicketCents).toBe(5667) // 17000 / 3, redondeado
    expect(m.averagePerGuestCents).toBe(2500) // 15000 de mesas / 6
    expect(totals).toMatchObject({ openDays: 2, seatDays: 80, seatMinutes: 24000 })
    expect(m.rotationBp).toBe(750) // 6 / 80 plazas-día
    expect(m.revenuePerSeatHourCents).toBe(38) // 15000 × 60 / 24000
    expect(m.occupancyBp).toBe(225) // (4×90 + 2×90) × 10 000 / 24 000
    expect(m).toMatchObject({ noShows: 1, noShowCovers: 2, noShowBp: 3333 }) // 1 de 3 que debían llegar
  })
  it("una cuenta que no cuadra es un error, no una cifra", () => {
    expect(() => computeTotals({ from: "2026-11-10", to: "2026-11-10", timezone: TZ, locationIds: ["centro"], bills: [bill("x", { totalCents: 1 })], refunds: [], reservations: [], capacity: [] })).toThrow(/no cuadra/)
  })
  it("sin plazas ni cuentas los cocientes son null, nunca cero inventado", () => {
    const m = deriveMetrics(emptyTotals())
    expect(m).toMatchObject({ averageTicketCents: null, rotationBp: null, occupancyBp: null, noShowBp: null, revenuePerSeatHourCents: null })
  })
  it("comparativa con el periodo anterior: vacía si no hay base", () => {
    expect(previousRange("2026-11-10", "2026-11-16")).toEqual({ from: "2026-11-03", to: "2026-11-09" })
    expect(previousRange("2026-03-01", "2026-03-01")).toEqual({ from: "2026-02-28", to: "2026-02-28" })
    const empty = comparePeriods(totals, emptyTotals())
    expect(empty.grossSalesCents).toEqual({ current: 17000, previous: null, delta: null, deltaBp: null })
    expect(comparePeriods(totals, null).guests.previous).toBeNull()
    const prev = { ...emptyTotals(), bills: 2, grossSalesCents: 10000, sessionGrossCents: 10000, guests: 4 }
    const c = comparePeriods(totals, prev)
    expect(c.grossSalesCents).toEqual({ current: 17000, previous: 10000, delta: 7000, deltaBp: 7000 })
    expect(c.occupancyBp.previous).toBeNull()
  })
  it("comparativa entre locales con su parte de las ventas", () => {
    const a = { ...emptyTotals(), bills: 1, grossSalesCents: 3000 }
    const b = { ...emptyTotals(), bills: 3, grossSalesCents: 1000 }
    const r = compareLocations({ playa: b, centro: a })
    expect(r.rows.map((x) => [x.locationId, x.salesShareBp])).toEqual([["centro", 7500], ["playa", 2500]])
    expect(r.total.grossSalesCents).toBe(4000)
    expect(r.total.averageTicketCents).toBe(1000)
  })
  it("horas punta por la hora en que se abrió la mesa", () => {
    const { slots, peak } = peakSlots({ bills, reservations, timezone: TZ, slotMinutes: 60, from: "2026-11-10", to: "2026-11-10" })
    expect(peak?.slot).toBe("21:00")
    expect(slots.find((s) => s.slot === "13:00")).toMatchObject({ guests: 2, bills: 1, salesCents: 5000, reservations: 1 })
    expect(slots.find((s) => s.slot === "20:00")).toMatchObject({ reservations: 1, reservationCovers: 6 })
  })
  it("platos más vendidos y los que no se han vendido nada", () => {
    const r = dishSales(
      [{ itemId: "paella", kind: "item", quantity: 3, netOfAdjustmentsCents: 5400 }, { itemId: "flan", kind: "menu_component", quantity: 2, netOfAdjustmentsCents: 0 }, { itemId: "paella", kind: "item", quantity: 1, netOfAdjustmentsCents: 1800 }],
      [{ itemId: "paella", name: "Paella", active: true }, { itemId: "flan", name: "Flan", active: true }, { itemId: "croquetas", name: "Croquetas", active: true }, { itemId: "viejo", name: "Viejo", active: false }],
    )
    expect(r.rows[0]).toEqual({ itemId: "paella", name: "Paella", units: 4, unitsInMenu: 0, salesCents: 7200 })
    expect(r.rows[1]).toMatchObject({ itemId: "flan", unitsInMenu: 2 })
    expect(r.zeroSales.map((z) => z.itemId)).toEqual(["croquetas"])
  })
  it("margen con el coste congelado de la fase 4, sin los platos de menú", () => {
    const m = marginTotals([
      { itemId: "paella", variantId: null, menuComponent: false, quantity: 1, state: "consumed", costCents: 400, complete: true, grossCents: 1100, taxRate: 10 },
      { itemId: "paella", variantId: null, menuComponent: false, quantity: 1, state: "no_recipe", costCents: null, complete: false, grossCents: 1100, taxRate: 10 },
      { itemId: "flan", variantId: null, menuComponent: true, quantity: 1, state: "consumed", costCents: 100, complete: true, grossCents: 0, taxRate: 10 },
    ])
    expect(m).toMatchObject({ netCents: 2000, coveredNetCents: 1000, costCents: 400, marginCents: 600, marginBp: 6000, coverageBp: 5000 })
  })
})

describe("previsión de ocupación", () => {
  const day = (date: string, guests: number, open = true): DayPresence => ({ date, open, slots: { [21 * 60]: guests, [21 * 60 + 15]: guests } })
  it("más peso a lo reciente, días cerrados fuera y lo reservado como mínimo", () => {
    const history = [day("2026-11-10", 30), day("2026-11-03", 10), day("2026-10-27", 0, false)]
    const f = forecastDay({ date: "2026-11-17", history, seats: 40, booked: { [21 * 60]: 25 } })
    expect(f.samples).toBe(2)
    expect(f.sampleDates).toEqual(["2026-11-10", "2026-11-03"])
    // (12×30 + 11×10) / 23 = 20,4 → 20
    const s = f.slots.find((x) => x.slot === "21:00")
    expect(s).toMatchObject({ expected: 20, booked: 25, projected: 25, occupancyBp: 6250 })
    expect(f.confidence).toBe("low")
    expect(f.peak?.slot).toBe("21:00")
  })
  it("confianza según muestras y variación", () => {
    const steady = Array.from({ length: 8 }, (_, i) => day(["2026-11-10", "2026-11-03", "2026-10-27", "2026-10-20", "2026-10-13", "2026-10-06", "2026-09-29", "2026-09-22"][i] as string, 20))
    expect(forecastDay({ date: "2026-11-17", history: steady, seats: 40, booked: {} })).toMatchObject({ samples: 8, confidence: "high", volatile: false })
    const wild = steady.map((d, i) => ({ ...d, slots: { [21 * 60]: i % 2 === 0 ? 40 : 5 } }))
    expect(forecastDay({ date: "2026-11-17", history: wild, seats: 40, booked: {} })).toMatchObject({ confidence: "medium", volatile: true })
    expect(forecastDay({ date: "2026-11-17", history: steady.slice(0, 3), seats: 40, booked: {} }).confidence).toBe("medium")
    expect(() => forecastDay({ date: "2026-11-17", history: [], seats: 40, booked: {}, maxWeeks: 13 })).toThrow()
    expect(forecastDay({ date: "2026-11-17", history: [], seats: 40, booked: {} })).toMatchObject({ samples: 0, confidence: "low", slots: [], peak: null })
  })
  it("presencia por tramos de 15 minutos, también pasada la medianoche", () => {
    const p = presenceBySlot([{ openedAt: at(10, 23, 30), closedAt: at(11, 0, 40), guests: 2 }, { openedAt: at(10, 23, 50), closedAt: null, guests: 3 }], "2026-11-10", TZ, at(11, 0, 20))
    expect(p).toEqual({ [23 * 60 + 30]: 2, [23 * 60 + 45]: 2, [24 * 60]: 5, [24 * 60 + 15]: 5, [24 * 60 + 30]: 2 })
  })
})

describe("resumen diario", () => {
  it("se manda una vez por día, persona y canal, a partir de la hora", () => {
    const s = { enabled: true, hour: "09:00", covers: "previous" as const }
    expect(dailySummaryDate(at(10, 8, 59), TZ, s)).toBeNull()
    expect(dailySummaryDate(at(10, 9), TZ, s)).toBe("2026-11-09")
    expect(dailySummaryDate(at(10, 23, 30), TZ, { ...s, hour: "23:30", covers: "same" })).toBe("2026-11-10")
    expect(dailySummaryDate(at(10, 9), TZ, { ...s, enabled: false })).toBeNull()
    expect(dailySummaryMessageId("2026-11-09", "u1", "email")).toBe("daily-summary.2026-11-09.u1.email")
  })
  it("texto llano con la comparación y las reservas de hoy", () => {
    const totals = { ...emptyTotals(), bills: 10, grossSalesCents: 120000, sessionGrossCents: 120000, guests: 30, reservationsExpected: 10, noShows: 1, seatMinutes: 12000, occupiedSeatMinutes: 6000 }
    const text = renderDailySummary({ date: "2026-11-09", restaurantName: "Taberna Lumbre", totals, previous: { ...totals, grossSalesCents: 100000 }, today: { reservations: 12, covers: 40, pending: 2 }, alerts: ["Queda poco aceite"] })
    expect(text).toContain("Resumen del 2026-11-09")
    expect(text).toMatch(/Ventas: 1\.?200,00/)
    expect(text).toContain("+20 % frente a hace una semana")
    expect(text).toContain("Hoy: 12 reservas, 40 comensales, 2 por confirmar")
    expect(text).toContain("Aviso: Queda poco aceite")
    expect(text).not.toContain("undefined")
    const sinBase = renderDailySummary({ date: "2026-11-09", restaurantName: "L", totals: emptyTotals(), previous: null, today: { reservations: 0, covers: 0, pending: 0 }, alerts: [] })
    expect(sinBase).toContain("ticket medio: sin datos")
    expect(sinBase).not.toContain("frente a")
  })
})

describe("automatizaciones que solo recomiendan", () => {
  const rule = AutomationRuleInputSchema.parse({
    name: "Señal a quien falla", enabled: true, event: "reservation.no_show",
    conditions: { all: [{ field: "customerNoShows", op: "gte", value: 2 }, { any: [{ field: "partySize", op: "gte", value: 6 }, { field: "hasDeposit", op: "eq", value: false }] }] },
    recommendation: { kind: "require_deposit", note: null, segmentId: null }, cooldownMinutes: 60 * 24, locationIds: [],
  })
  const ev = (id: string, minutes: number, data: AutomationEventInstance["data"], subject = "c1"): AutomationEventInstance => ({ id, type: "reservation.no_show", locationId: "centro", subject, at: at(10, 12) + minutes * 60_000, data })
  it("condiciones anidadas, campos del evento y enfriamiento", () => {
    expect(evaluateRule(rule, ev("e1", 0, { customerNoShows: 2, partySize: 2, hasDeposit: false }), null)).toEqual({ fire: true })
    expect(evaluateRule(rule, ev("e1", 0, { customerNoShows: 1, partySize: 8, hasDeposit: false }), null)).toEqual({ fire: false, reason: "conditions" })
    expect(evaluateRule(rule, ev("e2", 60, { customerNoShows: 3, partySize: 8, hasDeposit: true }), at(10, 12))).toEqual({ fire: false, reason: "cooldown" })
    expect(evaluateRule({ ...rule, enabled: false }, ev("e1", 0, {}), null)).toEqual({ fire: false, reason: "disabled" })
    expect(evaluateRule({ ...rule, locationIds: ["playa"] }, ev("e1", 0, { customerNoShows: 5, hasDeposit: false }), null)).toEqual({ fire: false, reason: "location" })
  })
  it("rechaza campos que el evento no tiene, más de dos niveles y campañas sin segmento", () => {
    const bad = (over: object) => AutomationRuleInputSchema.safeParse({ ...rule, ...over }).success
    expect(bad({ conditions: { all: [{ field: "stockLevel", op: "eq", value: 1 }] } })).toBe(false)
    expect(bad({ recommendation: { kind: "launch_campaign", note: null, segmentId: null } })).toBe(false)
    expect(bad({ conditions: { all: [{ all: [{ all: [{ field: "partySize", op: "gt", value: 1 }] }] }] } })).toBe(false)
  })
  it("la simulación respeta el enfriamiento por asunto y no ejecuta nada", () => {
    const events = [
      ev("e1", 0, { customerNoShows: 2, hasDeposit: false }),
      ev("e2", 60, { customerNoShows: 3, hasDeposit: false }),
      ev("e3", 60, { customerNoShows: 2, hasDeposit: false }, "c2"),
      ev("e4", 60 * 25, { customerNoShows: 4, hasDeposit: false }),
      ev("e5", 60 * 26, { customerNoShows: 0, hasDeposit: false }, "c3"),
    ]
    const r = simulateRule(rule, events)
    expect(r.fired.map((f) => f.eventId)).toEqual(["e1", "e3", "e4"])
    expect(r.skipped).toEqual({ event: 0, location: 0, conditions: 1, cooldown: 1 })
  })
})

describe("exportación CSV para Excel", () => {
  it("punto y coma, coma decimal, BOM y sin fórmulas", () => {
    const csv = toCsv([{ name: "=SUMA(A1)", cents: 123456, bp: -250, n: 3 }, { name: 'Tapa; "rica"', cents: 5, bp: 0, n: 0 }], [
      { header: "Plato", value: (r) => r.name }, { header: "Ventas", value: (r) => r.cents, kind: "cents" }, { header: "Variación", value: (r) => r.bp, kind: "bp" }, { header: "Unidades", value: (r) => r.n, kind: "integer" },
    ])
    expect(csv.startsWith("﻿Plato;Ventas;Variación;Unidades\r\n")).toBe(true)
    expect(csv).toContain("'=SUMA(A1);1234,56;-2,50;3\r\n")
    expect(csv).toContain('"Tapa; ""rica""";0,05;0,00;0\r\n')
    expect(() => toCsv([{ v: 1.5 }], [{ header: "x", value: (r) => r.v }])).toThrow()
  })
})
