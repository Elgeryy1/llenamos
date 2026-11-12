import { describe, it, expect, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { demoMenu } from "@llenamos/core"
import { ItemEditor } from "./ItemEditor"
import { editableItem } from "@/lib/carta/forms"
describe("Editor de carta con ficha de ejemplo de core", () => {
  it("conserva las traducciones al editar castellano y declara alérgenos y trazas por separado", () => {
    const value = editableItem(demoMenu().items.cana),
      onChange = vi.fn()
    render(
      <ItemEditor
        value={value}
        onChange={onChange}
        categories={[{ id: "bebidas", name: { es: "Bebidas" } }]}
        stations={[]}
      />,
    )
    fireEvent.change(screen.getAllByRole("textbox", { name: "Castellano" })[0], {
      target: { value: "Cerveza artesanal" },
    })
    expect(onChange.mock.calls[0][0].name).toEqual({ ...value.name, es: "Cerveza artesanal" })
    expect(screen.getByRole("group", { name: "Contiene estos alérgenos" })).toBeTruthy()
    expect(screen.getByRole("group", { name: "Puede contener trazas" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Añadir variante" })).toBeTruthy()
  })
})
