import { beforeEach, describe, expect, it, vi } from "vitest"
import { IntencionesCaja } from "./intenciones"
import type { llamarCaja } from "./api"

const input = {
  restaurantId: "r",
  locationId: "l",
  billId: "b",
  expectedRevision: 2,
  partId: "p",
  cashSessionId: "c",
  method: "cash" as const,
  amountCents: 900,
  tipCents: 100,
  tenderedCents: 2000,
}
const response = { paymentId: "pago", changeCents: 1000, dueCents: 0 }
beforeEach(() => sessionStorage.clear())
describe("intenciones de cobro", () => {
  it("recupera después de recargar el mismo payload y requestId", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce({ code: "functions/deadline-exceeded" })
      .mockResolvedValueOnce(response)
    const first = new IntencionesCaja(
      sessionStorage,
      "caja",
      send as typeof llamarCaja,
    )
    await expect(first.run("registrarCobro", input)).rejects.toBeDefined()
    const saved = JSON.parse(sessionStorage.getItem("caja")!)
    expect(saved.input.requestId).toBeTruthy()
    const restored = new IntencionesCaja(
      sessionStorage,
      "caja",
      send as typeof llamarCaja,
    )
    await expect(restored.run("registrarCobro", input)).rejects.toThrow(
      "Recupera",
    )
    expect((await restored.retry()).data).toEqual(response)
    expect(send.mock.calls[0]).toEqual(send.mock.calls[1])
    expect(sessionStorage.getItem("caja")).toBeNull()
  })
  it("excluye dos pulsaciones mientras el primer envío sigue en vuelo", async () => {
    let finish: (value: unknown) => void = () => {}
    const send = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const controller = new IntencionesCaja(
      sessionStorage,
      "caja",
      send as typeof llamarCaja,
    )
    const pending = controller.run("registrarCobro", input)
    await expect(controller.run("registrarCobro", input)).rejects.toThrow()
    await expect(controller.retry()).rejects.toThrow()
    finish(response)
    await pending
    expect(send).toHaveBeenCalledTimes(1)
  })
  it("una revisión obsoleta se rechaza sin conservar una intención ejecutable", async () => {
    const send = vi
      .fn()
      .mockRejectedValue({
        code: "functions/failed-precondition",
        message: "Recarga la cuenta",
      })
    const controller = new IntencionesCaja(
      sessionStorage,
      "caja",
      send as typeof llamarCaja,
    )
    await expect(controller.run("registrarCobro", input)).rejects.toBeDefined()
    expect(controller.pending).toBeNull()
  })
  it("no envía si el almacenamiento falla o la entrada es inválida", async () => {
    const send = vi.fn(),
      store = {
        getItem: () => null,
        setItem: () => {
          throw new Error("Sin espacio")
        },
        removeItem: () => {},
      }
    const controller = new IntencionesCaja(
      store,
      "caja",
      send as typeof llamarCaja,
    )
    await expect(controller.run("registrarCobro", input)).rejects.toThrow(
      "Sin espacio",
    )
    await expect(
      controller.run("registrarCobro", { ...input, amountCents: -1 }),
    ).rejects.toThrow()
    expect(send).not.toHaveBeenCalled()
  })
})
