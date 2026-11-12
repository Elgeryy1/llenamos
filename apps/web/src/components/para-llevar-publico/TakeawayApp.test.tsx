import { describe, it, expect, vi, beforeEach } from "vitest"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { PublicProvider } from "@/components/publica/PublicContext"
import { exampleAt, exampleMenu } from "@/lib/carta/fixtures.test-data"
import { TakeawayApp } from "./TakeawayApp"
const mock = vi.hoisted(() => ({ call: vi.fn(), refresh: vi.fn() }))
vi.mock("@/lib/para-llevar-publico/pedido", () => ({ callTakeaway: mock.call }))
vi.mock("@/lib/mesa-publica/consulta", () => ({
  usePublicCall: () => ({
    data: {
      enabled: true,
      date: "2026-11-09",
      timezone: "Europe/Madrid",
      slots: [
        { time: "13:30", wallDate: "2026-11-09", startAt: exampleAt, shift: "Comida", available: true, reason: null },
      ],
    },
    refresh: mock.refresh,
  }),
}))
// El desplegable se reduce a botones en esta prueba de flujo. Desplegable tiene sus propias pruebas.
vi.mock("@/components/common/form-fields", async (original) => ({
  ...(await original<typeof import("@/components/common/form-fields")>()),
  SelectField: ({ onChange, label }: { onChange: (e: { target: { value: string } }) => void; label: string }) => (
    <button onClick={() => onChange({ target: { value: "13:30" } })}>{label}</button>
  ),
}))
beforeEach(() => {
  sessionStorage.clear()
  mock.call.mockReset()
})
describe("Pedido público para llevar con carta y horas de ejemplo", () => {
  it("envía contacto, hora y líneas al servidor y conserva el enlace confirmado", async () => {
    mock.call.mockResolvedValue({
      status: "pending",
      reference: "ABC234",
      manageToken: "a".repeat(43),
      pickupAt: exampleAt,
      totalCents: 200,
    })
    render(
      <PublicProvider initialLang="es">
        <TakeawayApp slug="taberna-lumbre" locationId="centro" menu={exampleMenu()} timezone="Europe/Madrid" />
      </PublicProvider>,
    )
    fireEvent.click(screen.getByRole("button", { name: "Hora de recogida" }))
    const article = screen.getByRole("heading", { name: "Agua mineral" }).closest("article")!
    fireEvent.click(within(article).getByRole("button", { name: "Añadir" }))
    fireEvent.click(screen.getByRole("button", { name: /Añadir ·/ }))
    fireEvent.change(screen.getByRole("textbox", { name: "Tu nombre" }), { target: { value: "Cliente de prueba" } })
    fireEvent.change(screen.getByRole("textbox", { name: "Teléfono" }), { target: { value: "612345678" } })
    fireEvent.click(screen.getByRole("checkbox", { name: /Acepto que/ }))
    fireEvent.click(screen.getByRole("button", { name: /Revisar el total/ }))
    fireEvent.click(screen.getByRole("button", { name: "Enviar pedido" }))
    await screen.findByRole("heading", { name: "Hemos recibido tu pedido" })
    expect(mock.call).toHaveBeenCalledWith(
      "pedirParaLlevar",
      expect.objectContaining({
        time: "13:30",
        expectedTotalCents: 200,
        acceptPolicy: true,
        guestName: "Cliente de prueba",
      }),
    )
    expect(screen.getByRole("link", { name: "Consultar estado" }).getAttribute("href")).toContain(
      "/para-llevar/ABC234?t=",
    )
    expect(sessionStorage.getItem("llenamos:recogida:envio:taberna-lumbre:centro")).toContain("ABC234")
  })
})
