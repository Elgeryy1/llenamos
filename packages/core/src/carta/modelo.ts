/**
 * Carta de un local (fase 2): categorías, platos, menú del día y estaciones de cocina.
 *
 * restaurants/{rid}/locations/{lid}
 *   menuCategories/{cid}     categorías ("Para compartir", "Principales"…)
 *   menuItems/{iid}          platos y bebidas, con variantes, extras y alérgenos
 *   dailyMenus/{mid}         menús de precio cerrado (menú del día)
 *   stations/{sid}           estaciones: cocina, barra, postres…
 *
 * Todo lo escribe el servidor (callables de la carta); el personal lo lee. Cada local tiene
 * su carta: un grupo con varios locales la copia (eso no lo hace la fase 2).
 *
 * Dinero siempre en céntimos enteros, con el IVA incluido (como se enseña en España).
 */
import { z } from "zod"
import { DocIdSchema } from "../model"
import { WEEKDAYS } from "../reservation-settings"
import { HoraSchema } from "../reservas/tiempo"
import { menuTextSchema, optionalMenuTextSchema } from "./textos"

/* Piezas comunes ------------------------------------------------------------- */

/** Precio en céntimos: de 0 a 100 000 €. */
export const PriceCentsSchema = z
  .number()
  .int("El precio va en céntimos enteros.")
  .min(0, "El precio no puede ser negativo.")
  .max(10_000_000, "Precio demasiado alto.")

/** Id de una pieza dentro de un documento (variante, grupo de extras, opción, sección). */
export const PartIdSchema = z.string().regex(/^[a-z0-9_-]{1,40}$/, "Id no válido: minúsculas, cifras, guiones.")

function sinRepetidos<T>(lista: readonly T[], clave: (x: T) => string): boolean {
  return new Set(lista.map(clave)).size === lista.length
}

/* Alérgenos (Reglamento UE 1169/2011, anexo II) ------------------------------ */

/** Los 14 alérgenos de declaración obligatoria, en el orden del anexo II. */
export const ALLERGENS = [
  "gluten",
  "crustaceans",
  "eggs",
  "fish",
  "peanuts",
  "soy",
  "milk",
  "nuts",
  "celery",
  "mustard",
  "sesame",
  "sulphites",
  "lupin",
  "molluscs",
] as const
export type Allergen = (typeof ALLERGENS)[number]
export const AllergenSchema = z.enum(ALLERGENS)

const AllergenListSchema = z
  .array(AllergenSchema)
  .max(ALLERGENS.length)
  .refine((l) => new Set(l).size === l.length, "Hay alérgenos repetidos.")
  .default([])

export const DIETARY_TAGS = ["vegetarian", "vegan"] as const
export type DietaryTag = (typeof DIETARY_TAGS)[number]
export const DietaryTagSchema = z.enum(DIETARY_TAGS)

/* Pases ------------------------------------------------------------------------ */

/**
 * Pases del servicio, en orden: las bebidas salen siempre al momento; primeros, segundos y
 * postres salen por turno (ver `cocina/pases.ts`).
 */
export const COURSES = ["drinks", "first", "second", "dessert"] as const
export type Course = (typeof COURSES)[number]
export const CourseSchema = z.enum(COURSES)

/** Posición de un pase: menor sale antes. */
export function courseRank(course: Course): number {
  return COURSES.indexOf(course)
}

export function isFoodCourse(course: Course): boolean {
  return course !== "drinks"
}

/** Tipos de IVA de España. Lo usa la caja (fase 3); en la fase 2 solo se guarda. */
export const TAX_RATES = [0, 4, 10, 21] as const
export const TaxRateSchema = z.union([z.literal(0), z.literal(4), z.literal(10), z.literal(21)])
export type TaxRate = z.infer<typeof TaxRateSchema>

/* Categorías ------------------------------------------------------------------ */

export const MenuCategorySchema = z.object({
  name: menuTextSchema(60),
  description: optionalMenuTextSchema(200),
  sortOrder: z.number().int(),
  /** false = oculta en la carta (no se borra para no romper pedidos viejos). */
  active: z.boolean(),
})
export type MenuCategory = z.infer<typeof MenuCategorySchema>

/* Platos ------------------------------------------------------------------------ */

/**
 * Variante de un plato (tapa, media, ración; copa o botella). Si un plato tiene variantes,
 * elegir una es obligatorio y su precio **sustituye** al precio base.
 */
export const VariantSchema = z.object({
  soldOut: z.boolean().optional(),
  id: PartIdSchema,
  name: menuTextSchema(40),
  priceCents: PriceCentsSchema,
})
export type Variant = z.infer<typeof VariantSchema>

/** Una opción de un grupo de extras: suma su precio (puede ser 0) y sus alérgenos. */
export const ModifierOptionSchema = z.object({
  id: PartIdSchema,
  name: menuTextSchema(60),
  priceCents: PriceCentsSchema,
  allergens: AllergenListSchema,
  soldOut: z.boolean().default(false),
})
export type ModifierOption = z.infer<typeof ModifierOptionSchema>

/**
 * Grupo de extras u opciones ("Punto de la carne", "Añade algo"). Se eligen entre `min` y
 * `max` opciones distintas; `min` ≥ 1 lo hace obligatorio. Cada opción, como mucho una vez.
 */
export const ModifierGroupSchema = z
  .object({
    id: PartIdSchema,
    name: menuTextSchema(60),
    min: z.number().int().min(0).max(20),
    max: z.number().int().min(1).max(20),
    options: z.array(ModifierOptionSchema).min(1, "Añade al menos una opción.").max(30),
  })
  .refine((g) => g.min <= g.max, { message: "El mínimo no puede ser mayor que el máximo.", path: ["min"] })
  .refine((g) => g.max <= g.options.length, { message: "El máximo no puede pasar del número de opciones.", path: ["max"] })
  .refine((g) => sinRepetidos(g.options, (o) => o.id), { message: "Hay opciones con el mismo id.", path: ["options"] })
export type ModifierGroup = z.infer<typeof ModifierGroupSchema>

/** Lo que el personal escribe de un plato (la entrada de `guardarPlato`). */
export const MenuItemEditableSchema = z
  .object({
    categoryId: DocIdSchema,
    name: menuTextSchema(80),
    description: optionalMenuTextSchema(400),
    sortOrder: z.number().int(),
    /** Precio sin variantes. Con variantes no se usa (manda el de cada variante). */
    priceCents: PriceCentsSchema,
    variants: z.array(VariantSchema).max(10).default([]),
    modifierGroups: z.array(ModifierGroupSchema).max(10).default([]),
    featured: z.boolean().optional(),
    allergensReviewed: z.boolean().optional(),
    allergens: AllergenListSchema,
    /** «Puede contener trazas de». */
    traces: AllergenListSchema,
    dietary: z.array(DietaryTagSchema).max(DIETARY_TAGS.length).default([]),
    /** Ruta en Storage: `restaurants/{rid}/locations/{lid}/menu/{itemId}/{archivo}`, o null. */
    photoPath: z.string().max(300).regex(/^restaurants\/[^/]+\/locations\/[^/]+\/menu\/[^/]+\/[^/]+$/, "Ruta de foto no válida.").nullable().default(null),
    /** Pase por defecto. El camarero lo puede cambiar en una línea. */
    course: CourseSchema,
    /** Estación que lo prepara; null = la estación por defecto de los ajustes de sala. */
    stationId: DocIdSchema.nullable().default(null),
    /** Minutos de preparación objetivo; null = los de su estación. */
    prepMinutes: z.number().int().min(1).max(240).nullable().default(null),
    taxRate: TaxRateSchema.default(10),
    /** Se puede pedir desde la mesa con el QR. */
    selfOrder: z.boolean().default(true),
    /** Se puede pedir para llevar. */
    takeaway: z.boolean().default(false),
    /** false = retirado de la carta. */
    active: z.boolean().default(true),
  })
  .refine((i) => sinRepetidos(i.variants, (v) => v.id), { message: "Hay variantes con el mismo id.", path: ["variants"] })
  .refine((i) => sinRepetidos(i.modifierGroups, (g) => g.id), { message: "Hay grupos de extras con el mismo id.", path: ["modifierGroups"] })
  // La entrada del pedido identifica la opción sin grupo: el id debe ser único en el plato.
  .refine((i) => sinRepetidos(i.modifierGroups.flatMap((g) => g.options), (o) => o.id), { message: "Hay opciones con el mismo id en distintos grupos.", path: ["modifierGroups"] })
export type MenuItemEditable = z.infer<typeof MenuItemEditableSchema>

/** `menuItems/{iid}` tal como se guarda: lo editable más lo que pone el servidor. */
export const MenuItemSchema = MenuItemEditableSchema.and(
  z.object({
    /** Agotado (lo cambia `marcarAgotado`, también la cocina). */
    soldOut: z.boolean(),
    /**
     * Versión del precio: empieza en 1 y el servidor la sube cuando cambia algo que afecta
     * al precio (precio, variantes, extras). Cada línea de pedido guarda la versión y el
     * precio con el que se pidió, así un cambio de carta no toca lo ya pedido.
     */
    version: z.number().int().min(1),
    /** Recuento manual diario. null = sin límite. No se repone automáticamente ni al anular. */
    portions: z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      remaining: z.number().int().min(0).max(9999).nullable(),
      variants: z.record(z.string(), z.number().int().min(0).max(9999)),
    }).nullable().optional(),
    updatedBy: z.string().nullish(),
  }),
)
export type MenuItem = z.infer<typeof MenuItemSchema>

/* Menú del día ----------------------------------------------------------------- */

/** Un plato que se puede elegir en una sección del menú, con su suplemento. */
export const DailyMenuChoiceSchema = z.object({
  itemId: DocIdSchema,
  /** Variante fija dentro del menú (p. ej. «media ración»), o null. */
  variantId: PartIdSchema.nullable().default(null),
  supplementCents: PriceCentsSchema.default(0),
})
export type DailyMenuChoice = z.infer<typeof DailyMenuChoiceSchema>

/** Sección del menú ("Primeros: a elegir uno"). */
export const DailyMenuSectionSchema = z
  .object({
    id: PartIdSchema,
    name: menuTextSchema(40),
    course: CourseSchema,
    min: z.number().int().min(0).max(5),
    max: z.number().int().min(1).max(5),
    choices: z.array(DailyMenuChoiceSchema).min(1).max(30),
  })
  .refine((s) => s.min <= s.max, { message: "El mínimo no puede ser mayor que el máximo.", path: ["min"] })
  .refine((s) => sinRepetidos(s.choices, (c) => `${c.itemId}:${c.variantId ?? ""}`), { message: "Hay platos repetidos.", path: ["choices"] })
export type DailyMenuSection = z.infer<typeof DailyMenuSectionSchema>

export const DailyMenuEditableSchema = z
  .object({
    name: menuTextSchema(80),
    description: optionalMenuTextSchema(400),
    /** Lo que incluye además ("pan, bebida y postre o café"). */
    includes: optionalMenuTextSchema(200),
    priceCents: PriceCentsSchema,
    /** Días en los que se ofrece. */
    days: z
      .array(z.enum(WEEKDAYS))
      .min(1, "Elige al menos un día.")
      .refine((d) => new Set(d).size === d.length, "Hay días repetidos."),
    /** Horas de pared del local; si `to` < `from`, cruza la medianoche. */
    from: HoraSchema,
    to: HoraSchema,
    sections: z.array(DailyMenuSectionSchema).min(1).max(8),
    sortOrder: z.number().int().default(0),
    taxRate: TaxRateSchema.default(10),
    selfOrder: z.boolean().default(true),
    takeaway: z.boolean().default(false),
    active: z.boolean().default(true),
  })
  .refine((m) => sinRepetidos(m.sections, (s) => s.id), { message: "Hay secciones con el mismo id.", path: ["sections"] })
export type DailyMenuEditable = z.infer<typeof DailyMenuEditableSchema>

export const DailyMenuSchema = DailyMenuEditableSchema.and(
  z.object({ version: z.number().int().min(1), updatedBy: z.string().nullish() }),
)
export type DailyMenu = z.infer<typeof DailyMenuSchema>

/* Estaciones -------------------------------------------------------------------- */

/** Tipo de estación: decide qué rol la trabaja (`cocina.preparar` o `barra.preparar`). */
export const STATION_KINDS = ["kitchen", "bar"] as const
export type StationKind = (typeof STATION_KINDS)[number]
export const StationKindSchema = z.enum(STATION_KINDS)

export const STATION_KIND_LABEL: Record<StationKind, string> = { kitchen: "cocina", bar: "barra" }

export const StationSchema = z.object({
  name: z.string().trim().min(1).max(40),
  kind: StationKindSchema,
  sortOrder: z.number().int(),
  /** Minutos objetivo de una línea desde que se marcha hasta que está lista. */
  targetMinutes: z.number().int().min(1).max(240),
  /** Lo listo espera a que la sala lo recoja (crea una tarea «recoger»). false = lo sirve la propia estación. */
  pickup: z.boolean(),
  active: z.boolean(),
})
export type Station = z.infer<typeof StationSchema>

/* Versiones de precio --------------------------------------------------------- */

type ConPrecio = Pick<MenuItemEditable, "priceCents" | "variants" | "modifierGroups"> & { taxRate?: TaxRate }

/** Huella de lo que afecta al precio de un plato. Dos huellas iguales = mismo precio. */
export function itemPriceSignature(item: ConPrecio): string {
  return JSON.stringify([
    item.priceCents,
    item.taxRate ?? null,
    item.variants.map((v) => [v.id, v.priceCents]),
    item.modifierGroups.map((g) => [g.id, g.min, g.max, g.options.map((o) => [o.id, o.priceCents])]),
  ])
}

/** Versión que lleva un plato al guardarlo: 1 si es nuevo; +1 si cambia el precio. */
export function nextItemVersion(previous: (ConPrecio & { version: number }) | null, next: ConPrecio): number {
  if (!previous) return 1
  return itemPriceSignature(previous) === itemPriceSignature(next) ? previous.version : previous.version + 1
}

type MenuConPrecio = Pick<DailyMenuEditable, "priceCents" | "sections"> & { taxRate?: TaxRate }

export function dailyMenuPriceSignature(menu: MenuConPrecio): string {
  return JSON.stringify([
    menu.priceCents,
    menu.taxRate ?? null,
    menu.sections.map((s) => [s.id, s.min, s.max, s.choices.map((c) => [c.itemId, c.variantId, c.supplementCents])]),
  ])
}

export function nextDailyMenuVersion(previous: (MenuConPrecio & { version: number }) | null, next: MenuConPrecio): number {
  if (!previous) return 1
  return dailyMenuPriceSignature(previous) === dailyMenuPriceSignature(next) ? previous.version : previous.version + 1
}

/** Precio que se enseña en la carta: el base, o el de la variante más barata («desde»). */
export function displayPrice(item: Pick<MenuItemEditable, "priceCents" | "variants">): { priceCents: number; from: boolean } {
  if (item.variants.length === 0) return { priceCents: item.priceCents, from: false }
  const disponibles = item.variants.filter((v) => !v.soldOut)
  const precios = (disponibles.length ? disponibles : item.variants).map((v) => v.priceCents)
  const min = Math.min(...precios)
  return { priceCents: min, from: precios.some((p) => p !== min) }
}

/** Alérgenos de un plato con los extras elegidos (los del plato más los de las opciones). */
export function allergensWith(item: Pick<MenuItemEditable, "allergens" | "modifierGroups">, optionIds: readonly string[] = []): Allergen[] {
  const set = new Set<Allergen>(item.allergens)
  for (const g of item.modifierGroups) for (const o of g.options) if (optionIds.includes(o.id)) for (const a of o.allergens) set.add(a)
  return ALLERGENS.filter((a) => set.has(a))
}
