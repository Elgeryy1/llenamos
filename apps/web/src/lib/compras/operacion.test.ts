import { describe, expect, it, vi } from "vitest"
import { Intenciones } from "./operacion"

const scope = { restaurantId: "r", locationId: "l" }

describe("intenciones de compras", () => {
  it("reutiliza el requestId tras un error incierto y lo cambia tras un éxito", async () => {
    let n = 0
    const enviar = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("x"), { code: "functions/unavailable" }))
      .mockResolvedValue({ ok: true })
    const i = new Intenciones(enviar as never, () => `id${++n}`)
    const entrada = { ...scope, orderId: "o", expectedRevision: 1, to: "sent" as const, reason: null }
    await expect(i.run("cambiarEstadoPedidoProveedor", entrada)).rejects.toThrow()
    await i.run("cambiarEstadoPedidoProveedor", entrada)
    expect(enviar.mock.calls.map((c) => (c[1] as { requestId: string }).requestId)).toEqual(["id1", "id1"])
    await i.run("cambiarEstadoPedidoProveedor", entrada)
    expect((enviar.mock.calls[2]![1] as { requestId: string }).requestId).toBe("id2")
  })
  it("cambia de requestId si la entrada cambia o si el rechazo es claro", async () => {
    let n = 0
    const enviar = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("revisión"), { code: "functions/failed-precondition" }))
      .mockResolvedValue({ ok: true })
    const i = new Intenciones(enviar as never, () => `id${++n}`)
    const a = { ...scope, orderId: "o", expectedRevision: 1, to: "sent" as const, reason: null }
    await expect(i.run("cambiarEstadoPedidoProveedor", a)).rejects.toThrow()
    await i.run("cambiarEstadoPedidoProveedor", a)
    expect(enviar.mock.calls.map((c) => (c[1] as { requestId: string }).requestId)).toEqual(["id1", "id2"])
  })
})
