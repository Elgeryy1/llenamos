import { render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { CustomerDoc } from "@/lib/data/reservas"
import { CustomerSheet } from "./CustomerSheet"

vi.mock("@/components/panel/PanelContext", () => ({
  usePanel: () => ({ restaurant: { id: "demo" }, location: { id: "centro", name: "Centro" }, role: "waiter", user: { uid: "u1" } }),
}))
vi.mock("@/lib/data/reservas", () => ({
  useCustomerReservations: () => ({ status: "ready", data: [] }),
}))

const customer: CustomerDoc = {
  id: "cliente", name: "Ana Prueba", phone: "+34600000000", email: null, language: "es",
  visits: 1, noShows: 0, cancellations: 0, lastVisitAt: null, notes: "", allergies: "", tags: [],
}

describe("consumo en la ficha del cliente", () => {
  it("muestra los céntimos registrados sin presentarlos como un pago", () => {
    const { rerender } = render(<CustomerSheet customer={{ ...customer, spentCents: 3750 }} open onOpenChange={() => {}} timezone="Europe/Madrid" />)
    expect(within(screen.getByRole("region", { name: "Consumo registrado" })).getByText(/37,50/)).toBeTruthy()
    expect(screen.getByText(/No confirma un pago/)).toBeTruthy()
    rerender(<CustomerSheet customer={{ ...customer, spentCents: 4250 }} open onOpenChange={() => {}} timezone="Europe/Madrid" />)
    expect(within(screen.getByRole("region", { name: "Consumo registrado" })).getByText(/42,50/)).toBeTruthy()
  })

  it("conserva las fichas anteriores sin inventar un consumo", () => {
    render(<CustomerSheet customer={customer} open onOpenChange={() => {}} timezone="Europe/Madrid" />)
    expect(screen.queryByRole("region", { name: "Consumo registrado" })).toBeNull()
  })
})
