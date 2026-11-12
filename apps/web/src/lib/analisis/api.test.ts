vi.mock("@/lib/firebase/config", () => ({ firebaseConfig: { ok: true, settings: { options: { projectId: "demo-llenamos" }, emulators: {} } } }))
import { beforeEach, describe, expect, it, vi } from "vitest"
import { activeModulesFor, CALLABLE_SCHEMAS } from "@llenamos/core"
import { accesoAnalisis, buscarUltimoResumen, errorAnalisis, llamarAnalisis } from "./api"
import { panelEjemplo } from "./fixtures"

const mocks = vi.hoisted(() => ({ call: vi.fn(), callable: vi.fn() }))
vi.mock("firebase/functions", () => ({ httpsCallable: mocks.callable }))
vi.mock("@/lib/firebase/client", () => ({ getFirebase: () => ({ functions: {} }) }))
const input = { restaurantId: "demo", from: "2026-11-01", to: "2026-11-07", locationIds: null, compare: "previous", slotMinutes: 60 } as const
beforeEach(() => { vi.clearAllMocks(); mocks.callable.mockReturnValue(mocks.call) })

describe("Contrato de análisis", () => {
  it.each(["waiter", "kitchen", "bar"] as const)("%s no accede a ninguna consulta de análisis", (role) => {
    for (const name of ["panelAnalisis", "exportarAnalisis", "previsionOcupacion", "guardarConfiguracionAnalisis", "resolverRecomendacion"] as const)
      expect(accesoAnalisis(name, role, { plan: "completo" })).toBe(false)
  })
  it.each(["owner", "manager"] as const)("%s requiere los módulos de cada callable", (role) => {
    expect(accesoAnalisis("panelAnalisis", role, { plan: "completo" })).toBe(true)
    expect(accesoAnalisis("panelAnalisis", role, { plan: "sala" })).toBe(false)
    expect(accesoAnalisis("previsionOcupacion", role, { activeModules: activeModulesFor("completo"), plan: "completo", moduleOverrides: {} })).toBe(true)
    expect(accesoAnalisis("previsionOcupacion", role, { plan: "sala", moduleOverrides: { analytics: true, reservations: false } })).toBe(false)
  })
  it("valida antes de hacer la llamada y valida la respuesta", async () => {
    await expect(llamarAnalisis("panelAnalisis", { ...input, to: "2027-12-31" })).rejects.toThrow()
    expect(mocks.call).not.toHaveBeenCalled()
    mocks.call.mockResolvedValue({ data: { ok: true } })
    await expect(llamarAnalisis("panelAnalisis", input)).rejects.toThrow("no cumple el contrato")
    mocks.call.mockResolvedValue({ data: panelEjemplo(input.from, input.to, ["centro"], 60) })
    const result = await llamarAnalisis("panelAnalisis", input)
    expect(CALLABLE_SCHEMAS.panelAnalisis.output.safeParse(result).success).toBe(true)
  })
  it("un backend ausente nunca confirma ni devuelve fixtures", async () => {
    mocks.call.mockRejectedValue({ code: "functions/not-found" })
    await expect(llamarAnalisis("panelAnalisis", input)).rejects.toEqual({ code: "functions/not-found" })
    expect(errorAnalisis({ code: "functions/not-found" })).toContain("El servicio de análisis no está disponible")
  })
  it("busca el último resumen por fecha sin saltarse un fallo de backend", async () => {
    mocks.call.mockRejectedValueOnce({ code: "functions/not-found", message: "No hay resumen para ese día." }).mockResolvedValueOnce({ data: { date: "2026-11-09", text: "Resumen real", sentTo: [] } })
    const result = await buscarUltimoResumen("r", "2026-11-10")
    expect(result.date).toBe("2026-11-09")
    expect(mocks.call.mock.calls[0]![0].date).toBe("2026-11-10")
    expect(mocks.call.mock.calls[1]![0].date).toBe("2026-11-09")
    mocks.call.mockReset().mockRejectedValue({ code: "functions/not-found" })
    await expect(buscarUltimoResumen("r", "2026-11-10")).rejects.toEqual({ code: "functions/not-found" })
    expect(mocks.call).toHaveBeenCalledTimes(1)
  })
})
