vi.mock("@/lib/firebase/config", () => ({ firebaseConfig: { ok: true, settings: { options: { projectId: "demo-llenamos" }, region: "europe-west1", emulators: { host: "127.0.0.1", ports: { functions: 5001 } } } } }))
import { describe, expect, it, vi } from "vitest"
import { CALLABLE_SCHEMAS } from "@llenamos/core"
import { IntencionesMarketing, errorMarketing, llamarMarketing } from "./api"
const callable = vi.hoisted(() => vi.fn())
vi.mock("firebase/functions", () => ({ httpsCallable: () => callable }))
vi.mock("@/lib/firebase/client", () => ({ getFirebase: () => ({ functions: {} }) }))

describe("frontera de marketing", () => {
  it("valida antes de llamar y rechaza un éxito con salida fuera de contrato", async () => {
    callable.mockReset()
    await expect(llamarMarketing("guardarSegmento", {} as never)).rejects.toThrow()
    expect(callable).not.toHaveBeenCalled()
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ result: { ok: false } }))
    await expect(llamarMarketing("darseDeBaja", { slug: "taberna-lumbre", token: "a".repeat(43), website: "" } )).rejects.toThrow(/contrato/)
    fetcher.mockRestore()
  })
  it("reutiliza el requestId después de un error incierto y cambia tras confirmar", async () => {
    const enviar = vi.fn().mockRejectedValueOnce({ code: "functions/unavailable" }).mockResolvedValue({ ok: true })
    let id = 0
    const intenciones = new IntencionesMarketing(enviar, () => `id${++id}`)
    const settings = { senderName: "Lumbre", maxPer30Days: 2, minHoursBetween: 72, sendWindow: { from: "10:00", to: "21:00" } }
    const input = { restaurantId: "r", settings }
    await expect(intenciones.run("guardarConfiguracionMarketing", input)).rejects.toBeTruthy()
    await intenciones.run("guardarConfiguracionMarketing", input)
    await intenciones.run("guardarConfiguracionMarketing", input)
    expect(enviar.mock.calls.map((call) => call[1].requestId)).toEqual(["id1", "id1", "id2"])
    for (const call of enviar.mock.calls) expect(CALLABLE_SCHEMAS.guardarConfiguracionMarketing.input.safeParse(call[1]).success).toBe(true)
  })
  it("nombra el backend que falta y nunca afirma haber guardado", () => {
    expect(errorMarketing(Object.assign(new Error("NOT FOUND"), { code: "functions/not-found" }))).toContain("El servicio de campañas no está disponible")
  })
})
