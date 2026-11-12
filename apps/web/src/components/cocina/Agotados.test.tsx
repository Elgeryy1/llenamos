import { fireEvent, render, screen } from "@testing-library/react"
import { expect, it, vi } from "vitest"
import { demoMenu } from "@llenamos/core"
import { Agotados } from "./Agotados"

it("ofrece solo platos propios y conserva el id del extra al marcar agotado", () => {
  // Carta de ejemplo de core, solo en pruebas.
  const demo = demoMenu()
  const stations = Object.entries(demo.stations).map(([id, s]) => ({ id, ...s }))
  const kitchen = stations.find((s) => s.kind === "kitchen")!
  const ownItem = Object.entries(demo.items).find(([, item]) => item.stationId === kitchen.id)!
  const item = { ...ownItem[1], id: ownItem[0], modifierGroups: [{ id: "salsa", name: { es: "Salsa", ca: "", en: "" }, min: 0, max: 1, options: [{ id: "picante", name: { es: "Picante", ca: "", en: "" }, priceCents: 0, allergens: [], soldOut: false }] }] }
  const onChange = vi.fn()
  render(<Agotados items={[item, { ...item, id: "ajeno", stationId: stations.find((s) => s.kind === "bar")!.id, name: { es: "Producto ajeno", ca: "", en: "" } }]} station={kitchen} stations={stations} defaultStationId={null} disabled={false} onChange={onChange} />)
  expect(screen.queryByText("Producto ajeno")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: /Agotar extra: Picante/ }))
  expect(onChange).toHaveBeenCalledWith(item.id, "picante", true)
  fireEvent.change(screen.getByRole("textbox", { name: "Buscar un plato" }), { target: { value: "no existe" } })
  expect(screen.getByText("No hay platos con ese nombre.")).toBeTruthy()
})
