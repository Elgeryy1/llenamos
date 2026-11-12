/**
 * Lecturas en vivo de inventario, costes y compras en modo VPS. Las comparten la API y la web
 * (`useLiveQuery`). Costes, recetas y movimientos solo para quien ve costes; cocina y barra, existencias.
 */
import { z } from "zod"
import { DocIdSchema } from "../model"
import { MenuItemSchema } from "../carta/modelo"
import {
  GoodsReceiptSchema, IngredientCostSchema, IngredientSchema, InventorySettingsSchema, PurchaseOrderSchema, RecipeSchema, RecipeVersionSchema,
  StockAlertSchema, StockCountSchema, StockMovementSchema, SupplierItemSchema, SupplierSchema,
} from "./modelo"

export const INVENTARIO_LIVE = {
  stock: "inventarioStock",
  ajustes: "inventarioAjustes",
  costes: "inventarioCostes",
  recetas: "inventarioRecetas",
  versiones: "inventarioVersiones",
  recuentos: "inventarioRecuentos",
  movimientos: "inventarioMovimientos",
  platos: "inventarioPlatos",
  proveedores: "comprasProveedores",
  ingredientesCompras: "comprasIngredientes",
  pedidos: "comprasPedidos",
  albaranes: "comprasAlbaranes",
} as const

const Scope = z.strictObject({ restaurantId: DocIdSchema, locationId: DocIdSchema })
const withId = <S extends z.ZodType>(schema: S) => z.intersection(schema, z.object({ id: DocIdSchema }))

export const InventarioScopeSchema = Scope
export const InventarioStockOutputSchema = z.object({ ingredients: z.array(withId(IngredientSchema)), alerts: z.array(withId(StockAlertSchema)) })
export const InventarioAjustesOutputSchema = z.object({ saved: z.boolean(), settings: InventorySettingsSchema })
export const InventarioCostesOutputSchema = z.object({ costs: z.array(withId(IngredientCostSchema)) })
export const InventarioRecetasOutputSchema = z.object({ recipes: z.array(withId(RecipeSchema)) })
export const InventarioVersionesInputSchema = Scope.extend({ recipeId: DocIdSchema })
export const InventarioVersionesOutputSchema = z.object({ versions: z.array(RecipeVersionSchema) })
export const InventarioRecuentosOutputSchema = z.object({ counts: z.array(withId(StockCountSchema)) })
/** Últimos movimientos, todos o de un ingrediente; con `since`, los posteriores a ese instante, en orden cronológico. */
export const InventarioMovimientosInputSchema = Scope.extend({
  max: z.number().int().min(1).max(2000).default(200), ingredientId: DocIdSchema.nullable().default(null), since: z.number().int().min(0).nullable().default(null),
})
export const InventarioMovimientosOutputSchema = z.object({ movements: z.array(withId(StockMovementSchema)) })
export const InventarioPlatosOutputSchema = z.object({ items: z.array(withId(MenuItemSchema)) })
export const ComprasProveedoresOutputSchema = z.object({ suppliers: z.array(withId(SupplierSchema)), items: z.array(withId(SupplierItemSchema)) })
export const ComprasIngredientesOutputSchema = z.object({ ingredients: z.array(withId(IngredientSchema)) })
export const ComprasPedidosOutputSchema = z.object({ orders: z.array(withId(PurchaseOrderSchema)) })
export const ComprasAlbaranesInputSchema = Scope.extend({ orderId: DocIdSchema.nullable().default(null) })
export const ComprasAlbaranesOutputSchema = z.object({ receipts: z.array(withId(GoodsReceiptSchema)) })
