import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ token: vi.fn(), firebase: vi.fn(() => ({ functions: {} })), factory: vi.fn(), send: vi.fn() }))
vi.mock("@/lib/firebase/auth-client", () => ({ identityToken: mocks.token }))
vi.mock("@/lib/firebase/client", () => ({ getFirebase: mocks.firebase }))
vi.mock("firebase/functions", () => ({ httpsCallable: mocks.factory }))
vi.mock("@/lib/firebase/config", () => ({ firebaseConfig: { ok: true, settings: { options: { projectId: "demo-llenamos" }, region: "europe-west1", emulators: { host: "127.0.0.1", ports: { functions: 5001 } } } } }))
import { invokeOperation, isDefinitiveOperationError } from "./operations"
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "postgres"); mocks.token.mockResolvedValue("private-token"); mocks.factory.mockReturnValue(mocks.send) })
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe("operaciones compartidas VPS y demo", () => {
  it("en VPS usa exclusivamente same-origin y Bearer, sin SDK de datos", async () => {
    const fetcher = vi.fn(async () => Response.json({ result: { cashSessionId: "c1" } }))
    expect(await invokeOperation("abrirCaja", { requestId: "i1" }, { fetcher })).toEqual({ cashSessionId: "c1" })
    expect(fetcher).toHaveBeenCalledWith("/api/v1/operations/abrirCaja", expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer private-token" }), credentials: "omit", redirect: "error" }))
    expect(mocks.firebase).not.toHaveBeenCalled()
    expect(mocks.factory).not.toHaveBeenCalled()
  })
  it("baja marketing pública nunca solicita identidad, ni cae a SDK tras 404", async () => {
    const fetcher = vi.fn(async () => new Response("Not Found", { status: 404 }))
    await expect(invokeOperation("darseDeBaja", {}, { authentication: "none", fetcher })).rejects.toMatchObject({ code: "not-deployed" })
    expect(mocks.token).not.toHaveBeenCalled()
    expect(mocks.firebase).not.toHaveBeenCalled()
    expect(mocks.factory).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it("solo el modo demo explícito conserva SDK de emuladores", async () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "firebase-demo")
    mocks.send.mockResolvedValue({ data: { cashSessionId: "local" } })
    expect(await invokeOperation("abrirCaja", { requestId: "i1" })).toEqual({ cashSessionId: "local" })
    expect(mocks.factory).toHaveBeenCalledWith({}, "abrirCaja", { timeout: 20_000 })
    expect(mocks.token).not.toHaveBeenCalled()
  })
  it("baja pública demo también usa HTTP sin identidad", async () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "firebase-demo")
    const fetcher = vi.fn(async () => Response.json({ result: { ok: true } }))
    await invokeOperation("darseDeBaja", { slug: "taberna", token: "a".repeat(43), website: "" }, { authentication: "none", fetcher })
    expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:5001/demo-llenamos/europe-west1/darseDeBaja", expect.objectContaining({ headers: { "Content-Type": "application/json" } }))
    expect(mocks.token).not.toHaveBeenCalled()
    expect(mocks.firebase).not.toHaveBeenCalled()
  })
  it("un selector incorrecto falla antes de cargar Firebase", async () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "inventado")
    await expect(invokeOperation("abrirCaja", {})).rejects.toMatchObject({ code: "config" })
    expect(mocks.factory).not.toHaveBeenCalled()
  })
  it.each(["permission-denied", "unauthenticated", "invalid-argument", "failed-precondition", "not-deployed"])("clasifica %s como definitivo sin importar el transporte", code => {
    expect(isDefinitiveOperationError({ code })).toBe(true)
    expect(isDefinitiveOperationError({ code: `functions/${code}` })).toBe(true)
    expect(isDefinitiveOperationError({ code: "network" })).toBe(false)
    expect(isDefinitiveOperationError({ code: "deadline-exceeded" })).toBe(false)
  })
})
