import { describe, it, expect, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { exampleMenu, exampleLine, exampleAt } from "@/lib/carta/fixtures.test-data"
import { Cart } from "./Cart"
describe("Carrito público con carta de ejemplo de core", () => {
  it("requiere revisar el total y lo invalida si el servidor publica precios nuevos", () => {
    const menu = exampleMenu(),
      onSend = vi.fn()
    const props = {
      menu,
      lang: "es" as const,
      channel: "table" as const,
      at: exampleAt,
      lines: [exampleLine],
      onChange: vi.fn(),
      pending: false,
      blocked: false,
      onSend,
    }
    const view = render(<Cart {...props} />)
    const send = () => screen.getByRole("button", { name: "Enviar pedido" }) as HTMLButtonElement
    expect(send().disabled).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: /Revisar el total/ }))
    expect(send().disabled).toBe(false)
    const changed = structuredClone(menu)
    changed.items.find((i) => i.id === "cana")!.variants[0].priceCents = 300
    view.rerender(<Cart {...props} menu={changed} />)
    expect(send().disabled).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: /Revisar el total/ }))
    fireEvent.click(send())
    expect(onSend).toHaveBeenCalledWith(600, "")
  })
  it("bloquea enviar y quitar mientras hay un envío incierto", () => {
    const onSend = vi.fn()
    render(
      <Cart
        menu={exampleMenu()}
        lang="en"
        channel="table"
        at={exampleAt}
        lines={[exampleLine]}
        onChange={vi.fn()}
        pending={false}
        blocked
        onSend={onSend}
      />,
    )
    expect((screen.getByRole("button", { name: "Send order" }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole("button", { name: "Remove" }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "Send order" }))
    expect(onSend).not.toHaveBeenCalled()
  })
  it("un agotado en directo deshabilita la revisión", () => {
    const menu = exampleMenu()
    menu.items.find((i) => i.id === "cana")!.soldOut = true
    render(
      <Cart
        menu={menu}
        lang="ca"
        channel="table"
        at={exampleAt}
        lines={[exampleLine]}
        onChange={vi.fn()}
        pending={false}
        blocked={false}
        onSend={vi.fn()}
      />,
    )
    expect(screen.getByRole("alert").textContent).toContain("exhaurit")
    expect((screen.getByRole("button", { name: /Revisar el total/ }) as HTMLButtonElement).disabled).toBe(true)
  })
})
