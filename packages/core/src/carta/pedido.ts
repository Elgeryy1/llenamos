/**
 * Validar un pedido contra la carta y calcular su precio, en céntimos.
 *
 * Es la misma función en el navegador (para enseñar el total mientras se pide) y en el
 * servidor (que **siempre** recalcula: lo que manda el móvil no se cree). Lee solo lo que
 * necesita de la carta (`CatalogItem`, `CatalogMenu`), que cumplen tanto los documentos
 * de Firestore como la carta pública (`publicMenus`).
 *
 * Precio de una línea:
 * - plato: (precio de la variante, o el base si no tiene) + extras elegidos; × cantidad.
 * - menú del día: precio del menú + suplementos de los platos elegidos + sus extras; × cantidad.
 *   Dentro del menú las variantes no cobran (las cubre el precio del menú).
 */
import { z } from "zod"
import { assertCents } from "../money"
import { DocIdSchema, type Language } from "../model"
import { DIA_TO_WEEKDAY } from "../adapters"
import type { Weekday } from "../reservation-settings"
import { diaSemana, horaAMinutos, horaLocal, sumarDias } from "../reservas/tiempo"
import { CourseSchema, PartIdSchema, type Course, type DailyMenuEditable, type MenuItemEditable } from "./modelo"
import type { MenuText } from "./textos"

/* Entrada: líneas tal como las manda el comandero, la mesa o la web de para llevar -------- */

export const MAX_ORDER_LINES = 50
export const MAX_LINE_QUANTITY = 99

const QuantitySchema = z.number().int("Cantidad no válida.").min(1, "Al menos 1.").max(MAX_LINE_QUANTITY, `Como mucho ${MAX_LINE_QUANTITY}.`)
export const LineNotesSchema = z.string().trim().max(140, "Como mucho 140 caracteres.").default("")
const OptionIdsSchema = z.array(PartIdSchema).max(30).default([])
/** Comensal al que va la línea (para repartir la cuenta en la fase 3), o null. */
const GuestNumberSchema = z.number().int().min(1).max(50).nullable().default(null)

export const ItemLineInputSchema = z.strictObject({
  kind: z.literal("item"),
  itemId: DocIdSchema,
  variantId: PartIdSchema.nullable().default(null),
  optionIds: OptionIdsSchema,
  quantity: QuantitySchema,
  notes: LineNotesSchema,
  guest: GuestNumberSchema,
  /** Solo el personal: cambiar el pase de esta línea (un entrante que va de segundo). */
  course: CourseSchema.optional(),
})

export const MenuSelectionInputSchema = z.strictObject({
  sectionId: PartIdSchema,
  itemId: DocIdSchema,
  /** Si la opción del menú no fija variante y el plato tiene, se elige aquí. */
  variantId: PartIdSchema.nullable().default(null),
  optionIds: OptionIdsSchema,
  notes: LineNotesSchema,
})

export const MenuLineInputSchema = z.strictObject({
  kind: z.literal("menu"),
  dailyMenuId: DocIdSchema,
  quantity: QuantitySchema,
  notes: LineNotesSchema,
  guest: GuestNumberSchema,
  selections: z.array(MenuSelectionInputSchema).min(1).max(20),
})

export const OrderLineInputSchema = z.discriminatedUnion("kind", [ItemLineInputSchema, MenuLineInputSchema])
export type OrderLineInput = z.output<typeof OrderLineInputSchema>

/** Lo mismo sin `course`: la mesa y la web de para llevar no cambian pases. */
export const PublicOrderLineInputSchema = z.discriminatedUnion("kind", [ItemLineInputSchema.omit({ course: true }), MenuLineInputSchema])

export const OrderLinesInputSchema = z.array(OrderLineInputSchema).min(1, "El pedido está vacío.").max(MAX_ORDER_LINES, `Como mucho ${MAX_ORDER_LINES} líneas.`)
export const PublicOrderLinesInputSchema = z.array(PublicOrderLineInputSchema).min(1, "El pedido está vacío.").max(MAX_ORDER_LINES, `Como mucho ${MAX_ORDER_LINES} líneas.`)

/* La carta que hace falta ----------------------------------------------------------------- */

/** Desde dónde se pide: el personal puede pedir todo lo activo; la mesa y para llevar, lo marcado. */
export const ORDER_CHANNELS = ["staff", "table", "takeaway"] as const
export type OrderChannel = (typeof ORDER_CHANNELS)[number]

export type CatalogItem = Pick<
  MenuItemEditable,
  "name" | "priceCents" | "variants" | "modifierGroups" | "selfOrder" | "takeaway" | "active"
> & { soldOut: boolean; version: number }

export type CatalogMenu = Pick<
  DailyMenuEditable,
  "name" | "priceCents" | "days" | "from" | "to" | "sections" | "selfOrder" | "takeaway" | "active"
> & { version: number }

export interface Catalog {
  items: Readonly<Record<string, CatalogItem | undefined>>
  dailyMenus: Readonly<Record<string, CatalogMenu | undefined>>
}

export interface PriceContext {
  channel: OrderChannel
  /** ms UTC: para saber si el menú del día se sirve ahora. */
  now: number
  timezone: string
  /** Total que ha visto quien pide. Si no coincide con el recalculado: `price_changed`. */
  expectedTotalCents?: number | null
}

/* Salida ------------------------------------------------------------------------------- */

export interface PricedModifier {
  groupId: string
  optionId: string
  name: MenuText
  priceCents: number
}

export interface PricedVariant {
  id: string
  name: MenuText
  priceCents: number
}

/** Un plato elegido dentro de un menú del día. */
export interface PricedComponent {
  sectionId: string
  /** El pase de la sección. */
  course: Course
  itemId: string
  itemVersion: number
  name: MenuText
  variant: PricedVariant | null
  modifiers: PricedModifier[]
  /** Suplemento + extras, por unidad de menú. */
  unitPriceCents: number
  notes: string
}

export interface PricedLine {
  /** Posición en la entrada. */
  index: number
  kind: "item" | "menu"
  itemId: string | null
  dailyMenuId: string | null
  /** Versión del plato o del menú con la que se ha calculado. */
  version: number
  name: MenuText
  variant: PricedVariant | null
  modifiers: PricedModifier[]
  quantity: number
  /** En un menú: el precio del menú más todos los suplementos y extras. */
  unitPriceCents: number
  totalCents: number
  notes: string
  guest: number | null
  /** Pase pedido a mano (solo personal), o null para el de la carta. */
  courseOverride: Course | null
  /** Solo en menús. */
  components: PricedComponent[]
}

export const ORDER_PROBLEM_CODES = [
  "item_not_found",
  "item_inactive",
  "item_sold_out",
  "item_not_available_here",
  "variant_required",
  "variant_not_found",
  "variant_not_expected",
  "option_not_found",
  "option_duplicate",
  "option_sold_out",
  "group_min",
  "group_max",
  "menu_not_found",
  "menu_inactive",
  "menu_not_available_now",
  "menu_not_available_here",
  "section_not_found",
  "section_min",
  "section_max",
  "choice_not_allowed",
  "price_changed",
  "pickup_unavailable",
] as const
export type OrderProblemCode = (typeof ORDER_PROBLEM_CODES)[number]
export const OrderProblemCodeSchema = z.enum(ORDER_PROBLEM_CODES)

/** Un problema del pedido: en qué línea (y en qué plato del menú) y qué pasa. */
export const OrderProblemSchema = z.object({
  /** Posición de la línea en la entrada, o null si es del pedido entero. */
  line: z.number().int().min(0).nullable(),
  /** Posición de la elección dentro del menú, o null. */
  selection: z.number().int().min(0).nullable(),
  code: OrderProblemCodeSchema,
  /** Plato, grupo, opción o sección afectados, para marcarlo en pantalla. */
  ref: z.string().nullable(),
})
export type OrderProblem = z.infer<typeof OrderProblemSchema>

export type PriceResult =
  | { ok: true; lines: PricedLine[]; totalCents: number }
  | { ok: false; problems: OrderProblem[]; lines: PricedLine[]; totalCents: number }

/* Menú del día: ¿se sirve ahora? ------------------------------------------------------------ */

/**
 * Si un menú del día se sirve en un instante, en la hora del local. Un tramo que cruza la
 * medianoche (`to` < `from`) pertenece al día en que empieza, como los turnos.
 */
export function isDailyMenuAvailable(menu: Pick<CatalogMenu, "active" | "days" | "from" | "to">, now: number, timezone: string): boolean {
  if (!menu.active) return false
  const local = horaLocal(now, timezone)
  const desde = horaAMinutos(menu.from)
  const hasta = horaAMinutos(menu.to)
  const dia = (fecha: string): Weekday => DIA_TO_WEEKDAY[diaSemana(fecha)]
  if (hasta >= desde) return menu.days.includes(dia(local.fecha)) && local.minutos >= desde && local.minutos <= hasta
  // Cruza la medianoche: o es la parte de hoy (desde → 24:00) o la de ayer (00:00 → hasta).
  if (local.minutos >= desde) return menu.days.includes(dia(local.fecha))
  return local.minutos <= hasta && menu.days.includes(dia(sumarDias(local.fecha, -1)))
}

/* Cálculo ---------------------------------------------------------------------------------- */

function disponibleEn(cosa: { selfOrder: boolean; takeaway: boolean }, channel: OrderChannel): boolean {
  if (channel === "staff") return true
  return channel === "table" ? cosa.selfOrder : cosa.takeaway
}

interface Ctx {
  line: number
  selection: number | null
  problems: OrderProblem[]
}

function problema(ctx: Ctx, code: OrderProblemCode, ref: string | null): void {
  ctx.problems.push({ line: ctx.line, selection: ctx.selection, code, ref })
}

/** Comprueba y calcula los extras de un plato. Devuelve los elegidos y su suma por unidad. */
function precioExtras(item: CatalogItem, itemId: string, optionIds: readonly string[], ctx: Ctx): { modifiers: PricedModifier[]; cents: number } {
  const modifiers: PricedModifier[] = []
  const vistos = new Set<string>()
  for (const optionId of optionIds) {
    if (vistos.has(optionId)) {
      problema(ctx, "option_duplicate", optionId)
      continue
    }
    vistos.add(optionId)
    const grupo = item.modifierGroups.find((g) => g.options.some((o) => o.id === optionId))
    const opcion = grupo?.options.find((o) => o.id === optionId)
    if (!grupo || !opcion) {
      problema(ctx, "option_not_found", `${itemId}:${optionId}`)
      continue
    }
    if (opcion.soldOut) problema(ctx, "option_sold_out", `${itemId}:${optionId}`)
    modifiers.push({ groupId: grupo.id, optionId: opcion.id, name: opcion.name, priceCents: opcion.priceCents })
  }
  for (const g of item.modifierGroups) {
    const n = modifiers.filter((m) => m.groupId === g.id).length
    if (n < g.min) problema(ctx, "group_min", `${itemId}:${g.id}`)
    if (n > g.max) problema(ctx, "group_max", `${itemId}:${g.id}`)
  }
  // Orden estable: el de la carta, no el del toque en pantalla.
  const orden = (m: PricedModifier) => {
    const gi = item.modifierGroups.findIndex((g) => g.id === m.groupId)
    const oi = item.modifierGroups[gi]?.options.findIndex((o) => o.id === m.optionId) ?? 0
    return gi * 100 + oi
  }
  modifiers.sort((a, b) => orden(a) - orden(b))
  return { modifiers, cents: modifiers.reduce((s, m) => s + m.priceCents, 0) }
}

function comprobarPlato(item: CatalogItem | undefined, itemId: string, channel: OrderChannel, ctx: Ctx): item is CatalogItem {
  if (!item) {
    problema(ctx, "item_not_found", itemId)
    return false
  }
  if (!item.active) problema(ctx, "item_inactive", itemId)
  else if (item.soldOut) problema(ctx, "item_sold_out", itemId)
  return true
}

function precioLineaPlato(line: Extract<OrderLineInput, { kind: "item" }>, catalog: Catalog, context: PriceContext, ctx: Ctx): PricedLine | null {
  const item = catalog.items[line.itemId]
  if (!comprobarPlato(item, line.itemId, context.channel, ctx)) return null
  if (item.active && !disponibleEn(item, context.channel)) problema(ctx, "item_not_available_here", line.itemId)
  let variant: PricedVariant | null = null
  if (item.variants.length > 0) {
    if (line.variantId === null) problema(ctx, "variant_required", line.itemId)
    else {
      const v = item.variants.find((x) => x.id === line.variantId)
      if (!v) problema(ctx, "variant_not_found", `${line.itemId}:${line.variantId}`)
      else {
        if (v.soldOut) problema(ctx, "item_sold_out", `${line.itemId}:${v.id}`)
        variant = { id: v.id, name: v.name, priceCents: v.priceCents }
      }
    }
  } else if (line.variantId !== null) problema(ctx, "variant_not_expected", `${line.itemId}:${line.variantId}`)
  const extras = precioExtras(item, line.itemId, line.optionIds, ctx)
  const unit = (variant?.priceCents ?? item.priceCents) + extras.cents
  return {
    index: ctx.line,
    kind: "item",
    itemId: line.itemId,
    dailyMenuId: null,
    version: item.version,
    name: item.name,
    variant,
    modifiers: extras.modifiers,
    quantity: line.quantity,
    unitPriceCents: assertCents(unit),
    totalCents: assertCents(unit * line.quantity),
    notes: line.notes,
    guest: line.guest,
    courseOverride: line.course ?? null,
    components: [],
  }
}

function precioLineaMenu(line: Extract<OrderLineInput, { kind: "menu" }>, catalog: Catalog, context: PriceContext, ctx: Ctx): PricedLine | null {
  const menu = catalog.dailyMenus[line.dailyMenuId]
  if (!menu) {
    problema(ctx, "menu_not_found", line.dailyMenuId)
    return null
  }
  if (!menu.active) problema(ctx, "menu_inactive", line.dailyMenuId)
  else if (!isDailyMenuAvailable(menu, context.now, context.timezone)) problema(ctx, "menu_not_available_now", line.dailyMenuId)
  if (menu.active && !disponibleEn(menu, context.channel)) problema(ctx, "menu_not_available_here", line.dailyMenuId)

  const components: PricedComponent[] = []
  line.selections.forEach((sel, i) => {
    const sctx: Ctx = { line: ctx.line, selection: i, problems: ctx.problems }
    const seccion = menu.sections.find((s) => s.id === sel.sectionId)
    if (!seccion) return problema(sctx, "section_not_found", sel.sectionId)
    const opciones = seccion.choices.filter((c) => c.itemId === sel.itemId)
    if (opciones.length === 0) return problema(sctx, "choice_not_allowed", `${sel.sectionId}:${sel.itemId}`)
    const item = catalog.items[sel.itemId]
    if (!comprobarPlato(item, sel.itemId, "staff", sctx)) return
    // La variante: la fija la opción del menú; si no, la elige quien pide (si el plato tiene).
    const fija = opciones.find((c) => c.variantId !== null && (sel.variantId === null || c.variantId === sel.variantId))
    const libre = opciones.find((c) => c.variantId === null)
    const choice = fija ?? libre
    if (!choice) return problema(sctx, "choice_not_allowed", `${sel.sectionId}:${sel.itemId}:${sel.variantId ?? ""}`)
    const variantId = choice.variantId ?? sel.variantId
    let variant: PricedVariant | null = null
    if (variantId !== null) {
      const v = item.variants.find((x) => x.id === variantId)
      if (!v) problema(sctx, "variant_not_found", `${sel.itemId}:${variantId}`)
      // Dentro del menú la variante no cobra.
      else {
        if (v.soldOut) problema(sctx, "item_sold_out", `${sel.itemId}:${v.id}`)
        variant = { id: v.id, name: v.name, priceCents: 0 }
      }
    } else if (item.variants.length > 0) problema(sctx, "variant_required", sel.itemId)
    const extras = precioExtras(item, sel.itemId, sel.optionIds, sctx)
    components.push({
      sectionId: seccion.id,
      course: seccion.course,
      itemId: sel.itemId,
      itemVersion: item.version,
      name: item.name,
      variant,
      modifiers: extras.modifiers,
      unitPriceCents: assertCents(choice.supplementCents + extras.cents),
      notes: sel.notes,
    })
  })
  for (const s of menu.sections) {
    const n = line.selections.filter((x) => x.sectionId === s.id).length
    if (n < s.min) problema(ctx, "section_min", s.id)
    if (n > s.max) problema(ctx, "section_max", s.id)
  }
  const unit = menu.priceCents + components.reduce((s, c) => s + c.unitPriceCents, 0)
  return {
    index: ctx.line,
    kind: "menu",
    itemId: null,
    dailyMenuId: line.dailyMenuId,
    version: menu.version,
    name: menu.name,
    variant: null,
    modifiers: [],
    quantity: line.quantity,
    unitPriceCents: assertCents(unit),
    totalCents: assertCents(unit * line.quantity),
    notes: line.notes,
    guest: line.guest,
    courseOverride: null,
    components,
  }
}

/**
 * Valida un pedido contra la carta y calcula sus precios.
 *
 * Devuelve todas las líneas que se han podido calcular y **todos** los problemas (no se
 * para en el primero), para que la pantalla marque cada línea. Con algún problema, el
 * pedido no se guarda.
 */
export function priceOrder(lines: readonly OrderLineInput[], catalog: Catalog, context: PriceContext): PriceResult {
  const problems: OrderProblem[] = []
  const priced: PricedLine[] = []
  lines.forEach((line, i) => {
    const ctx: Ctx = { line: i, selection: null, problems }
    const r = line.kind === "item" ? precioLineaPlato(line, catalog, context, ctx) : precioLineaMenu(line, catalog, context, ctx)
    if (r) priced.push(r)
  })
  const totalCents = assertCents(priced.reduce((s, l) => s + l.totalCents, 0))
  if (problems.length === 0 && context.expectedTotalCents != null && context.expectedTotalCents !== totalCents) {
    problems.push({ line: null, selection: null, code: "price_changed", ref: null })
  }
  return problems.length === 0 ? { ok: true, lines: priced, totalCents } : { ok: false, problems, lines: priced, totalCents }
}

/** Nombre del plato tal como lo ve el cliente o la cocina, con variante: «Croquetas · media». */
export function lineDisplayName(line: { name: MenuText; variant: { name: MenuText } | null }, language: Language): string {
  const base = line.name[language].trim() || line.name.es
  if (!line.variant) return base
  return `${base} · ${line.variant.name[language].trim() || line.variant.name.es}`
}

/** Firma orientativa para exigir revisión incluso si dos cambios de precio se compensan. */
export function orderPriceSignature(lines: readonly PricedLine[]): string {
  return JSON.stringify(lines.map(l => [l.version, l.unitPriceCents, l.components.map(c => [c.itemId, c.itemVersion, c.unitPriceCents])]))
}
