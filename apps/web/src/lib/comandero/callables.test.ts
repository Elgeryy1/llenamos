vi.mock("@/lib/firebase/config", () => ({ firebaseConfig: { ok: true, settings: { options: { projectId: "demo-llenamos" }, emulators: {} } } }))
vi.mock("@/lib/sin-conexion/cliente", () => ({ queueOperation: async (_name: string, input: unknown) => (await send(input)).data }))
import { beforeEach, describe, expect, it, vi } from "vitest"
const { send, factory } = vi.hoisted(() => ({
  send: vi.fn(),
  factory: vi.fn(),
}))
vi.mock("firebase/functions", () => ({ httpsCallable: factory }))
vi.mock("@/lib/firebase/client", () => ({
  getFirebase: () => ({ functions: {} }),
  FirebaseConfigError: class extends Error {},
}))
import { errorSala, llamarSala } from "./callables"

beforeEach(() => {
  send.mockReset()
  factory.mockReset().mockReturnValue(send)
})
describe("callables reales de sala", () => {
  it("no envía mesas vacías ni precios ajenos al contrato", async () => {
    await expect(
      llamarSala("abrirMesa", {
        restaurantId: "r",
        locationId: "l",
        tableIds: [],
        guests: 2,
      }),
    ).rejects.toThrow()
    expect(send).not.toHaveBeenCalled()
  })
  it("usa el nombre real, normaliza la entrada y valida la salida", async () => {
    send.mockResolvedValue({
      data: {
        sessionId: "s1",
        label: "S1",
        joinable: true,
        reservationSeated: false,
      },
    })
    const result = await llamarSala("abrirMesa", {
      restaurantId: "r",
      locationId: "l",
      tableIds: ["t1"],
      guests: 2,
    })
    expect(factory).toHaveBeenCalledWith({}, "abrirMesa", { timeout: 20_000 })
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        tableIds: ["t1"],
        reservationId: null,
        guest: null,
        notes: "",
      }),
    )
    expect(result.sessionId).toBe("s1")
  })
  it("no convierte una respuesta incompleta en éxito", async () => {
    send.mockResolvedValue({ data: { ok: true } })
    await expect(
      llamarSala("abrirMesa", {
        restaurantId: "r",
        locationId: "l",
        tableIds: ["t1"],
        guests: 2,
      }),
    ).rejects.toThrow("contrato")
  })
  it("conserva la contención de una tarea y el rechazo de precios", async () => {
    send.mockResolvedValueOnce({
      data: { result: "taken", claimedBy: "lucia", claimedByName: "Lucía" },
    })
    expect(
      await llamarSala("cambiarEstadoTarea", {
        restaurantId: "r",
        locationId: "l",
        taskId: "t",
        action: "claim",
      }),
    ).toEqual({ result: "taken", claimedBy: "lucia", claimedByName: "Lucía" })
    send.mockResolvedValueOnce({
      data: {
        status: "rejected",
        problems: [
          { line: null, selection: null, code: "price_changed", ref: null },
        ],
        totalCents: 700,
      },
    })
    expect(
      (
        await llamarSala("enviarPedido", {
          restaurantId: "r",
          locationId: "l",
          sessionId: "s",
          lines: [{ kind: "item", itemId: "bravas", quantity: 1 }],
        })
      ).status,
    ).toBe("rejected")
  })
  it("dice que falta el servidor y conserva el error sin simular confirmación", async () => {
    send.mockRejectedValue({ code: "functions/not-found" })
    await expect(
      llamarSala("crearTarea", {
        restaurantId: "r",
        locationId: "l",
        note: "Agua",
      }),
    ).rejects.toEqual({ code: "functions/not-found" })
    expect(errorSala({ code: "functions/not-found" })).toContain(
      "Falta el servidor de esta función",
    )
  })
})
