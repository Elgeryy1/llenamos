import type { CallableInput, CallableOutput, CallableWithSchema } from "@llenamos/core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ token: vi.fn(), queue: vi.fn(), legacy: vi.fn() }))
vi.mock("@/lib/firebase/auth-client", () => ({ identityToken: mocks.token }))
vi.mock("@/lib/firebase/client", () => ({ getFirebase: mocks.legacy }))
vi.mock("@/lib/sin-conexion/cliente", () => ({ queueOperation: mocks.queue, puedeEncolar: async () => true }))
vi.mock("@/lib/firebase/config", () => ({ firebaseConfig: { ok: true, settings: { options: { projectId: "llenamos-real" } } } }))
import { llamarCaja, esIncierto as cajaIncierto } from "@/lib/caja/api"
import { buscarUltimoResumen, llamarAnalisis } from "@/lib/analisis/api"
import { llamarCompras, esDefinitivo as compraDefinitivo } from "@/lib/compras/api"
import { llamarMarketing } from "@/lib/campanas/api"
import { llamarFidelizacion } from "@/lib/fidelizacion/api"
import { llamarPersonal, esIncierto as personalIncierto } from "@/lib/personal/api"
import { llamarSala } from "@/lib/comandero/callables"
import { llamarCocina } from "@/lib/cocina/callables"
import { callService } from "@/lib/carta/callables"
import { esDefinitivo as inventarioDefinitivo } from "@/lib/inventario/acciones"
type Wrapper = <N extends CallableWithSchema>(name: N, input: CallableInput<N>) => Promise<CallableOutput<N>>
const samples: { module: string; wrapper: Wrapper; name: CallableWithSchema; input: unknown; output: unknown; public?: boolean }[] = [
  { module: "caja", wrapper: llamarCaja as Wrapper, name: "abrirCaja", input: { restaurantId: "r", locationId: "l", requestId: "i", registerId: "principal", openingCents: 100 }, output: { cashSessionId: "c1" } },
  { module: "análisis", wrapper: llamarAnalisis as Wrapper, name: "verResumenDiario", input: { restaurantId: "r", date: "2026-11-10" }, output: { date: "2026-11-10", text: "Resumen", sentTo: [] } },
  { module: "compras", wrapper: llamarCompras as Wrapper, name: "sugerirPedidos", input: { restaurantId: "r", locationId: "l" }, output: { orders: [], withoutSupplier: [] } },
  { module: "campañas", wrapper: llamarMarketing as Wrapper, name: "darseDeBaja", input: { slug: "taberna", token: "a".repeat(43), website: "" }, output: { ok: true }, public: true },
  { module: "fidelización", wrapper: llamarFidelizacion as Wrapper, name: "altaFidelizacion", input: { restaurantId: "r", requestId: "i", customerId: "a".repeat(20), acceptedTermsVersion: "1" }, output: { balance: 0, enrolledAt: 1700000000000, alreadyEnrolled: false } },
  { module: "personal", wrapper: llamarPersonal as Wrapper, name: "fichar", input: { restaurantId: "r", locationId: "l", requestId: "i", action: "in", note: null }, output: { entryId: "e1", state: "working", at: 1700000000000, workedMinutes: null } },
  { module: "sala", wrapper: llamarSala, name: "abrirMesa", input: { restaurantId: "r", locationId: "l", tableIds: ["t"], guests: 2 }, output: { sessionId: "s1", label: "S1", joinable: true, reservationSeated: false } },
  { module: "cocina", wrapper: llamarCocina as Wrapper, name: "guardarRaciones", input: { restaurantId: "r", locationId: "l", itemId: "p", remaining: 4 }, output: { ok: true } },
  { module: "carta", wrapper: callService as Wrapper, name: "guardarCategoriaCarta", input: { restaurantId: "r", locationId: "l", categoryId: null, category: { name: { es: "Bebidas", ca: "", en: "" }, description: { es: "", ca: "", en: "" }, sortOrder: 0, active: true } }, output: { ok: true, categoryId: "c1" } },
]
beforeEach(() => { vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "postgres"); vi.clearAllMocks(); mocks.token.mockResolvedValue("private-token") })
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })
describe("wrappers de módulos en VPS", () => {
  it.each(samples)("$module valida ida/vuelta y envía al nombre de operación real", async sample => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ result: sample.output }))
    vi.stubGlobal("fetch", fetcher)
    expect(await sample.wrapper(sample.name, sample.input as never)).toEqual(sample.output)
    expect(fetcher).toHaveBeenCalledWith(`/api/v1/operations/${sample.name}`, expect.objectContaining({ method: "POST", credentials: "omit", redirect: "error" }))
    const headers = fetcher.mock.calls[0]?.[1]?.headers as Record<string, string>
    expect(headers.Authorization).toBe(sample.public ? undefined : "Bearer private-token")
    expect(mocks.legacy).not.toHaveBeenCalled()
    expect(mocks.queue).not.toHaveBeenCalled()
  })
  it.each(samples)("$module rechaza servidor ausente sin simular ni activar Firebase", async sample => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("Not found", { status: 404 }))
    vi.stubGlobal("fetch", fetcher)
    await expect(sample.wrapper(sample.name, sample.input as never)).rejects.toMatchObject({ code: sample.module === "carta" ? "missing" : "not-deployed" })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(mocks.legacy).not.toHaveBeenCalled()
    expect(mocks.queue).not.toHaveBeenCalled()
  })
  it.each(samples)("$module no confirma una salida que incumple core", async sample => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ result: null }))
    vi.stubGlobal("fetch", fetcher)
    await expect(sample.wrapper(sample.name, sample.input as never)).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledOnce()
    expect(mocks.legacy).not.toHaveBeenCalled()
  })
  it("QR público no envía identidad aunque el caller pida autenticación", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("Not found", { status: 404 }))
    await expect(callService("verMesaPublica", { slug: "taberna", locationId: "l", tableId: "t", token: "a".repeat(43) }, true, fetcher)).rejects.toMatchObject({ code: "missing" })
    expect(mocks.token).not.toHaveBeenCalled()
    expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual({ "Content-Type": "application/json" })
  })
  it("un backend de resumen ausente no provoca 92 búsquedas", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ error: { code: "not-deployed", message: "Operación no disponible." } }, { status: 404 }))
    vi.stubGlobal("fetch", fetcher)
    await expect(buscarUltimoResumen("r", "2026-11-10")).rejects.toMatchObject({ code: "not-deployed" })
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it("en el VPS las intenciones de cocina y sala van por la cola del servicio sync, sin Firebase", async () => {
    mocks.queue.mockResolvedValue({ ok: true, soldOut: true })
    const fetcher = vi.fn<typeof fetch>()
    vi.stubGlobal("fetch", fetcher)
    expect(await llamarCocina("marcarAgotado", { restaurantId: "r", locationId: "l", itemId: "p", soldOut: true })).toEqual({ ok: true, soldOut: true })
    expect(mocks.queue).toHaveBeenCalledWith("marcarAgotado", expect.objectContaining({ itemId: "p" }))
    expect(fetcher).not.toHaveBeenCalled(); expect(mocks.legacy).not.toHaveBeenCalled()
  })
  it("sin conexión, lo que no es de la cola no se envía", async () => {
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
    const fetcher = vi.fn<typeof fetch>()
    vi.stubGlobal("fetch", fetcher)
    try {
      await expect(llamarCocina("guardarRaciones", { restaurantId: "r", locationId: "l", itemId: "p", remaining: 1 })).rejects.toThrow("Necesitas conexión")
      await expect(llamarSala("crearTarea", { restaurantId: "r", locationId: "l", note: "Agua" })).rejects.toThrow("Necesitas conexión")
      expect(fetcher).not.toHaveBeenCalled()
      expect(mocks.queue).not.toHaveBeenCalled()
    } finally { online.mockRestore() }
  })
  it("rechazo SQL definitivo no retiene intención incierta; fallo de red sí", () => {
    for (const code of ["permission-denied", "unauthenticated", "not-deployed"]) {
      expect(cajaIncierto({ code })).toBe(false)
      expect(personalIncierto({ code })).toBe(false)
      expect(compraDefinitivo({ code })).toBe(true)
      expect(inventarioDefinitivo({ code })).toBe(true)
    }
    expect(cajaIncierto({ code: "network" })).toBe(true)
    expect(personalIncierto({ code: "network" })).toBe(true)
  })
})
