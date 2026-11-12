import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ getStorage: vi.fn(() => ({})), connectStorage: vi.fn() }))
vi.mock("firebase/storage", () => ({ getStorage: mocks.getStorage, connectStorageEmulator: mocks.connectStorage }))

// Configuración real de producción en el VPS: proyecto llenamos-logiqd, sin emuladores y selector `postgres`.
function entornoVps() {
  vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "postgres")
  vi.stubEnv("NEXT_PUBLIC_USE_EMULATORS", "0")
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_PROJECT_ID", "llenamos-logiqd")
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_API_KEY", "clave-publica")
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_APP_ID", "1:844781008037:web:74dee224fcac157c51894c")
}

describe("storage de la demo", () => {
  beforeEach(() => { vi.resetModules(); mocks.getStorage.mockClear() })
  afterEach(() => { vi.unstubAllEnvs(); delete (globalThis as { __llenamosStorage?: unknown }).__llenamosStorage; delete (globalThis as { __llenamosDemoData?: unknown }).__llenamosDemoData })

  it("con la configuración real y `postgres` falla antes de crear el cliente de Storage", async () => {
    entornoVps()
    const { getStorageClient } = await import("./storage")
    expect(() => getStorageClient()).toThrow("todavía no está migrado")
    expect(mocks.getStorage).not.toHaveBeenCalled()
  })
})
