/**
 * Carta pública de un local: `publicMenus/{publicMenuId(restaurantId, locationId)}`.
 *
 * Lo que ve el cliente en la mesa (QR) y en la web de para llevar, sin sesión: platos
 * activos con precio, variantes, extras, alérgenos, foto y si están agotados, y los menús
 * del día. Sin estaciones, tiempos ni nada interno. La mantiene un disparador del servidor
 * (`cartaPublica`) con `buildPublicMenu` cada vez que cambia la carta o los ajustes de sala;
 * la web la escucha en tiempo real (un agotado se ve al momento). Se lee con
 * `PublicMenuSchema` y cumple `Catalog` (`publicMenuCatalog`), así el navegador calcula el
 * total con la misma función que el servidor.
 */
import { z } from "zod"
import { sha256Hex } from "../sha256"
import { DocIdSchema, HexColorSchema } from "../model"
import type { FloorSettings } from "../sala/modelo"
import { ZonaHorariaSchema } from "../reservas/tiempo"
import {
  AllergenSchema,
  DailyMenuSectionSchema,
  DietaryTagSchema,
  ModifierGroupSchema,
  PriceCentsSchema,
  VariantSchema,
  type DailyMenu,
  type MenuCategory,
  type MenuItem,
} from "./modelo"
import type { Catalog } from "./pedido"
import { menuTextSchema, optionalMenuTextSchema } from "./textos"
import { WEEKDAYS } from "../reservation-settings"
import { HoraSchema } from "../reservas/tiempo"

/** Id del documento de la carta pública de un local. */
export function publicMenuId(restaurantId: string, locationId: string): string {
  // Una concatenación con «_» confunde [a_b, c] con [a, b_c].
  return sha256Hex(JSON.stringify([restaurantId, locationId]))
}

export const PublicMenuCategorySchema = z.object({
  id: DocIdSchema,
  name: menuTextSchema(60),
  description: optionalMenuTextSchema(200),
  sortOrder: z.number().int(),
})

export const PublicMenuItemSchema = z.object({
  id: DocIdSchema,
  categoryId: DocIdSchema,
  name: menuTextSchema(80),
  description: optionalMenuTextSchema(400),
  sortOrder: z.number().int(),
  priceCents: PriceCentsSchema,
  variants: z.array(VariantSchema),
  modifierGroups: z.array(ModifierGroupSchema),
  allergens: z.array(AllergenSchema),
  traces: z.array(AllergenSchema),
  dietary: z.array(DietaryTagSchema),
  photoPath: z.string().max(300).nullable(),
  soldOut: z.boolean(),
  featured: z.boolean().optional(),
  allergensReviewed: z.boolean().optional(),
  selfOrder: z.boolean(),
  takeaway: z.boolean(),
  /** Siempre true (solo se publican los activos); está para cumplir `CatalogItem`. */
  active: z.boolean(),
  version: z.number().int().min(1),
})
export type PublicMenuItem = z.infer<typeof PublicMenuItemSchema>

export const PublicDailyMenuSchema = z.object({
  id: DocIdSchema,
  name: menuTextSchema(80),
  description: optionalMenuTextSchema(400),
  includes: optionalMenuTextSchema(200),
  priceCents: PriceCentsSchema,
  days: z.array(z.enum(WEEKDAYS)),
  from: HoraSchema,
  to: HoraSchema,
  sections: z.array(DailyMenuSectionSchema),
  sortOrder: z.number().int(),
  selfOrder: z.boolean(),
  takeaway: z.boolean(),
  active: z.boolean(),
  version: z.number().int().min(1),
})
export type PublicDailyMenu = z.infer<typeof PublicDailyMenuSchema>

export const PublicMenuSchema = z.object({
  restaurantId: DocIdSchema,
  locationId: DocIdSchema,
  restaurantName: z.string().max(80),
  locationName: z.string().max(80),
  brandColor: HexColorSchema,
  timezone: ZonaHorariaSchema,
  currency: z.literal("EUR"),
  categories: z.array(PublicMenuCategorySchema),
  items: z.array(PublicMenuItemSchema),
  dailyMenus: z.array(PublicDailyMenuSchema),
  selfOrder: z.object({ enabled: z.boolean(), requireApproval: z.boolean(), callWaiter: z.boolean(), requestBill: z.boolean() }),
  takeaway: z.object({ enabled: z.boolean() }),
})
export type PublicMenu = z.infer<typeof PublicMenuSchema>

export interface PublicMenuSource {
  restaurantId: string
  locationId: string
  restaurantName: string
  locationName: string
  brandColor: string
  timezone: string
  categories: Readonly<Record<string, MenuCategory>>
  items: Readonly<Record<string, MenuItem>>
  dailyMenus: Readonly<Record<string, DailyMenu>>
  settings: FloorSettings
  /** Si el módulo `floor` está activo: sin él, la carta se publica pero no se puede pedir. */
  floorModule: boolean
}

const porOrden = <T extends { sortOrder: number; id: string }>(a: T, b: T) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)

/**
 * Construye la carta pública: solo categorías activas con platos activos, y menús del día
 * activos con las opciones cuyos platos siguen activos (las secciones que se quedan sin
 * opciones sacan el menú entero).
 */
export function buildPublicMenu(src: PublicMenuSource): PublicMenu {
  const categorias = Object.entries(src.categories)
    .filter(([, c]) => c.active)
    .map(([id, c]) => ({ id, name: c.name, description: c.description, sortOrder: c.sortOrder }))
    .sort(porOrden)
  const visibles = new Set(categorias.map((c) => c.id))
  const items: PublicMenuItem[] = Object.entries(src.items)
    .filter(([, i]) => i.active && visibles.has(i.categoryId))
    .map(([id, i]) => ({
      id,
      categoryId: i.categoryId,
      name: i.name,
      description: i.description,
      sortOrder: i.sortOrder,
      priceCents: i.priceCents,
      variants: i.variants,
      modifierGroups: i.modifierGroups,
      allergens: i.allergens,
      traces: i.traces,
      dietary: i.dietary,
      photoPath: i.photoPath,
      soldOut: i.soldOut,
      featured: i.featured ?? false,
      allergensReviewed: i.allergensReviewed ?? false,
      selfOrder: i.selfOrder,
      takeaway: i.takeaway,
      active: true,
      version: i.version,
    }))
    .sort(porOrden)
  // Los platos de un menú del día pueden no estar en la carta (solo del menú): basta que estén activos.
  const activos = new Set(Object.entries(src.items).filter(([, i]) => i.active).map(([id]) => id))
  const menus: PublicDailyMenu[] = []
  for (const [id, m] of Object.entries(src.dailyMenus)) {
    if (!m.active) continue
    const sections = m.sections.map((s) => ({ ...s, choices: s.choices.filter((c) => activos.has(c.itemId)) }))
    if (sections.some((s) => s.choices.length === 0 || s.choices.length < s.min)) continue
    menus.push({
      id,
      name: m.name,
      description: m.description,
      includes: m.includes,
      priceCents: m.priceCents,
      days: m.days,
      from: m.from,
      to: m.to,
      sections,
      sortOrder: m.sortOrder,
      selfOrder: m.selfOrder,
      takeaway: m.takeaway,
      active: true,
      version: m.version,
    })
  }
  menus.sort(porOrden)
  // Los platos que solo salen en un menú hacen falta para calcular su precio y alérgenos.
  const enCarta = new Set(items.map((i) => i.id))
  for (const m of menus) {
    for (const s of m.sections) {
      for (const c of s.choices) {
        const i = src.items[c.itemId]
        if (!i || enCarta.has(c.itemId)) continue
        enCarta.add(c.itemId)
        items.push({
          id: c.itemId,
          categoryId: i.categoryId,
          name: i.name,
          description: i.description,
          sortOrder: i.sortOrder,
          priceCents: i.priceCents,
          variants: i.variants,
          modifierGroups: i.modifierGroups,
          allergens: i.allergens,
          traces: i.traces,
          dietary: i.dietary,
          photoPath: i.photoPath,
          soldOut: i.soldOut,
      featured: i.featured ?? false,
      allergensReviewed: i.allergensReviewed ?? false,
          // Fuera de su menú no se puede pedir: su categoría está oculta.
          selfOrder: false,
          takeaway: false,
          active: true,
          version: i.version,
        })
      }
    }
  }
  const s = src.settings
  return {
    restaurantId: src.restaurantId,
    locationId: src.locationId,
    restaurantName: src.restaurantName,
    locationName: src.locationName,
    brandColor: src.brandColor,
    timezone: src.timezone,
    currency: "EUR",
    categories: categorias,
    items,
    dailyMenus: menus,
    selfOrder: {
      enabled: src.floorModule && s.selfOrder.enabled,
      requireApproval: s.selfOrder.requireApproval,
      callWaiter: src.floorModule && s.selfOrder.callWaiter,
      requestBill: src.floorModule && s.selfOrder.requestBill,
    },
    takeaway: { enabled: src.floorModule && s.takeaway.enabled && s.takeaway.publicOrdering },
  }
}

/** La carta pública como `Catalog`, para calcular el total en el navegador con `priceOrder`. */
export function publicMenuCatalog(menu: Pick<PublicMenu, "items" | "dailyMenus">): Catalog {
  return {
    items: Object.fromEntries(menu.items.map((i) => [i.id, i])),
    dailyMenus: Object.fromEntries(menu.dailyMenus.map((m) => [m.id, m])),
  }
}

/** Platos de la carta pública por categoría, en orden (los que solo son de un menú no salen). */
export function publicMenuSections(menu: Pick<PublicMenu, "categories" | "items">): { category: PublicMenu["categories"][number]; items: PublicMenuItem[] }[] {
  return menu.categories
    .map((category) => ({ category, items: menu.items.filter((i) => i.categoryId === category.id) }))
    .filter((s) => s.items.length > 0)
}
