import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { PublicProvider } from "@/components/publica/PublicContext"
import { type CallableOutput } from "@llenamos/core"
import { TrackingApp } from "./TrackingApp"
let data: CallableOutput<"verParaLlevarPublico">
vi.mock("@/lib/mesa-publica/consulta", () => ({ usePublicCall: () => ({ data, refresh: vi.fn() }) }))
describe("Seguimiento de recogida con salida de ejemplo", () => {
  it("actualiza pendiente, aceptado, listo y recogido sin confirmar un pago", () => {
    data = {
      reference: "ABC234",
      status: "pending",
      guestName: "Cliente de prueba",
      pickupAt: Date.UTC(2026, 10, 9, 19),
      timezone: "Europe/Madrid",
      locationName: "Centro",
      totalCents: 1250,
      lines: [],
    }
    const app = () => (
      <PublicProvider initialLang="en">
        <TrackingApp slug="taberna-lumbre" reference="ABC234" token={"a".repeat(43)} />
      </PublicProvider>
    )
    const view = render(app())
    expect(screen.getByRole("heading", { name: "Awaiting confirmation" })).toBeTruthy()
    for (const [status, label] of [
      ["accepted", "Accepted"],
      ["ready", "Ready for pickup"],
      ["picked_up", "Picked up"],
    ] as const) {
      data = { ...data, status }
      view.rerender(app())
      expect(screen.getByRole("heading", { name: label })).toBeTruthy()
    }
    expect(screen.getByText(/You pay when you pick it up/)).toBeTruthy()
  })
  it("no consulta sin token", () => {
    render(
      <PublicProvider initialLang="ca">
        <TrackingApp slug="taberna-lumbre" reference="ABC234" token="" />
      </PublicProvider>,
    )
    expect(screen.getByRole("alert").textContent).toContain("incomplet")
    expect(screen.queryByRole("button", { name: "Consultar l'estat" })).toBeNull()
  })
})
