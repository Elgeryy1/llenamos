import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { Bill, BillPart } from "@llenamos/core"
import type { OperacionCaja } from "@/lib/caja/useOperacion"
import { PagoMovil } from "./PagoMovil"

const bill: Bill = { target: { kind: "session", id: "mesa" }, customerId: null, status: "locked", revision: 3, lines: [], adjustments: [], totalCents: 200, paidCents: 0, refundedCents: 0, openedAt: 1, lockedAt: 2, settledAt: null }
const parts: (BillPart & { id: string })[] = ["uno", "dos"].map(id => ({ id, billId: "cuenta", label: id, revision: 3, allocations: [], totalCents: 100, paidCents: 0, invoiceId: null }))
describe("enlace privado de cobro", () => {
  it("oculta el enlace anterior al cambiar de parte y pide el nuevo sobre su revisión", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() })
    const result = { checkoutId: "checkout", token: "t".repeat(43), path: "/p/demo/centro/checkout?t=privado", expiresAt: 9999999999999 }
    const run = vi.fn().mockResolvedValue(result)
    const op = { run, blocked: false, result: { name: "crearEnlaceCobro", data: result } } as unknown as OperacionCaja
    render(<PagoMovil bill={bill} billId="cuenta" parts={parts} op={op} fresh />)
    fireEvent.click(screen.getByRole("button", { name: "Crear enlace privado de pago" }))
    await screen.findByRole("link", { name: "Abrir cuenta del cliente" })
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Parte para el enlace móvil" }), { key: "ArrowDown" })
    fireEvent.click(await screen.findByRole("option", { name: /dos/ }))
    expect(screen.queryByRole("link", { name: "Abrir cuenta del cliente" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Crear enlace privado de pago" }))
    await waitFor(() => expect(run).toHaveBeenLastCalledWith("crearEnlaceCobro", { billId: "cuenta", partId: "dos", expectedRevision: 3 }, expect.any(Function)))
  })
})
