import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { Payment } from "@llenamos/core"
import type { OperacionCaja } from "@/lib/caja/useOperacion"
import { Devoluciones } from "./Historial"

vi.mock("@/components/panel/PanelContext", () => ({
  usePanel: () => ({ role: "manager", restaurant: { timezone: "Europe/Madrid" } }),
}))
const charge: Payment & { id: string } = {
  id: "pago", billId: "cuenta", partId: "parte", cashSessionId: "caja",
  kind: "charge", originalPaymentId: null, method: "cash", status: "succeeded",
  amountCents: 1000, tipCents: 100, tenderedCents: 2000, changeCents: 900,
  externalId: null, requestId: "intencion", reason: null, at: 1, by: "encargada",
}
function operation() {
  return {
    run: vi.fn().mockResolvedValue({ refundId: "devolucion", status: "pending" }),
    retry: vi.fn(), busy: false, blocked: false, pending: false,
    error: null, message: null, result: null, pendingName: undefined,
  } as OperacionCaja
}
describe("selección y límites de una devolución", () => {
  it("permite elegir el original y devolver solo la propina sin convertir pendiente en éxito", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() })
    const op = operation()
    render(<Devoluciones live={{ status: "ready", fresh: true, data: [charge] }} op={op} />)
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Cobro original a devolver" }), { key: "ArrowDown" })
    fireEvent.click(await screen.findByRole("option", { name: /Efectivo/ }))
    fireEvent.change(screen.getByLabelText("Propina a devolver (€)"), { target: { value: "0,50" } })
    fireEvent.change(screen.getByLabelText("Motivo de la devolución"), { target: { value: "Propina corregida por el cliente" } })
    fireEvent.click(screen.getByRole("button", { name: "Confirmar devolución" }))
    await waitFor(() => expect(op.run).toHaveBeenCalledWith("devolverCobro", expect.objectContaining({ paymentId: "pago", amountCents: 0, tipCents: 50 }), expect.any(Function)))
    const confirmation = vi.mocked(op.run).mock.calls[0]![2]
    expect(confirmation({ refundId: "devolucion", status: "pending" } as never)).toContain("Todavía no está confirmada")
  })
  it("descuenta devoluciones pendientes para impedir superar el saldo disponible", async () => {
    const op = operation()
    const refund: Payment & { id: string } = { ...charge, id: "devolucion", kind: "refund", originalPaymentId: "pago", status: "pending", amountCents: 800, tipCents: 0, tenderedCents: 0, changeCents: 0, reason: "Devolución anterior" }
    render(<Devoluciones live={{ status: "ready", fresh: true, data: [charge, refund] }} op={op} />)
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Cobro original a devolver" }), { key: "ArrowDown" })
    fireEvent.click(await screen.findByRole("option", { name: /Efectivo/ }))
    fireEvent.change(screen.getByLabelText("Consumo a devolver (€)"), { target: { value: "3" } })
    fireEvent.change(screen.getByLabelText("Motivo de la devolución"), { target: { value: "Producto devuelto" } })
    fireEvent.click(screen.getByRole("button", { name: "Confirmar devolución" }))
    await screen.findByText(/supera el consumo o la propina disponible/)
    expect(op.run).not.toHaveBeenCalled()
  })
})
