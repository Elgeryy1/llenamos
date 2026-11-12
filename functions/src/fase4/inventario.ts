/** Callables de inventario y escandallos (fase 4): ingredientes, recetas, merma, ajustes, recuentos y avisos. */
import { Timestamp } from 'firebase-admin/firestore'
import * as core from '@llenamos/core'
import { StockBook, neg } from './almacen'
import { col, fail, loadInventorySettings, missing, requireRevision, type Ctx, type Input } from './context'

const ts = Timestamp.fromMillis

export async function guardarConfiguracionInventario(c: Ctx, d: Input<'guardarConfiguracionInventario'>) {
  c.set(col(c, 'settings').doc('inventory'), d.settings)
  c.audit('inventory.settings_saved', 'Ajustes de inventario guardados.')
  return { ok: true as const }
}

/* Ingredientes ------------------------------------------------------------------------------ */

export async function guardarIngrediente(c: Ctx, d: Input<'guardarIngrediente'>) {
  const book = new StockBook(c, await loadInventorySettings(c))
  if (d.ingredientId === null) {
    const id = col(c, 'ingredients').doc().id
    const ingredient = core.IngredientSchema.parse({ ...d.ingredient, quantity: 0, revision: 1 })
    book.seedNew(id, ingredient)
    if (d.opening) {
      const step = core.addStock(core.emptyStock(), d.opening.quantity, d.opening.valueCents, d.opening.valueCents > 0)
      book.move(id, step.state, { kind: 'opening', quantity: d.opening.quantity, valueCents: d.opening.valueCents, requestId: d.requestId })
    } else book.reevaluate(id, ingredient)
    c.audit('inventory.ingredient_saved', `Ingrediente creado: ${ingredient.name}.`, { ingredientId: id })
    return { ingredientId: id, revision: 1 }
  }
  const ref = col(c, 'ingredients').doc(d.ingredientId)
  const snap = await c.tx.get(ref)
  if (!snap.exists) missing('No se encuentra el ingrediente.')
  const previous = core.IngredientSchema.parse(snap.data())
  requireRevision(previous.revision, d.expectedRevision!, 'El ingrediente')
  if (d.ingredient.unit !== previous.unit) {
    const moved = await c.tx.get(col(c, 'stockMovements').where('ingredientId', '==', d.ingredientId).limit(1))
    if (!moved.empty || previous.quantity !== 0) fail('La unidad no se puede cambiar: el ingrediente ya tiene movimientos.')
  }
  const next = core.IngredientSchema.parse({ ...d.ingredient, quantity: previous.quantity, revision: previous.revision + 1 })
  c.update(ref, { ...d.ingredient, revision: next.revision })
  await book.load([d.ingredientId])
  book.reevaluate(d.ingredientId, next)
  c.audit('inventory.ingredient_saved', `Ingrediente guardado: ${next.name}.`, { ingredientId: d.ingredientId })
  return { ingredientId: d.ingredientId, revision: next.revision }
}

/* Recetas ----------------------------------------------------------------------------------- */

export async function guardarReceta(c: Ctx, d: Input<'guardarReceta'>) {
  const r = d.recipe
  const itemSnap = await c.tx.get(col(c, 'menuItems').doc(r.itemId))
  if (!itemSnap.exists) missing('No se encuentra el plato de la carta.')
  const item = core.MenuItemSchema.parse(itemSnap.data())
  if (r.variantId !== null && !item.variants.some((v) => v.id === r.variantId)) fail('Esa variante no existe en el plato.')
  const options = new Set(item.modifierGroups.flatMap((g) => g.options.map((o) => o.id)))
  for (const optionId of Object.keys(r.optionLines)) if (!options.has(optionId)) fail('Un extra de la receta no existe en el plato.')

  const ids = [...r.lines, ...Object.values(r.optionLines).flat()].map((l) => l.ingredientId)
  const book = new StockBook(c, await loadInventorySettings(c))
  await book.load(ids)

  // Una sola receta por plato y variante.
  const same = await c.tx.get(col(c, 'recipes').where('itemId', '==', r.itemId))
  const clash = same.docs.find((x) => x.id !== d.recipeId && (x.get('variantId') ?? null) === r.variantId)
  if (clash) fail('Ya hay una receta para ese plato y esa variante.')

  let recipeId: string, version: number, bumped = true
  const ref = d.recipeId === null ? col(c, 'recipes').doc() : col(c, 'recipes').doc(d.recipeId)
  if (d.recipeId === null) {
    recipeId = ref.id; version = 1
    c.create(ref, { ...r, version })
  } else {
    const snap = await c.tx.get(ref)
    if (!snap.exists) missing('No se encuentra la receta.')
    const previous = core.RecipeSchema.parse(snap.data())
    requireRevision(previous.version, d.expectedVersion!, 'La receta')
    if (previous.itemId !== r.itemId || previous.variantId !== r.variantId) fail('No se puede cambiar el plato de una receta. Crea otra.')
    recipeId = ref.id
    version = core.nextRecipeVersion(previous, r)
    bumped = version !== previous.version
    c.update(ref, { ...r, version })
  }
  if (bumped) {
    const snapshot = core.RecipeVersionSchema.parse({ ...r, version, at: c.now, by: c.uid })
    c.create(ref.collection('versions').doc(String(version)), { ...snapshot, at: ts(snapshot.at) })
  }
  const cost = core.recipeCost(r, (id) => book.costOf(id))
  c.audit('inventory.recipe_saved', `Receta guardada: ${r.name}.`, { recipeId, itemId: r.itemId, version })
  return { recipeId, version, cost }
}

/* Merma y ajustes --------------------------------------------------------------------------- */

export async function registrarMerma(c: Ctx, d: Input<'registrarMerma'>) {
  const book = new StockBook(c, await loadInventorySettings(c))
  await book.load([d.ingredientId])
  const step = core.removeStock(book.state(d.ingredientId), d.quantity)
  const movementId = book.move(d.ingredientId, step.state, { kind: 'waste', quantity: -d.quantity, valueCents: neg(step.valueCents), wasteReason: d.wasteReason, reason: d.reason, requestId: d.requestId })
  c.audit('stock.waste', `Merma de ${book.ingredient(d.ingredientId).name}: ${core.WASTE_REASON_LABEL[d.wasteReason].toLowerCase()}.`, { ingredientId: d.ingredientId, movementId, wasteReason: d.wasteReason })
  return { movementId, quantityAfter: step.state.quantity }
}

export async function ajustarStock(c: Ctx, d: Input<'ajustarStock'>) {
  const book = new StockBook(c, await loadInventorySettings(c))
  await book.load([d.ingredientId])
  const before = book.state(d.ingredientId)
  let movementId: string, quantityAfter: number
  if (d.kind === 'adjustment' && d.quantity > 0) {
    const value = core.valueOfExtraUnits(before, d.quantity)
    const step = core.addStock(before, d.quantity, value, false)
    movementId = book.move(d.ingredientId, step.state, { kind: 'adjustment', quantity: d.quantity, valueCents: value, reason: d.reason, requestId: d.requestId })
    quantityAfter = step.state.quantity
  } else {
    const out = d.kind === 'adjustment' ? -d.quantity : d.quantity
    const step = core.removeStock(before, out)
    movementId = book.move(d.ingredientId, step.state, { kind: d.kind, quantity: -out, valueCents: neg(step.valueCents), reason: d.reason, requestId: d.requestId })
    quantityAfter = step.state.quantity
  }
  c.audit('stock.adjusted', `${d.kind === 'adjustment' ? 'Ajuste' : 'Devolución a proveedor'} de ${book.ingredient(d.ingredientId).name}.`, { ingredientId: d.ingredientId, movementId, reason: d.reason })
  return { movementId, quantityAfter }
}

/* Recuento ---------------------------------------------------------------------------------- */

async function readCount(c: Ctx, id: string) {
  const ref = col(c, 'stockCounts').doc(id)
  const snap = await c.tx.get(ref)
  if (!snap.exists) missing('No se encuentra el recuento.')
  return { ref, count: core.StockCountSchema.parse(snap.data()), raw: snap.data()! }
}

export async function iniciarRecuento(c: Ctx, d: Input<'iniciarRecuento'>) {
  let docs: { id: string; quantity: number }[]
  if (d.ingredientIds === null) {
    const snap = await c.tx.get(col(c, 'ingredients').where('active', '==', true))
    docs = snap.docs.map((x) => ({ id: x.id, quantity: core.IngredientSchema.parse(x.data()).quantity }))
  } else {
    const ids = [...new Set(d.ingredientIds)]
    const snaps = await c.tx.getAll(...ids.map((id) => col(c, 'ingredients').doc(id)))
    if (snaps.some((s) => !s.exists)) missing('Hay ingredientes que no existen.')
    docs = snaps.map((s) => ({ id: s.id, quantity: core.IngredientSchema.parse(s.data()).quantity }))
  }
  if (docs.length === 0) fail('No hay ingredientes que contar.')
  if (docs.length > 500) fail('Un recuento admite hasta 500 ingredientes. Cuéntalos por partes.')
  docs.sort((a, b) => (a.id < b.id ? -1 : 1))
  const count = core.StockCountSchema.parse({
    name: d.name, status: 'draft', startedAt: c.now, startedBy: c.uid, appliedAt: null, appliedBy: null, revision: 1,
    lines: docs.map((x) => ({ ingredientId: x.id, expectedAtStart: x.quantity, countedQuantity: null, countedAt: null })),
  })
  const ref = col(c, 'stockCounts').doc()
  c.create(ref, core.stockCountForWrite(count, ts))
  c.audit('stock.count_started', `Recuento iniciado: ${d.name}.`, { countId: ref.id, ingredients: docs.length })
  return { countId: ref.id, revision: 1, ingredients: docs.length }
}

export async function guardarRecuento(c: Ctx, d: Input<'guardarRecuento'>) {
  const { ref, count } = await readCount(c, d.countId)
  requireRevision(count.revision, d.expectedRevision, 'El recuento')
  if (count.status !== 'draft') fail('Ese recuento ya está cerrado.')
  const byId = new Map(count.lines.map((l) => [l.ingredientId, l]))
  for (const l of d.lines) if (!byId.has(l.ingredientId)) fail('Un ingrediente no pertenece a este recuento.')
  for (const l of d.lines) {
    const old = byId.get(l.ingredientId)!
    if (l.countedQuantity === null) byId.set(l.ingredientId, { ...old, countedQuantity: null, countedAt: null })
    // Si lo contado no cambia se conserva el instante de la cuenta: es lo que fija qué ventas son posteriores.
    else if (old.countedQuantity !== l.countedQuantity) byId.set(l.ingredientId, { ...old, countedQuantity: l.countedQuantity, countedAt: c.now })
  }
  const next = core.StockCountSchema.parse({ ...count, lines: count.lines.map((l) => byId.get(l.ingredientId)!), revision: count.revision + 1 })
  c.update(ref, { lines: core.stockCountForWrite(next, ts).lines, revision: next.revision })
  return { revision: next.revision }
}

export async function aplicarRecuento(c: Ctx, d: Input<'aplicarRecuento'>) {
  const { ref, count, raw } = await readCount(c, d.countId)
  if (count.status === 'applied' && raw.result) return raw.result as core.CallableOutput<'aplicarRecuento'>
  if (count.status !== 'draft') fail('Ese recuento está cancelado.')
  requireRevision(count.revision, d.expectedRevision, 'El recuento')
  const book = new StockBook(c, await loadInventorySettings(c))
  await book.load(count.lines.map((l) => l.ingredientId))
  // Lo movido desde que se contó cada línea: ventas, mermas y recepciones durante el conteo.
  const moved = new Map<string, number>()
  await Promise.all(count.lines.filter((l) => l.countedQuantity !== null && l.countedAt !== null).map(async (l) => {
    const snap = await c.tx.get(col(c, 'stockMovements').where('ingredientId', '==', l.ingredientId).where('at', '>', ts(l.countedAt!)))
    moved.set(l.ingredientId, snap.docs.reduce((s, x) => s + core.StockMovementSchema.parse(x.data()).quantity, 0))
  }))
  const plan = core.planCountAdjustments(count.lines, book.states(count.lines.map((l) => l.ingredientId)), moved)
  for (const a of plan.adjustments) {
    book.move(a.ingredientId, a.state, { kind: 'count_adjust', quantity: a.quantity, valueCents: a.valueCents, countId: d.countId, reason: `Recuento: ${count.name}`, requestId: d.requestId })
  }
  const result = {
    adjusted: plan.adjustments.map((a) => ({ ingredientId: a.ingredientId, quantity: a.quantity, valueCents: a.valueCents })),
    unchanged: plan.unchanged.length, uncounted: plan.uncounted.length,
  }
  c.update(ref, { status: 'applied', appliedAt: ts(c.now), appliedBy: c.uid, revision: count.revision + 1, result })
  c.audit('stock.count_applied', `Recuento aplicado: ${count.name}.`, { countId: d.countId, adjusted: result.adjusted.length, unchanged: result.unchanged, uncounted: result.uncounted })
  return result
}

export async function cancelarRecuento(c: Ctx, d: Input<'cancelarRecuento'>) {
  const { ref, count } = await readCount(c, d.countId)
  requireRevision(count.revision, d.expectedRevision, 'El recuento')
  if (!core.canCountTransition(count.status, 'cancelled')) fail('Ese recuento ya está cerrado.')
  c.update(ref, { status: 'cancelled', revision: count.revision + 1 })
  c.audit('stock.count_cancelled', `Recuento cancelado: ${count.name}.`, { countId: d.countId })
  return { ok: true as const }
}

/* Avisos ------------------------------------------------------------------------------------- */

export async function reconocerAvisoStock(c: Ctx, d: Input<'reconocerAvisoStock'>) {
  const ref = col(c, 'stockAlerts').doc(d.ingredientId)
  const snap = await c.tx.get(ref)
  if (!snap.exists) missing('No hay ningún aviso de stock para ese ingrediente.')
  const alert = core.StockAlertSchema.parse(snap.data())
  if (alert.status === 'resolved') fail('Ese aviso ya no está activo.')
  if (alert.status === 'acknowledged') return { alert }
  const next = { ...alert, status: 'acknowledged' as const, acknowledgedBy: c.uid }
  c.update(ref, { status: 'acknowledged', acknowledgedBy: c.uid })
  return { alert: next }
}
