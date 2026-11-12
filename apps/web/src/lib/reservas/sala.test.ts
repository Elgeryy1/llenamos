import { describe, expect, it } from "vitest"
import { staffAvailability, walkInTime } from "./disponibilidad"
import { at, config, reservation, TZ } from "./fixtures"
import { arrivals, countStates, liveLine, liveTables } from "./sala"

const TUE = "2026-11-10"
const tables = [
  { id: "s1", enabled: true },
  { id: "s2", enabled: true },
  { id: "s3", enabled: true },
  { id: "t6", enabled: false },
]

describe("sala en directo", () => {
  const now = at(TUE, "21:00")
  const seated = reservation({ status: "seated", tableIds: ["s1", "s2"], startAt: at(TUE, "20:00"), durationMinutes: 90, history: [{ from: "confirmed", to: "seated", at: at(TUE, "20:10"), by: null, reason: null }] })
  const soon = reservation({ status: "confirmed", tableIds: ["s3"], startAt: at(TUE, "21:20") })
  const later = reservation({ status: "confirmed", tableIds: ["s1"], startAt: at(TUE, "22:30") })
  const cancelled = reservation({ status: "cancelled", tableIds: ["s2"], startAt: at(TUE, "21:00") })
  const live = liveTables(tables, [later, soon, seated, cancelled], now)

  it("sentados con sus minutos, progreso y mesas unidas", () => {
    const s1 = live.get("s1")!
    expect(s1).toMatchObject({ state: "seated", minutes: 50, joinedWith: ["s2"] })
    expect(s1.current?.id).toBe(seated.id)
    expect(s1.next?.id).toBe(later.id)
    expect(s1.progress).toBeCloseTo(50 / 90)
    expect(live.get("s2")).toMatchObject({ state: "seated", joinedWith: ["s1"] })
  })

  it("llega pronto si falta menos de media hora; las canceladas no cuentan", () => {
    expect(live.get("s3")?.state).toBe("soon")
    expect(live.get("s2")?.reservations.map((r) => r.id)).toEqual([seated.id])
  })

  it("pasa de su hora y deshabilitada", () => {
    const late = liveTables(tables, [seated], at(TUE, "21:50"))
    expect(late.get("s1")?.state).toBe("overtime")
    expect(late.get("t6")?.state).toBe("disabled")
    expect(countStates(late)).toEqual({ free: 1, reserved: 0, soon: 0, late: 0, seated: 0, overtime: 2, disabled: 1 })
  })

  it("va tarde si ya pasó su hora y no ha llegado", () => {
    const tarde = liveTables(tables, [soon], soon.startAt + 12 * 60_000)
    expect(tarde.get("s3")).toMatchObject({ state: "late", minutes: 12 })
    expect(countStates(tarde).late).toBe(1)
  })

  it("reservada más tarde y libre", () => {
    const l = liveTables(tables, [later], now)
    expect(l.get("s1")?.state).toBe("reserved")
    expect(l.get("s3")?.state).toBe("free")
  })

  it("texto de cada mesa en el plano", () => {
    expect(liveLine(live.get("s1")!, TZ)).toBe(`${seated.guestName} · 50 min`)
    expect(liveLine(live.get("s3")!, TZ)).toBe(`21:20 ${soon.guestName}`)
    expect(liveLine(liveTables(tables, [soon], at(TUE, "21:25")).get("s3")!, TZ)).toBe(`21:20 ${soon.guestName}, retraso 5 min`)
    expect(liveLine(liveTables(tables, [later], now).get("s1")!, TZ)).toBe("Reservada 22:30")
    expect(liveLine(live.get("t6")!, TZ)).toBe("Deshabilitada")
  })

  it("próximas llegadas en orden de hora", () => {
    expect(arrivals([later, seated, soon], now).map((r) => r.id)).toEqual([soon.id, later.id])
  })
})

describe("horas libres para el personal", () => {
  const mesas = [
    { id: "s1", name: "S1", areaId: "sala", seats: 2, shape: "rect" as const, x: 0, y: 0, w: 10, h: 10, joinableWith: [], enabled: true },
  ]

  it("ofrece las franjas del día y marca las ocupadas con su motivo", () => {
    const busy = reservation({ status: "confirmed", tableIds: ["s1"], startAt: at(TUE, "21:00"), durationMinutes: 90 })
    const a = staffAvailability({ config: config(), date: TUE, partySize: 2, tables: mesas, reservations: [busy], now: at(TUE, "10:00") })
    expect(a.open).toBe(true)
    expect(a.slots.find((s) => s.time === "13:00")?.available).toBe(true)
    const nine = a.slots.find((s) => s.time === "21:00")
    expect(nine?.available).toBe(false)
    expect(nine?.reason).toContain("mesa")
  })

  it("se salta la antelación mínima de la web y no choca consigo misma al mover", () => {
    const own = reservation({ id: "yo", status: "confirmed", tableIds: ["s1"], startAt: at(TUE, "21:00") })
    const a = staffAvailability({ config: config(), date: TUE, partySize: 2, tables: mesas, reservations: [own], now: at(TUE, "20:50"), excludeReservationId: "yo" })
    expect(a.slots.find((s) => s.time === "21:00")?.available).toBe(true)
  })

  it("un día cerrado lo dice", () => {
    const a = staffAvailability({ config: config(), date: "2026-11-09", partySize: 2, tables: mesas, reservations: [], now: at(TUE, "10:00") })
    expect(a.open).toBe(false)
    expect(a.message).toContain("lunes")
  })

  it("quien entra sin reserva: ahora redondeado a 5 minutos", () => {
    expect(walkInTime(at(TUE, "20:43"), TZ)).toEqual({ date: TUE, time: "20:40" })
  })
})
