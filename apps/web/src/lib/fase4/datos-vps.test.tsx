// Con el selector `postgres`, personal, inventario y compras leen de la API del VPS y no abren ninguna escucha de Firestore.
vi.mock("@/lib/firebase/config", () => ({ firebaseConfig: { ok: true, settings: { options: { projectId: "llenamos-real" } } } }))
const firebaseLive = vi.hoisted(() => ({ key: vi.fn(), doc: vi.fn() }))
vi.mock("@/lib/fase4/demo", () => ({
  useLiveQuery: (key: string | null) => { firebaseLive.key(key); return { status: "loading" } },
  useLiveDoc: (path: string | null) => { firebaseLive.doc(path); return { status: "loading" } },
}))
const api = vi.hoisted(() => ({ calls: [] as { name: string; input: unknown }[], answer: vi.fn() }))
vi.mock("@/lib/api/live", () => ({
  useLiveQuery: (name: string, input: unknown) => {
    api.calls.push({ name, input })
    return input === null ? { status: "loading" } : api.answer(name, input)
  },
}))
import { renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { defaultInventorySettings, defaultStaffSettings } from "@llenamos/core"
import { useAjustesPersonal, useEventosFichaje, useFichajesAbiertos, useFichajesDe, useFichajesPeriodo, useTurnosSemana } from "@/lib/personal/datos"
import { useAjustesInventario, useAvisos, useCostes, useIngredientes, useMovimientos, useMovimientosDesde, usePlatos, useRecetas, useRecuentos, useVersiones } from "@/lib/inventario/datos"
import { useAlbaranes, useFormatos, useIngredientes as useIngredientesCompras, usePedidos, useProveedores } from "@/lib/compras/datos"

const scope = { restaurantId: "rest-a", locationId: "centro" }
const base = "restaurants/rest-a/locations/centro"
const ready = (data: unknown) => ({ status: "ready", data })
const entry = { id: "e1", date: "2026-06-10", startAt: 1, uid: "u" }

beforeEach(() => { vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "postgres"); api.calls.length = 0; firebaseLive.key.mockClear(); firebaseLive.doc.mockClear(); api.answer.mockReset() })
afterEach(() => vi.unstubAllEnvs())

describe("lecturas de personal en VPS", () => {
  it("piden a la API por nombre, con el alcance, y Firestore queda sin clave", () => {
    api.answer.mockImplementation((name: string) => {
      if (name === "personalAjustes") return ready({ settings: { ...defaultStaffSettings(), kioskEnabled: true } })
      if (name === "personalFichajes") return ready({ entries: [{ ...entry, id: "antes", date: "2026-06-09" }, { ...entry, id: "e1" }, { ...entry, id: "e0", date: "2026-06-11" }] })
      if (name === "personalFichajesAbiertos") return ready({ entries: [entry] })
      if (name === "personalTurnos") return ready({ shifts: [{ id: "s1" }] })
      return ready({ events: [{ id: "b", at: 2 }, { id: "a", at: 1 }] })
    })
    expect(renderHook(() => useAjustesPersonal(scope, true)).result.current).toMatchObject({ status: "ready", data: { kioskEnabled: true } })
    expect(renderHook(() => useFichajesPeriodo(scope, "2026-06-10", "2026-06-16")).result.current).toMatchObject({ status: "ready" })
    expect((renderHook(() => useFichajesDe(scope, "u", "2026-06-10", "2026-06-16")).result.current as { data: { id: string }[] }).data.map((e) => e.id)).toEqual(["e0", "e1"])
    expect(renderHook(() => useFichajesAbiertos(scope)).result.current).toMatchObject({ status: "ready", data: [{ id: "e1" }] })
    expect(renderHook(() => useTurnosSemana(scope, "2026-06-15", true)).result.current).toMatchObject({ data: [{ id: "s1" }] })
    expect((renderHook(() => useEventosFichaje(scope, "e1")).result.current as { data: { id: string }[] }).data.map((e) => e.id)).toEqual(["a", "b"])
    expect(api.calls.find((c) => c.name === "personalTurnos")!.input).toEqual({ ...scope, weekStart: "2026-06-15", onlyPublished: true })
    expect(api.calls.find((c) => c.name === "personalFichajes")!.input).toMatchObject({ ...scope, from: "2026-06-10", to: "2026-06-16" })
    expect(firebaseLive.key.mock.calls.every(([key]) => key === null)).toBe(true)
    expect(firebaseLive.doc.mock.calls.every(([path]) => path === null)).toBe(true)
  })

  it("sin permiso o sin ajustes habilitados no se pide nada", () => {
    renderHook(() => useAjustesPersonal(scope, false))
    renderHook(() => useEventosFichaje(scope, null))
    renderHook(() => useFichajesAbiertos(null))
    expect(api.calls.every((c) => c.input === null)).toBe(true)
  })

  it("un error de la API llega a la pantalla, nunca datos inventados", () => {
    api.answer.mockReturnValue({ status: "error", error: Object.assign(new Error("x"), { code: "not-deployed" }) })
    expect(renderHook(() => useFichajesAbiertos(scope)).result.current).toMatchObject({ status: "error" })
  })
})

describe("lecturas de inventario y compras en VPS", () => {
  it("existencias, avisos, costes, recetas y movimientos salen de la API con consultas acotadas", () => {
    api.answer.mockImplementation((name: string) => {
      if (name === "inventarioStock") return ready({ ingredients: [{ id: "i1", name: "Patatas" }], alerts: [{ id: "i1", level: "low", status: "open" }] })
      if (name === "inventarioCostes") return ready({ costs: [{ id: "i1", valueCents: 120, lastCost: null }] })
      if (name === "inventarioRecetas") return ready({ recipes: [{ id: "r1" }] })
      if (name === "inventarioPlatos") return ready({ items: [{ id: "bravas" }] })
      if (name === "inventarioAjustes") return ready({ saved: true, settings: { ...defaultInventorySettings(), consumeOnSale: true } })
      if (name === "inventarioRecuentos") return ready({ counts: [{ id: "c1" }] })
      if (name === "inventarioMovimientos") return ready({ movements: [{ id: "m1" }] })
      return ready({ versions: [{ version: 2 }, { version: 1 }] })
    })
    expect(renderHook(() => useIngredientes(base)).result.current).toMatchObject({ data: [{ id: "i1" }] })
    const avisos = renderHook(() => useAvisos(base)).result.current
    expect(avisos.status === "ready" && avisos.data.get("i1")).toMatchObject({ level: "low" })
    const costes = renderHook(() => useCostes(base, true)).result.current
    expect(costes.status === "ready" && costes.data.get("i1")).toEqual({ valueCents: 120, lastCost: null })
    expect(renderHook(() => useRecetas(base)).result.current).toMatchObject({ data: [{ id: "r1" }] })
    expect(renderHook(() => usePlatos(base)).result.current).toMatchObject({ data: [{ id: "bravas" }] })
    expect(renderHook(() => useAjustesInventario(base)).result.current).toMatchObject({ data: { guardado: true, ajustes: { consumeOnSale: true } } })
    expect(renderHook(() => useRecuentos(base)).result.current).toMatchObject({ data: [{ id: "c1" }] })
    renderHook(() => useMovimientos(base, 99999, "i1"))
    renderHook(() => useMovimientosDesde(base, 123))
    expect(renderHook(() => useVersiones(base, "r1")).result.current).toMatchObject({ data: [{ version: 2 }, { version: 1 }] })
    const moves = api.calls.filter((c) => c.name === "inventarioMovimientos").map((c) => c.input)
    expect(moves).toEqual([{ ...scope, max: 2000, ingredientId: "i1", since: null }, { ...scope, max: 2000, ingredientId: null, since: 123 }])
    expect(firebaseLive.key.mock.calls.every(([key]) => key === null)).toBe(true)
    expect(firebaseLive.doc.mock.calls.every(([path]) => path === null)).toBe(true)
  })

  it("sin local o sin permiso de costes no se pide nada", () => {
    renderHook(() => useIngredientes(null))
    renderHook(() => useCostes(base, false))
    renderHook(() => useMovimientosDesde(base, null))
    renderHook(() => useVersiones(base, null))
    expect(api.calls.every((c) => c.input === null)).toBe(true)
  })

  it("compras: proveedores, formatos, ingredientes, pedidos y albaranes de la API", () => {
    api.answer.mockImplementation((name: string) => {
      if (name === "comprasProveedores") return ready({ suppliers: [{ id: "p1" }], items: [{ id: "f1" }] })
      if (name === "comprasIngredientes") return ready({ ingredients: [{ id: "i1" }] })
      if (name === "comprasPedidos") return ready({ orders: [{ id: "o1" }] })
      return ready({ receipts: [{ id: "a1" }] })
    })
    expect(renderHook(() => useProveedores(scope)).result.current).toMatchObject({ data: [{ id: "p1" }] })
    expect(renderHook(() => useFormatos(scope)).result.current).toMatchObject({ data: [{ id: "f1" }] })
    expect(renderHook(() => useIngredientesCompras(scope)).result.current).toMatchObject({ data: [{ id: "i1" }] })
    expect(renderHook(() => usePedidos(scope)).result.current).toMatchObject({ data: [{ id: "o1" }] })
    expect(renderHook(() => useAlbaranes(scope, "o1")).result.current).toMatchObject({ data: [{ id: "a1" }] })
    expect(api.calls.find((c) => c.name === "comprasAlbaranes")!.input).toEqual({ ...scope, orderId: "o1" })
    expect(firebaseLive.key.mock.calls.every(([key]) => key === null)).toBe(true)
  })
})
