/**
 * Callables de inventario, escandallos y compras (fase 4). Región europe-west1.
 *
 * Mismas convenciones que las otras fases: entradas estrictas, autor de Auth (nunca de la
 * entrada), `requestId` en toda mutación con respuesta idempotente, cantidades enteras en
 * unidad base y dinero en céntimos sin IVA. **Ninguna entrada trae costes ni valores**: el
 * servidor calcula el coste medio, el valor de cada movimiento y los totales.
 * No hay callable para el descuento al vender: lo hace el proceso `consumirPorLinea` (ver
 * ARQUITECTURA.md). Este archivo no importa `api.ts`.
 */
import { z } from "zod"
import { DocIdSchema } from "./model"
import { FechaSchema } from "./reservas/tiempo"
import { MillisSchema } from "./timestamp"
import type { Module } from "./modules"
import type { Permission } from "./roles"
import { QuantitySchema } from "./inventario/coste"
import {
  GoodsReceiptLineSchema, IngredientEditableSchema, InventorySettingsSchema, PURCHASE_STATUSES, PurchaseLineSchema,
  RecipeEditableSchema, StockAlertSchema, SupplierEditableSchema, SupplierItemEditableSchema, WasteReasonSchema,
} from "./inventario/modelo"
import { PartIdSchema } from "./carta/modelo"

const Scope = { restaurantId: DocIdSchema, locationId: DocIdSchema }
const Mutation = { ...Scope, requestId: DocIdSchema }
const Ok = z.literal(true)
const Reason = z.string().trim().min(1, "Escribe el motivo.").max(200)
const Revision = z.number().int().min(1)
const Positive = QuantitySchema.refine((v) => v > 0, "La cantidad debe ser mayor que cero.")
const Cents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const Signed = z.number().int().min(-1_000_000_000_000).max(1_000_000_000_000)

export const GuardarConfiguracionInventarioInputSchema = z.strictObject({ ...Mutation, settings: InventorySettingsSchema })
export const GuardarConfiguracionInventarioOutputSchema = z.object({ ok: Ok })

/** Al crear, `opening` fija las existencias iniciales (con su valor sin IVA); al editar no se admite. */
export const GuardarIngredienteInputSchema = z.strictObject({
  ...Mutation, ingredientId: DocIdSchema.nullable(), expectedRevision: Revision.nullable(), ingredient: IngredientEditableSchema,
  opening: z.strictObject({ quantity: Positive, valueCents: Cents }).nullable().default(null),
}).superRefine((v, ctx) => {
  if (v.opening && v.ingredientId !== null) ctx.addIssue({ code: "custom", message: "Las existencias iniciales solo se fijan al crear.", path: ["opening"] })
  if (v.ingredientId !== null && v.expectedRevision === null) ctx.addIssue({ code: "custom", message: "Falta la revisión.", path: ["expectedRevision"] })
})
export const GuardarIngredienteOutputSchema = z.object({ ingredientId: DocIdSchema, revision: Revision })

export const RecipeCostOutputSchema = z.object({ costCents: Cents, complete: z.boolean(), missing: z.array(DocIdSchema) })
export const GuardarRecetaInputSchema = z.strictObject({ ...Mutation, recipeId: DocIdSchema.nullable(), expectedVersion: Revision.nullable(), recipe: RecipeEditableSchema })
export const GuardarRecetaOutputSchema = z.object({ recipeId: DocIdSchema, version: Revision, cost: RecipeCostOutputSchema })

export const RegistrarMermaInputSchema = z.strictObject({ ...Mutation, ingredientId: DocIdSchema, quantity: Positive, wasteReason: WasteReasonSchema, reason: z.string().trim().max(200).nullable().default(null) })
/** Sin valor ni coste: lo ve quien tiene `costes.ver` en los movimientos. */
export const RegistrarMermaOutputSchema = z.object({ movementId: DocIdSchema, quantityAfter: Signed })
export const AjustarStockInputSchema = z.strictObject({
  ...Mutation, ingredientId: DocIdSchema, kind: z.enum(["adjustment", "supplier_return"]),
  /** `adjustment`: con signo y no cero. `supplier_return`: positiva (lo que se devuelve). */
  quantity: Signed, reason: Reason,
}).superRefine((v, ctx) => {
  if (v.quantity === 0) ctx.addIssue({ code: "custom", message: "La cantidad no puede ser cero.", path: ["quantity"] })
  if (v.kind === "supplier_return" && v.quantity < 0) ctx.addIssue({ code: "custom", message: "Indica cuánto se devuelve, en positivo.", path: ["quantity"] })
})
export const AjustarStockOutputSchema = RegistrarMermaOutputSchema

export const IniciarRecuentoInputSchema = z.strictObject({ ...Mutation, name: z.string().trim().min(1).max(80), ingredientIds: z.array(DocIdSchema).min(1).max(500).nullable() })
export const IniciarRecuentoOutputSchema = z.object({ countId: DocIdSchema, revision: Revision, ingredients: z.number().int().min(1) })
export const GuardarRecuentoInputSchema = z.strictObject({
  ...Mutation, countId: DocIdSchema, expectedRevision: Revision,
  lines: z.array(z.strictObject({ ingredientId: DocIdSchema, countedQuantity: QuantitySchema.nullable() })).min(1).max(500),
})
export const GuardarRecuentoOutputSchema = z.object({ revision: Revision })
export const AplicarRecuentoInputSchema = z.strictObject({ ...Mutation, countId: DocIdSchema, expectedRevision: Revision })
export const AplicarRecuentoOutputSchema = z.object({
  adjusted: z.array(z.object({ ingredientId: DocIdSchema, quantity: Signed, valueCents: z.number().int() })),
  unchanged: z.number().int().min(0), uncounted: z.number().int().min(0),
})
export const CancelarRecuentoInputSchema = AplicarRecuentoInputSchema
export const CancelarRecuentoOutputSchema = z.object({ ok: Ok })

export const ReconocerAvisoStockInputSchema = z.strictObject({ ...Mutation, ingredientId: DocIdSchema })
export const ReconocerAvisoStockOutputSchema = z.object({ alert: StockAlertSchema })

export const GuardarProveedorInputSchema = z.strictObject({ ...Mutation, supplierId: DocIdSchema.nullable(), supplier: SupplierEditableSchema })
export const GuardarProveedorOutputSchema = z.object({ supplierId: DocIdSchema })
export const GuardarFormatoProveedorInputSchema = z.strictObject({ ...Mutation, itemId: DocIdSchema.nullable(), item: SupplierItemEditableSchema })
export const GuardarFormatoProveedorOutputSchema = z.object({ itemId: DocIdSchema })

/** Solo borradores. El precio de cada línea sale del formato guardado, nunca de la entrada. */
export const GuardarPedidoProveedorInputSchema = z.strictObject({
  ...Mutation, orderId: DocIdSchema.nullable(), expectedRevision: Revision.nullable(), supplierId: DocIdSchema,
  lines: z.array(z.strictObject({ supplierItemId: DocIdSchema, formats: z.number().int().min(1).max(100_000) })).min(1).max(200),
  expectedOn: FechaSchema.nullable(), notes: z.string().trim().max(500).default(""),
}).superRefine((v, ctx) => {
  if (new Set(v.lines.map((l) => l.supplierItemId)).size !== v.lines.length) ctx.addIssue({ code: "custom", message: "Hay formatos repetidos.", path: ["lines"] })
  if (v.orderId !== null && v.expectedRevision === null) ctx.addIssue({ code: "custom", message: "Falta la revisión.", path: ["expectedRevision"] })
})
export const GuardarPedidoProveedorOutputSchema = z.object({ orderId: DocIdSchema, reference: z.string(), revision: Revision, totalCents: Cents })
export const CambiarEstadoPedidoProveedorInputSchema = z.strictObject({
  ...Mutation, orderId: DocIdSchema, expectedRevision: Revision, to: z.enum(["sent", "cancelled", "closed"]), reason: z.string().trim().max(200).nullable().default(null),
})
export const CambiarEstadoPedidoProveedorOutputSchema = z.object({ revision: Revision, status: z.enum(PURCHASE_STATUSES) })

const PriceChange = z.object({ supplierItemId: DocIdSchema, previousCents: Cents, newCents: Cents, changeBp: z.number().int() })
export const RecibirPedidoProveedorInputSchema = z.strictObject({
  ...Mutation, supplierId: DocIdSchema, purchaseOrderId: DocIdSchema.nullable(), expectedRevision: Revision.nullable(),
  deliveryNote: z.string().trim().max(60).nullable().default(null),
  lines: z.array(z.strictObject({ supplierItemId: DocIdSchema, receivedFormats: z.number().int().min(1).max(100_000), priceCents: Cents })).min(1).max(200),
}).superRefine((v, ctx) => {
  if (v.purchaseOrderId !== null && v.expectedRevision === null) ctx.addIssue({ code: "custom", message: "Falta la revisión del pedido.", path: ["expectedRevision"] })
})
export const RecibirPedidoProveedorOutputSchema = z.object({
  receiptId: DocIdSchema, totalCents: Cents, orderStatus: z.enum(PURCHASE_STATUSES).nullable(),
  pending: z.array(z.object({ lineId: PartIdSchema, formats: z.number().int().min(1) })),
  exceeded: z.array(z.object({ lineId: PartIdSchema, extraFormats: z.number().int().min(1) })),
  priceChanges: z.array(PriceChange),
})

export const SugerirPedidosInputSchema = z.strictObject({ ...Scope })
export const SugerirPedidosOutputSchema = z.object({
  orders: z.array(z.object({
    supplierId: DocIdSchema,
    lines: z.array(z.object({ supplierItemId: DocIdSchema, ingredientId: DocIdSchema, formats: z.number().int().min(1), totalCents: Cents })),
    totalCents: Cents, belowMinimum: z.boolean(),
  })),
  withoutSupplier: z.array(DocIdSchema),
})

export const MargenPlatosInputSchema = z.strictObject({ ...Scope, from: FechaSchema, to: FechaSchema }).refine((v) => v.from <= v.to, "El periodo está al revés.")
export const MargenPlatosOutputSchema = z.object({
  /** Histórico: lo vendido en el periodo con el coste de cada momento. */
  sold: z.array(z.object({
    itemId: DocIdSchema, variantId: PartIdSchema.nullable(), inMenu: z.boolean(), units: z.number().int(), coveredUnits: z.number().int(),
    grossCents: Cents, netCents: Cents, coveredNetCents: Cents, costCents: Cents, wasteCostCents: Cents, marginCents: z.number().int(), marginBp: z.number().int().nullable(),
  })),
  /** Teórico: coste de una ración con los costes medios de hoy y su margen sobre el precio de carta. */
  theoretical: z.array(z.object({
    recipeId: DocIdSchema, itemId: DocIdSchema, variantId: PartIdSchema.nullable(), costCents: Cents, complete: z.boolean(),
    priceCents: Cents.nullable(), marginBp: z.number().int().nullable(), foodCostBp: z.number().int().nullable(),
  })),
  generatedAt: MillisSchema,
})

export const CALLABLES_FASE4_INVENTARIO = {
  guardarConfiguracionInventario: "guardarConfiguracionInventario",
  guardarIngrediente: "guardarIngrediente",
  guardarReceta: "guardarReceta",
  registrarMerma: "registrarMerma",
  ajustarStock: "ajustarStock",
  iniciarRecuento: "iniciarRecuento",
  guardarRecuento: "guardarRecuento",
  aplicarRecuento: "aplicarRecuento",
  cancelarRecuento: "cancelarRecuento",
  reconocerAvisoStock: "reconocerAvisoStock",
  guardarProveedor: "guardarProveedor",
  guardarFormatoProveedor: "guardarFormatoProveedor",
  guardarPedidoProveedor: "guardarPedidoProveedor",
  cambiarEstadoPedidoProveedor: "cambiarEstadoPedidoProveedor",
  recibirPedidoProveedor: "recibirPedidoProveedor",
  sugerirPedidos: "sugerirPedidos",
  margenPlatos: "margenPlatos",
} as const

export const CALLABLE_SCHEMAS_FASE4_INVENTARIO = {
  guardarConfiguracionInventario: { input: GuardarConfiguracionInventarioInputSchema, output: GuardarConfiguracionInventarioOutputSchema },
  guardarIngrediente: { input: GuardarIngredienteInputSchema, output: GuardarIngredienteOutputSchema },
  guardarReceta: { input: GuardarRecetaInputSchema, output: GuardarRecetaOutputSchema },
  registrarMerma: { input: RegistrarMermaInputSchema, output: RegistrarMermaOutputSchema },
  ajustarStock: { input: AjustarStockInputSchema, output: AjustarStockOutputSchema },
  iniciarRecuento: { input: IniciarRecuentoInputSchema, output: IniciarRecuentoOutputSchema },
  guardarRecuento: { input: GuardarRecuentoInputSchema, output: GuardarRecuentoOutputSchema },
  aplicarRecuento: { input: AplicarRecuentoInputSchema, output: AplicarRecuentoOutputSchema },
  cancelarRecuento: { input: CancelarRecuentoInputSchema, output: CancelarRecuentoOutputSchema },
  reconocerAvisoStock: { input: ReconocerAvisoStockInputSchema, output: ReconocerAvisoStockOutputSchema },
  guardarProveedor: { input: GuardarProveedorInputSchema, output: GuardarProveedorOutputSchema },
  guardarFormatoProveedor: { input: GuardarFormatoProveedorInputSchema, output: GuardarFormatoProveedorOutputSchema },
  guardarPedidoProveedor: { input: GuardarPedidoProveedorInputSchema, output: GuardarPedidoProveedorOutputSchema },
  cambiarEstadoPedidoProveedor: { input: CambiarEstadoPedidoProveedorInputSchema, output: CambiarEstadoPedidoProveedorOutputSchema },
  recibirPedidoProveedor: { input: RecibirPedidoProveedorInputSchema, output: RecibirPedidoProveedorOutputSchema },
  sugerirPedidos: { input: SugerirPedidosInputSchema, output: SugerirPedidosOutputSchema },
  margenPlatos: { input: MargenPlatosInputSchema, output: MargenPlatosOutputSchema },
} as const satisfies Record<keyof typeof CALLABLES_FASE4_INVENTARIO, { input: z.ZodType; output: z.ZodType }>

export const FASE4_INVENTARIO_ACCESS: Record<keyof typeof CALLABLES_FASE4_INVENTARIO, { permission: Permission; modules: readonly Module[] }> = {
  guardarConfiguracionInventario: { permission: "inventario.gestionar", modules: ["inventory"] },
  guardarIngrediente: { permission: "inventario.gestionar", modules: ["inventory"] },
  guardarReceta: { permission: "escandallos.editar", modules: ["inventory"] },
  registrarMerma: { permission: "inventario.mermar", modules: ["inventory"] },
  ajustarStock: { permission: "inventario.gestionar", modules: ["inventory"] },
  iniciarRecuento: { permission: "inventario.gestionar", modules: ["inventory"] },
  guardarRecuento: { permission: "inventario.gestionar", modules: ["inventory"] },
  aplicarRecuento: { permission: "inventario.gestionar", modules: ["inventory"] },
  cancelarRecuento: { permission: "inventario.gestionar", modules: ["inventory"] },
  reconocerAvisoStock: { permission: "inventario.ver", modules: ["inventory"] },
  guardarProveedor: { permission: "compras.gestionar", modules: ["inventory"] },
  guardarFormatoProveedor: { permission: "compras.gestionar", modules: ["inventory"] },
  guardarPedidoProveedor: { permission: "compras.gestionar", modules: ["inventory"] },
  cambiarEstadoPedidoProveedor: { permission: "compras.gestionar", modules: ["inventory"] },
  recibirPedidoProveedor: { permission: "compras.gestionar", modules: ["inventory"] },
  sugerirPedidos: { permission: "compras.gestionar", modules: ["inventory"] },
  margenPlatos: { permission: "costes.ver", modules: ["inventory"] },
}
