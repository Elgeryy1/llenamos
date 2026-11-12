/** Inventario y escandallos (fase 4): ingredientes, recetas, merma, ajustes, recuentos y avisos. */
import * as core from '@llenamos/core'
import { StockBook, neg } from './almacen.js'
import { TABLES, audit, create, fail, get, list, listAll, loadInventorySettings, missing, must, newId, replace, requireRevision, saveSettings, type Ctx, type Input } from '../fase4/contexto.js'
import { menuCatalog } from '../fase4/puertos.js'

export async function guardarConfiguracionInventario(c: Ctx, d: Input<'guardarConfiguracionInventario'>) {
  await saveSettings(c, 'inventory', d.settings)
  await audit(c, 'inventory.settings_saved', 'Ajustes de inventario guardados.')
  return { ok: true as const }
}

/* Ingredientes ------------------------------------------------------------------------------ */

export async function guardarIngrediente(c: Ctx, d: Input<'guardarIngrediente'>) {
  const book = new StockBook(c, await loadInventorySettings(c))
  if (d.ingredientId === null) {
    const id = newId()
    const ingredient = core.IngredientSchema.parse({ ...d.ingredient, quantity: 0, revision: 1 })
    await book.seedNew(id, ingredient)
    if (d.opening) {
      const step = core.addStock(core.emptyStock(), d.opening.quantity, d.opening.valueCents, d.opening.valueCents > 0)
      await book.move(id, step.state, { kind: 'opening', quantity: d.opening.quantity, valueCents: d.opening.valueCents, requestId: d.requestId })
    } else await book.reevaluate(id, ingredient)
    await audit(c, 'inventory.ingredient_saved', `Ingrediente creado: ${ingredient.name}.`, { ingredientId: id })
    return { ingredientId: id, revision: 1 }
  }
  const previous = await must(c, TABLES.ingredients, d.ingredientId, core.IngredientSchema, 'el ingrediente')
  requireRevision(previous.revision, d.expectedRevision!, 'El ingrediente')
  if (d.ingredient.unit !== previous.unit) {
    const moved = await c.client.query('SELECT 1 FROM llenamos.inv_stock_movements WHERE restaurant_id=$1 AND location_id=$2 AND ingredient_id=$3 LIMIT 1', [c.rid, c.lid, d.ingredientId])
    if (moved.rowCount || previous.quantity !== 0) fail('La unidad no se puede cambiar: el ingrediente ya tiene movimientos.')
  }
  const next = core.IngredientSchema.parse({ ...d.ingredient, quantity: previous.quantity, revision: previous.revision + 1 })
  await replace(c, TABLES.ingredients, d.ingredientId, next)
  await book.load([d.ingredientId])
  await book.reevaluate(d.ingredientId, next)
  await audit(c, 'inventory.ingredient_saved', `Ingrediente guardado: ${next.name}.`, { ingredientId: d.ingredientId })
  return { ingredientId: d.ingredientId, revision: next.revision }
}

/* Recetas ----------------------------------------------------------------------------------- */

export async function guardarReceta(c: Ctx, d: Input<'guardarReceta'>) {
  const r = d.recipe
  const item = await menuCatalog().item(c.client, { restaurantId: c.rid, locationId: c.lid }, r.itemId) ?? missing('No se encuentra el plato de la carta.')
  if (r.variantId !== null && !item.variants.some(v => v.id === r.variantId)) fail('Esa variante no existe en el plato.')
  const options = new Set(item.modifierGroups.flatMap(g => g.options.map(o => o.id)))
  for (const optionId of Object.keys(r.optionLines)) if (!options.has(optionId)) fail('Un extra de la receta no existe en el plato.')

  const ids = [...r.lines, ...Object.values(r.optionLines).flat()].map(l => l.ingredientId)
  const book = new StockBook(c, await loadInventorySettings(c))
  await book.load(ids)

  // Una sola receta por plato y variante (también lo garantiza un índice único).
  const same = await listAll(c, TABLES.recipes, core.RecipeSchema, 'item_id=$3', [r.itemId], 'id', 50)
  const clash = same.find(x => x.id !== d.recipeId && (x.variantId ?? null) === r.variantId)
  if (clash) fail('Ya hay una receta para ese plato y esa variante.')

  let recipeId: string, version: number, bumped = true
  if (d.recipeId === null) {
    recipeId = newId(); version = 1
    await create(c, TABLES.recipes, recipeId, { ...r, version })
  } else {
    const previous = await must(c, TABLES.recipes, d.recipeId, core.RecipeSchema, 'la receta')
    requireRevision(previous.version, d.expectedVersion!, 'La receta')
    if (previous.itemId !== r.itemId || previous.variantId !== r.variantId) fail('No se puede cambiar el plato de una receta. Crea otra.')
    recipeId = d.recipeId
    version = core.nextRecipeVersion(previous, r)
    bumped = version !== previous.version
    await replace(c, TABLES.recipes, recipeId, { ...r, version })
  }
  if (bumped) await create(c, TABLES.recipeVersions, `${recipeId}.${version}`, { ...core.RecipeVersionSchema.parse({ ...r, version, at: c.now, by: c.uid }), recipeId })
  const cost = core.recipeCost(r, id => book.costOf(id))
  await audit(c, 'inventory.recipe_saved', `Receta guardada: ${r.name}.`, { recipeId, itemId: r.itemId, version })
  return { recipeId, version, cost }
}

/* Merma y ajustes --------------------------------------------------------------------------- */

export async function registrarMerma(c: Ctx, d: Input<'registrarMerma'>) {
  const book = new StockBook(c, await loadInventorySettings(c))
  await book.load([d.ingredientId])
  const step = core.removeStock(book.state(d.ingredientId), d.quantity)
  const movementId = await book.move(d.ingredientId, step.state, { kind: 'waste', quantity: -d.quantity, valueCents: neg(step.valueCents), wasteReason: d.wasteReason, reason: d.reason, requestId: d.requestId })
  await audit(c, 'stock.waste', `Merma de ${book.ingredient(d.ingredientId).name}: ${core.WASTE_REASON_LABEL[d.wasteReason].toLowerCase()}.`, { ingredientId: d.ingredientId, movementId, wasteReason: d.wasteReason })
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
    movementId = await book.move(d.ingredientId, step.state, { kind: 'adjustment', quantity: d.quantity, valueCents: value, reason: d.reason, requestId: d.requestId })
    quantityAfter = step.state.quantity
  } else {
    const out = d.kind === 'adjustment' ? -d.quantity : d.quantity
    const step = core.removeStock(before, out)
    movementId = await book.move(d.ingredientId, step.state, { kind: d.kind, quantity: -out, valueCents: neg(step.valueCents), reason: d.reason, requestId: d.requestId })
    quantityAfter = step.state.quantity
  }
  await audit(c, 'stock.adjusted', `${d.kind === 'adjustment' ? 'Ajuste' : 'Devolución a proveedor'} de ${book.ingredient(d.ingredientId).name}.`, { ingredientId: d.ingredientId, movementId, reason: d.reason })
  return { movementId, quantityAfter }
}

/* Recuento ---------------------------------------------------------------------------------- */

/** El documento crudo conserva el `result` de un recuento aplicado, que el esquema no declara. */
async function readCount(c: Ctx, id: string) {
  const row = (await c.client.query<{ doc: Record<string, unknown> }>('SELECT doc FROM llenamos.inv_counts WHERE restaurant_id=$1 AND location_id=$2 AND id=$3', [c.rid, c.lid, id])).rows[0]
  if (!row) missing('No se encuentra el recuento.')
  return { count: core.StockCountSchema.parse(row.doc), raw: row.doc }
}

export async function iniciarRecuento(c: Ctx, d: Input<'iniciarRecuento'>) {
  let docs: { id: string; quantity: number }[]
  if (d.ingredientIds === null) {
    docs = (await list(c, TABLES.ingredients, core.IngredientSchema, 'active', [], 'id', 501)).map(x => ({ id: x.id, quantity: x.quantity }))
  } else {
    const ids = [...new Set(d.ingredientIds)]
    const found = await list(c, TABLES.ingredients, core.IngredientSchema, 'id=ANY($3::text[])', [ids], 'id', 501)
    if (found.length !== ids.length) missing('Hay ingredientes que no existen.')
    docs = found.map(x => ({ id: x.id, quantity: x.quantity }))
  }
  if (docs.length === 0) fail('No hay ingredientes que contar.')
  if (docs.length > 500) fail('Un recuento admite hasta 500 ingredientes. Cuéntalos por partes.')
  docs.sort((a, b) => (a.id < b.id ? -1 : 1))
  const count = core.StockCountSchema.parse({
    name: d.name, status: 'draft', startedAt: c.now, startedBy: c.uid, appliedAt: null, appliedBy: null, revision: 1,
    lines: docs.map(x => ({ ingredientId: x.id, expectedAtStart: x.quantity, countedQuantity: null, countedAt: null })),
  })
  const id = newId()
  await create(c, TABLES.counts, id, count)
  await audit(c, 'stock.count_started', `Recuento iniciado: ${d.name}.`, { countId: id, ingredients: docs.length })
  return { countId: id, revision: 1, ingredients: docs.length }
}

export async function guardarRecuento(c: Ctx, d: Input<'guardarRecuento'>) {
  const { count, raw } = await readCount(c, d.countId)
  requireRevision(count.revision, d.expectedRevision, 'El recuento')
  if (count.status !== 'draft') fail('Ese recuento ya está cerrado.')
  const byId = new Map(count.lines.map(l => [l.ingredientId, l]))
  for (const l of d.lines) if (!byId.has(l.ingredientId)) fail('Un ingrediente no pertenece a este recuento.')
  for (const l of d.lines) {
    const old = byId.get(l.ingredientId)!
    if (l.countedQuantity === null) byId.set(l.ingredientId, { ...old, countedQuantity: null, countedAt: null })
    // Si lo contado no cambia se conserva el instante de la cuenta: es lo que fija qué ventas son posteriores.
    else if (old.countedQuantity !== l.countedQuantity) byId.set(l.ingredientId, { ...old, countedQuantity: l.countedQuantity, countedAt: c.now })
  }
  const next = core.StockCountSchema.parse({ ...count, lines: count.lines.map(l => byId.get(l.ingredientId)!), revision: count.revision + 1 })
  await replace(c, TABLES.counts, d.countId, { ...raw, lines: next.lines, revision: next.revision })
  return { revision: next.revision }
}

export async function aplicarRecuento(c: Ctx, d: Input<'aplicarRecuento'>) {
  const { count, raw } = await readCount(c, d.countId)
  if (count.status === 'applied' && raw.result) return raw.result as core.CallableOutput<'aplicarRecuento'>
  if (count.status !== 'draft') fail('Ese recuento está cancelado.')
  requireRevision(count.revision, d.expectedRevision, 'El recuento')
  const book = new StockBook(c, await loadInventorySettings(c))
  await book.load(count.lines.map(l => l.ingredientId))
  // Lo movido desde que se contó cada línea: ventas, mermas y recepciones durante el conteo.
  const counted = count.lines.filter(l => l.countedQuantity !== null && l.countedAt !== null)
  const moved = new Map<string, number>()
  if (counted.length) {
    const rows = (await c.client.query<{ ingredient_id: string; moved: string }>(
      `SELECT x.ingredient_id,coalesce(sum((m.doc->>'quantity')::bigint),0) AS moved
       FROM unnest($3::text[],$4::bigint[]) AS x(ingredient_id,counted_at)
       LEFT JOIN llenamos.inv_stock_movements m ON m.restaurant_id=$1 AND m.location_id=$2 AND m.ingredient_id=x.ingredient_id AND m.at>x.counted_at
       GROUP BY x.ingredient_id`, [c.rid, c.lid, counted.map(l => l.ingredientId), counted.map(l => l.countedAt)])).rows
    for (const r of rows) moved.set(r.ingredient_id, Number(r.moved))
  }
  const plan = core.planCountAdjustments(count.lines, book.states(count.lines.map(l => l.ingredientId)), moved)
  for (const a of plan.adjustments) {
    await book.move(a.ingredientId, a.state, { kind: 'count_adjust', quantity: a.quantity, valueCents: a.valueCents, countId: d.countId, reason: `Recuento: ${count.name}`, requestId: d.requestId })
  }
  const result = {
    adjusted: plan.adjustments.map(a => ({ ingredientId: a.ingredientId, quantity: a.quantity, valueCents: a.valueCents })),
    unchanged: plan.unchanged.length, uncounted: plan.uncounted.length,
  }
  await replace(c, TABLES.counts, d.countId, { ...raw, status: 'applied', appliedAt: c.now, appliedBy: c.uid, revision: count.revision + 1, result })
  await audit(c, 'stock.count_applied', `Recuento aplicado: ${count.name}.`, { countId: d.countId, adjusted: result.adjusted.length, unchanged: result.unchanged, uncounted: result.uncounted })
  return result
}

export async function cancelarRecuento(c: Ctx, d: Input<'cancelarRecuento'>) {
  const { count, raw } = await readCount(c, d.countId)
  requireRevision(count.revision, d.expectedRevision, 'El recuento')
  if (!core.canCountTransition(count.status, 'cancelled')) fail('Ese recuento ya está cerrado.')
  await replace(c, TABLES.counts, d.countId, { ...raw, status: 'cancelled', revision: count.revision + 1 })
  await audit(c, 'stock.count_cancelled', `Recuento cancelado: ${count.name}.`, { countId: d.countId })
  return { ok: true as const }
}

/* Avisos ------------------------------------------------------------------------------------- */

export async function reconocerAvisoStock(c: Ctx, d: Input<'reconocerAvisoStock'>) {
  const alert = await get(c, TABLES.alerts, d.ingredientId, core.StockAlertSchema) ?? missing('No hay ningún aviso de stock para ese ingrediente.')
  if (alert.status === 'resolved') fail('Ese aviso ya no está activo.')
  if (alert.status === 'acknowledged') return { alert }
  const next = { ...alert, status: 'acknowledged' as const, acknowledgedBy: c.uid }
  await replace(c, TABLES.alerts, d.ingredientId, next)
  return { alert: next }
}
