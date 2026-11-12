import { renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { defaultFloorSettings } from "@llenamos/core"

const live = vi.hoisted(() => ({ useLiveQuery: vi.fn() }))
vi.mock("@/lib/api/live", () => live)
const transport = vi.hoisted(() => ({ postOperation: vi.fn() }))
vi.mock("@/lib/api/transport", async (original) => ({ ...(await original<typeof import("@/lib/api/transport")>()), postOperation: transport.postOperation }))

const scope = { restaurantId: "r", locationId: "l" }
const historial = { sessions: [{ id: "s3" }, { id: "s1" }], tasks: [], takeaways: [{ id: "k0" }], orders: [], lines: [{ id: "l9", sessionId: "s3", takeawayId: null }], truncated: false }
const servicio = {
  truncated: false, sessions: [{ id: "s1" }, { id: "s2" }], tasks: [{ id: "t1" }], takeaways: [{ id: "k1" }], orders: [{ id: "o1", sessionId: "s1" }, { id: "o2", sessionId: "s2" }],
  lines: [{ id: "l1", sessionId: "s1", takeawayId: null }, { id: "l2", sessionId: "s2", takeawayId: null }, { id: "l3", sessionId: null, takeawayId: "k1" }],
}
const carta = { categories: [{ id: "c" }], items: [{ id: "i" }], menus: [], stations: [{ id: "st" }], settings: defaultFloorSettings(), settingsSaved: false }

describe("sala y cocina en modo VPS", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "postgres")
    live.useLiveQuery.mockReset()
    live.useLiveQuery.mockImplementation((name: string, input: unknown) => input === null ? { status: "loading" } : ({ status: "ready", data: name === "salaServicio" ? servicio : name === "salaHistorial" ? historial : name === "salaCarta" ? carta : { lines: [{ id: "l1" }] } }))
  })
  afterEach(() => vi.unstubAllEnvs())

  it("lee mesas, tareas, recogidas y líneas del servicio vivo, sin tocar Firestore", async () => {
    const datos = await import("@/lib/comandero/datos")
    // Las mesas cerradas de las últimas horas se suman a las vivas, sin duplicar.
    expect(renderHook(() => datos.useMesas(scope)).result.current).toEqual({ status: "ready", data: [{ id: "s1" }, { id: "s2" }, { id: "s3" }] })
    expect(renderHook(() => datos.useTareas(scope)).result.current).toMatchObject({ data: servicio.tasks })
    expect(renderHook(() => datos.useRecogidas(scope)).result.current).toMatchObject({ data: [{ id: "k1" }, { id: "k0" }] })
    expect(renderHook(() => datos.useServicio(scope)).result.current).toMatchObject({ data: [...servicio.lines, historial.lines[0]] })
    const destino = renderHook(() => datos.useDestino(scope, "sessionId", "s1")).result.current
    expect(destino.lines).toMatchObject({ data: [servicio.lines[0]] }); expect(destino.orders).toMatchObject({ data: [servicio.orders[0]] })
    const recogida = renderHook(() => datos.useDestino(scope, "takeawayId", "k1")).result.current
    expect(recogida.lines).toMatchObject({ data: [servicio.lines[2]] })
    expect(live.useLiveQuery).toHaveBeenCalledWith("salaServicio", scope, expect.anything())
  })
  it("entrega carta, ajustes y estaciones de una sola lectura acotada", async () => {
    const datos = await import("@/lib/comandero/datos")
    expect(renderHook(() => datos.useCarta(scope)).result.current).toMatchObject({ data: { items: carta.items, categories: carta.categories, menus: [] } })
    expect(renderHook(() => datos.useAjustesSala(scope)).result.current).toMatchObject({ data: carta.settings })
    const hooks = await import("@/lib/carta/hooks")
    expect(renderHook(() => hooks.useFloor("restaurants/r/locations/l")).result.current).toMatchObject({ data: { saved: false } })
    expect(renderHook(() => hooks.useStations("restaurants/r/locations/l")).result.current).toMatchObject({ data: carta.stations })
    expect(renderHook(() => hooks.useCatalog("r", "l")).result.current.items).toMatchObject({ data: carta.items })
    expect(renderHook(() => hooks.useCatalog("r", null)).result.current.items).toEqual({ status: "loading" })
  })
  it("la estación solo pide sus líneas y espera a tener estación", async () => {
    const cocina = await import("@/lib/cocina/datos")
    expect(renderHook(() => cocina.useLineasEstacion("restaurants/r/locations/l", "st", "kitchen", 0)).result.current).toMatchObject({ data: [{ id: "l1" }] })
    expect(live.useLiveQuery).toHaveBeenCalledWith("cocinaLineas", { ...scope, stationId: "st", kind: "kitchen" }, expect.anything())
    live.useLiveQuery.mockClear()
    renderHook(() => cocina.useLineasEstacion("restaurants/r/locations/l", null, "kitchen", 0))
    expect(live.useLiveQuery).toHaveBeenCalledWith("cocinaLineas", null, expect.anything())
  })
  it("si el historial falla o tarda, se enseña lo vivo sin tapar el servicio", async () => {
    live.useLiveQuery.mockImplementation((name: string) => name === "salaHistorial" ? { status: "error", error: new Error("x") } : { status: "ready", data: servicio })
    const datos = await import("@/lib/comandero/datos")
    expect(renderHook(() => datos.useMesas(scope)).result.current).toEqual({ status: "ready", data: servicio.sessions })
  })
  it("un fallo de la API llega como error de la lectura, nunca como datos", async () => {
    live.useLiveQuery.mockReturnValue({ status: "error", error: new Error("not-deployed") })
    const datos = await import("@/lib/comandero/datos")
    expect(renderHook(() => datos.useMesas(scope)).result.current.status).toBe("error")
  })
  it("la carta pública sale de la operación pública por slug y local", async () => {
    transport.postOperation.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "unavailable" }))
    const hooks = await import("@/lib/carta/hooks")
    const { result } = renderHook(() => hooks.useMenu("hash", { slug: "demo", locationId: "l" }))
    expect(result.current).toEqual({ status: "loading" })
    await waitFor(() => expect(transport.postOperation).toHaveBeenCalledWith("verCartaPublica", { slug: "demo", locationId: "l" }, { authentication: "none" }))
    expect(hooks.useMenu).toBeTypeOf("function")
  })
  it("las fotos van por el servicio de archivos del VPS: subida con sesión y descarga por enlace público", async () => {
    const id = "123e4567-e89b-42d3-a456-426614174000"
    const files = await import("@/lib/api/files")
    const subida = vi.spyOn(files, "uploadFile").mockResolvedValue({ id, contentType: "image/jpeg", sizeBytes: 1, sha256: "x" })
    const photos = await import("@/lib/carta/photos")
    const file = new File(["x"], "a.jpg", { type: "image/jpeg" })
    const ruta = await photos.uploadPhoto("r", "l", "i", file)
    expect(subida).toHaveBeenCalledWith("r", "carta_foto", file)
    expect(ruta).toBe(`restaurants/r/locations/l/menu/i/${id}`)
    const fetcher = vi.fn().mockResolvedValue(new Response("bytes", { status: 200 }))
    vi.stubGlobal("fetch", fetcher)
    await expect(photos.photoBlob(ruta)).resolves.toBeInstanceOf(Blob)
    expect(fetcher).toHaveBeenCalledWith(`/api/v1/public/files/r/${id}`, { credentials: "omit", redirect: "error" })
    await expect(photos.photoBlob("restaurants/r/locations/l/menu/i/a.jpg")).rejects.toThrow(/no está disponible/)
    vi.unstubAllGlobals()
  })
})
