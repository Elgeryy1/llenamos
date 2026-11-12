import { describe, expect, it } from "vitest"
import { DEFAULT_EMULATOR_PORTS, parseFirebaseEnv, type PublicEnv } from "./config"

const base: PublicEnv = {
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-llenamos",
  NEXT_PUBLIC_FIREBASE_API_KEY: "demo-api-key",
  NEXT_PUBLIC_FIREBASE_APP_ID: "demo-app-id",
  NEXT_PUBLIC_USE_EMULATORS: "1",
}

describe("parseFirebaseEnv", () => {
  it("usa los puertos y la región del contrato si no se dice otra cosa", () => {
    const r = parseFirebaseEnv(base)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.settings.region).toBe("europe-west1")
    expect(r.settings.emulators).toEqual({ host: "127.0.0.1", ports: { ...DEFAULT_EMULATOR_PORTS } })
    expect(DEFAULT_EMULATOR_PORTS).toEqual({ auth: 9099, firestore: 8085, functions: 5001, storage: 9199 })
    expect(r.settings.options.projectId).toBe("demo-llenamos")
  })

  it("acepta host y puertos alternativos", () => {
    const r = parseFirebaseEnv({
      ...base,
      NEXT_PUBLIC_EMULATOR_HOST: "localhost",
      NEXT_PUBLIC_AUTH_EMULATOR_PORT: "9101",
      NEXT_PUBLIC_FIRESTORE_EMULATOR_PORT: "8095",
      NEXT_PUBLIC_FUNCTIONS_EMULATOR_PORT: "5011",
      NEXT_PUBLIC_STORAGE_EMULATOR_PORT: "9211",
    })
    expect(r.ok && r.settings.emulators).toEqual({
      host: "localhost",
      ports: { auth: 9101, firestore: 8095, functions: 5011, storage: 9211 },
    })
  })

  it("dice qué variables faltan en vez de inventarlas", () => {
    const r = parseFirebaseEnv({ NEXT_PUBLIC_USE_EMULATORS: "1" })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.problems).toEqual([
      "Falta NEXT_PUBLIC_FIREBASE_PROJECT_ID.",
      "Falta NEXT_PUBLIC_FIREBASE_API_KEY.",
      "Falta NEXT_PUBLIC_FIREBASE_APP_ID.",
    ])
  })

  it("trata los valores en blanco como ausentes", () => {
    const r = parseFirebaseEnv({ ...base, NEXT_PUBLIC_FIREBASE_API_KEY: "   " })
    expect(r.ok).toBe(false)
  })

  it("rechaza puertos que no son números válidos", () => {
    const r = parseFirebaseEnv({ ...base, NEXT_PUBLIC_FIRESTORE_EMULATOR_PORT: "ochenta" })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.problems[0]).toContain("NEXT_PUBLIC_FIRESTORE_EMULATOR_PORT")
  })

  it("no deja usar un proyecto demo- sin emuladores", () => {
    const r = parseFirebaseEnv({ ...base, NEXT_PUBLIC_USE_EMULATORS: "0" })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.problems[0]).toContain("NEXT_PUBLIC_USE_EMULATORS=1")
  })

  it("sin emuladores y con proyecto real no conecta a ningún emulador", () => {
    const r = parseFirebaseEnv({ ...base, NEXT_PUBLIC_FIREBASE_PROJECT_ID: "llenamos-prod", NEXT_PUBLIC_USE_EMULATORS: undefined })
    expect(r.ok && r.settings.emulators).toBeNull()
  })
})
