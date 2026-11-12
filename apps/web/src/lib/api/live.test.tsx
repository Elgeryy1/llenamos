import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { useLiveQuery } from "./live"
import { cancelIdentityRequests } from "./transport"

vi.mock("@/lib/firebase/auth-client", () => ({ identityToken: async () => "token-de-prueba" }))
const schema = z.object({ names: z.array(z.string()) })
const encoder = new TextEncoder()

/** Servidor SSE falso: cada petición recibe un controlador para empujar tramas a mano. */
function fakeServer() {
  const pushes: Array<(text: string) => void> = []
  const requests: Array<{ path: string; body: unknown; headers: Record<string, string>; signal: AbortSignal }> = []
  const fetcher = vi.fn(async (path: string, init: RequestInit) => {
    requests.push({ path, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string>, signal: init.signal! })
    return new Response(new ReadableStream({
      start(controller) {
        pushes.push(text => controller.enqueue(encoder.encode(text)))
        init.signal!.addEventListener("abort", () => { try { controller.error(new DOMException("abort", "AbortError")) } catch { /* ya cerrado */ } })
      },
    }), { status: 200 })
  })
  vi.stubGlobal("fetch", fetcher)
  return { pushes, requests, fetcher }
}
const frame = (id: number, value: unknown) => `id: ${id}\nevent: snapshot\ndata: ${JSON.stringify(value)}\n\n`

afterEach(() => { vi.unstubAllGlobals(); cancelIdentityRequests() })
describe("useLiveQuery sobre la API del VPS", () => {
  it("con input null no abre ninguna conexión", () => {
    const server = fakeServer()
    const { result } = renderHook(() => useLiveQuery("localesPrueba", null, schema))
    expect(result.current).toEqual({ status: "loading" })
    expect(server.fetcher).not.toHaveBeenCalled()
  })
  it("pasa de cargando a datos y se actualiza con cada foto nueva", async () => {
    const server = fakeServer()
    const { result } = renderHook(() => useLiveQuery("localesPrueba", { restaurantId: "r1" }, schema))
    expect(result.current).toEqual({ status: "loading" })
    await waitFor(() => expect(server.pushes).toHaveLength(1))
    expect(server.requests[0]).toMatchObject({ path: "/api/v1/live/localesPrueba", body: { data: { restaurantId: "r1" } }, headers: { Authorization: "Bearer token-de-prueba" } })
    act(() => server.pushes[0]!(frame(1, { names: ["a"] })))
    await waitFor(() => expect(result.current).toEqual({ status: "ready", data: { names: ["a"] } }))
    act(() => server.pushes[0]!(frame(2, { names: ["a", "b"] })))
    await waitFor(() => expect(result.current).toEqual({ status: "ready", data: { names: ["a", "b"] } }))
  })
  it("un input equivalente en otro objeto no reabre la conexión; otro input sí y no mezcla datos", async () => {
    const server = fakeServer()
    const { result, rerender } = renderHook(({ rid }) => useLiveQuery("localesPrueba", { restaurantId: rid }, schema), { initialProps: { rid: "r1" } })
    await waitFor(() => expect(server.pushes).toHaveLength(1))
    act(() => server.pushes[0]!(frame(1, { names: ["uno"] })))
    await waitFor(() => expect(result.current.status).toBe("ready"))
    rerender({ rid: "r1" })
    expect(server.fetcher).toHaveBeenCalledTimes(1)
    rerender({ rid: "r2" })
    expect(result.current).toEqual({ status: "loading" })
    await waitFor(() => expect(server.pushes).toHaveLength(2))
    expect(server.requests[0]!.signal.aborted).toBe(true)
    expect(server.requests[1]!.body).toEqual({ data: { restaurantId: "r2" } })
  })
  it("una foto que no cumple el contrato se enseña como error y corta la conexión", async () => {
    const server = fakeServer()
    const { result } = renderHook(() => useLiveQuery("localesPrueba", { restaurantId: "r1" }, schema))
    await waitFor(() => expect(server.pushes).toHaveLength(1))
    act(() => server.pushes[0]!(frame(1, { names: 5 })))
    await waitFor(() => expect(result.current.status).toBe("error"))
    expect(server.requests[0]!.signal.aborted).toBe(true)
  })
  it("al desmontar, o al cambiar de cuenta, cancela la conexión", async () => {
    const server = fakeServer()
    const first = renderHook(() => useLiveQuery("localesPrueba", { restaurantId: "r1" }, schema))
    await waitFor(() => expect(server.pushes).toHaveLength(1))
    first.unmount()
    expect(server.requests[0]!.signal.aborted).toBe(true)
    renderHook(() => useLiveQuery("localesPrueba", { restaurantId: "r1" }, schema))
    await waitFor(() => expect(server.pushes).toHaveLength(2))
    cancelIdentityRequests()
    expect(server.requests[1]!.signal.aborted).toBe(true)
  })
  it("una lectura no desplegada o sin permiso se enseña como error definitivo y no reintenta", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { code: "not-deployed", message: "x" } }), { status: 404 }))
    vi.stubGlobal("fetch", fetcher)
    const { result } = renderHook(() => useLiveQuery("noExiste", { restaurantId: "r1" }, schema))
    await waitFor(() => expect(result.current.status).toBe("error"))
    expect(result.current).toMatchObject({ error: { code: "not-deployed" } })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it("tras cancelar las conexiones (cambio de cuenta o salir) deja de enseñar los datos anteriores", async () => {
    const server = fakeServer()
    const { result } = renderHook(() => useLiveQuery("localesPrueba", { restaurantId: "r1" }, schema))
    await waitFor(() => expect(server.pushes).toHaveLength(1))
    act(() => server.pushes[0]!(frame(1, { names: ["de-la-cuenta-anterior"] })))
    await waitFor(() => expect(result.current.status).toBe("ready"))
    act(() => cancelIdentityRequests())
    await waitFor(() => expect(result.current).toEqual({ status: "loading" }))
    expect(JSON.stringify(result.current)).not.toContain("cuenta-anterior")
  })
})
