import { describe, expect, it } from "vitest"
import {
  ALLERGEN_LABEL,
  ALLERGENS,
  allergensWith,
  buildPublicMenu,
  COURSE_LABEL,
  DailyMenuSchema,
  demoMenu,
  displayPrice,
  localize,
  MENU_UI_TEXT,
  MenuCategorySchema,
  MenuItemEditableSchema,
  MenuItemSchema,
  menuUi,
  missingLanguages,
  ModifierGroupSchema,
  nextDailyMenuVersion,
  nextItemVersion,
  ORDER_PROBLEM_CODES,
  ORDER_PROBLEM_TEXT,
  PUBLIC_LINE_STATUS_TEXT,
  publicMenuCatalog,
  publicMenuId,
  PublicMenuSchema,
  publicMenuSections,
  StationSchema,
  sha256Hex,
  LANGUAGES,
  type MenuItem,
} from "../index"

const errores = (r: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }) =>
  r.success ? [] : (r.error?.issues ?? []).map((i) => `${i.path.join(".")}: ${i.message}`)

describe("textos en tres idiomas", () => {
  it("el castellano es obligatorio y lo que falta se enseña en castellano", () => {
    const t = { es: "Croquetas", ca: "", en: "Croquettes" }
    expect(localize(t, "ca")).toBe("Croquetas")
    expect(localize(t, "en")).toBe("Croquettes")
    expect(missingLanguages([t])).toEqual(["ca"])
    // Una descripción vacía en castellano no pide traducción.
    expect(missingLanguages([t, { es: "", ca: "", en: "" }])).toEqual(["ca"])
    expect(missingLanguages([{ es: "Pan", ca: "Pa", en: "Bread" }])).toEqual([])
  })

  it("al leer, rellena con vacío los idiomas que no llegan", () => {
    const c = MenuCategorySchema.parse({ name: { es: "Postres" }, sortOrder: 1, active: true })
    expect(c.name).toEqual({ es: "Postres", ca: "", en: "" })
    expect(c.description).toEqual({ es: "", ca: "", en: "" })
    expect(errores(MenuCategorySchema.safeParse({ name: { es: " " }, sortOrder: 1, active: true }))).toEqual(["name.es: Escribe el texto en castellano."])
  })
})

describe("modelo de la carta", () => {
  const base = { categoryId: "compartir", name: { es: "Bravas" }, sortOrder: 1, priceCents: 650, course: "first" }

  it("un plato mínimo lleva los valores por defecto", () => {
    const p = MenuItemEditableSchema.parse(base)
    expect(p).toMatchObject({ variants: [], modifierGroups: [], allergens: [], traces: [], photoPath: null, stationId: null, prepMinutes: null, taxRate: 10, selfOrder: true, takeaway: false, active: true })
  })

  it("rechaza precios con decimales, negativos y alérgenos fuera de la lista oficial", () => {
    expect(MenuItemEditableSchema.safeParse({ ...base, priceCents: 6.5 }).success).toBe(false)
    expect(MenuItemEditableSchema.safeParse({ ...base, priceCents: -1 }).success).toBe(false)
    expect(MenuItemEditableSchema.safeParse({ ...base, allergens: ["gluten", "gluten"] }).success).toBe(false)
    expect(MenuItemEditableSchema.safeParse({ ...base, allergens: ["picante"] }).success).toBe(false)
    expect(ALLERGENS).toHaveLength(14)
  })

  it("comprueba los grupos de extras", () => {
    const opcion = (id: string) => ({ id, name: { es: id }, priceCents: 0 })
    expect(ModifierGroupSchema.safeParse({ id: "g", name: { es: "G" }, min: 2, max: 1, options: [opcion("a"), opcion("b")] }).success).toBe(false)
    expect(ModifierGroupSchema.safeParse({ id: "g", name: { es: "G" }, min: 0, max: 3, options: [opcion("a"), opcion("b")] }).success).toBe(false)
    expect(ModifierGroupSchema.safeParse({ id: "g", name: { es: "G" }, min: 0, max: 2, options: [opcion("a"), opcion("a")] }).success).toBe(false)
    expect(ModifierGroupSchema.safeParse({ id: "g", name: { es: "G" }, min: 1, max: 2, options: [opcion("a"), opcion("b")] }).success).toBe(true)
  })

  it("la foto va en la ruta del plato en Storage", () => {
    expect(MenuItemEditableSchema.safeParse({ ...base, photoPath: "restaurants/r/locations/l/menu/bravas/foto.webp" }).success).toBe(true)
    expect(MenuItemEditableSchema.safeParse({ ...base, photoPath: "otra/cosa.jpg" }).success).toBe(false)
  })

  it("los ids de opciones son únicos entre todos los grupos de un plato", () => {
    const grupo = (id: string) => ({ id, name: { es: id }, min: 0, max: 1, options: [{ id: "queso", name: { es: "Queso" }, priceCents: 100 }] })
    expect(MenuItemEditableSchema.safeParse({ ...base, modifierGroups: [grupo("salsas"), grupo("extras")] }).success).toBe(false)
  })

  it("la carta de demostración cumple los esquemas", () => {
    const d = demoMenu()
    for (const [id, i] of Object.entries(d.items)) {
      expect(MenuItemSchema.safeParse(i).success, id).toBe(true)
      expect(MenuItemSchema.parse({ ...i, updatedBy: null }).updatedBy).toBeNull()
      expect(MenuItemSchema.safeParse({ ...i, updatedBy: 123 }).success).toBe(false)
    }
    for (const m of Object.values(d.dailyMenus)) {
      expect(DailyMenuSchema.safeParse(m).success).toBe(true)
      expect(DailyMenuSchema.parse({ ...m, updatedBy: null }).updatedBy).toBeNull()
      expect(DailyMenuSchema.safeParse({ ...m, updatedBy: 123 }).success).toBe(false)
    }
    for (const s of Object.values(d.stations)) expect(StationSchema.safeParse(s).success).toBe(true)
    // Cada plato apunta a una categoría y una estación que existen.
    for (const i of Object.values(d.items)) {
      expect(d.categories[i.categoryId]).toBeDefined()
      if (i.stationId) expect(d.stations[i.stationId]).toBeDefined()
    }
  })
})

describe("versiones de precio", () => {
  it("sube la versión solo si cambia el precio", () => {
    const d = demoMenu()
    const croquetas = d.items.croquetas as MenuItem
    expect(nextItemVersion(null, croquetas)).toBe(1)
    expect(nextItemVersion(croquetas, { ...croquetas, name: { es: "Croquetas caseras", ca: "", en: "" } } as MenuItem)).toBe(1)
    const subida = { ...croquetas, variants: croquetas.variants.map((v) => (v.id === "media" ? { ...v, priceCents: 650 } : v)) }
    expect(nextItemVersion(croquetas, subida)).toBe(2)
    const entrecot = d.items.entrecot as MenuItem
    const salsa = { ...entrecot, modifierGroups: entrecot.modifierGroups.map((g) => ({ ...g, options: g.options.map((o) => ({ ...o, priceCents: o.priceCents + 50 })) })) }
    expect(nextItemVersion({ ...entrecot, version: 4 }, salsa)).toBe(5)
    // Marcar agotado no es un cambio de precio.
    expect(nextItemVersion(entrecot, { ...entrecot, soldOut: true } as MenuItem)).toBe(1)
  })

  it("en el menú del día cuenta el precio y los suplementos", () => {
    const m = demoMenu().dailyMenus.mediodia
    if (!m) throw new Error("falta el menú")
    expect(nextDailyMenuVersion(m, { ...m, from: "12:30" } as typeof m)).toBe(1)
    expect(nextDailyMenuVersion(m, { ...m, priceCents: 1600 })).toBe(2)
    const sup = { ...m, sections: m.sections.map((s) => ({ ...s, choices: s.choices.map((c) => ({ ...c, supplementCents: c.supplementCents + 100 })) })) }
    expect(nextDailyMenuVersion(m, sup)).toBe(2)
  })

  it("precio que se enseña y alérgenos con los extras", () => {
    const d = demoMenu()
    expect(displayPrice(d.items.bravas as MenuItem)).toEqual({ priceCents: 650, from: false })
    expect(displayPrice(d.items.croquetas as MenuItem)).toEqual({ priceCents: 600, from: true })
    expect(allergensWith(d.items.entrecot as MenuItem)).toEqual([])
    expect(allergensWith(d.items.entrecot as MenuItem, ["punto", "roquefort"])).toEqual(["milk"])
    expect(allergensWith(d.items.hamburguesa as MenuItem, ["queso"])).toEqual(["gluten", "milk", "mustard", "sesame"])
  })
})

describe("textos de la interfaz", () => {
  it("los tres idiomas tienen las mismas claves y ninguna vacía", () => {
    const claves = Object.keys(MENU_UI_TEXT.es).sort()
    for (const lang of LANGUAGES) {
      expect(Object.keys(MENU_UI_TEXT[lang]).sort()).toEqual(claves)
      for (const v of Object.values(MENU_UI_TEXT[lang])) expect(v.trim()).not.toBe("")
      expect(Object.keys(ALLERGEN_LABEL[lang])).toEqual([...ALLERGENS])
      expect(Object.keys(ORDER_PROBLEM_TEXT[lang]).sort()).toEqual([...ORDER_PROBLEM_CODES].sort())
      expect(Object.keys(COURSE_LABEL[lang])).toEqual(["drinks", "first", "second", "dessert"])
      expect(Object.keys(PUBLIC_LINE_STATUS_TEXT[lang]).length).toBe(6)
    }
  })

  it("rellena los huecos", () => {
    expect(menuUi("es", "pickupAt", { time: "21:30" })).toBe("Recogida a las 21:30")
    expect(menuUi("ca", "chooseUpTo", { n: 2 })).toBe("Tria'n fins a 2")
    expect(menuUi("en", "chooseUpTo")).toBe("Choose up to {n}")
  })
})

describe("carta pública", () => {
  const src = () => {
    const d = demoMenu()
    return {
      restaurantId: "demo-lumbre",
      locationId: "centro",
      restaurantName: "Taberna Lumbre",
      locationName: "Centro",
      brandColor: "#f0a35e",
      timezone: "Europe/Madrid",
      categories: d.categories,
      items: d.items,
      dailyMenus: d.dailyMenus,
      settings: d.settings,
      floorModule: true,
    }
  }

  it("publica solo lo activo, sin datos internos, y se lee con su esquema", () => {
    const s = src()
    s.items = { ...s.items, ensalada: { ...(s.items.ensalada as MenuItem), active: false } }
    const menu = buildPublicMenu(s)
    expect(PublicMenuSchema.parse(menu)).toEqual(menu)
    expect(publicMenuId("demo-lumbre", "centro")).toBe(sha256Hex(JSON.stringify(["demo-lumbre", "centro"])))
    expect(menu.categories.map((c) => c.id)).toEqual(["bebidas", "compartir", "principales", "postres"])
    const ids = menu.items.map((i) => i.id)
    expect(ids).not.toContain("ensalada")
    // Los platos que solo están en el menú del día van, pero no se piden sueltos.
    expect(menu.items.find((i) => i.id === "sopa")).toMatchObject({ selfOrder: false, takeaway: false })
    expect(publicMenuSections(menu).flatMap((x) => x.items.map((i) => i.id))).not.toContain("sopa")
    expect(JSON.stringify(menu)).not.toContain("stationId")
    expect(JSON.stringify(menu)).not.toContain("prepMinutes")
    // La ensalada sale del menú del día; el menú sigue porque quedan primeros.
    const primeros = menu.dailyMenus[0]?.sections.find((x) => x.id === "primeros")
    expect(primeros?.choices.map((c) => c.itemId)).toEqual(["sopa", "croquetas"])
    expect(menu.selfOrder.enabled).toBe(true)
    expect(menu.takeaway.enabled).toBe(true)
  })

  it("sin el módulo de sala se ve la carta pero no se pide", () => {
    const menu = buildPublicMenu({ ...src(), floorModule: false })
    expect(menu.items.length).toBeGreaterThan(0)
    expect(menu.selfOrder).toMatchObject({ enabled: false, callWaiter: false, requestBill: false })
    expect(menu.takeaway.enabled).toBe(false)
  })

  it("un menú con una sección sin opciones activas no se publica", () => {
    const s = src()
    s.items = { ...s.items, crema: { ...(s.items.crema as MenuItem), active: false }, tarta: { ...(s.items.tarta as MenuItem), active: false } }
    expect(buildPublicMenu(s).dailyMenus).toEqual([])
  })

  it("se puede usar como carta para calcular precios", () => {
    const c = publicMenuCatalog(buildPublicMenu(src()))
    expect(c.items.bravas?.priceCents).toBe(650)
    expect(c.dailyMenus.mediodia?.priceCents).toBe(1550)
  })

  it("el id público distingue restaurantes y locales con separadores en sus ids", () => {
    expect(publicMenuId("a_b", "c")).not.toBe(publicMenuId("a", "b_c"))
    expect(publicMenuId("a", "b")).toMatch(/^[a-f0-9]{64}$/)
  })
})
