import { describe, expect, it } from "vitest"
import {
  buildPublicMenu,
  demoMenu,
  filterPublicMenu,
  priceOrder,
  nextItemVersion,
  MarcarAgotadoInputSchema,
} from "../index"

function menu() {
  const demo = demoMenu()
  return buildPublicMenu({
    ...demo,
    restaurantId: "r",
    locationId: "l",
    restaurantName: "Lumbre",
    locationName: "Centro",
    brandColor: "#f0a35e",
    timezone: "Europe/Madrid",
    floorModule: true,
  })
}
describe("Buscar y filtrar carta", () => {
  it("busca nombres y descripciones traducidos, sin distinguir acentos ni mayúsculas", () => {
    const m = menu()
    m.items[0]!.description.en = "Smoky summer special"
    expect(filterPublicMenu(m, "en", "SMOKY").items.map((i) => i.id)).toEqual([m.items[0]!.id])
    expect(filterPublicMenu(m, "es", "cerveza").items.map((i) => i.id)).toEqual(["cana"])
    expect(filterPublicMenu(m, "es", "cerveza", "postres").total).toBe(0)
    expect(filterPublicMenu(m, "es", "", "bebidas").items.every((i) => i.categoryId === "bebidas")).toBe(true)
  })
  it("excluye presencia, trazas, extras y fichas sin revisar con contador", () => {
    const m = menu()
    const item = m.items.find((i) => i.id === "bravas")!
    item.allergensReviewed = true
    item.allergens = []
    item.traces = []
    item.modifierGroups = []
    const only = { ...m, items: [item], dailyMenus: [] }
    expect(filterPublicMenu(only, "es", "", "", ["milk"]).total).toBe(1)
    item.traces = ["milk"]
    expect(filterPublicMenu(only, "es", "", "", ["milk"]).hidden).toBe(1)
    item.traces = []
    item.allergensReviewed = false
    expect(filterPublicMenu(only, "es", "", "", ["milk"])).toMatchObject({
      hidden: 1,
      incomplete: 1,
      total: 0,
    })
    item.allergensReviewed = true
    item.modifierGroups = [
      {
        id: "g",
        name: item.name,
        min: 0,
        max: 1,
        options: [{ id: "o", name: item.name, priceCents: 0, allergens: ["milk"], soldOut: false }],
      },
    ]
    expect(filterPublicMenu(only, "es", "", "", ["milk"]).hidden).toBe(1)
    expect(filterPublicMenu(m, "es", "", "", ["milk"]).dailyMenus).toEqual([])
    expect(filterPublicMenu(m, "es").dailyMenus.length).toBeGreaterThan(0)
  })
  it("publica los campos opcionales sin alterar el precio ni exponer datos internos", () => {
    const demo = demoMenu()
    demo.items.bravas!.featured = true
    demo.items.bravas!.allergensReviewed = true
    const m = buildPublicMenu({
      ...demo,
      restaurantId: "r",
      locationId: "l",
      restaurantName: "Lumbre",
      locationName: "Centro",
      brandColor: "#f0a35e",
      timezone: "Europe/Madrid",
      floorModule: true,
    })
    expect(m.items.find((i) => i.id === "bravas")).toMatchObject({ featured: true, allergensReviewed: true })
    const changed = { ...demo.items.bravas!, featured: false }
    expect(nextItemVersion(demo.items.bravas!, changed)).toBe(1)
  })
})
describe("Disponibilidad de variantes", () => {
  it("rechaza solo la botella agotada y conserva copa y versión, también en menú", () => {
    const demo = demoMenu(),
      wine = demo.items.vino!
    wine.selfOrder = true
    wine.variants[1]!.soldOut = true
    expect(
      nextItemVersion({ ...wine, variants: wine.variants.map((v) => ({ ...v, soldOut: false })) }, wine),
    ).toBe(1)
    const opts = { channel: "table" as const, now: Date.UTC(2026, 10, 9, 13), timezone: "Europe/Madrid" }
    const order = (variantId: string) =>
      priceOrder(
        [{ kind: "item", itemId: "vino", variantId, quantity: 1, optionIds: [], notes: "", guest: null }],
        demo,
        opts,
      )
    expect(order(wine.variants[0]!.id).ok).toBe(true)
    expect(order(wine.variants[1]!.id)).toMatchObject({
      ok: false,
      problems: [expect.objectContaining({ code: "item_sold_out" })],
    })
    const fixed = demo.dailyMenus.mediodia!
    fixed.sections = [
      {
        id: "wine",
        name: wine.name,
        course: "drinks",
        min: 1,
        max: 1,
        choices: [{ itemId: "vino", variantId: wine.variants[1]!.id, supplementCents: 0 }],
      },
    ]
    expect(
      priceOrder(
        [
          {
            kind: "menu",
            dailyMenuId: "mediodia",
            quantity: 1,
            notes: "",
            guest: null,
            selections: [{ sectionId: "wine", itemId: "vino", variantId: null, optionIds: [], notes: "" }],
          },
        ],
        demo,
        opts,
      ).ok,
    ).toBe(false)
  })
  it("no acepta cambiar variante y extra en la misma operación", () => {
    expect(
      MarcarAgotadoInputSchema.safeParse({
        restaurantId: "r",
        locationId: "l",
        itemId: "i",
        variantId: "v",
        optionId: "o",
        soldOut: true,
      }).success,
    ).toBe(false)
  })
})
