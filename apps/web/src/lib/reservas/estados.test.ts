import { describe, expect, it } from "vitest"
import { actionsFor, countByFilter, formatMinutes, matchesFilter, matchesSearch, tableLabel, visibleStatus } from "./estados"
import { at, reservation } from "./fixtures"

const START = at("2026-11-10", "21:00")
const names = new Map([
  ["sala-1", "S1"],
  ["sala-2", "S2"],
])

describe("estado visible", () => {
  it("por llegar antes de la hora y retraso después", () => {
    const r = reservation({ startAt: START, status: "confirmed" })
    expect(visibleStatus(r, START - 60_000)).toEqual({ tone: "waiting", label: "por llegar", muted: false })
    expect(visibleStatus(r, START + 12 * 60_000)).toEqual({ tone: "late", label: "retraso 12 min", muted: false })
  })

  it("terminadas, canceladas y no presentadas van apagadas", () => {
    for (const status of ["finished", "cancelled", "no_show"] as const) {
      expect(visibleStatus(reservation({ status }), START).muted).toBe(true)
    }
    expect(visibleStatus(reservation({ status: "no_show" }), START).label).toBe("no presentada")
  })

  it("minutos legibles", () => {
    expect(formatMinutes(5)).toBe("5 min")
    expect(formatMinutes(65)).toBe("1 h 05")
    expect(formatMinutes(120)).toBe("2 h")
  })
})

describe("filtros", () => {
  const list = (["pending", "confirmed", "seated", "finished", "cancelled", "no_show"] as const).map((status) => reservation({ status }))

  it("por llegar junta pendientes y confirmadas; canceladas junta no presentadas", () => {
    expect(countByFilter(list)).toEqual({ all: 6, toArrive: 2, seated: 1, finished: 1, dropped: 2 })
    expect(matchesFilter("no_show", "dropped")).toBe(true)
    expect(matchesFilter("seated", "toArrive")).toBe(false)
  })
})

describe("búsqueda", () => {
  const r = reservation({ guestName: "Núria Bosch", phone: "+34612345678", reference: "K7Q2MD" })

  it("por nombre sin acentos ni mayúsculas", () => {
    expect(matchesSearch(r, "nuria")).toBe(true)
    expect(matchesSearch(r, "BOSCH")).toBe(true)
    expect(matchesSearch(r, "marta")).toBe(false)
  })

  it("por teléfono con espacios o prefijo", () => {
    expect(matchesSearch(r, "612 34")).toBe(true)
    expect(matchesSearch(r, "+34 612 345 678")).toBe(true)
    expect(matchesSearch(r, "0034612345678")).toBe(true)
  })

  it("por referencia en minúsculas", () => {
    expect(matchesSearch(r, "k7q2md")).toBe(true)
  })

  it("vacío lo encuentra todo", () => {
    expect(matchesSearch(r, "  ")).toBe(true)
  })
})

describe("acciones según el estado", () => {
  const before = START - 30 * 60_000
  const after = START + 20 * 60_000
  const kinds = (plan: ReturnType<typeof actionsFor>) => plan.secondary.map((a) => (a.kind === "status" ? a.to : a.kind))

  it("pendiente: confirmar primero; sentar, mesa, mover y cancelar después", () => {
    const plan = actionsFor(reservation({ status: "pending", startAt: START }), before, names, { canManage: true })
    expect(plan.primary).toMatchObject({ kind: "status", to: "confirmed", label: "Confirmar" })
    expect(kinds(plan)).toEqual(["seated", "tables", "move", "cancelled"])
  })

  it("confirmada con mesa: sentar en su mesa; no presentada solo pasada la hora", () => {
    const r = reservation({ status: "confirmed", startAt: START, tableIds: ["sala-1", "sala-2"] })
    const early = actionsFor(r, before, names, { canManage: true })
    expect(early.primary).toMatchObject({ kind: "status", to: "seated", label: "Sentar en S1 + S2" })
    expect(kinds(early)).toEqual(["tables", "move", "cancelled"])
    expect(kinds(actionsFor(r, after, names, { canManage: true }))).toEqual(["tables", "move", "cancelled", "no_show"])
  })

  it("sin mesa pero con sugerencia: sentar en la sugerida", () => {
    const plan = actionsFor(reservation({ status: "confirmed", suggestedTableIds: ["sala-2"] }), before, names, { canManage: true })
    expect(plan.primary).toEqual({ kind: "seatAt", tableIds: ["sala-2"], label: "Sentar en S2" })
    expect(plan.secondary[0]).toMatchObject({ kind: "tables", label: "Asignar mesa" })
  })

  it("sentada: terminar; terminada y cancelada: nada", () => {
    expect(actionsFor(reservation({ status: "seated", tableIds: ["sala-1"] }), after, names, { canManage: true }).primary).toMatchObject({ to: "finished" })
    expect(actionsFor(reservation({ status: "finished" }), after, names, { canManage: true })).toEqual({ primary: null, secondary: [] })
    expect(actionsFor(reservation({ status: "cancelled" }), after, names, { canManage: true })).toEqual({ primary: null, secondary: [] })
  })

  it("no presentada que llega tarde: se puede sentar", () => {
    expect(actionsFor(reservation({ status: "no_show", tableIds: ["sala-1"] }), after, names, { canManage: true }).primary).toMatchObject({ to: "seated" })
  })

  it("cancelar y no presentada piden confirmación", () => {
    const plan = actionsFor(reservation({ status: "confirmed", startAt: START }), after, names, { canManage: true })
    const destructive = plan.secondary.filter((a) => a.kind === "status" && a.needsConfirm)
    expect(destructive).toHaveLength(2)
  })

  it("sin permiso de gestión no hay acciones", () => {
    expect(actionsFor(reservation(), before, names, { canManage: false })).toEqual({ primary: null, secondary: [] })
  })

  it("una mesa que ya no existe se enseña por su id", () => {
    expect(tableLabel(["sala-1", "borrada"], names)).toBe("S1 + borrada")
  })
})
