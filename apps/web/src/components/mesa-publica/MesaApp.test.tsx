import { describe, it, expect, vi, beforeEach } from "vitest"
import { fireEvent, render, screen, within, waitFor } from "@testing-library/react"
import { type CallableOutput } from "@llenamos/core"
import { exampleMenu } from "@/lib/carta/fixtures.test-data"
import { PublicProvider } from "@/components/publica/PublicContext"
import { ServiceError } from "@/lib/carta/callables"
import { MesaApp } from "./MesaApp"
const mocks = vi.hoisted(() => ({ call: vi.fn(), refresh: vi.fn() }))
let data: CallableOutput<"verMesaPublica">
vi.mock("@/lib/mesa-publica/consulta", () => ({ usePublicCall: () => ({ data, refresh: mocks.refresh }) }))
vi.mock("@/lib/carta/hooks", () => ({ useMenu: () => ({ status: "ready", data: exampleMenu() }) }))
vi.mock("@/lib/mesa-publica/pedido", async (original) => ({
  ...(await original<typeof import("@/lib/mesa-publica/pedido")>()),
  callMesa: mocks.call,
}))
const link = { slug: "taberna-lumbre", locationId: "centro", tableId: "S1", token: "a".repeat(43) }
const app = () => (
  <PublicProvider initialLang="es">
    <MesaApp link={link} />
  </PublicProvider>
)
async function addSimpleItem() {
  const article = screen.getByRole("heading", { name: "Agua mineral" }).closest("article")!
  fireEvent.click(within(article).getByRole("button", { name: "Añadir" }))
  fireEvent.click(screen.getByRole("button", { name: /Añadir ·/ }))
  fireEvent.click(screen.getByRole("button", { name: /Revisar el total/ }))
}
beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  mocks.call.mockReset()
  mocks.refresh.mockReset()
  data = {
    restaurantName: "Taberna Lumbre",
    locationName: "Centro",
    tableName: "S1",
    publicMenuId: "public",
    canOrder: true,
    requireApproval: true,
    callWaiter: true,
    requestBill: true,
    session: { sessionId: "s1", status: "open", guests: 2, totalCents: 0, lines: [] },
  }
})
describe("Mesa pública con fixtures de core y servidor unitario explícito", () => {
  it("envía una vez, explica la aprobación y enseña hasta servido", async () => {
    mocks.call.mockImplementation(async (name: string) =>
      name === "verMesaPublica" ? data : { status: "pending_approval", orderId: "o1", totalCents: 200 },
    )
    const view = render(app())
    expect(screen.getByRole("heading", { level: 1, name: "Carta" })).toBeTruthy()
    await addSimpleItem()
    const button = screen.getByRole("button", { name: "Enviar pedido" })
    fireEvent.click(button)
    fireEvent.click(button)
    await screen.findByText(/un camarero lo confirmará/)
    expect(mocks.call.mock.calls.filter((c) => c[0] === "pedirDesdeMesa")).toHaveLength(1)
    const input = mocks.call.mock.calls.find((c) => c[0] === "pedirDesdeMesa")![1]
    expect(input.sessionId).toBe("s1")
    expect(input).not.toHaveProperty("priceCents")
    const line = {
      id: "l1",
      kind: "item" as const,
      name: { es: "Agua", ca: "Aigua", en: "Water" },
      variant: null,
      modifiers: [],
      components: [],
      quantity: 1,
      totalCents: 200,
      status: "in_kitchen" as const,
    }
    data = { ...data, session: { ...data.session!, totalCents: 200, lines: [line] } }
    view.rerender(app())
    expect(screen.getByText("en cocina")).toBeTruthy()
    data = { ...data, session: { ...data.session!, lines: [{ ...line, status: "served" }] } }
    view.rerender(app())
    expect(screen.getByText("servido")).toBeTruthy()
  })
  it("revalida la sesión inmediatamente antes de escribir", async () => {
    mocks.call.mockResolvedValue({ ...data, session: { ...data.session!, sessionId: "s2" } })
    render(app())
    await addSimpleItem()
    fireEvent.click(screen.getByRole("button", { name: "Enviar pedido" }))
    await screen.findByText(/La mesa ha cambiado/)
    expect(mocks.call.mock.calls.every((c) => c[0] === "verMesaPublica")).toBe(true)
  })
  it("bloquea reenvío y conserva marcador después de perder la respuesta", async () => {
    mocks.call.mockImplementation(async (name: string) => {
      if (name === "verMesaPublica") return data
      throw new ServiceError("uncertain", "Sin respuesta")
    })
    render(app())
    await addSimpleItem()
    fireEvent.click(screen.getByRole("button", { name: "Enviar pedido" }))
    await screen.findByText(/No sabemos si el servidor recibió/)
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Enviar pedido" }) as HTMLButtonElement).disabled).toBe(true),
    )
    expect(screen.getByRole("button", { name: "Recuperar resultado del envío" })).toBeTruthy()
    const saved = JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith("llenamos:mesa:borrador:"))!)!)
    expect(saved.submission.requestId).toBeTruthy()
    expect(saved.lines).toHaveLength(1)
  })
  it("no anuncia éxito si falta el servidor al llamar al camarero", async () => {
    mocks.call.mockRejectedValue(new ServiceError("missing", "Falta el servidor de esta función: avisarDesdeMesa."))
    render(app())
    fireEvent.click(screen.getByRole("button", { name: "Llamar al camarero" }))
    await screen.findByText("Falta el servidor de esta función: avisarDesdeMesa.")
    expect(screen.queryByText("Aviso enviado al personal")).toBeNull()
  })
  it("recupera después de recargar el QR con la misma clave y conserva la nota", async () => {
    mocks.call.mockImplementation(async (name: string) => {
      if (name === "verMesaPublica") return data
      throw new ServiceError("uncertain", "Respuesta perdida")
    })
    const view = render(app())
    await addSimpleItem()
    fireEvent.click(screen.getByRole("button", { name: "Enviar pedido" }))
    await screen.findByText(/No sabemos si el servidor recibió/)
    const original = mocks.call.mock.calls.find(c => c[0] === "pedirDesdeMesa")![1]
    view.unmount()
    mocks.call.mockResolvedValue({ status: "pending_approval", orderId: "o1", totalCents: 200 })
    render(app())
    fireEvent.click(screen.getByRole("button", { name: "Recuperar resultado del envío" }))
    await screen.findByText(/un camarero lo confirmará/)
    expect(mocks.call.mock.calls.filter(c => c[0] === "pedirDesdeMesa").at(-1)![1]).toEqual(original)
  })

})
