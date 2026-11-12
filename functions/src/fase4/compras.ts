/** Callables de compras y costes (fase 4): proveedores, formatos, pedidos, recepción, sugerencias y márgenes. */
import { randomInt } from 'node:crypto'
import { Timestamp, type DocumentReference } from 'firebase-admin/firestore'
import * as core from '@llenamos/core'
import { StockBook } from './almacen'
import { col, fail, loadInventorySettings, missing, newId, requireRevision, type Ctx, type Input } from './context'

const ts = Timestamp.fromMillis

/* Proveedores y formatos -------------------------------------------------------------------- */

export async function guardarProveedor(c: Ctx, d: Input<'guardarProveedor'>) {
  if (d.supplierId === null) {
    const ref = col(c, 'suppliers').doc()
    c.create(ref, d.supplier)
    c.audit('purchase.supplier_saved', `Proveedor creado: ${d.supplier.name}.`, { supplierId: ref.id })
    return { supplierId: ref.id }
  }
  const ref = col(c, 'suppliers').doc(d.supplierId)
  if (!(await c.tx.get(ref)).exists) missing('No se encuentra el proveedor.')
  c.update(ref, d.supplier)
  c.audit('purchase.supplier_saved', `Proveedor guardado: ${d.supplier.name}.`, { supplierId: d.supplierId })
  return { supplierId: d.supplierId }
}

export async function guardarFormatoProveedor(c: Ctx, d: Input<'guardarFormatoProveedor'>) {
  const item = d.item
  const [supplier, ingredient] = await Promise.all([c.tx.get(col(c, 'suppliers').doc(item.supplierId)), c.tx.get(col(c, 'ingredients').doc(item.ingredientId))])
  if (!supplier.exists) missing('No se encuentra el proveedor.')
  if (!ingredient.exists) missing('No se encuentra el ingrediente.')
  const ref = d.itemId === null ? col(c, 'supplierItems').doc() : col(c, 'supplierItems').doc(d.itemId)
  if (d.itemId === null) c.create(ref, core.supplierItemForWrite(core.SupplierItemSchema.parse({ ...item, lastPriceCents: null, lastReceivedAt: null }), ts))
  else {
    const snap = await c.tx.get(ref)
    if (!snap.exists) missing('No se encuentra el formato.')
    const previous = core.SupplierItemSchema.parse(snap.data())
    // Los pedidos y los albaranes cuelgan del proveedor y del ingrediente: si cambian, se crea otro formato.
    if (previous.supplierId !== item.supplierId || previous.ingredientId !== item.ingredientId) fail('Un formato no cambia de proveedor ni de ingrediente. Crea otro.')
    c.update(ref, item)
  }
  // Un solo formato preferido por ingrediente.
  if (item.preferred) {
    const others = await c.tx.get(col(c, 'supplierItems').where('ingredientId', '==', item.ingredientId).where('preferred', '==', true))
    for (const o of others.docs) if (o.id !== ref.id) c.update(o.ref, { preferred: false })
  }
  c.audit('purchase.item_saved', `Formato guardado: ${item.name}.`, { itemId: ref.id, supplierId: item.supplierId })
  return { itemId: ref.id }
}

/* Pedidos ------------------------------------------------------------------------------------ */

async function readOrder(c: Ctx, id: string) {
  const ref = col(c, 'purchaseOrders').doc(id)
  const snap = await c.tx.get(ref)
  if (!snap.exists) missing('No se encuentra el pedido.')
  return { ref, order: core.PurchaseOrderSchema.parse(snap.data()) }
}

/** Referencia de seis caracteres única en el local. */
async function newReference(c: Ctx, orderId: string): Promise<string> {
  const candidates = Array.from({ length: 8 }, () => Array.from({ length: 6 }, () => core.REFERENCE_ALPHABET[randomInt(core.REFERENCE_ALPHABET.length)]).join(''))
  const snaps = await c.tx.getAll(...candidates.map((r) => col(c, 'purchaseReferences').doc(r)))
  const free = candidates.find((_, i) => !snaps[i]!.exists)
  if (!free) fail('No se ha podido generar la referencia del pedido. Inténtalo de nuevo.')
  c.create(col(c, 'purchaseReferences').doc(free), { orderId })
  return free
}

export async function guardarPedidoProveedor(c: Ctx, d: Input<'guardarPedidoProveedor'>) {
  const supplierSnap = await c.tx.get(col(c, 'suppliers').doc(d.supplierId))
  if (!supplierSnap.exists) missing('No se encuentra el proveedor.')
  if (!core.SupplierSchema.parse(supplierSnap.data()).active) fail('Ese proveedor está desactivado.')
  const itemSnaps = await c.tx.getAll(...d.lines.map((l) => col(c, 'supplierItems').doc(l.supplierItemId)))
  const items = new Map(itemSnaps.map((s) => {
    if (!s.exists) missing('Un formato del pedido no existe.')
    return [s.id, core.SupplierItemSchema.parse(s.data())] as const
  }))
  for (const item of items.values()) if (item.supplierId !== d.supplierId) fail('Un formato no es de este proveedor.')
  for (const item of items.values()) if (!item.active) fail(`El formato «${item.name}» está desactivado.`)

  let previous: core.PurchaseOrder | null = null
  const ref = d.orderId === null ? col(c, 'purchaseOrders').doc() : col(c, 'purchaseOrders').doc(d.orderId)
  if (d.orderId !== null) {
    previous = (await readOrder(c, d.orderId)).order
    requireRevision(previous.revision, d.expectedRevision!, 'El pedido')
    if (previous.status !== 'draft') fail('Solo se puede editar un pedido en borrador.')
    if (previous.supplierId !== d.supplierId) fail('Un pedido no cambia de proveedor. Crea otro.')
  }
  const reference = previous ? previous.reference : await newReference(c, ref.id)
  let next = previous ? Math.max(0, ...previous.lines.map((l) => Number(/^l(\d+)$/.exec(l.lineId)?.[1] ?? 0))) : 0
  const lines: core.PurchaseLine[] = d.lines.map((l) => {
    const item = items.get(l.supplierItemId)!
    const old = previous?.lines.find((p) => p.supplierItemId === l.supplierItemId)
    return {
      lineId: old?.lineId ?? `l${++next}`, supplierItemId: l.supplierItemId, ingredientId: item.ingredientId, name: item.name,
      baseQuantity: item.baseQuantity, priceCents: item.priceCents, orderedFormats: l.formats, receivedFormats: 0,
    }
  })
  const order = core.PurchaseOrderSchema.parse({
    supplierId: d.supplierId, reference, status: 'draft', lines, expectedOn: d.expectedOn, notes: d.notes,
    totalCents: core.purchaseTotal(lines), createdBy: previous?.createdBy ?? c.uid, sentAt: null, closedReason: null, revision: previous ? previous.revision + 1 : 1,
  })
  if (previous) c.update(ref, core.purchaseOrderForWrite(order, ts)); else c.create(ref, core.purchaseOrderForWrite(order, ts))
  c.audit('purchase.order_saved', `Pedido ${reference} guardado como borrador.`, { orderId: ref.id, reference })
  return { orderId: ref.id, reference, revision: order.revision, totalCents: order.totalCents }
}

export async function cambiarEstadoPedidoProveedor(c: Ctx, d: Input<'cambiarEstadoPedidoProveedor'>) {
  const { ref, order } = await readOrder(c, d.orderId)
  requireRevision(order.revision, d.expectedRevision, 'El pedido')
  const check = core.checkPurchaseTransition(order, d.to, d.reason)
  if (!check.ok) fail(check.message)
  const patch: Record<string, unknown> = { status: d.to, revision: order.revision + 1 }
  if (d.to === 'sent') patch.sentAt = ts(c.now)
  if (d.to === 'cancelled' || d.to === 'closed') patch.closedReason = d.reason?.trim() ?? null
  c.update(ref, patch)
  const verb = d.to === 'sent' ? 'marcado como enviado' : d.to === 'cancelled' ? 'anulado' : 'cerrado sin completar'
  c.audit(`purchase.${d.to}`, `Pedido ${order.reference} ${verb}.`, { orderId: d.orderId, reference: order.reference, reason: d.reason })
  return { revision: order.revision + 1, status: d.to }
}

export async function recibirPedidoProveedor(c: Ctx, d: Input<'recibirPedidoProveedor'>) {
  const supplierSnap = await c.tx.get(col(c, 'suppliers').doc(d.supplierId))
  if (!supplierSnap.exists) missing('No se encuentra el proveedor.')
  let order: { ref: DocumentReference; order: core.PurchaseOrder } | null = null
  if (d.purchaseOrderId !== null) {
    order = await readOrder(c, d.purchaseOrderId)
    requireRevision(order.order.revision, d.expectedRevision!, 'El pedido')
  }
  const itemSnaps = await c.tx.getAll(...d.lines.map((l) => col(c, 'supplierItems').doc(l.supplierItemId)))
  const items = new Map<string, core.SupplierItemWithId>()
  for (const s of itemSnaps) if (s.exists) items.set(s.id, { ...core.SupplierItemSchema.parse(s.data()), id: s.id })
  // `planReceipt` lanza errores con mensaje en castellano si el albarán no cuadra con el pedido.
  const plan = core.planReceipt(order?.order ?? null, d.supplierId, items, d.lines)

  const book = new StockBook(c, await loadInventorySettings(c))
  await book.load(plan.lines.map((l) => l.ingredientId))
  const receiptId = newId(c, 'goodsReceipts')
  for (const l of plan.lines) {
    const step = core.addStock(book.state(l.ingredientId), l.receivedBase, l.totalCents, l.totalCents > 0)
    book.move(l.ingredientId, step.state, { kind: 'receipt', quantity: l.receivedBase, valueCents: l.totalCents, receiptId, requestId: d.requestId })
  }
  const receipt = core.GoodsReceiptSchema.parse({
    supplierId: d.supplierId, purchaseOrderId: d.purchaseOrderId, deliveryNote: d.deliveryNote, lines: plan.lines, totalCents: plan.totalCents, receivedAt: c.now, receivedBy: c.uid,
  })
  c.create(col(c, 'goodsReceipts').doc(receiptId), core.goodsReceiptForWrite(receipt, ts))
  // El último precio pagado queda en el formato, para detectar el próximo cambio.
  for (const l of plan.lines) c.update(col(c, 'supplierItems').doc(l.supplierItemId), { lastPriceCents: l.priceCents, lastReceivedAt: ts(c.now) })
  if (order && plan.orderLines && plan.status) {
    const next = core.PurchaseOrderSchema.parse({ ...order.order, lines: plan.orderLines, status: plan.status, revision: order.order.revision + 1 })
    c.update(order.ref, { lines: next.lines, status: next.status, revision: next.revision })
  }
  const name = core.SupplierSchema.parse(supplierSnap.data()).name
  c.audit('purchase.received', `Mercancía recibida de ${name}.`, {
    receiptId, orderId: d.purchaseOrderId, deliveryNote: d.deliveryNote, priceChanges: plan.priceChanges.length, exceeded: plan.exceeded.length,
  })
  return { receiptId, totalCents: plan.totalCents, orderStatus: plan.status, pending: plan.pending, exceeded: plan.exceeded, priceChanges: plan.priceChanges }
}

/* Sugerencias y márgenes (lecturas) ---------------------------------------------------------- */

export async function sugerirPedidos(c: Ctx, _d: Input<'sugerirPedidos'>) {
  const [ingredients, items, suppliers, open] = await Promise.all([
    c.tx.get(col(c, 'ingredients').where('active', '==', true)),
    c.tx.get(col(c, 'supplierItems')),
    c.tx.get(col(c, 'suppliers')),
    c.tx.get(col(c, 'purchaseOrders').where('status', 'in', ['sent', 'partially_received'])),
  ])
  const reorder = ingredients.docs.map((doc) => {
    const i = core.IngredientSchema.parse(doc.data())
    return { id: doc.id, quantity: i.quantity, minQuantity: i.minQuantity, targetQuantity: i.targetQuantity, active: i.active }
  })
  const supplierMap = new Map(suppliers.docs.map((doc) => { const s = core.SupplierSchema.parse(doc.data()); return [doc.id, { minOrderCents: s.minOrderCents, active: s.active }] as const }))
  const result = core.suggestOrders(
    reorder, items.docs.map((doc) => ({ ...core.SupplierItemSchema.parse(doc.data()), id: doc.id })), supplierMap,
    core.onOrderByIngredient(open.docs.map((doc) => core.PurchaseOrderSchema.parse(doc.data()))),
  )
  return result
}

export async function margenPlatos(c: Ctx, d: Input<'margenPlatos'>) {
  const from = core.instanteDeHoraLocal(d.from, 0, c.tz), to = core.instanteDeHoraLocal(core.sumarDias(d.to, 1), 0, c.tz)
  if (from === null || to === null) fail('El periodo no es válido.')
  const [lineCosts, recipes, ingredients, costs] = await Promise.all([
    c.tx.get(col(c, 'lineCosts').where('at', '>=', ts(from)).where('at', '<', ts(to))),
    c.tx.get(col(c, 'recipes').where('active', '==', true)),
    c.tx.get(col(c, 'ingredients')),
    c.tx.get(col(c, 'ingredientCosts')),
  ])
  const sold = core.summarizeDishMargins(lineCosts.docs.map((doc) => core.LineCostSchema.parse(doc.data())))
  const state = new Map<string, core.StockState>()
  const costDocs = new Map(costs.docs.map((doc) => [doc.id, core.IngredientCostSchema.parse(doc.data())]))
  for (const doc of ingredients.docs) {
    const cost = costDocs.get(doc.id) ?? { valueCents: 0, lastCost: null }
    state.set(doc.id, { quantity: core.IngredientSchema.parse(doc.data()).quantity, valueCents: cost.valueCents, lastCost: cost.lastCost })
  }
  const recipeRows = recipes.docs.map((doc) => ({ ...core.RecipeSchema.parse(doc.data()), id: doc.id }))
  const itemIds = [...new Set(recipeRows.map((r) => r.itemId))]
  const itemSnaps = itemIds.length ? await c.tx.getAll(...itemIds.map((id) => col(c, 'menuItems').doc(id))) : []
  const menu = new Map(itemSnaps.filter((s) => s.exists).map((s) => [s.id, core.MenuItemSchema.parse(s.data())] as const))
  const theoretical = recipeRows.map((r) => {
    const cost = core.recipeCost(r, (id) => { const s = state.get(id); return s ? core.averageCost(s) : null })
    const item = menu.get(r.itemId)
    const priceCents = item ? (r.variantId ? item.variants.find((v) => v.id === r.variantId)?.priceCents : item.priceCents) ?? null : null
    const margin = item && priceCents !== null && cost.complete ? core.dishMargin({ grossCents: priceCents, taxRate: item.taxRate, costCents: cost.costCents }) : null
    return { recipeId: r.id, itemId: r.itemId, variantId: r.variantId, costCents: cost.costCents, complete: cost.complete, priceCents, marginBp: margin?.marginBp ?? null, foodCostBp: margin?.foodCostBp ?? null }
  })
  return { sold, theoretical, generatedAt: c.now }
}
