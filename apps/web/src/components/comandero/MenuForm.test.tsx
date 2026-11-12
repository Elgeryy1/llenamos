import { fireEvent, render, screen } from "@testing-library/react"
import { demoMenu, priceOrder } from "@llenamos/core"
import { describe, expect, it, vi } from "vitest"
import { MenuForm } from "./MenuForm"

// Menú de demostración de core utilizado únicamente en la prueba.
const demo = demoMenu()
const carta = {
  items: Object.entries(demo.items).map(([id, i]) => ({ ...i, id })),
  categories: [],
  menus: [],
}

describe("elecciones de menú del camarero", () => {
  it("exige cada sección, respeta la variante incluida y no cobra el plato de nuevo", () => {
    const onAdd = vi.fn()
    const menu = { ...demo.dailyMenus.mediodia!, id: "mediodia" }
    render(<MenuForm menu={menu} carta={carta} onAdd={onAdd} />)
    expect(
      screen
        .getByRole("button", { name: "Añadir menú" })
        .hasAttribute("disabled"),
    ).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: /Croquetas de jamón/ }))
    fireEvent.click(screen.getByRole("button", { name: "Pollo asado" }))
    fireEvent.click(screen.getByRole("button", { name: "Crema catalana" }))
    expect(
      screen
        .getByRole("button", { name: "Añadir menú" })
        .hasAttribute("disabled"),
    ).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: "Añadir menú" }))
    const line = onAdd.mock.calls[0]![0]
    expect(line.selections[0]).toEqual(
      expect.objectContaining({ itemId: "croquetas", variantId: "media" }),
    )
    const price = priceOrder([line], demo, {
      channel: "staff",
      now: Date.UTC(2026, 10, 9, 13),
      timezone: "Europe/Madrid",
    })
    expect(price.ok).toBe(true)
    expect(price.totalCents).toBe(1550)
    expect(
      screen
        .getByRole("button", { name: /Tarta de queso.*Agotado/ })
        .hasAttribute("disabled"),
    ).toBe(true)
  })
})
