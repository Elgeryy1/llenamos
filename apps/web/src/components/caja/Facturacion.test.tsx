import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { Bill, BillPart } from "@llenamos/core"
import type { OperacionCaja } from "@/lib/caja/useOperacion"
import { Facturacion, destinatario, clienteVacio } from "./Facturacion"
const bill: Bill = { target: { kind: "takeaway", id: "recogida" }, customerId: null, status: "locked", revision: 4, lines: [], adjustments: [], totalCents: 1000, paidCents: 1000, refundedCents: 0, openedAt: 1, lockedAt: 2, settledAt: 3 }
const part: BillPart & { id: string } = { id: "p", billId: "b", label: "Parte única", revision: 4, allocations: [{ lineId: "l", amountCents: 1000 }], totalCents: 1000, paidCents: 1000, invoiceId: null }
function operation() { return { run: vi.fn().mockResolvedValue({ invoiceId: "factura", recordId: "registro", number: "PRUEBA/1", fiscalStatus: "not_configured", warning: "No se ha enviado nada" }), retry: vi.fn(), busy: false, blocked: false, pending: false, error: null, message: null, result: null, pendingName: undefined } as OperacionCaja }
describe("facturas sin éxito fiscal inventado", () => {
  it("muestra el aviso de prueba antes y después de emitir, sin otra venta por cada pago", async () => {
    const op = operation()
    render(<Facturacion bill={bill} billId="b" parts={[part]} op={op} fresh />)
    expect(screen.getByText(/Proveedor de prueba: no válido para Hacienda/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Emitir documento de prueba" }))
    await waitFor(() => expect(op.run).toHaveBeenCalledWith("emitirFactura", { billId: "b", expectedRevision: 4, partId: "p", type: "F2", recipient: null }, expect.any(Function)))
    await screen.findByText("Documento PRUEBA/1")
    expect(screen.getByText(/No se ha enviado a Hacienda/)).toBeTruthy()
  })
  it("una parte ya facturada no se puede emitir otra vez", () => {
    const op = operation()
    render(<Facturacion bill={bill} billId="b" parts={[{ ...part, invoiceId: "original" }]} op={op} fresh />)
    fireEvent.click(screen.getByRole("button", { name: "Emitir documento de prueba" }))
    expect(op.run).not.toHaveBeenCalled()
    expect(screen.getByText(/Esta parte ya está facturada/)).toBeTruthy()
  })
  it("valida datos completos del cliente sin inventar un NIF extranjero", () => {
    expect(() => destinatario(clienteVacio)).toThrow()
    expect(destinatario({ ...clienteVacio, name: "Cliente", address: "Calle Mayor 1", nif: "b12345678" }).identity).toEqual({ kind: "nif", nif: "B12345678" })
    expect(destinatario({ ...clienteVacio, name: "Cliente", address: "Paris", kind: "other", country: "fr", idType: "03", foreignId: "AB123" }).identity).toEqual({ kind: "other", country: "FR", idType: "03", id: "AB123" })
  })
  it("permite elegir otra parte cuando la primera ya está facturada", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() })
    const op = operation()
    render(<Facturacion bill={bill} billId="b" parts={[{ ...part, invoiceId: "original" }, { ...part, id: "segunda", label: "Parte 2" }]} op={op} fresh />)
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Parte a facturar" }), { key: "ArrowDown" })
    fireEvent.click(await screen.findByRole("option", { name: "Parte 2" }))
    fireEvent.click(screen.getByRole("button", { name: "Emitir documento de prueba" }))
    await waitFor(() => expect(op.run).toHaveBeenCalledWith("emitirFactura", expect.objectContaining({ partId: "segunda" }), expect.any(Function)))
  })
  it("bloquea la emisión con una parte de una revisión anterior", () => {
    const op = operation()
    render(<Facturacion bill={bill} billId="b" parts={[{ ...part, revision: 3 }]} op={op} fresh />)
    fireEvent.click(screen.getByRole("button", { name: "Emitir documento de prueba" }))
    expect(op.run).not.toHaveBeenCalled()
  })
})
