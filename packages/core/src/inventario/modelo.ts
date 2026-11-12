/**
 * Inventario y costes (fase 4): documentos. Solo servidor; cantidades enteras en unidad base,
 * dinero en céntimos sin IVA, horas en ms al leer.
 */
import { z } from "zod"
import { PartIdSchema, TaxRateSchema } from "../carta/modelo"
import { DocIdSchema } from "../model"
import { FechaSchema } from "../reservas/tiempo"
import { LineStatusSchema } from "../sala/modelo"
import { TimestampSchema } from "../timestamp"
import { SignedCentsSchema } from "../caja/modelo"
import { CentsSchema, QuantitySchema, SignedQuantitySchema, UnitCostSchema } from "./coste"
import { BaseUnitSchema } from "./unidades"

const Name = z.string().trim().min(1, "Escribe un nombre.").max(80)
const Revision = z.number().int().min(1)

export const InventorySettingsSchema = z.object({
  /** Descuenta del almacén al marchar un plato con receta. Apagado: solo se registra a mano. */
  consumeOnSale: z.boolean(),
  /** Crea avisos de stock bajo. */
  lowStockAlerts: z.boolean(),
})
export type InventorySettings = z.infer<typeof InventorySettingsSchema>
export function defaultInventorySettings(): InventorySettings { return { consumeOnSale: true, lowStockAlerts: true } }

/* Ingredientes ------------------------------------------------------------------------------ */

export const IngredientEditableSchema = z.object({
  name: Name,
  /** Unidad base: no cambia una vez hay movimientos. */
  unit: BaseUnitSchema,
  category: z.string().trim().max(40).nullable(),
  /** Aviso de stock bajo cuando la cantidad llega a este nivel. 0 = sin aviso. */
  minQuantity: QuantitySchema,
  /** Hasta dónde conviene reponer al pedir. null = el doble del mínimo. */
  targetQuantity: QuantitySchema.nullable(),
  active: z.boolean(),
}).refine((v) => v.targetQuantity === null || v.targetQuantity >= v.minQuantity, { message: "El objetivo no puede ser menor que el mínimo.", path: ["targetQuantity"] })
export type IngredientEditable = z.infer<typeof IngredientEditableSchema>

/** `ingredients/{id}`: cantidad actual (solo servidor). Sin costes: cocina y barra pueden leerlo. */
export const IngredientSchema = IngredientEditableSchema.and(z.object({
  quantity: SignedQuantitySchema,
  revision: Revision,
}))
export type Ingredient = z.infer<typeof IngredientSchema>
export type IngredientWithId = Ingredient & { id: string }

/** `ingredientCosts/{id}`: valor y último coste. Solo quien ve costes. */
export const IngredientCostSchema = z.object({ valueCents: CentsSchema, lastCost: UnitCostSchema.nullable() })
export type IngredientCost = z.infer<typeof IngredientCostSchema>

/* Movimientos ------------------------------------------------------------------------------- */

export const MOVEMENT_KINDS = ["opening", "receipt", "sale", "sale_reversal", "waste", "supplier_return", "count_adjust", "adjustment"] as const
export type MovementKind = (typeof MOVEMENT_KINDS)[number]
export const MovementKindSchema = z.enum(MOVEMENT_KINDS)
export const MOVEMENT_KIND_LABEL: Record<MovementKind, string> = {
  opening: "Existencias iniciales", receipt: "Recepción", sale: "Consumo por venta", sale_reversal: "Devolución de consumo",
  waste: "Merma", supplier_return: "Devolución a proveedor", count_adjust: "Ajuste de recuento", adjustment: "Ajuste manual",
}
export const WASTE_REASONS = ["expired", "spoiled", "broken", "cooking_error", "staff_meal", "other"] as const
export type WasteReason = (typeof WASTE_REASONS)[number]
export const WasteReasonSchema = z.enum(WASTE_REASONS)
export const WASTE_REASON_LABEL: Record<WasteReason, string> = {
  expired: "Caducado", spoiled: "Estropeado", broken: "Roto o derramado", cooking_error: "Error de cocina", staff_meal: "Comida del personal", other: "Otro motivo",
}

/** Libro inmutable `stockMovements/{id}`: solo se añade. Las correcciones son otro movimiento. */
export const StockMovementSchema = z.object({
  ingredientId: DocIdSchema,
  kind: MovementKindSchema,
  /** Con signo: entradas positivas, salidas negativas. Nunca cero. */
  quantity: SignedQuantitySchema.refine((v) => v !== 0, "El movimiento necesita cantidad."),
  /** Con el mismo signo que la cantidad (o cero). */
  valueCents: SignedCentsSchema,
  quantityAfter: SignedQuantitySchema,
  at: TimestampSchema,
  by: z.string().nullable(),
  reason: z.string().trim().max(200).nullable(),
  wasteReason: WasteReasonSchema.nullable(),
  /** Referencias al hecho que lo provoca. */
  lineId: DocIdSchema.nullable(),
  receiptId: DocIdSchema.nullable(),
  countId: DocIdSchema.nullable(),
  requestId: z.string().nullable(),
}).superRefine((v, ctx) => {
  const entra: MovementKind[] = ["opening", "receipt", "sale_reversal"]
  const sale: MovementKind[] = ["sale", "waste", "supplier_return"]
  if (entra.includes(v.kind) && v.quantity < 0) ctx.addIssue({ code: "custom", message: "Esta entrada no puede restar." })
  if (sale.includes(v.kind) && v.quantity > 0) ctx.addIssue({ code: "custom", message: "Esta salida no puede sumar." })
  if (v.valueCents !== 0 && Math.sign(v.valueCents) !== Math.sign(v.quantity)) ctx.addIssue({ code: "custom", message: "El valor tiene que ir en el mismo sentido que la cantidad." })
  if (v.kind === "waste" && !v.wasteReason) ctx.addIssue({ code: "custom", message: "Indica el motivo de la merma." })
  if ((v.kind === "adjustment" || v.kind === "supplier_return") && !v.reason) ctx.addIssue({ code: "custom", message: "Escribe el motivo." })
  if (v.kind === "sale" && !v.lineId) ctx.addIssue({ code: "custom", message: "El consumo referencia su línea." })
})
export type StockMovement = z.infer<typeof StockMovementSchema>

/* Recetas ----------------------------------------------------------------------------------- */

export const RecipeLineSchema = z.object({
  ingredientId: DocIdSchema,
  /** Cantidad neta por ración en unidad base. */
  quantity: z.number().int().min(1).max(1_000_000_000),
  /** Rendimiento en puntos básicos: 8000 = se aprovecha el 80 %, hay que comprar más. 10000 = sin merma. */
  yieldBp: z.number().int().min(1).max(10000),
})
export type RecipeLine = z.infer<typeof RecipeLineSchema>
const RecipeLinesSchema = z.array(RecipeLineSchema).max(60)

export const RecipeEditableSchema = z.object({
  name: Name,
  itemId: DocIdSchema,
  /** null: el plato sin variante o una receta común a todas las variantes sin receta propia. */
  variantId: PartIdSchema.nullable(),
  lines: RecipeLinesSchema,
  /** Ingredientes que añade elegir un extra (`optionId` de la carta). */
  optionLines: z.record(PartIdSchema, RecipeLinesSchema).refine((v) => Object.keys(v).length <= 30, "Demasiados extras con receta."),
  /** Coste por ración cuando no se detallan ingredientes. No se usa si hay líneas. */
  manualCostCents: CentsSchema.nullable(),
  active: z.boolean(),
}).superRefine((v, ctx) => {
  if (v.lines.length > 0 && v.manualCostCents !== null) ctx.addIssue({ code: "custom", message: "Usa ingredientes o un coste manual, no los dos.", path: ["manualCostCents"] })
  const ids = v.lines.map((l) => l.ingredientId)
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "Hay ingredientes repetidos.", path: ["lines"] })
})
export type RecipeEditable = z.infer<typeof RecipeEditableSchema>

/** `recipes/{id}`; cada versión anterior queda en `recipes/{id}/versions/{n}`, inmutable. */
export const RecipeSchema = RecipeEditableSchema.and(z.object({ version: Revision }))
export type Recipe = z.infer<typeof RecipeSchema>
/** `recipes/{id}/versions/{n}`: la receta tal como era en esa versión. Inmutable. */
export const RecipeVersionSchema = RecipeSchema.and(z.object({ at: TimestampSchema, by: z.string().nullable() }))
export type RecipeVersion = z.infer<typeof RecipeVersionSchema>
export type RecipeWithId = Recipe & { id: string }

/* Coste histórico de cada línea vendida ------------------------------------------------------ */

export const LINE_COST_STATES = ["consumed", "reversed", "wasted", "no_recipe"] as const
export type LineCostState = (typeof LINE_COST_STATES)[number]

/**
 * `lineCosts/{lineId}`: una por línea de pedido que consume. Ancla de la idempotencia (nunca se
 * descuenta dos veces) y dato del margen histórico: congela precio, IVA y coste del momento.
 */
export const LineCostSchema = z.object({
  orderId: DocIdSchema,
  itemId: DocIdSchema,
  variantId: PartIdSchema.nullable(),
  quantity: z.number().int().min(1).max(99),
  recipeId: DocIdSchema.nullable(),
  recipeVersion: z.number().int().min(1).nullable(),
  state: z.enum(LINE_COST_STATES),
  /** Veces que ha entrado en `consumed`; fija los ids de movimiento (`{lineId}.{ciclo}.c|r`). */
  cycle: z.number().int().min(0),
  /** Coste total de la línea al consumir, o null sin receta. Se conserva en `wasted` como pérdida. */
  costCents: CentsSchema.nullable(),
  /** false si algún ingrediente no tenía coste conocido: el coste es parcial. */
  complete: z.boolean(),
  grossCents: CentsSchema,
  taxRate: TaxRateSchema,
  /** Plato dentro de un menú del día: su ingreso va en el menú, así que no se calcula su margen suelto. */
  menuComponent: z.boolean(),
  lineStatus: LineStatusSchema,
  at: TimestampSchema,
})
export type LineCost = z.infer<typeof LineCostSchema>
export type LineCostWithId = LineCost & { id: string }

/* Recuentos --------------------------------------------------------------------------------- */

export const COUNT_STATUSES = ["draft", "applied", "cancelled"] as const
export type CountStatus = (typeof COUNT_STATUSES)[number]
export const StockCountLineSchema = z.object({
  ingredientId: DocIdSchema,
  /** Lo que decía el sistema al empezar (solo para enseñar; el ajuste usa el libro). */
  expectedAtStart: SignedQuantitySchema,
  countedQuantity: QuantitySchema.nullable(),
  /** Instante en que se contó; el ajuste descuenta lo movido desde entonces. */
  countedAt: TimestampSchema.nullable(),
})
export type StockCountLine = z.infer<typeof StockCountLineSchema>
export const StockCountSchema = z.object({
  name: Name,
  status: z.enum(COUNT_STATUSES),
  startedAt: TimestampSchema,
  startedBy: z.string().min(1),
  lines: z.array(StockCountLineSchema).min(1).max(500),
  appliedAt: TimestampSchema.nullable(),
  appliedBy: z.string().nullable(),
  revision: Revision,
})
export type StockCount = z.infer<typeof StockCountSchema>

/* Avisos de stock bajo ---------------------------------------------------------------------- */

export const STOCK_LEVELS = ["ok", "low", "out", "negative"] as const
export type StockLevel = (typeof STOCK_LEVELS)[number]
export const STOCK_LEVEL_LABEL: Record<StockLevel, string> = { ok: "Bien", low: "Stock bajo", out: "Agotado", negative: "Negativo" }
/** `stockAlerts/{ingredientId}`: un aviso vivo por ingrediente. */
export const StockAlertSchema = z.object({
  level: z.enum(["low", "out", "negative"]),
  quantity: SignedQuantitySchema,
  minQuantity: QuantitySchema,
  status: z.enum(["open", "acknowledged", "resolved"]),
  openedAt: TimestampSchema,
  lastChangedAt: TimestampSchema,
  acknowledgedBy: z.string().nullable(),
  resolvedAt: TimestampSchema.nullable(),
})
export type StockAlert = z.infer<typeof StockAlertSchema>

/* Proveedores, formatos y pedidos ----------------------------------------------------------- */

export const SupplierEditableSchema = z.object({
  name: Name,
  phone: z.string().trim().max(30).nullable(),
  email: z.email().nullable(),
  contact: z.string().trim().max(80).nullable(),
  /** Días entre pedir y recibir. */
  leadDays: z.number().int().min(0).max(60),
  /** Importe mínimo de pedido sin IVA. 0 = sin mínimo. */
  minOrderCents: CentsSchema,
  notes: z.string().trim().max(500),
  active: z.boolean(),
})
export type SupplierEditable = z.infer<typeof SupplierEditableSchema>
/** `suppliers/{id}` se guarda tal cual lo edita el encargado. */
export const SupplierSchema = SupplierEditableSchema
export type Supplier = SupplierEditable
export type SupplierWithId = Supplier & { id: string }

/** Un formato que vende un proveedor para un ingrediente («Caja 6 × 1 l»). Precio sin IVA. */
export const SupplierItemEditableSchema = z.object({
  supplierId: DocIdSchema,
  ingredientId: DocIdSchema,
  name: Name,
  sku: z.string().trim().max(40).nullable(),
  /** Unidades base que trae un formato (6 000 ml). */
  baseQuantity: z.number().int().min(1).max(1_000_000_000),
  priceCents: CentsSchema,
  /** El que se propone al sugerir pedidos para ese ingrediente. */
  preferred: z.boolean(),
  active: z.boolean(),
})
export type SupplierItemEditable = z.infer<typeof SupplierItemEditableSchema>
/** El último precio pagado lo escribe la recepción. */
export const SupplierItemSchema = SupplierItemEditableSchema.and(z.object({ lastPriceCents: CentsSchema.nullable(), lastReceivedAt: TimestampSchema.nullable() }))
export type SupplierItem = z.infer<typeof SupplierItemSchema>
export type SupplierItemWithId = SupplierItem & { id: string }

export const PURCHASE_STATUSES = ["draft", "sent", "partially_received", "received", "cancelled", "closed"] as const
export type PurchaseStatus = (typeof PURCHASE_STATUSES)[number]
export const PURCHASE_STATUS_LABEL: Record<PurchaseStatus, string> = {
  draft: "Borrador", sent: "Enviado", partially_received: "Recibido en parte", received: "Recibido", cancelled: "Anulado", closed: "Cerrado sin completar",
}
export const PurchaseLineSchema = z.object({
  lineId: PartIdSchema,
  supplierItemId: DocIdSchema,
  ingredientId: DocIdSchema,
  /** Nombre, unidades base y precio del formato congelados al crear el pedido. */
  name: Name,
  baseQuantity: z.number().int().min(1).max(1_000_000_000),
  priceCents: CentsSchema,
  orderedFormats: z.number().int().min(1).max(100_000),
  receivedFormats: z.number().int().min(0),
})
export type PurchaseLine = z.infer<typeof PurchaseLineSchema>
export const PurchaseOrderSchema = z.object({
  supplierId: DocIdSchema,
  reference: z.string().regex(/^[A-Z0-9]{6}$/),
  status: z.enum(PURCHASE_STATUSES),
  lines: z.array(PurchaseLineSchema).min(1).max(200),
  /** Fecha de entrega esperada (fecha local) o null. */
  expectedOn: FechaSchema.nullable(),
  notes: z.string().trim().max(500),
  totalCents: CentsSchema,
  createdBy: z.string().min(1),
  sentAt: TimestampSchema.nullable(),
  closedReason: z.string().max(200).nullable(),
  revision: Revision,
}).superRefine((v, ctx) => {
  const ids = v.lines.map((l) => l.lineId)
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "Hay líneas repetidas." })
})
export type PurchaseOrder = z.infer<typeof PurchaseOrderSchema>
export type PurchaseOrderWithId = PurchaseOrder & { id: string }

/** Albarán de recepción inmutable `goodsReceipts/{id}`; con o sin pedido. */
export const GoodsReceiptLineSchema = z.object({
  supplierItemId: DocIdSchema,
  ingredientId: DocIdSchema,
  purchaseLineId: PartIdSchema.nullable(),
  receivedFormats: z.number().int().min(1).max(100_000),
  baseQuantity: z.number().int().min(1).max(1_000_000_000),
  /** Precio por formato según el albarán. */
  priceCents: CentsSchema,
  totalCents: CentsSchema,
  receivedBase: QuantitySchema,
})
export type GoodsReceiptLine = z.infer<typeof GoodsReceiptLineSchema>
export const GoodsReceiptSchema = z.object({
  supplierId: DocIdSchema,
  purchaseOrderId: DocIdSchema.nullable(),
  deliveryNote: z.string().trim().max(60).nullable(),
  lines: z.array(GoodsReceiptLineSchema).min(1).max(200),
  totalCents: CentsSchema,
  receivedAt: TimestampSchema,
  receivedBy: z.string().min(1),
})
export type GoodsReceipt = z.infer<typeof GoodsReceiptSchema>

type Convert<H> = (ms: number) => H
export function stockMovementForWrite<H>(v: StockMovement, c: Convert<H>) { return { ...v, at: c(v.at) } }
export function lineCostForWrite<H>(v: LineCost, c: Convert<H>) { return { ...v, at: c(v.at) } }
export function stockCountForWrite<H>(v: StockCount, c: Convert<H>) {
  return {
    ...v, startedAt: c(v.startedAt), appliedAt: v.appliedAt === null ? null : c(v.appliedAt),
    lines: v.lines.map((l) => ({ ...l, countedAt: l.countedAt === null ? null : c(l.countedAt) })),
  }
}
export function stockAlertForWrite<H>(v: StockAlert, c: Convert<H>) {
  return { ...v, openedAt: c(v.openedAt), lastChangedAt: c(v.lastChangedAt), resolvedAt: v.resolvedAt === null ? null : c(v.resolvedAt) }
}
export function supplierItemForWrite<H>(v: SupplierItem, c: Convert<H>) { return { ...v, lastReceivedAt: v.lastReceivedAt === null ? null : c(v.lastReceivedAt) } }
export function purchaseOrderForWrite<H>(v: PurchaseOrder, c: Convert<H>) { return { ...v, sentAt: v.sentAt === null ? null : c(v.sentAt) } }
export function goodsReceiptForWrite<H>(v: GoodsReceipt, c: Convert<H>) { return { ...v, receivedAt: c(v.receivedAt) } }
