// Con el selector `postgres`, análisis, campañas y fidelización leen de la API del VPS y no abren ninguna escucha de Firestore.
const demo = vi.hoisted(() => ({ key: vi.fn(), doc: vi.fn() }))
vi.mock("@/lib/fase4/demo", () => ({
  useLiveQuery: (key: string | null) => { demo.key(key); return { status: "loading" } },
  useLiveDoc: (path: string | null) => { demo.doc(path); return { status: "loading" } },
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
import { esquemas, useColeccion, useDocumento } from "@/lib/fidelizacion/datos"
import { useAjustes, useRecomendaciones, useReglas } from "@/lib/analisis/datos"
import { useAjustesMarketing, useCampanas, useSegmentos } from "@/lib/campanas/datos"

const ready = (data: unknown) => ({ status: "ready", data })
beforeEach(() => { vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "postgres"); api.calls.length = 0; demo.key.mockClear(); demo.doc.mockClear(); api.answer.mockReset() })
afterEach(() => vi.unstubAllEnvs())
const sinFirestore = () => {
  expect(demo.key.mock.calls.every(([k]) => k === null)).toBe(true)
  expect(demo.doc.mock.calls.every(([p]) => p === null)).toBe(true)
}

describe("lecturas de gestión en VPS", () => {
  it("análisis pide ajustes, reglas y recomendaciones por nombre", () => {
    api.answer.mockReturnValue(ready([]))
    renderHook(() => useAjustes("r1"))
    renderHook(() => useReglas("r1"))
    renderHook(() => useRecomendaciones("r1"))
    expect(api.calls).toEqual([
      { name: "analisis.ajustes", input: { restaurantId: "r1" } },
      { name: "analisis.reglas", input: { restaurantId: "r1" } },
      { name: "analisis.recomendaciones", input: { restaurantId: "r1" } },
    ])
    sinFirestore()
  })
  it("sin restaurante no se pide nada", () => {
    renderHook(() => useReglas(null))
    expect(api.calls.every((c) => c.input === null)).toBe(true)
  })
  it("campañas pide campañas, segmentos y ajustes", () => {
    api.answer.mockReturnValue(ready([]))
    renderHook(() => useCampanas("r1"))
    renderHook(() => useSegmentos("r1"))
    renderHook(() => useAjustesMarketing("r1"))
    expect(api.calls.map((c) => c.name)).toEqual(["campanas.campanas", "campanas.segmentos", "campanas.ajustes"])
    sinFirestore()
  })
  it("fidelización traduce las rutas de la demo a lecturas de la API", () => {
    api.answer.mockReturnValue(ready(null))
    renderHook(() => useDocumento("r1", "settings/loyalty", esquemas.LoyaltySettingsSchema))
    renderHook(() => useDocumento("r1", "settings/repite", esquemas.RepiteSettingsSchema))
    renderHook(() => useColeccion("r1", "loyaltyRewards", esquemas.LoyaltyRewardSchema))
    renderHook(() => useColeccion("r1", "promotions", esquemas.PromotionSchema))
    expect(api.calls.map((c) => c.name)).toEqual(["fidelizacion.ajustes", "fidelizacion.repite", "fidelizacion.premios", "fidelizacion.promociones"])
    sinFirestore()
  })
  it("fidelización desactivada no pide nada y una ruta sin lectura es un error visible", () => {
    renderHook(() => useDocumento("r1", "settings/loyalty", esquemas.LoyaltySettingsSchema, false))
    expect(api.calls.every((c) => c.input === null)).toBe(true)
    expect(renderHook(() => useDocumento("r1", "settings/otra", esquemas.LoyaltySettingsSchema)).result.current.status).toBe("error")
  })
  it("un error de la API llega a la pantalla, nunca datos inventados", () => {
    api.answer.mockReturnValue({ status: "error", error: Object.assign(new Error("x"), { code: "not-deployed" }) })
    expect(renderHook(() => useCampanas("r1")).result.current.status).toBe("error")
  })
})

describe("último resumen de análisis en VPS", () => {
  it("lo da la lectura analisis.ultimoResumen, sin probar fechas", async () => {
    const { useUltimoResumen } = await import("@/lib/analisis/datos")
    api.answer.mockReturnValue(ready({ date: "2026-11-10" }))
    const { result } = renderHook(() => useUltimoResumen("r1"))
    expect(result.current).toMatchObject({ vps: true, api: { status: "ready", data: { date: "2026-11-10" } } })
    expect(api.calls).toEqual([{ name: "analisis.ultimoResumen", input: { restaurantId: "r1" } }])
  })
})
