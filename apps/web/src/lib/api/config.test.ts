import { describe, expect, it } from "vitest"
import type { FirebaseSettings } from "@/lib/firebase/config"
import { dataBackend, DataBackendConfigError } from "./config"

const local: FirebaseSettings = {
  options: { projectId: "demo-llenamos" }, region: "europe-west1",
  emulators: { host: "127.0.0.1", ports: { auth: 9099, functions: 5001, firestore: 8085, storage: 9199 } },
}
describe("selección del backend", () => {
  it("PostgreSQL requiere selector explícito y no depende de Firebase para operaciones públicas", () => {
    expect(dataBackend(null, "postgres")).toBe("postgres")
    expect(dataBackend(local, "postgres")).toBe("postgres")
  })
  it("conserva el origen legacy solo para demo con emuladores", () => {
    expect(dataBackend(local, "")).toBe("firebase-demo")
    expect(dataBackend(local, "firebase-demo")).toBe("firebase-demo")
  })
  it("no vuelve a Firebase productivo ni selecciona PostgreSQL por defecto", () => {
    for (const settings of [null, { ...local, emulators: null }, { ...local, options: { projectId: "proyecto-real" } }]) {
      expect(() => dataBackend(settings, "")).toThrow(DataBackendConfigError)
      expect(() => dataBackend(settings, "firebase-demo")).toThrow(DataBackendConfigError)
    }
    expect(() => dataBackend(local, "automatico")).toThrow(DataBackendConfigError)
  })
})
