import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { InicioView } from "./InicioView"

const state = vi.hoisted(() => ({
  modules: ["reservations"] as string[],
  role: "manager" as "manager" | "kitchen" | "bar",
  sala: vi.fn(() => ({ status: "ready", data: { tables: [], areas: [] } })),
}))
vi.mock("@/components/panel/PanelContext", () => ({
  usePanel: () => ({ restaurant: { id: "demo-lumbre", name: "Taberna Lumbre", plan: "reservas", activeModules: state.modules }, location: { id: "centro", name: "Centro" }, member: { displayName: "Demo" }, role: state.role }),
}))
vi.mock("@/lib/data/hooks", () => ({ useSala: state.sala, useMembers: () => ({ status: "ready", data: [] }), useActivity: () => ({ status: "ready", data: [] }) }))
vi.mock("@/lib/use-now", () => ({ useNow: () => new Date("2026-11-09T18:00:00Z") }))

describe("Inicio según módulos y estación", () => {
  it("no ofrece sala ni consulta sus mesas en el plan reservas", () => {
    state.role = "manager"
    state.modules = ["reservations"]
    const view = render(<InicioView />)
    expect(screen.queryByRole("link", { name: "Abrir sala" })).toBeNull()
    expect(state.sala).toHaveBeenLastCalledWith("demo-lumbre", null)
    state.modules = ["reservations", "floor", "kitchen"]
    view.rerender(<InicioView />)
    expect(screen.getByRole("link", { name: "Abrir sala" }).getAttribute("href")).toBe("/panel/sala")
  })
  it.each(["kitchen", "bar"] as const)("abre la estación ya disponible de %s y la oculta sin módulos", (role) => {
    state.role = role
    state.modules = ["floor", "kitchen"]
    const view = render(<InicioView />)
    expect(screen.getByRole("link", { name: "Abrir estación" }).getAttribute("href")).toBe(role === "kitchen" ? "/panel/cocina" : "/panel/barra")
    expect(screen.queryByText(/llega en la fase 2/)).toBeNull()
    state.modules = ["reservations"]
    view.rerender(<InicioView />)
    expect(screen.queryByRole("link", { name: "Abrir estación" })).toBeNull()
  })
})
