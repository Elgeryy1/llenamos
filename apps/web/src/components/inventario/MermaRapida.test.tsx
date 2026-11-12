import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"

const { panel, ingredientes } = vi.hoisted(() => ({ panel: vi.fn(), ingredientes: vi.fn() }))
vi.mock("@/components/panel/PanelContext", () => ({ usePanel: panel }))
vi.mock("@/lib/inventario/datos", () => ({ useIngredientes: ingredientes }))
vi.mock("./MermaDialog", () => ({ MermaDialog: () => <div role="dialog">Diálogo de merma</div> }))
import { MermaRapida } from "./MermaRapida"

const como = (role: string, activeModules: string[]) =>
  panel.mockReturnValue({ role, restaurant: { id: "demo-lumbre", plan: "completo", activeModules }, location: { id: "centro", name: "Centro" } })
beforeEach(() => { vi.clearAllMocks(); ingredientes.mockReturnValue({ status: "ready", data: [] }) })

it("cocina y barra con inventario activo ven el acceso directo", () => {
  for (const role of ["kitchen", "bar", "manager"]) {
    como(role, ["inventory", "floor", "kitchen"])
    const { unmount } = render(<MermaRapida />)
    expect(screen.getByRole("button", { name: "Registrar merma" })).toBeTruthy()
    unmount()
  }
})

it("sin el módulo de inventario o sin permiso no aparece nada ni se lee el almacén", () => {
  como("kitchen", ["floor", "kitchen"])
  const { container, unmount } = render(<MermaRapida />)
  expect(container.textContent).toBe("")
  unmount()
  como("waiter", ["inventory", "floor", "kitchen"])
  const otro = render(<MermaRapida />)
  expect(otro.container.textContent).toBe("")
  expect(ingredientes).not.toHaveBeenCalled()
})

it("no escucha los ingredientes hasta que se abre y entonces enseña el mismo diálogo", () => {
  como("kitchen", ["inventory", "floor", "kitchen"])
  render(<MermaRapida />)
  expect(ingredientes).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "Registrar merma" }))
  expect(ingredientes).toHaveBeenCalled()
  expect(screen.getByRole("dialog").textContent).toContain("Diálogo de merma")
})
