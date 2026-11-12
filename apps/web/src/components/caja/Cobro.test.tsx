vi.mock("@/components/sin-conexion/EfectivoLocal", () => ({ EfectivoLocal: () => null }))
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { Bill, BillPart } from "@llenamos/core"
import type { OperacionCaja } from "@/lib/caja/useOperacion"
import { Cobro } from "./Cobro"
const bill: Bill = {
  target: { kind: "session", id: "s" },
  status: "locked",
  customerId: null,
  revision: 7,
  lines: [],
  adjustments: [],
  totalCents: 1230,
  paidCents: 0,
  refundedCents: 0,
  openedAt: 1,
  lockedAt: 2,
  settledAt: null,
}
const part: BillPart & { id: string } = {
  id: "parte",
  billId: "cuenta",
  label: "Parte 1",
  revision: 7,
  allocations: [{ lineId: "l", amountCents: 1230 }],
  totalCents: 1230,
  paidCents: 0,
  invoiceId: null,
}
function operation() {
  return {
    run: vi
      .fn()
      .mockResolvedValue({ paymentId: "p", changeCents: 720, dueCents: 0 }),
    retry: vi.fn(),
    busy: false,
    blocked: false,
    pending: false,
    error: null,
    message: null,
    result: null,
    pendingName: undefined,
  } as OperacionCaja
}
function mount(op: OperacionCaja, fresh = true, cashSessionId = "turno") {
  return render(
    <Cobro
      bill={bill}
      billId="cuenta"
      parts={[part]}
      cashSessionId={cashSessionId}
      op={op}
      fresh={fresh}
    />,
  )
}
describe("cobro táctil", () => {
  it("muestra el cambio grande y envía consumo, propina y entrega separados", async () => {
    const op = operation()
    mount(op)
    fireEvent.change(screen.getByLabelText("Propina voluntaria (€)"), {
      target: { value: "0,50" },
    })
    fireEvent.click(screen.getByRole("button", { name: /20,00\s*€/ }))
    expect(screen.getByRole("status").textContent).toContain("7,20")
    fireEvent.click(screen.getByRole("button", { name: /Registrar 12,30\s*€/ }))
    await waitFor(() =>
      expect(op.run).toHaveBeenCalledWith(
        "registrarCobro",
        expect.objectContaining({
          expectedRevision: 7,
          amountCents: 1230,
          tipCents: 50,
          tenderedCents: 2000,
          cashSessionId: "turno",
          partId: "parte",
        }),
        expect.any(Function),
      ),
    )
  })
  it("bloquea cobros sin conexión confirmada, sin caja o con resultado incierto", () => {
    const op = operation(),
      view = mount(op, false)
    expect(
      screen
        .getByRole("button", { name: /Registrar 12,30\s*€/ })
        .closest("fieldset")?.disabled,
    ).toBe(true)
    view.unmount()
    mount({ ...op, blocked: true }, true, "")
    expect(screen.getByText(/Selecciona una caja abierta/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /Registrar 12,30\s*€/ }))
    expect(op.run).not.toHaveBeenCalled()
  })
  it("rechaza entrega insuficiente y sobrecobro antes de enviar", async () => {
    const op = operation()
    mount(op)
    fireEvent.change(screen.getByLabelText("Efectivo entregado (€)"), {
      target: { value: "1" },
    })
    fireEvent.click(screen.getByRole("button", { name: /Registrar 12,30\s*€/ }))
    await screen.findByText(/no cubre el cobro/)
    fireEvent.change(screen.getByLabelText("Importe del consumo (€)"), {
      target: { value: "13" },
    })
    fireEvent.click(screen.getByRole("button", { name: /Registrar 13,00\s*€/ }))
    await screen.findByText(/supera el saldo pendiente/)
    expect(op.run).not.toHaveBeenCalled()
  })
})

describe("pago parcial y tarjeta externa", () => {
  it("recalcula el cambio al preparar otro cobro y actualiza el saldo pendiente", async () => {
    const op = operation()
    vi.mocked(op.run).mockResolvedValueOnce({ paymentId: "parcial", changeCents: 500, dueCents: 730 })
    const view = mount(op)
    fireEvent.change(screen.getByLabelText("Importe del consumo (€)"), { target: { value: "5" } })
    fireEvent.change(screen.getByLabelText("Efectivo entregado (€)"), { target: { value: "10" } })
    fireEvent.click(screen.getByRole("button", { name: /Registrar 5,00\s*€/ }))
    await screen.findByText("Cambio confirmado por el servidor")
    view.rerender(<Cobro bill={{ ...bill, paidCents: 500 }} billId="cuenta" parts={[{ ...part, paidCents: 500 }]} cashSessionId="turno" op={op} fresh />)
    expect((screen.getByLabelText("Importe del consumo (€)") as HTMLInputElement).value).toBe("7,30")
    fireEvent.change(screen.getByLabelText("Efectivo entregado (€)"), { target: { value: "20" } })
    expect(screen.getByText("Cambio previsto")).toBeTruthy()
    expect(screen.getByRole("status").textContent).toContain("12,70")
  })
  it("conserva el importe escrito si el servidor no confirma", async () => {
    const op = operation()
    vi.mocked(op.run).mockResolvedValueOnce(null)
    mount(op)
    fireEvent.change(screen.getByLabelText("Importe del consumo (€)"), { target: { value: "5,00" } })
    fireEvent.change(screen.getByLabelText("Efectivo entregado (€)"), { target: { value: "10,00" } })
    fireEvent.click(screen.getByRole("button", { name: /Registrar 5,00\s*€/ }))
    await waitFor(() => expect(op.run).toHaveBeenCalled())
    expect((screen.getByLabelText("Importe del consumo (€)") as HTMLInputElement).value).toBe("5,00")
    expect((screen.getByLabelText("Efectivo entregado (€)") as HTMLInputElement).value).toBe("10,00")
  })
  it("identifica el datáfono como cobro externo y exige su referencia", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() })
    const op = operation()
    mount(op)
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Forma de pago" }), { key: "ArrowDown" })
    fireEvent.click(await screen.findByRole("option", { name: "Tarjeta con datáfono externo" }))
    expect(screen.getByText(/No ejecuta un cargo bancario ni usa Stripe/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText("Referencia del datáfono"), { target: { value: "TICKET 14" } })
    fireEvent.change(screen.getByLabelText("Importe del consumo (€)"), { target: { value: "5" } })
    fireEvent.click(screen.getByRole("button", { name: /Registrar 5,00\s*€/ }))
    await waitFor(() => expect(op.run).toHaveBeenCalledWith("registrarCobro", expect.objectContaining({ method: "card", terminalReference: "TICKET 14", amountCents: 500, tenderedCents: 0 }), expect.any(Function)))
  })
})

describe("ticket después del cobro confirmado", () => {
  it("emite una sola simplificada al completar la parte y conserva el cambio si falla la emisión", async () => {
    const op = operation()
    vi.mocked(op.run).mockResolvedValueOnce({ paymentId: "p", changeCents: 770, dueCents: 0 }).mockResolvedValueOnce(null)
    mount(op)
    fireEvent.change(screen.getByLabelText("Efectivo entregado (€)"), { target: { value: "20" } })
    fireEvent.click(screen.getByRole("button", { name: /Registrar 12,30\s*€/ }))
    await waitFor(() => expect(op.run).toHaveBeenCalledTimes(2))
    expect(op.run).toHaveBeenNthCalledWith(2, "emitirFactura", { billId: "cuenta", partId: "parte", expectedRevision: 7, type: "F2", recipient: null }, expect.any(Function))
    expect(screen.getByRole("status").textContent).toContain("7,70")
  })
  it("permite reservar la emisión para una completa sin emitir ticket automático", async () => {
    const op = operation()
    mount(op)
    fireEvent.click(screen.getByLabelText("Emitir ticket al completar esta parte"))
    fireEvent.change(screen.getByLabelText("Efectivo entregado (€)"), { target: { value: "20" } })
    fireEvent.click(screen.getByRole("button", { name: /Registrar 12,30\s*€/ }))
    await waitFor(() => expect(op.run).toHaveBeenCalledTimes(1))
    expect(op.run).toHaveBeenCalledWith("registrarCobro", expect.any(Object), expect.any(Function))
  })
})
