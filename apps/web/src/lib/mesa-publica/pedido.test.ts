import { describe, it, expect } from "vitest"
import { reviewOrder, changedSession } from "./pedido"
import { exampleMenu, exampleLine, exampleAt } from "@/lib/carta/fixtures.test-data"
describe("Revisión del pedido público con datos de ejemplo de core", () => {
  it("usa la variante y la cantidad, sin aceptar un precio del móvil", () => {
    const price = reviewOrder(exampleMenu(), [exampleLine], "table", exampleAt)
    expect(price.ok).toBe(true)
    expect(price.totalCents).toBe(500)
    expect(() =>
      reviewOrder(
        exampleMenu(),
        [{ ...exampleLine, priceCents: 1 } as unknown as typeof exampleLine],
        "table",
        exampleAt,
      ),
    ).toThrow()
  })
  it("detecta un cambio de precio para revisión explícita", () => {
    const menu = exampleMenu()
    menu.items.find((i) => i.id === "cana")!.variants[0].priceCents = 300
    const result = reviewOrder(menu, [exampleLine], "table", exampleAt, 500)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.problems.some((p) => p.code === "price_changed")).toBe(true)
  })
  it("rechaza un plato agotado después de añadirlo", () => {
    const menu = exampleMenu()
    menu.items.find((i) => i.id === "cana")!.soldOut = true
    const result = reviewOrder(menu, [exampleLine], "table", exampleAt)
    expect(!result.ok && result.problems[0].code).toBe("item_sold_out")
  })
  it("valida menús contra la hora de recogida y el canal", () => {
    const menu = exampleMenu(),
      daily = menu.dailyMenus[0]
    const line = {
      kind: "menu" as const,
      dailyMenuId: daily.id,
      quantity: 1,
      notes: "",
      guest: null,
      selections: daily.sections.map((s) => ({
        sectionId: s.id,
        itemId: s.choices[0].itemId,
        variantId: s.choices[0].variantId,
        optionIds: [],
        notes: "",
      })),
    }
    const afterHours = reviewOrder(menu, [line], "table", Date.UTC(2026, 10, 9, 22))
    expect(!afterHours.ok && afterHours.problems.some((p) => p.code === "menu_not_available_now")).toBe(true)
    const takeaway = reviewOrder(menu, [line], "takeaway", exampleAt)
    expect(!takeaway.ok && takeaway.problems.some((p) => p.code === "menu_not_available_here")).toBe(true)
  })
  it("distingue una sesión cerrada o sustituida", () => {
    expect(changedSession("s1", "s2")).toBe(true)
    expect(changedSession("s1", null)).toBe(true)
    expect(changedSession("s1", "s1")).toBe(false)
  })
})
