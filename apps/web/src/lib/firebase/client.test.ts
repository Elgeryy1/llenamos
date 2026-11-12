import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const mock = vi.hoisted(() => ({
  config: { ok: true, settings: { options: { projectId: "demo-llenamos" }, region: "europe-west1", emulators: { host: "127.0.0.1", ports: { auth: 9099, firestore: 8085, functions: 5001 } } as object | undefined } },
  auth: { emulatorConfig: null as object | null }, connectAuth: vi.fn(), getFirestore: vi.fn(() => ({})), getFunctions: vi.fn(() => ({})),
}))
vi.mock("./config", () => ({ firebaseConfig: mock.config }))
vi.mock("firebase/app", () => ({ getApps: () => [], initializeApp: () => ({ options: mock.config.settings.options }), getApp: () => ({ options: mock.config.settings.options }) }))
vi.mock("firebase/auth", () => ({ getAuth: () => mock.auth, connectAuthEmulator: mock.connectAuth }))
vi.mock("firebase/firestore", () => ({ getFirestore: mock.getFirestore, connectFirestoreEmulator: vi.fn() }))
vi.mock("firebase/functions", () => ({ getFunctions: mock.getFunctions, connectFunctionsEmulator: vi.fn() }))
import { getFirebase } from "./client"
const holder = globalThis as typeof globalThis & { __llenamosDemoData?: unknown }
beforeEach(() => { delete holder.__llenamosDemoData; delete (globalThis as { __llenamosFirebaseIdentity?: unknown }).__llenamosFirebaseIdentity; vi.clearAllMocks(); vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", ""); mock.config.settings.options.projectId = "demo-llenamos"; mock.auth.emulatorConfig = null })
afterEach(() => { delete holder.__llenamosDemoData; delete (globalThis as { __llenamosFirebaseIdentity?: unknown }).__llenamosFirebaseIdentity; vi.unstubAllEnvs() })
describe("cliente de datos legacy cerrado", () => {
  it("solo inicializa datos en demo con emuladores", () => {
    const first = getFirebase()
    expect(first.db).toBe(getFirebase().db)
    expect(first.auth).toBe(getFirebase().auth)
    expect(mock.getFirestore).toHaveBeenCalledOnce()
    expect(mock.connectAuth).toHaveBeenCalledOnce()
  })
  it("no reconecta el emulador Auth cuando ya lo configuró auth-client", () => {
    mock.auth.emulatorConfig = { host: "127.0.0.1" }
    getFirebase()
    expect(mock.connectAuth).not.toHaveBeenCalled()
  })
  it.each(["postgres", ""])("configuración real con selector %s no inicializa Firestore/Functions", selected => {
    vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", selected)
    mock.config.settings.options.projectId = "llenamos-real"
    expect(() => getFirebase()).toThrow()
    expect(mock.getFirestore).not.toHaveBeenCalled()
    expect(mock.getFunctions).not.toHaveBeenCalled()
  })
  it("tampoco reutiliza un cliente cacheado si se selecciona VPS", () => {
    getFirebase()
    vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "postgres")
    expect(() => getFirebase()).toThrow("todavía no está migrado")
  })
})
