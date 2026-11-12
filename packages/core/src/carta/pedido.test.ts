import { describe, expect, it } from "vitest"
import {
  demoMenu,
  isDailyMenuAvailable,
  lineDisplayName,
  OrderLinesInputSchema,
  priceOrder,
  PublicOrderLinesInputSchema,
  type Catalog,
  type OrderLineInput,
  type PriceContext,
} from "../index"

/** Lunes 9 de noviembre de 2026 a las 13:30 en Madrid (UTC+1). */
const LUNES_1330 = Date.UTC(2026, 10, 9, 12, 30)
const staff: PriceContext = { channel: "staff", now: LUNES_1330, timezone: "Europe/Madrid" }

function carta(): Catalog {
  const d = demoMenu()
  return { items: d.items, dailyMenus: d.dailyMenus }
}

const lineas = (raw: unknown[]): OrderLineInput[] => OrderLinesInputSchema.parse(raw)
const codigos = (r: ReturnType<typeof priceOrder>) => (r.ok ? [] : r.problems.map((p) => `${p.line}:${p.selection ?? "-"}:${p.code}:${p.ref ?? ""}`))

describe("precio de un plato", () => {
  it("base × cantidad, variante que sustituye al base y extras que suman", () => {
    const r = priceOrder(
      lineas([
        { kind: "item", itemId: "bravas", quantity: 2 },
        { kind: "item", itemId: "cana", variantId: "doble", quantity: 3 },
        { kind: "item", itemId: "entrecot", optionIds: ["roquefort", "punto"], quantity: 1, notes: "sin guarnición" },
        { kind: "item", itemId: "hamburguesa", optionIds: ["queso", "bacon"], quantity: 2, guest: 3 },
      ]),
      carta(),
      staff,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.lines.map((l) => [l.unitPriceCents, l.totalCents])).toEqual([
      [650, 1300],
      [380, 1140],
      [2200 + 200, 2400],
      [1400 + 150 + 200, 3500],
    ])
    expect(r.totalCents).toBe(1300 + 1140 + 2400 + 3500)
    // Los extras salen en el orden de la carta, no en el del toque.
    expect(r.lines[2]?.modifiers.map((m) => m.optionId)).toEqual(["punto", "roquefort"])
    expect(r.lines[2]?.notes).toBe("sin guarnición")
    expect(r.lines[3]?.guest).toBe(3)
    expect(r.lines[1]?.version).toBe(1)
  })

  it("todo son enteros de céntimos, también con muchas unidades", () => {
    const r = priceOrder(lineas([{ kind: "item", itemId: "vino", variantId: "botella", quantity: 99 }]), carta(), staff)
    expect(r.ok && r.totalCents).toBe(178200)
    expect(Number.isInteger(r.totalCents)).toBe(true)
  })

  it("nombre para enseñar con la variante", () => {
    const r = priceOrder(lineas([{ kind: "item", itemId: "croquetas", variantId: "media", quantity: 1 }]), carta(), staff)
    const l = r.lines[0]
    if (!l) throw new Error("sin línea")
    expect(lineDisplayName(l, "es")).toBe("Croquetas de jamón · Media")
    expect(lineDisplayName(l, "en")).toBe("Ham croquettes · Half")
  })
})

describe("validación contra la carta", () => {
  it("dice todos los problemas, cada uno en su línea", () => {
    const c = carta()
    const entrecot = c.items.entrecot
    if (!entrecot) throw new Error("falta el entrecot")
    c.items = {
      ...c.items,
      entrecot: { ...entrecot, modifierGroups: entrecot.modifierGroups.map((g) => ({ ...g, options: g.options.map((o) => (o.id === "pimienta" ? { ...o, soldOut: true } : o)) })) },
    }
    const r = priceOrder(
      lineas([
        { kind: "item", itemId: "tarta", quantity: 1 },
        { kind: "item", itemId: "croquetas", quantity: 1 },
        { kind: "item", itemId: "bravas", variantId: "media", quantity: 1 },
        { kind: "item", itemId: "entrecot", optionIds: ["pimienta"], quantity: 1 },
        { kind: "item", itemId: "hamburguesa", optionIds: ["queso", "queso", "pepinillo"], quantity: 1 },
        { kind: "item", itemId: "fantasma", quantity: 1 },
        { kind: "item", itemId: "croquetas", variantId: "gigante", quantity: 1 },
      ]),
      c,
      staff,
    )
    expect(codigos(r)).toEqual([
      "0:-:item_sold_out:tarta",
      "1:-:variant_required:croquetas",
      "2:-:variant_not_expected:bravas:media",
      "3:-:option_sold_out:entrecot:pimienta",
      "3:-:group_min:entrecot:punto",
      "4:-:option_duplicate:queso",
      "4:-:option_not_found:hamburguesa:pepinillo",
      "5:-:item_not_found:fantasma",
      "6:-:variant_not_found:croquetas:gigante",
    ])
  })

  it("demasiadas opciones en un grupo", () => {
    const r = priceOrder(lineas([{ kind: "item", itemId: "entrecot", optionIds: ["poco", "hecho"], quantity: 1 }]), carta(), staff)
    expect(codigos(r)).toEqual(["0:-:group_max:entrecot:punto"])
  })

  it("un plato retirado no se puede pedir", () => {
    const c = carta()
    c.items = { ...c.items, bravas: { ...(c.items.bravas as NonNullable<Catalog["items"][string]>), active: false } }
    expect(codigos(priceOrder(lineas([{ kind: "item", itemId: "bravas", quantity: 1 }]), c, staff))).toEqual(["0:-:item_inactive:bravas"])
  })

  it("desde la mesa solo lo marcado para el QR, y para llevar solo lo marcado para llevar", () => {
    const vino = lineas([{ kind: "item", itemId: "vino", variantId: "copa", quantity: 1 }])
    expect(priceOrder(vino, carta(), staff).ok).toBe(true)
    expect(codigos(priceOrder(vino, carta(), { ...staff, channel: "table" }))).toEqual(["0:-:item_not_available_here:vino"])
    const menu = lineas([
      {
        kind: "menu",
        dailyMenuId: "mediodia",
        quantity: 1,
        selections: [
          { sectionId: "primeros", itemId: "sopa" },
          { sectionId: "segundos", itemId: "pollo" },
          { sectionId: "postres", itemId: "crema" },
        ],
      },
    ])
    expect(priceOrder(menu, carta(), { ...staff, channel: "table" }).ok).toBe(true)
    expect(codigos(priceOrder(menu, carta(), { ...staff, channel: "takeaway" }))).toEqual(["0:-:menu_not_available_here:mediodia"])
  })

  it("si el total que vio el cliente no coincide, price_changed", () => {
    const l = lineas([{ kind: "item", itemId: "bravas", quantity: 1 }])
    expect(priceOrder(l, carta(), { ...staff, expectedTotalCents: 650 }).ok).toBe(true)
    const r = priceOrder(l, carta(), { ...staff, expectedTotalCents: 600 })
    expect(codigos(r)).toEqual(["null:-:price_changed:"])
    expect(r.totalCents).toBe(650)
  })

  it("la mesa y la web no pueden cambiar el pase de una línea", () => {
    expect(PublicOrderLinesInputSchema.safeParse([{ kind: "item", itemId: "bravas", quantity: 1, course: "second" }]).success).toBe(false)
    expect(OrderLinesInputSchema.safeParse([{ kind: "item", itemId: "bravas", quantity: 1, course: "second" }]).success).toBe(true)
    expect(OrderLinesInputSchema.safeParse([]).success).toBe(false)
    expect(OrderLinesInputSchema.safeParse([{ kind: "item", itemId: "bravas", quantity: 0 }]).success).toBe(false)
    expect(OrderLinesInputSchema.safeParse([{ kind: "item", itemId: "bravas", quantity: 1, priceCents: 1 }]).success).toBe(false)
  })
})

describe("menú del día", () => {
  const menuDe = (selections: unknown[], quantity = 1) => lineas([{ kind: "menu", dailyMenuId: "mediodia", quantity, selections }])

  it("precio del menú + suplementos + extras; las variantes no cobran", () => {
    const r = priceOrder(
      menuDe(
        [
          { sectionId: "primeros", itemId: "croquetas" },
          { sectionId: "segundos", itemId: "entrecot", optionIds: ["punto", "pimienta"], notes: "bien caliente" },
          { sectionId: "postres", itemId: "crema" },
        ],
        2,
      ),
      carta(),
      staff,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const l = r.lines[0]
    if (!l) throw new Error("sin línea")
    expect(l.kind).toBe("menu")
    expect(l.components.map((c) => [c.itemId, c.course, c.unitPriceCents, c.variant?.id ?? null])).toEqual([
      ["croquetas", "first", 0, "media"],
      ["entrecot", "second", 400 + 150, null],
      ["crema", "dessert", 0, null],
    ])
    expect(l.unitPriceCents).toBe(1550 + 550)
    expect(l.totalCents).toBe(2 * 2100)
    expect(l.components[1]?.notes).toBe("bien caliente")
  })

  it("comprueba secciones, opciones y agotados", () => {
    const r = priceOrder(
      menuDe([
        { sectionId: "primeros", itemId: "sopa" },
        { sectionId: "primeros", itemId: "ensalada" },
        { sectionId: "segundos", itemId: "hamburguesa" },
        { sectionId: "postres", itemId: "tarta" },
        { sectionId: "cafes", itemId: "agua" },
      ]),
      carta(),
      staff,
    )
    expect(codigos(r)).toEqual([
      "0:2:choice_not_allowed:segundos:hamburguesa",
      "0:3:item_sold_out:tarta",
      "0:4:section_not_found:cafes",
      "0:-:section_max:primeros",
    ])
    // Una sección vacía sí avisa.
    expect(codigos(priceOrder(menuDe([{ sectionId: "primeros", itemId: "sopa" }, { sectionId: "postres", itemId: "crema" }]), carta(), staff))).toEqual([
      "0:-:section_min:segundos",
    ])
  })

  it("fuera de su horario o de sus días no se puede pedir", () => {
    const sel = [
      { sectionId: "primeros", itemId: "sopa" },
      { sectionId: "segundos", itemId: "pollo" },
      { sectionId: "postres", itemId: "crema" },
    ]
    const sabado = Date.UTC(2026, 10, 14, 12, 30)
    expect(codigos(priceOrder(menuDe(sel), carta(), { ...staff, now: sabado }))).toEqual(["0:-:menu_not_available_now:mediodia"])
    const lunesNoche = Date.UTC(2026, 10, 9, 20, 0)
    expect(codigos(priceOrder(menuDe(sel), carta(), { ...staff, now: lunesNoche }))).toEqual(["0:-:menu_not_available_now:mediodia"])
  })

  it("horario con la hora del local y tramos que cruzan la medianoche", () => {
    const m = { active: true, days: ["fri" as const], from: "22:00", to: "02:00" }
    // Viernes 13 a las 23:30 y sábado 14 a las 01:30 (hora de Madrid) valen; sábado 23:30 no.
    expect(isDailyMenuAvailable(m, Date.UTC(2026, 10, 13, 22, 30), "Europe/Madrid")).toBe(true)
    expect(isDailyMenuAvailable(m, Date.UTC(2026, 10, 14, 0, 30), "Europe/Madrid")).toBe(true)
    expect(isDailyMenuAvailable(m, Date.UTC(2026, 10, 14, 22, 30), "Europe/Madrid")).toBe(false)
    expect(isDailyMenuAvailable({ ...m, active: false }, Date.UTC(2026, 10, 13, 22, 30), "Europe/Madrid")).toBe(false)
    // En verano Madrid va a UTC+2: las 13:00 locales son las 11:00 UTC.
    const verano = { active: true, days: ["wed" as const], from: "13:00", to: "16:00" }
    expect(isDailyMenuAvailable(verano, Date.UTC(2026, 6, 15, 11, 0), "Europe/Madrid")).toBe(true)
    expect(isDailyMenuAvailable(verano, Date.UTC(2026, 6, 15, 10, 59), "Europe/Madrid")).toBe(false)
  })
})
