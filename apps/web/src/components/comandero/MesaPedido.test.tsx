vi.mock("@/components/sin-conexion/ColaServicio", () => ({ ColaServicio: () => null }))
import { fireEvent, render, screen } from "@testing-library/react"
import { demoMenu, type TableSessionWithId } from "@llenamos/core"
import { describe, expect, it, vi } from "vitest"
vi.mock("@/components/panel/PanelContext", () => ({
  usePanel: () => ({ restaurant: { timezone: "Europe/Madrid" } }),
}))
vi.mock("./GestionMesa", () => ({ GestionMesa: () => null }))
vi.mock("./HistorialPedido", () => ({ HistorialPedido: () => null }))
vi.mock("@/lib/comandero/callables", () => ({
  llamarSala: vi.fn(),
  errorSala: (e: Error) => e.message,
}))
import type { Carta } from "@/lib/comandero/datos"
import type { Live } from "@/lib/firebase/live"
vi.mock("@/lib/comandero/datos", () => ({ useDestino: () => ({ lines: { status: "ready", data: [] } }) }))
import { MesaPedido } from "./Comandero"
import { llamarSala } from "@/lib/comandero/callables"

// Solo datos de ejemplo para ejercitar actualizaciones del listener durante un borrador.
const demo = demoMenu()
const carta: Live<Carta> = {
  status: "ready",
  data: {
    items: Object.entries(demo.items).map(([id, i]) => ({ ...i, id })),
    categories: [],
    menus: [],
  },
}
const session: TableSessionWithId = {
  id: "s1",
  status: "open",
  tableIds: ["sala-1"],
  label: "S1",
  guests: 2,
  reservationId: null,
  customerId: null,
  guestName: null,
  waiterUid: null,
  waiterName: null,
  notes: "",
  openedAt: 100,
  openedBy: "u1",
  closedAt: null,
  closedBy: null,
  billRequestedAt: null,
  mergedInto: null,
  totalCents: 0,
  lineCount: 0,
  unservedCount: 0,
  history: [],
}
const props = {
  scope: { restaurantId: "r", locationId: "l" },
  carta,
  ready: true,
  now: Date.UTC(2026, 10, 9, 13),
}

describe("mesa que cambia con el comandero abierto", () => {
  it("conserva los platos al moverse y exige revisión explícita antes de enviarlos", () => {
    const { rerender } = render(<MesaPedido {...props} session={session} />)
    fireEvent.click(
      screen.getByRole("button", { name: "Añadir Patatas bravas" }),
    )
    rerender(
      <MesaPedido
        {...props}
        session={{ ...session, tableIds: ["sala-4"], label: "S4" }}
      />,
    )
    expect(
      screen
        .getByRole("button", { name: "Enviar pedido" })
        .hasAttribute("disabled"),
    ).toBe(true)
    expect(screen.getByText("1 × Patatas bravas")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Enviar pedido" }))
    expect(llamarSala).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "He revisado esta mesa" }))
    fireEvent.click(screen.getByRole("button", { name: "Revisar destino del borrador" }))
    fireEvent.click(screen.getByRole("button", { name: /Revisar total/ }))
    expect(
      screen
        .getByRole("button", { name: "Enviar pedido" })
        .hasAttribute("disabled"),
    ).toBe(false)
    rerender(
      <MesaPedido
        {...props}
        session={{ ...session, status: "merged", mergedInto: "s2" }}
      />,
    )
    expect(
      screen
        .getByRole("button", { name: "Enviar pedido" })
        .hasAttribute("disabled"),
    ).toBe(true)
    expect(
      screen.queryByRole("button", { name: "He revisado esta mesa" }),
    ).toBeNull()
    expect(screen.getByText("1 × Patatas bravas")).toBeTruthy()
  })
})
