import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { SalaView } from "./SalaView"

const state = vi.hoisted(() => ({ modules: ["reservations"] as string[] }))
vi.mock("@/components/panel/PanelContext", () => ({
  usePanel: () => ({ restaurant: { id: "demo-lumbre", name: "Taberna Lumbre", plan: "reservas", activeModules: state.modules }, location: { id: "centro" }, role: "manager" }),
}))
vi.mock("@/components/sala/SalaServicio", () => ({ SalaServicio: () => <p>Servicio de sala activo</p> }))

describe("Acceso directo a sala por módulo", () => {
  it("bloquea el plan reservas y permite la sala al activar floor", () => {
    state.modules = ["reservations"]
    const view = render(<SalaView />)
    expect(screen.getByText("El módulo Sala y comandero no está activo")).toBeTruthy()
    expect(screen.queryByText("Servicio de sala activo")).toBeNull()
    state.modules = ["reservations", "floor", "kitchen"]
    view.rerender(<SalaView />)
    expect(screen.getByText("Servicio de sala activo")).toBeTruthy()
  })
})
