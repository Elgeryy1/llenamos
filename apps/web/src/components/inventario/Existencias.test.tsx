import { render, screen } from "@testing-library/react"
import type { IngredientWithId } from "@llenamos/core"
import { beforeEach, expect, it, vi } from "vitest"

const { panel, costes } = vi.hoisted(() => ({ panel: vi.fn(), costes: vi.fn() }))
vi.mock("@/components/panel/PanelContext", () => ({ usePanel: panel }))
vi.mock("next/navigation", () => ({ usePathname: () => "/panel/inventario" }))
vi.mock("@/lib/inventario/acciones", () => ({ useAccion: () => ({ ejecutar: vi.fn(), busy: false, error: null, limpiar: vi.fn() }) }))

const ingrediente = (id: string, name: string, quantity: number, minQuantity: number): IngredientWithId =>
  ({ id, name, unit: "g", category: "Carne", minQuantity, targetQuantity: null, active: true, quantity, revision: 1 })
vi.mock("@/lib/inventario/datos", () => ({
  rutaLocal: (r: string, l: string | null) => (l ? `restaurants/${r}/locations/${l}` : null),
  useIngredientes: () => ({ status: "ready", data: [ingrediente("b", "Bacon", 250, 300), ingrediente("e", "Entrecot", 8000, 3000)] }),
  useAvisos: () => ({ status: "ready", data: new Map([["b", { level: "low", status: "open", quantity: 250, minQuantity: 300 }]]) }),
  useCostes: costes,
}))
import { Existencias } from "./Existencias"
import { MarcoInventario } from "./Marco"
import { Escandallos } from "./Escandallos"

const restaurante = { id: "demo-lumbre", name: "Lumbre", timezone: "Europe/Madrid", plan: "completo", activeModules: ["inventory", "floor"] }
const como = (role: string) => panel.mockReturnValue({ role, user: { uid: role }, restaurant: restaurante, location: { id: "centro", name: "Centro" } })

beforeEach(() => {
  vi.clearAllMocks()
  costes.mockImplementation((_base: string | null, activo: boolean) =>
    activo ? { status: "ready", data: new Map([["b", { valueCents: 250, lastCost: null }], ["e", { valueCents: 12800, lastCost: null }]]) } : { status: "loading" })
})

it("cocina ve existencias y avisos pero ningún importe, y ni siquiera pide los costes", () => {
  como("kitchen")
  const { container } = render(<MarcoInventario><Existencias /></MarcoInventario>)
  expect(screen.getByText("Bacon")).toBeTruthy()
  expect(screen.getAllByText("Stock bajo").length).toBeGreaterThan(0)
  expect(container.textContent).not.toContain("€")
  expect(screen.queryByText("Valor del almacén")).toBeNull()
  expect(screen.queryByRole("button", { name: /Ajustar/ })).toBeNull()
  expect(screen.getByRole("button", { name: "Apuntar merma" })).toBeTruthy()
  // Sin pestañas de gestión ni de costes.
  expect(screen.queryByText("Movimientos")).toBeNull()
  expect(screen.queryByText("Recuento")).toBeNull()
  expect(costes.mock.calls.every(([, activo]) => activo === false)).toBe(true)
})

it("la barra tampoco ve costes", () => {
  como("bar")
  const { container } = render(<Existencias />)
  expect(container.textContent).not.toContain("€")
})

it("el encargado ve valor, costes y puede ajustar", () => {
  como("manager")
  render(<MarcoInventario><Existencias /></MarcoInventario>)
  expect(screen.getByText("Valor del almacén")).toBeTruthy()
  expect(screen.getAllByRole("button", { name: /Ajustar/ }).length).toBe(2)
  expect(screen.getByText("Movimientos")).toBeTruthy()
  expect(screen.getByText("Ingredientes", { selector: "nav a" })).toBeTruthy()
})

it("los escandallos son solo de quien ve costes", () => {
  como("kitchen")
  render(<Escandallos />)
  expect(screen.getByText("Tu rol no puede ver los escandallos")).toBeTruthy()
})
