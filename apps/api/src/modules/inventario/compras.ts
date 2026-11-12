/** Compras y costes (fase 4): proveedores, formatos, pedidos, recepción, sugerencias y márgenes. */
import { randomInt } from 'node:crypto'
import * as core from '@llenamos/core'
import { StockBook } from './almacen.js'
import { TABLES, audit, create, fail, getMany, list, listAll, loadInventorySettings, missing, must, newId, replace, requireRevision, type Ctx, type Input } from '../fase4/contexto.js'
import { menuCatalog } from '../fase4/puertos.js'

/* Proveedores y formatos -------------------------------------------------------------------- */

export async function guardarProveedor(c: Ctx, d: Input<'guardarProveedor'>) {
  if (d.supplierId === null) {
    const id = newId()
    await create(c, TABLES.suppliers, id, d.supplier)
    await audit(c, 'purchase.supplier_saved', `Proveedor creado: ${d.supplier.name}.`, { supplierId: id })
    return { supplierId: id }
  }
  const previous = await must(c, TABLES.suppliers, d.supplierId, core.SupplierSchema, 'el proveedor')
  await replace(c, TABLES.suppliers, d.supplierId, { ...previous, ...d.supplier })
  await audit(c, 'purchase.supplier_saved', `Proveedor guardado: ${d.supplier.name}.`, { supplierId: d.supplierId })
  return { supplierId: d.supplierId }
}

export async function guardarFormatoProveedor(c: Ctx, d: Input<'guardarFormatoProveedor'>) {
  const item = d.item
  await must(c, TABLES.suppliers, item.supplierId, core.SupplierSchema, 'el proveedor')
  await must(c, TABLES.ingredients, item.ingredientId, core.IngredientSchema, 'el ingrediente')
  const id = d.itemId ?? newId()
  const previous = d.itemId === null ? null : await must(c, TABLES.supplierItems, d.itemId, core.SupplierItemSchema, 'el formato')
  // Los pedidos y los albaranes cuelgan del proveedor y del ingrediente: si cambian, se crea otro formato.
  if (previous && (previous.supplierId !== item.supplierId || previous.ingredientId !== item.ingredientId)) fail('Un formato no cambia de proveedor ni de ingrediente. Crea otro.')
  // Un solo formato preferido por ingrediente: se quita el anterior antes de escribir (el índice único lo exige).
  if (item.preferred) {
    await c.client.query(`UPDATE llenamos.inv_supplier_items SET doc=jsonb_set(doc,'{preferred}','false'::jsonb),updated_at=now(),updated_by=$4
      WHERE restaurant_id=$1 AND location_id=$2 AND ingredient_id=$3 AND preferred AND id<>$5`, [c.rid, c.lid, item.ingredientId, c.uid, id])
  }
  if (previous) await replace(c, TABLES.supplierItems, id, { ...previous, ...item })
  else await create(c, TABLES.supplierItems, id, core.SupplierItemSchema.parse({ ...item, lastPriceCents: null, lastReceivedAt: null }))
  await audit(c, 'purchase.item_saved', `Formato guardado: ${item.name}.`, { itemId: id, supplierId: item.supplierId })
  return { itemId: id }
}

/* Pedidos ------------------------------------------------------------------------------------ */

const readOrder = (c: Ctx, id: string) => must(c, TABLES.orders, id, core.PurchaseOrderSchema, 'el pedido')

/** Referencia de seis caracteres única en el local (un índice único lo garantiza además). */
async function newReference(c: Ctx): Promise<string> {
  const candidates = Array.from({ length: 8 }, () => Array.from({ length: 6 }, () => core.REFERENCE_ALPHABET[randomInt(core.REFERENCE_ALPHABET.length)]).join(''))
  const taken = new Set((await c.client.query<{ reference: string }>('SELECT reference FROM llenamos.inv_purchase_orders WHERE restaurant_id=$1 AND location_id=$2 AND reference=ANY($3::text[])', [c.rid, c.lid, candidates])).rows.map(r => r.reference))
  const free = candidates.find(r => !taken.has(r))
  if (!free) fail('No se ha podido generar la referencia del pedido. Inténtalo de nuevo.')
  return free
}

export async function guardarPedidoProveedor(c: Ctx, d: Input<'guardarPedidoProveedor'>) {
  const supplier = await must(c, TABLES.suppliers, d.supplierId, core.SupplierSchema, 'el proveedor')
  if (!supplier.active) fail('Ese proveedor está desactivado.')
  const items = await getMany(c, TABLES.supplierItems, d.lines.map(l => l.supplierItemId), core.SupplierItemSchema)
  for (const l of d.lines) if (!items.has(l.supplierItemId)) missing('Un formato del pedido no existe.')
  for (const item of items.values()) if (item.supplierId !== d.supplierId) fail('Un formato no es de este proveedor.')
  for (const item of items.values()) if (!item.active) fail(`El formato «${item.name}» está desactivado.`)

  let previous: core.PurchaseOrder | null = null
  const id = d.orderId ?? newId()
  if (d.orderId !== null) {
    previous = await readOrder(c, d.orderId)
    requireRevision(previous.revision, d.expectedRevision!, 'El pedido')
    if (previous.status !== 'draft') fail('Solo se puede editar un pedido en borrador.')
    if (previous.supplierId !== d.supplierId) fail('Un pedido no cambia de proveedor. Crea otro.')
  }
  const reference = previous ? previous.reference : await newReference(c)
  let next = previous ? Math.max(0, ...previous.lines.map(l => Number(/^l(\d+)$/.exec(l.lineId)?.[1] ?? 0))) : 0
  const lines: core.PurchaseLine[] = d.lines.map(l => {
    const item = items.get(l.supplierItemId)!
    const old = previous?.lines.find(p => p.supplierItemId === l.supplierItemId)
    return {
      lineId: old?.lineId ?? `l${++next}`, supplierItemId: l.supplierItemId, ingredientId: item.ingredientId, name: item.name,
      baseQuantity: item.baseQuantity, priceCents: item.priceCents, orderedFormats: l.formats, receivedFormats: 0,
    }
  })
  const order = core.PurchaseOrderSchema.parse({
    supplierId: d.supplierId, reference, status: 'draft', lines, expectedOn: d.expectedOn, notes: d.notes,
    totalCents: core.purchaseTotal(lines), createdBy: previous?.createdBy ?? c.uid, sentAt: null, closedReason: null, revision: previous ? previous.revision + 1 : 1,
  })
  if (previous) await replace(c, TABLES.orders, id, order); else await create(c, TABLES.orders, id, order)
  await audit(c, 'purchase.order_saved', `Pedido ${reference} guardado como borrador.`, { orderId: id, reference })
  return { orderId: id, reference, revision: order.revision, totalCents: order.totalCents }
}

export async function cambiarEstadoPedidoProveedor(c: Ctx, d: Input<'cambiarEstadoPedidoProveedor'>) {
  const order = await readOrder(c, d.orderId)
  requireRevision(order.revision, d.expectedRevision, 'El pedido')
  const check = core.checkPurchaseTransition(order, d.to, d.reason)
  if (!check.ok) fail(check.message)
  const next = { ...order, status: d.to, revision: order.revision + 1, ...(d.to === 'sent' ? { sentAt: c.now } : {}), ...(d.to === 'cancelled' || d.to === 'closed' ? { closedReason: d.reason?.trim() ?? null } : {}) }
  await replace(c, TABLES.orders, d.orderId, next)
  const verb = d.to === 'sent' ? 'marcado como enviado' : d.to === 'cancelled' ? 'anulado' : 'cerrado sin completar'
  await audit(c, `purchase.${d.to}`, `Pedido ${order.reference} ${verb}.`, { orderId: d.orderId, reference: order.reference, reason: d.reason })
  return { revision: order.revision + 1, status: d.to }
}

export async function recibirPedidoProveedor(c: Ctx, d: Input<'recibirPedidoProveedor'>) {
  const supplier = await must(c, TABLES.suppliers, d.supplierId, core.SupplierSchema, 'el proveedor')
  let order: core.PurchaseOrder | null = null
  if (d.purchaseOrderId !== null) {
    order = await readOrder(c, d.purchaseOrderId)
    requireRevision(order.revision, d.expectedRevision!, 'El pedido')
  }
  const found = await getMany(c, TABLES.supplierItems, d.lines.map(l => l.supplierItemId), core.SupplierItemSchema)
  const items = new Map<string, core.SupplierItemWithId>([...found].map(([id, item]) => [id, { ...item, id }]))
  // `planReceipt` lanza errores con mensaje en castellano si el albarán no cuadra con el pedido.
  const plan = core.planReceipt(order, d.supplierId, items, d.lines)

  const book = new StockBook(c, await loadInventorySettings(c))
  await book.load(plan.lines.map(l => l.ingredientId))
  const receiptId = newId()
  for (const l of plan.lines) {
    const step = core.addStock(book.state(l.ingredientId), l.receivedBase, l.totalCents, l.totalCents > 0)
    await book.move(l.ingredientId, step.state, { kind: 'receipt', quantity: l.receivedBase, valueCents: l.totalCents, receiptId, requestId: d.requestId })
  }
  const receipt = core.GoodsReceiptSchema.parse({
    supplierId: d.supplierId, purchaseOrderId: d.purchaseOrderId, deliveryNote: d.deliveryNote, lines: plan.lines, totalCents: plan.totalCents, receivedAt: c.now, receivedBy: c.uid,
  })
  await create(c, TABLES.receipts, receiptId, receipt)
  // El último precio pagado queda en el formato, para detectar el próximo cambio.
  for (const l of plan.lines) await replace(c, TABLES.supplierItems, l.supplierItemId, { ...found.get(l.supplierItemId)!, lastPriceCents: l.priceCents, lastReceivedAt: c.now })
  if (order && d.purchaseOrderId && plan.orderLines && plan.status) {
    await replace(c, TABLES.orders, d.purchaseOrderId, core.PurchaseOrderSchema.parse({ ...order, lines: plan.orderLines, status: plan.status, revision: order.revision + 1 }))
  }
  await audit(c, 'purchase.received', `Mercancía recibida de ${supplier.name}.`, {
    receiptId, orderId: d.purchaseOrderId, deliveryNote: d.deliveryNote, priceChanges: plan.priceChanges.length, exceeded: plan.exceeded.length,
  })
  return { receiptId, totalCents: plan.totalCents, orderStatus: plan.status, pending: plan.pending, exceeded: plan.exceeded, priceChanges: plan.priceChanges }
}

/* Sugerencias y márgenes (lecturas) ---------------------------------------------------------- */

const SUGGEST_LIMIT = 5000
export async function sugerirPedidos(c: Ctx, _d: Input<'sugerirPedidos'>) {
  const [ingredients, items, suppliers, open] = await Promise.all([
    listAll(c, TABLES.ingredients, core.IngredientSchema, 'active', [], 'id', SUGGEST_LIMIT),
    listAll(c, TABLES.supplierItems, core.SupplierItemSchema, '', [], 'id', SUGGEST_LIMIT),
    listAll(c, TABLES.suppliers, core.SupplierSchema, '', [], 'id', 1000),
    listAll(c, TABLES.orders, core.PurchaseOrderSchema, "status IN ('sent','partially_received')", [], 'id', 1000),
  ])
  const reorder = ingredients.map(i => ({ id: i.id, quantity: i.quantity, minQuantity: i.minQuantity, targetQuantity: i.targetQuantity, active: i.active }))
  const supplierMap = new Map(suppliers.map(s => [s.id, { minOrderCents: s.minOrderCents, active: s.active }] as const))
  return core.suggestOrders(reorder, items, supplierMap, core.onOrderByIngredient(open))
}

const MARGIN_DAYS = 93
const MARGIN_LINES = 50_000
export async function margenPlatos(c: Ctx, d: Input<'margenPlatos'>) {
  const from = core.instanteDeHoraLocal(d.from, 0, c.tz), to = core.instanteDeHoraLocal(core.sumarDias(d.to, 1), 0, c.tz)
  if (from === null || to === null) fail('El periodo no es válido.')
  if ((to - from) / 86_400_000 > MARGIN_DAYS + 1) fail('El periodo es demasiado largo. Pide como máximo tres meses.')
  // Páginas por (at, id): el periodo está acotado y la lectura no carga más de `MARGIN_LINES` líneas.
  const lineCosts: core.LineCost[] = []
  let cursor: { at: number; id: string } | null = null
  for (;;) {
    const page: (core.LineCost & { id: string })[] = await list(c, TABLES.lineCosts, core.LineCostSchema,
      cursor ? 'at>=$3 AND at<$4 AND (at,id)>($5::bigint,$6::text)' : 'at>=$3 AND at<$4', cursor ? [from, to, cursor.at, cursor.id] : [from, to], 'at,id', 5000)
    lineCosts.push(...page)
    if (lineCosts.length > MARGIN_LINES) fail('Hay demasiadas ventas en ese periodo. Acórtalo.')
    if (page.length < 5000) break
    const last = page[page.length - 1]!
    cursor = { at: last.at, id: last.id }
  }
  const recipes = await listAll(c, TABLES.recipes, core.RecipeSchema, 'active', [], 'id', 5000)
  const [ingredients, costs] = await Promise.all([
    listAll(c, TABLES.ingredients, core.IngredientSchema, '', [], 'id', SUGGEST_LIMIT),
    listAll(c, TABLES.costs, core.IngredientCostSchema, '', [], 'id', SUGGEST_LIMIT),
  ])
  const sold = core.summarizeDishMargins(lineCosts)
  const costDocs = new Map(costs.map(x => [x.id, x]))
  const state = new Map<string, core.StockState>()
  for (const i of ingredients) {
    const cost = costDocs.get(i.id) ?? { valueCents: 0, lastCost: null }
    state.set(i.id, { quantity: i.quantity, valueCents: cost.valueCents, lastCost: cost.lastCost })
  }
  const menu = await menuCatalog().items(c.client, { restaurantId: c.rid, locationId: c.lid }, [...new Set(recipes.map(r => r.itemId))])
  const theoretical = recipes.map(r => {
    const cost = core.recipeCost(r, id => { const s = state.get(id); return s ? core.averageCost(s) : null })
    const item = menu.get(r.itemId)
    const priceCents = item ? (r.variantId ? item.variants.find(v => v.id === r.variantId)?.priceCents : item.priceCents) ?? null : null
    const margin = item && priceCents !== null && cost.complete ? core.dishMargin({ grossCents: priceCents, taxRate: item.taxRate, costCents: cost.costCents }) : null
    return { recipeId: r.id, itemId: r.itemId, variantId: r.variantId, costCents: cost.costCents, complete: cost.complete, priceCents, marginBp: margin?.marginBp ?? null, foodCostBp: margin?.foodCostBp ?? null }
  })
  return { sold, theoretical, generatedAt: c.now }
}
