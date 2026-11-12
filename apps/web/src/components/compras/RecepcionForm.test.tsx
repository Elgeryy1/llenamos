import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PurchaseOrderWithId } from "@llenamos/core"

const llamar = vi.fn()
vi.mock("@/lib/compras/api", () => ({
  llamarCompras: (...a: unknown[]) => llamar(...a),
  esDefinitivo: () => true,
  errorCompras: (e: unknown) => (e instanceof Error ? e.message : "error"),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { RecepcionForm } from "./RecepcionForm"
import type { Base } from "./lecturas"

const scope = { restaurantId: "r", locationId: "l" }
const item = { id: "f1", supplierId: "p1", ingredientId: "i1", name: "Saco 25 kg", sku: null, baseQuantity: 25_000, priceCents: 3000, preferred: true, active: true, lastPriceCents: 3100, lastReceivedAt: 1 }
const base = {
  proveedores: [], formatos: [item], ingredientes: [],
  proveedorPorId: new Map(), formatoPorId: new Map([[item.id, item]]),
  ingredientePorId: new Map([["i1", { id: "i1", name: "Patatas", unit: "g" }]]),
} as unknown as Base
const pedido = {
  id: "o1", supplierId: "p1", reference: "ABC123", status: "sent", revision: 4, expectedOn: null, notes: "", totalCents: 6000, createdBy: "u", sentAt: 1, closedReason: null,
  lines: [{ lineId: "a", supplierItemId: "f1", ingredientId: "i1", name: "Saco 25 kg", baseQuantity: 25_000, priceCents: 3000, orderedFormats: 2, receivedFormats: 0 }],
} as PurchaseOrderWithId

describe("recepción de un pedido", () => {
  beforeEach(() => llamar.mockReset())

  it("propone lo pendiente, avisa de más y del cambio de precio frente al último pagado", () => {
    render(<RecepcionForm scope={scope} base={base} modo={{ tipo: "pedido", pedido }} onDone={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByLabelText("Formatos recibidos")).toHaveProperty("value", "2")
    // 30,00 frente al último pagado (31,00): baja un 3,23 %
    expect(screen.getByText(/-3,23 % frente al último precio pagado/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText("Formatos recibidos"), { target: { value: "3" } })
    expect(screen.getByText("Recibes 1 formato de más")).toBeTruthy()
  })

  it("envía céntimos enteros, el número de albarán y la revisión del pedido", async () => {
    llamar.mockResolvedValue({ receiptId: "g", totalCents: 6200, orderStatus: "received", pending: [], exceeded: [], priceChanges: [] })
    const onDone = vi.fn()
    render(<RecepcionForm scope={scope} base={base} modo={{ tipo: "pedido", pedido }} onDone={onDone} onCancel={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/Número de albarán/), { target: { value: "ALB-9" } })
    fireEvent.change(screen.getByLabelText(/Precio del albarán/), { target: { value: "31,00" } })
    fireEvent.click(screen.getByRole("button", { name: "Guardar albarán" }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    const [nombre, entrada] = llamar.mock.calls[0]!
    expect(nombre).toBe("recibirPedidoProveedor")
    expect(entrada).toMatchObject({
      supplierId: "p1", purchaseOrderId: "o1", expectedRevision: 4, deliveryNote: "ALB-9",
      lines: [{ supplierItemId: "f1", receivedFormats: 2, priceCents: 3100 }],
    })
    expect(typeof entrada.requestId).toBe("string")
  })

  it("no envía nada con un precio que no es un importe o sin formatos", async () => {
    render(<RecepcionForm scope={scope} base={base} modo={{ tipo: "pedido", pedido }} onDone={vi.fn()} onCancel={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/Precio del albarán/), { target: { value: "3,123" } })
    fireEvent.click(screen.getByRole("button", { name: "Guardar albarán" }))
    expect((await screen.findByRole("alert")).textContent).toMatch(/dos decimales/)
    fireEvent.change(screen.getByLabelText("Formatos recibidos"), { target: { value: "0" } })
    fireEvent.click(screen.getByRole("button", { name: "Guardar albarán" }))
    expect((await screen.findByRole("alert")).textContent).toMatch(/al menos un formato/)
    expect(llamar).not.toHaveBeenCalled()
  })
})
