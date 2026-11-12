import { act, renderHook, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { useAccion, useConsulta } from "./datos"

const mock = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock("./api", () => ({ llamarAnalisis: mock.call }))
vi.mock("@/lib/fase4/demo", () => ({ useLiveDoc: vi.fn(), useLiveQuery: vi.fn() }))
describe("Consultas y reintentos de análisis", () => {
  it("reintenta una mutación incierta con el mismo requestId", async () => {
    mock.call.mockReset().mockRejectedValueOnce(new Error("Sin respuesta")).mockResolvedValueOnce({ status: "accepted", kind: "review_day" })
    const { result } = renderHook(useAccion)
    const input = { restaurantId: "r", recommendationId: "rec", decision: "accepted" as const, note: null }
    await act(() => result.current.run("resolverRecomendacion", input, "Guardado"))
    expect(result.current.message).toBe("")
    await act(() => result.current.run("resolverRecomendacion", input, "Guardado"))
    expect(mock.call.mock.calls[0]![1].requestId).toBe(mock.call.mock.calls[1]![1].requestId)
    expect(result.current.message).toBe("Guardado")
  })
  it("no añade requestId a exportaciones de solo lectura con esquema estricto", async () => {
    mock.call.mockReset().mockResolvedValue({ csv: "", rows: 0, filename: "datos.csv" })
    const { result } = renderHook(useAccion)
    await act(() => result.current.run("exportarAnalisis", { restaurantId: "r", from: "2026-11-01", to: "2026-11-02", locationIds: null, kind: "hours" }, "Preparado"))
    expect(mock.call.mock.calls[0]![1]).not.toHaveProperty("requestId")
  })
  it("descarta respuestas de otro local aunque lleguen después", async () => {
    const pending = new Map<string, (v: unknown) => void>()
    mock.call.mockReset().mockImplementation((_name, input) => new Promise((resolve) => pending.set(input.locationId, resolve)))
    const { result, rerender } = renderHook(({ local }) => useConsulta("previsionOcupacion", { restaurantId: "r", locationId: local, from: "2026-11-10", days: 1 }), { initialProps: { local: "a" } })
    rerender({ local: "b" })
    await act(async () => pending.get("b")!({ seats: 20, days: [] }))
    await waitFor(() => expect(result.current.live.status).toBe("ready"))
    await act(async () => pending.get("a")!({ seats: 999, days: [] }))
    expect(result.current.live).toEqual({ status: "ready", data: { seats: 20, days: [] } })
  })
})
