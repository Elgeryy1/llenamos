import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PurchaseOrderWithId } from "@llenamos/core"

const llamar = vi.fn()
vi.mock("@/lib/compras/api", () => ({
  llamarCompras: (...a: unknown[]) => llamar(...a),
  esDefinitivo: () => true,
  errorCompras: (e: unknown) => (e instanceof Error ? e.message : "error"),
}))
vi.mock("@/lib/compras/datos", () => ({ useAlbaranes: () => ({ status: "ready", data: [] }) }))
vi.mock("@/components/panel/PanelContext", () => ({ usePanel: () => ({ restaurant: { name: "Taberna Lumbre" }, location: { name: "Centro" } }) }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { PedidoDetalle } from "./PedidoDetalle"
import type { Base } from "./lecturas"

const scope = { restaurantId: "r", locationId: "l" }
const base = {
  proveedores: [], formatos: [], ingredientes: [],
  proveedorPorId: new Map([["p1", { id: "p1", name: "Mercabarna", contact: "Rosa Vidal", active: true }]]),
  formatoPorId: new Map(),
  ingredientePorId: new Map([["i1", { id: "i1", name: "Patatas", unit: "g" }]]),
} as unknown as Base
const pedido = (status: PurchaseOrderWithId["status"], receivedFormats = 0) =>
  ({
    id: "o1", supplierId: "p1", reference: "ABC123", status, revision: 3, expectedOn: null, notes: "", totalCents: 6000, createdBy: "u", sentAt: null, closedReason: null,
    lines: [{ lineId: "a", supplierItemId: "f1", ingredientId: "i1", name: "Saco 25 kg", baseQuantity: 25_000, priceCents: 3000, orderedFormats: 2, receivedFormats }],
  }) as PurchaseOrderWithId

function abrir(p: PurchaseOrderWithId) {
  render(<PedidoDetalle scope={scope} base={base} pedido={p} onClose={vi.fn()} onEditar={vi.fn()} />)
}

describe("detalle de un pedido", () => {
  beforeEach(() => llamar.mockReset())

  it("un borrador solo pasa a enviado cuando el encargado lo confirma, y dice que Llenamos no envía nada", async () => {
    llamar.mockResolvedValue({ revision: 4, status: "sent" })
    abrir(pedido("draft"))
    fireEvent.click(screen.getByRole("button", { name: "Marcar como enviado" }))
    expect(screen.getByText(/Llenamos no envía nada al proveedor/)).toBeTruthy()
    expect(llamar).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Sí, ya lo he enviado" }))
    await waitFor(() => expect(llamar).toHaveBeenCalled())
    expect(llamar.mock.calls[0]![0]).toBe("cambiarEstadoPedidoProveedor")
    expect(llamar.mock.calls[0]![1]).toMatchObject({ orderId: "o1", expectedRevision: 3, to: "sent", reason: null })
  })

  it("cerrar sin completar exige motivo y solo se ofrece en un pedido recibido en parte", async () => {
    llamar.mockResolvedValue({ revision: 4, status: "closed" })
    abrir(pedido("partially_received", 1))
    fireEvent.click(screen.getByRole("button", { name: "Cerrar sin completar" }))
    const confirmar = screen.getAllByRole("button", { name: "Cerrar sin completar" }).at(-1)!
    expect(confirmar).toHaveProperty("disabled", true)
    fireEvent.change(screen.getByLabelText("Motivo del cierre"), { target: { value: "No hay más género" } })
    fireEvent.click(screen.getAllByRole("button", { name: "Cerrar sin completar" }).at(-1)!)
    await waitFor(() => expect(llamar).toHaveBeenCalled())
    expect(llamar.mock.calls[0]![1]).toMatchObject({ to: "closed", reason: "No hay más género" })
  })

  it("un pedido enviado se recibe o se anula, nunca se cierra sin completar; uno recibido ya no tiene acciones de estado", () => {
    const { unmount } = render(<PedidoDetalle scope={scope} base={base} pedido={pedido("sent")} onClose={vi.fn()} onEditar={vi.fn()} />)
    expect(screen.getByRole("button", { name: "Recibir mercancía" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Anular" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Cerrar sin completar" })).toBeNull()
    unmount()
    abrir(pedido("received", 2))
    expect(screen.queryByRole("button", { name: /Recibir/ })).toBeNull()
    expect(screen.queryByRole("button", { name: "Anular" })).toBeNull()
  })

  it("el texto del pedido se prepara para copiar, con saludo y sin precios por defecto", () => {
    abrir(pedido("draft"))
    fireEvent.click(screen.getByRole("button", { name: "Texto del pedido" }))
    const texto = (screen.getByLabelText("Texto del pedido para copiar") as HTMLTextAreaElement).value
    expect(texto).toContain("Hola Rosa,")
    expect(texto).toContain("• 2 x Saco 25 kg")
    expect(texto).not.toContain("€")
  })
})
