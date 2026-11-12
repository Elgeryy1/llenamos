import { afterEach, describe, expect, it, vi } from "vitest"
const { identityToken, legacy } = vi.hoisted(() => ({ identityToken: vi.fn(async () => "token-identidad"), legacy: vi.fn() }))
vi.mock("@/lib/firebase/auth-client", () => ({ identityToken }))
vi.mock("firebase/functions", () => ({ httpsCallable: legacy }))
vi.mock("@/lib/firebase/config", () => ({ firebaseConfig: { ok: true, settings: { options: { projectId: "llenamos-logiqd" }, region: "europe-west1", emulators: null } } }))
import { llamarCore, RespuestaInesperadaError } from "./callables"

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks() })
describe("llamarCore hacia VPS", () => {
  it("valida y autentica sin inicializar Functions ni hacer fallback", async () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "postgres")
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{"result":{"plans":[]}}', { status: 200 }))
    vi.stubGlobal("fetch", fetcher)
    expect(await llamarCore("listarPlanesDisponibles", {})).toEqual({ plans: [] })
    expect(identityToken).toHaveBeenCalledOnce()
    expect(legacy).not.toHaveBeenCalled()
  })
  it("no presenta una salida inválida como éxito", async () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "postgres")
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"result":{"plans":"incorrecto"}}', { status: 200 })))
    await expect(llamarCore("listarPlanesDisponibles", {})).rejects.toBeInstanceOf(RespuestaInesperadaError)
  })
  it("producción sin selector explícito se detiene antes de llamar a servicios", async () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "")
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher)
    await expect(llamarCore("listarPlanesDisponibles", {})).rejects.toThrow("servidor de datos")
    expect(fetcher).not.toHaveBeenCalled(); expect(legacy).not.toHaveBeenCalled()
  })
})
