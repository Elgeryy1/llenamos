import * as core from '@llenamos/core'
import { TABLES, fail, list, listAll, loadInventorySettings } from '../fase4/contexto.js'
import { liveQuery } from '../fase4/operacion.js'
import { menuCatalog } from '../fase4/puertos.js'
import type { LiveQuery } from '../types.js'

const L = core.INVENTARIO_LIVE
const MODULE = ['inventory'] as const
const BIG = 2000
const Scope = core.InventarioScopeSchema

/** Cocina y barra leen existencias y avisos (inventario.ver) sin ver costes. */
const stock = liveQuery(L.stock, 'inventario.ver', MODULE, Scope, core.InventarioStockOutputSchema, ['inventario.stock'],
  async (c) => ({
    ingredients: await listAll(c, TABLES.ingredients, core.IngredientSchema, '', [], 'id', BIG),
    alerts: await listAll(c, TABLES.alerts, core.StockAlertSchema, '', [], 'id', BIG),
  }))
const ajustes = liveQuery(L.ajustes, 'inventario.gestionar', MODULE, Scope, core.InventarioAjustesOutputSchema, ['inventario.ajustes'],
  async (c) => {
    const row = await c.client.query("SELECT 1 FROM llenamos.fase4_settings WHERE restaurant_id=$1 AND location_id=$2 AND kind='inventory'", [c.rid, c.lid])
    return { saved: row.rowCount === 1, settings: await loadInventorySettings(c) }
  })
/** Costes, recetas, movimientos y recuentos: solo quien ve costes o gestiona. */
const costes = liveQuery(L.costes, 'costes.ver', MODULE, Scope, core.InventarioCostesOutputSchema, ['inventario.stock'],
  async (c) => ({ costs: await listAll(c, TABLES.costs, core.IngredientCostSchema, '', [], 'id', BIG) }))
const recetas = liveQuery(L.recetas, 'costes.ver', MODULE, Scope, core.InventarioRecetasOutputSchema, ['inventario.receta'],
  async (c) => ({ recipes: await listAll(c, TABLES.recipes, core.RecipeSchema, '', [], 'id', BIG) }))
const versiones = liveQuery(L.versiones, 'costes.ver', MODULE, core.InventarioVersionesInputSchema, core.InventarioVersionesOutputSchema, ['inventario.receta'],
  async (c, i) => ({ versions: await list(c, TABLES.recipeVersions, core.RecipeVersionSchema, 'recipe_id=$3', [i.recipeId], 'version DESC', 20) }))
const recuentos = liveQuery(L.recuentos, 'inventario.gestionar', MODULE, Scope, core.InventarioRecuentosOutputSchema, ['inventario.recuento'],
  async (c) => ({ counts: await list(c, TABLES.counts, core.StockCountSchema, '', [], 'started_at DESC', 30) }))
const movimientos = liveQuery(L.movimientos, 'costes.ver', MODULE, core.InventarioMovimientosInputSchema, core.InventarioMovimientosOutputSchema, ['inventario.stock'],
  async (c, i) => {
    const params: unknown[] = [], where: string[] = []
    if (i.ingredientId !== null) { params.push(i.ingredientId); where.push(`ingredient_id=$${params.length + 2}`) }
    if (i.since !== null) { params.push(i.since); where.push(`at>=$${params.length + 2}`) }
    return { movements: await list(c, TABLES.movements, core.StockMovementSchema, where.join(' AND '), params, i.since !== null ? 'at,id' : 'at DESC,id', i.max) }
  })
/** Platos de la carta para montar recetas: los lee del módulo de carta (V4) a través del puerto. */
const platos = liveQuery(L.platos, 'costes.ver', MODULE, Scope, core.InventarioPlatosOutputSchema, ['carta.plato'],
  async (c) => {
    const items = await menuCatalog().list(c.client, { restaurantId: c.rid, locationId: c.lid }, BIG + 1)
    if (items.length > BIG) fail(`La carta tiene más de ${BIG} platos: no se puede montar el escandallo de una vez.`)
    return { items: items.map(x => ({ ...x.item, id: x.id })) }
  })

/** Compras: quien gestiona compras. Los pedidos son los 200 más recientes. */
const COMPRAS = 'compras.gestionar'
const proveedores = liveQuery(L.proveedores, COMPRAS, MODULE, Scope, core.ComprasProveedoresOutputSchema, ['compras.proveedor'],
  async (c) => ({
    suppliers: await listAll(c, TABLES.suppliers, core.SupplierSchema, '', [], 'id', 1000),
    items: await listAll(c, TABLES.supplierItems, core.SupplierItemSchema, '', [], 'id', BIG * 2),
  }))
const ingredientesCompras = liveQuery(L.ingredientesCompras, COMPRAS, MODULE, Scope, core.ComprasIngredientesOutputSchema, ['inventario.stock'],
  async (c) => ({ ingredients: await listAll(c, TABLES.ingredients, core.IngredientSchema, '', [], 'id', BIG) }))
const pedidos = liveQuery(L.pedidos, COMPRAS, MODULE, Scope, core.ComprasPedidosOutputSchema, ['compras.pedido'],
  async (c) => ({ orders: await list(c, TABLES.orders, core.PurchaseOrderSchema, '', [], 'created_at DESC,id', 200) }))
const albaranes = liveQuery(L.albaranes, COMPRAS, MODULE, core.ComprasAlbaranesInputSchema, core.ComprasAlbaranesOutputSchema, ['compras.pedido'],
  async (c, i) => ({ receipts: i.orderId
    ? await list(c, TABLES.receipts, core.GoodsReceiptSchema, 'purchase_order_id=$3', [i.orderId], 'received_at DESC,id', 100)
    : await list(c, TABLES.receipts, core.GoodsReceiptSchema, '', [], 'received_at DESC,id', 15) }))

export const inventarioLiveQueries: LiveQuery[] = [stock, ajustes, costes, recetas, versiones, recuentos, movimientos, platos, proveedores, ingredientesCompras, pedidos, albaranes]
