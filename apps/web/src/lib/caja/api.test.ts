vi.mock("@/lib/firebase/config", () => ({ firebaseConfig: { ok: true, settings: { options: { projectId: "demo-llenamos" }, emulators: {} } } }))
import { beforeEach, describe, expect, it, vi } from "vitest"
const { send, factory } = vi.hoisted(() => ({
  send: vi.fn(),
  factory: vi.fn(),
}))
vi.mock("firebase/functions", () => ({ httpsCallable: factory }))
vi.mock("@/lib/firebase/client", () => ({
  getFirebase: () => ({ functions: {} }),
}))
import { errorCaja, llamarCaja, esIncierto } from "./api"
beforeEach(() => {
  send.mockReset()
  factory.mockReset().mockReturnValue(send)
})
describe("callables reales del contrato de caja", () => {
  it("llama al nombre publicado y exige una salida válida", async () => {
    const input = {
      restaurantId: "r",
      locationId: "l",
      requestId: "intencion",
      registerId: "principal",
      openingCents: 15000,
    }
    send.mockResolvedValueOnce({ data: { cashSessionId: "caja" } })
    expect(await llamarCaja("abrirCaja", input)).toEqual({
      cashSessionId: "caja",
    })
    expect(factory).toHaveBeenCalledWith({}, "abrirCaja", { timeout: 20_000 })
    expect(send).toHaveBeenCalledWith(input)
    send.mockResolvedValueOnce({ data: { ok: true } })
    await expect(llamarCaja("abrirCaja", input)).rejects.toThrow("confirmar")
  })
  it("no admite precios de línea enviados por la pantalla", async () => {
    await expect(
      llamarCaja("abrirCuenta", {
        restaurantId: "r",
        locationId: "l",
        requestId: "i",
        target: { kind: "session", id: "s" },
        totalCents: 1,
      } as never),
    ).rejects.toThrow()
    expect(send).not.toHaveBeenCalled()
  })
  it("no disfraza un backend ausente ni una devolución pendiente como éxito", async () => {
    send.mockRejectedValueOnce({ code: "functions/not-found" })
    await expect(
      llamarCaja("verCuenta", {
        restaurantId: "r",
        locationId: "l",
        billId: "b",
      }),
    ).rejects.toBeDefined()
    expect(errorCaja({ code: "functions/not-found" })).toContain(
      "aún no está disponible",
    )
    expect(errorCaja({ code: "functions/internal" })).toContain(
      "No se ha podido confirmar",
    )
    expect(esIncierto({ code: "functions/internal" })).toBe(true)
    send.mockResolvedValueOnce({ data: { refundId: "r", status: "pending" } })
    expect(
      (
        await llamarCaja("devolverCobro", {
          restaurantId: "r",
          locationId: "l",
          requestId: "i",
          paymentId: "p",
          amountCents: 10,
          reason: "Devolución parcial",
        })
      ).status,
    ).toBe("pending")
  })
})
