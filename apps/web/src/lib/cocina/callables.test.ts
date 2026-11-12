vi.mock("@/lib/firebase/config", () => ({ firebaseConfig: { ok: true, settings: { options: { projectId: "demo-llenamos" }, emulators: {} } } }))
vi.mock("@/lib/sin-conexion/cliente", () => ({ queueOperation: async (_name: string, input: unknown) => (await request(input)).data }))
import { beforeEach, expect, it, vi } from "vitest"
import { FirebaseError } from "firebase/app"
const { request, factory } = vi.hoisted(() => ({ request: vi.fn(), factory: vi.fn() }))
vi.mock("firebase/functions", () => ({ httpsCallable: factory }))
vi.mock("@/lib/firebase/client", () => ({ getFirebase: () => ({ functions: {} }), FirebaseConfigError: class extends Error {} }))
import { errorCocina, llamarCocina } from "./callables"
const context = { restaurantId: "demo-lumbre", locationId: "centro" }
beforeEach(() => { vi.clearAllMocks(); factory.mockReturnValue(request) })
it("valida antes de llamar al servidor", async () => {
  await expect(llamarCocina("cambiarEstadoLineas", { ...context, lineIds: [], status: "ready" })).rejects.toThrow()
  expect(factory).not.toHaveBeenCalled()
})
it("llama por su nombre real con espera limitada y valida la salida", async () => {
  request.mockResolvedValue({ data: { ok: true, lines: [{ id: "l1", status: "ready" }], firedNext: [] } })
  await llamarCocina("cambiarEstadoLineas", { ...context, lineIds: ["l1"], status: "ready" })
  expect(factory).not.toHaveBeenCalled()
  expect(request).toHaveBeenCalledWith({ ...context, lineIds: ["l1"], status: "ready" })
})
it("no presenta una respuesta ajena al contrato como éxito", async () => {
  request.mockResolvedValue({ data: { ok: true } })
  await expect(llamarCocina("marcarAgotado", { ...context, itemId: "bravas", soldOut: true })).rejects.toThrow("no cumple el contrato")
})
it("explica la falta de servidor sin simular una escritura", async () => {
  const missing = new FirebaseError("functions/not-found", "NOT_FOUND")
  request.mockRejectedValue(missing)
  await expect(llamarCocina("marcarAgotado", { ...context, itemId: "bravas", soldOut: true })).rejects.toBe(missing)
  expect(errorCocina(missing)).toContain("Falta el servidor de esta función")
})
