import { describe, expect, it } from "vitest"
import { demoMenu } from "@llenamos/core"
// Ejemplos de core solo para pruebas. No se cargan en las pantallas.
import { linea, T0 } from "../../../../../packages/core/src/sala/datos-prueba"
import { claveTicket, nuevosRetrasos, platosDeEstacion, puedeVer, ticketsDeEstacion, type StationDoc } from "./modelo"

export const station: StationDoc = { id: "cocina", name: "Cocina", kind: "kitchen", sortOrder: 0, targetMinutes: 10, pickup: true, active: true }
const line = (id: string, changes: Parameters<typeof linea>[0] = {}) => ({ id, ...linea(changes) })

describe("Aislamiento de cocina y barra", () => {
  it("excluye otra estación, otro tipo, padres de menú y pedidos sin aceptar", () => {
    const lines = [line("propia"), line("otra", { stationId: "barra", stationKind: "bar" }), line("tipo-falso", { stationKind: "bar" }), line("pendiente", { status: "pending" }), line("padre", { kind: "menu" }), line("servida", { status: "served" })]
    expect(ticketsDeEstacion(lines, station, T0, 3).flatMap((t) => t.lines.map((l) => l.id))).toEqual(["propia"])
  })
  it("separa la misma comanda entre dos mesas y un destino para llevar", () => {
    const tickets = ticketsDeEstacion([line("a"), line("b", { sessionId: "s2", label: "S5" }), line("c", { sessionId: null, takeawayId: "t1", label: "Recogida" })], station, T0, 3)
    expect(tickets).toHaveLength(3)
    expect(new Set(tickets.map(claveTicket)).size).toBe(3)
    expect(tickets.map((t) => t.lines.length)).toEqual([1, 1, 1])
  })
  it("permite únicamente el rol propio y responsables", () => {
    expect(puedeVer("kitchen", "bar")).toBe(false)
    expect(puedeVer("bar", "kitchen")).toBe(false)
    expect(puedeVer("waiter", "kitchen")).toBe(false)
    expect(puedeVer("kitchen", "kitchen")).toBe(true)
    expect(puedeVer("bar", "bar")).toBe(true)
    expect(puedeVer("manager", "bar")).toBe(true)
    expect(puedeVer("owner", "kitchen")).toBe(true)
  })
  it("usa el destino de estación real, incluido el de respaldo, para agotados", () => {
    const demo = demoMenu()
    const item = Object.values(demo.items)[0]!
    const bar: StationDoc = { ...station, id: "barra", kind: "bar" }
    const items = [{ ...item, id: "directo", stationId: "cocina" }, { ...item, id: "respaldo", stationId: "borrada" }, { ...item, id: "ajeno", stationId: "barra" }, { ...item, id: "inactivo", active: false, stationId: "cocina" }]
    expect(platosDeEstacion(items, [station, bar], station, "cocina").map((i) => i.id).sort()).toEqual(["directo", "respaldo"])
  })
})

describe("Avisos de retraso", () => {
  it("avisa al cruzar el plazo y no repite ni avisa por retrasos antiguos", () => {
    const lines = [line("a")]
    const due = T0 + 10 * 60_000
    expect(nuevosRetrasos(lines, due - 1, due)).toEqual(["a"])
    expect(nuevosRetrasos(lines, due, due + 5_000)).toEqual([])
    expect(nuevosRetrasos(lines, due + 5_000, due + 10_000)).toEqual([])
  })
  it("cuenta desde la marcha y no desde empezar; no duplica la recogida", () => {
    const due = T0 + 10 * 60_000
    expect(nuevosRetrasos([line("preparando", { status: "preparing", startedAt: T0 + 9 * 60_000 }), line("lista", { status: "ready", readyAt: T0 }), line("retenida", { status: "held" })], due - 1, due)).toEqual(["preparando"])
  })
})
