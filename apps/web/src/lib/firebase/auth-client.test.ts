import { beforeEach, describe, expect, it, vi } from "vitest"
const state = vi.hoisted(() => {
  const settings = { options: { projectId: "demo-llenamos" }, emulators: { host: "127.0.0.1", ports: { auth: 9099 } } }
  const app = { options: { projectId: "demo-llenamos" } }
  const auth: { emulatorConfig: object | null; currentUser: null | { getIdToken: () => Promise<string> } } = { emulatorConfig: null, currentUser: null }
  return { settings, app, auth, getApps: vi.fn(), getAuth: vi.fn(), connect: vi.fn() }
})
vi.mock("firebase/app", () => ({ getApps: state.getApps, getApp: () => state.app, initializeApp: () => state.app }))
vi.mock("firebase/auth", () => ({ getAuth: state.getAuth, connectAuthEmulator: state.connect }))
vi.mock("./config", () => ({ firebaseConfig: { ok: true, settings: state.settings } }))
import { getFirebaseIdentity, identityToken } from "./auth-client"

beforeEach(() => {
  Reflect.deleteProperty(globalThis, "__llenamosFirebaseIdentity")
  vi.clearAllMocks()
  state.app.options.projectId = "demo-llenamos"
  state.auth.emulatorConfig = null; state.auth.currentUser = null
  state.getApps.mockReturnValue([]); state.getAuth.mockReturnValue(state.auth)
  state.connect.mockImplementation(() => { state.auth.emulatorConfig = { host: "127.0.0.1" } })
})
describe("cliente solo identidad", () => {
  it("inicializa una sola identidad y conecta únicamente el emulador de Auth", () => {
    const first = getFirebaseIdentity()
    expect(getFirebaseIdentity()).toBe(first)
    expect(state.getAuth).toHaveBeenCalledOnce()
    expect(state.connect).toHaveBeenCalledExactlyOnceWith(state.auth, "http://127.0.0.1:9099", { disableWarnings: true })
    expect(first).not.toHaveProperty("db"); expect(first).not.toHaveProperty("functions")
  })
  it("no conecta dos veces si otro consumidor ya inició Auth emulado", () => {
    state.auth.emulatorConfig = { host: "127.0.0.1" }
    getFirebaseIdentity()
    expect(state.connect).not.toHaveBeenCalled()
  })
  it("rechaza una instancia preexistente de otro proyecto", () => {
    state.getApps.mockReturnValue([state.app]); state.app.options.projectId = "otro-proyecto"
    expect(() => getFirebaseIdentity()).toThrow("otro proyecto")
    expect(state.getAuth).not.toHaveBeenCalled()
  })
  it("no inventa sesión y obtiene el token de la persona actual", async () => {
    await expect(identityToken()).rejects.toThrow("Inicia sesión")
    state.auth.currentUser = { getIdToken: async () => "id-token" }
    expect(await identityToken()).toBe("id-token")
  })
})
