import { describe, expect, it } from "vitest"
import { fechaLarga, textoPedido } from "./texto"

const order = {
  reference: "AB12CD",
  expectedOn: "2026-11-11",
  notes: "Entregar antes de las 10:00",
  lines: [
    { lineId: "a", supplierItemId: "s1", ingredientId: "i1", name: "Saco patatas", baseQuantity: 25_000, priceCents: 3000, orderedFormats: 2, receivedFormats: 1 },
    { lineId: "b", supplierItemId: "s2", ingredientId: "i2", name: "Garrafa aceite", baseQuantity: 5000, priceCents: 4500, orderedFormats: 2, receivedFormats: 2 },
  ],
}
const proveedor = { name: "Mercabarna", contact: "Rosa Vidal" }
const unidadDe = (id: string) => (id === "i1" ? ("g" as const) : ("ml" as const))

describe("texto del pedido", () => {
  it("escribe el día largo en castellano", () => {
    expect(fechaLarga("2026-11-11")).toBe("miércoles 11 de noviembre")
  })
  it("lleva saludo, líneas, nota y despedida, y no pone precios si no se piden", () => {
    const t = textoPedido(order, proveedor, { restaurante: "Taberna Lumbre", local: "Centro", conPrecios: false, soloPendiente: false, unidadDe })
    expect(t).toContain("Hola Rosa,")
    expect(t).toContain("Pedido AB12CD de Taberna Lumbre (Centro) para el miércoles 11 de noviembre:")
    expect(t).toContain("• 2 x Saco patatas (25 kg)")
    expect(t).toContain("• 2 x Garrafa aceite (5 l)")
    expect(t).toContain("Nota: Entregar antes de las 10:00")
    expect(t).not.toContain("€")
    expect(t).not.toMatch(/ [-–—] /)
  })
  it("con precios suma el total sin IVA", () => {
    const t = textoPedido(order, proveedor, { restaurante: "Taberna Lumbre", local: null, conPrecios: true, soloPendiente: false, unidadDe })
    expect(t).toMatch(/Total sin IVA: 150,00\s€/)
  })
  it("solo pendiente deja fuera lo ya recibido", () => {
    const t = textoPedido(order, proveedor, { restaurante: "Taberna Lumbre", local: null, conPrecios: false, soloPendiente: true, unidadDe })
    expect(t).toContain("nos falta por recibir")
    expect(t).toContain("• 1 x Saco patatas")
    expect(t).not.toContain("Garrafa")
  })
})
