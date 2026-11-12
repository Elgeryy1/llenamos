import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { demoMenu } from "@llenamos/core"
import { describe, expect, it, vi } from "vitest"
import { Pedido } from "./Pedido"

// Carta de ejemplo compartida de core, solo para las pruebas unitarias.
const demo = demoMenu()
const carta = {
  items: Object.entries(demo.items).map(([id, i]) => ({ ...i, id })),
  categories: Object.entries(demo.categories).map(([id, c]) => ({ ...c, id })),
  menus: Object.entries(demo.dailyMenus).map(([id, m]) => ({ ...m, id })),
}
const base = {
  carta,
  timezone: "Europe/Madrid",
  now: Date.UTC(2026, 10, 9, 13, 0),
}

async function addBravas() {
  fireEvent.click(screen.getByRole("button", { name: "Añadir Patatas bravas" }))
}

describe("pedido del camarero", () => {
  it("muestra alérgenos y obliga a elegir variante antes de añadir", () => {
    render(<Pedido {...base} onSend={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "Añadir Cerveza" }))
    expect(
      screen
        .getByRole("button", { name: "Añadir al pedido" })
        .hasAttribute("disabled"),
    ).toBe(true)
    expect(screen.getAllByText(/Alérgenos:.*[Gg]luten/).length).toBeGreaterThan(
      0,
    )
    fireEvent.click(screen.getByRole("button", { name: /Caña/ }))
    expect(
      screen
        .getByRole("button", { name: "Añadir al pedido" })
        .hasAttribute("disabled"),
    ).toBe(false)
  })
  it("conserva el borrador y bloquea el envío si la sesión cambia", async () => {
    const onSend = vi.fn()
    const { rerender } = render(<Pedido {...base} onSend={onSend} />)
    await addBravas()
    rerender(
      <Pedido
        {...base}
        blocked="La mesa ha cambiado mientras pedías"
        onSend={onSend}
      />,
    )
    expect(screen.getByText("1 × Patatas bravas")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Enviar pedido" }))
    expect(onSend).not.toHaveBeenCalled()
  })
  it("conserva las líneas cuando el servidor falla y solo vacía al confirmar", async () => {
    const onSend = vi
      .fn()
      .mockRejectedValueOnce(new Error("Falta el servidor de esta función"))
      .mockResolvedValueOnce(undefined)
    render(<Pedido {...base} onSend={onSend} />)
    await addBravas()
    fireEvent.click(screen.getByRole("button", { name: /Revisar total/ }))
    fireEvent.click(screen.getByRole("button", { name: "Enviar pedido" }))
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "Falta el servidor",
      ),
    )
    expect(screen.getByText("1 × Patatas bravas")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Recuperar resultado del envío" }))
    await waitFor(() =>
      expect(screen.queryByText("1 × Patatas bravas")).toBeNull(),
    )
    expect(onSend).toHaveBeenLastCalledWith(
      [
        expect.objectContaining({
          kind: "item",
          itemId: "bravas",
          quantity: 1,
        }),
      ],
      650,
      "auto",
      "",
      expect.any(String),
      undefined,
      expect.any(String),
    )
  })
  it("suma con un toque y recupera líneas y nota al cambiar de vista", () => {
    localStorage.clear()
    const key = "prueba:borrador:diego:s1"
    const view = render(<Pedido {...base} draftKey={key} destination="s1-original" onSend={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "Añadir Patatas bravas" }))
    fireEvent.click(screen.getByRole("button", { name: "Añadir Patatas bravas" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Nota del envío" }), { target: { value: "Sale junto" } })
    view.unmount()
    const restored = render(<Pedido {...base} draftKey={key} destination="s1-movida" onSend={vi.fn()} />)
    expect(screen.getByText("2 × Patatas bravas")).toBeTruthy()
    expect((screen.getByRole("textbox", { name: "Nota del envío" }) as HTMLTextAreaElement).value).toBe("Sale junto")
    expect(screen.getByRole("button", { name: "Revisar destino del borrador" })).toBeTruthy()
    restored.unmount()
    render(<Pedido {...base} draftKey="prueba:borrador:lucia:s1" destination="s1-original" onSend={vi.fn()} />)
    expect(screen.queryByText("2 × Patatas bravas")).toBeNull()
  })
  it("reutiliza exactamente la solicitud guardada al recuperar una respuesta perdida tras recargar", async () => {
    localStorage.clear()
    const onSend = vi.fn().mockRejectedValueOnce(new Error("Respuesta perdida")).mockResolvedValueOnce(undefined)
    const props = { ...base, draftKey: "prueba:envio", destination: "mesa-original", onSend }
    const view = render(<Pedido {...props} />)
    await addBravas()
    fireEvent.click(screen.getByRole("button", { name: /Revisar total/ }))
    fireEvent.click(screen.getByRole("button", { name: "Enviar pedido" }))
    await screen.findByText("Respuesta perdida")
    const original = onSend.mock.calls[0]
    view.unmount()
    render(<Pedido {...props} destination="mesa-movida" blocked="La mesa ha cambiado" />)
    fireEvent.click(screen.getByRole("button", { name: "Recuperar resultado del envío" }))
    await screen.findByText("Pedido confirmado por el servidor.")
    expect(onSend.mock.calls[1]).toEqual(original)
    expect(screen.queryByText("1 × Patatas bravas")).toBeNull()
  })
  it("oculta los platos de categorías retiradas y exige revisar un cambio de precio", () => {
    const { rerender } = render(<Pedido {...base} onSend={vi.fn()} />)
    expect(screen.queryByRole("button", { name: "Añadir Sopa de galets" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Añadir Patatas bravas" }))
    fireEvent.click(screen.getByRole("button", { name: /Revisar total/ }))
    expect((screen.getByRole("button", { name: "Enviar pedido" }) as HTMLButtonElement).disabled).toBe(false)
    rerender(<Pedido {...base} carta={{ ...carta, items: carta.items.map(i => i.id === "bravas" ? { ...i, version: 2, priceCents: 700 } : i) }} onSend={vi.fn()} />)
    expect((screen.getByRole("button", { name: "Enviar pedido" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("permite cambiar nota y comensal de una línea ya añadida", async () => {
    render(<Pedido {...base} onSend={vi.fn()} />)
    await addBravas()
    fireEvent.click(screen.getByRole("button", { name: "Opciones, nota y comensal de la línea 1" }))
    fireEvent.change(screen.getByRole("spinbutton", { name: "Comensal opcional" }), { target: { value: "2" } })
    fireEvent.change(screen.getByRole("textbox", { name: "Notas para la cocina" }), { target: { value: "Sin salsa" } })
    fireEvent.click(screen.getByRole("button", { name: "Guardar línea" }))
    expect(screen.getByText("Sin salsa", { exact: true })).toBeTruthy()
    expect(screen.getByText("Comensal 2", { exact: true })).toBeTruthy()
    expect(screen.getByText("1 × Patatas bravas", { exact: true })).toBeTruthy()
  })

})
