/**
 * Descuento al vender, al anular y por merma (proceso `consumirPorLinea`) y su reconciliación.
 *
 * El objetivo de cada línea sale solo de su estado actual y su historial (`lineConsumptionTarget`),
 * nunca del evento que despierta el proceso: un disparador repetido, perdido o fuera de orden no
 * duplica ni olvida nada. Los ids de movimiento son deterministas y el estado vive en `lineCosts`,
 * que se escribe en la misma transacción que los movimientos. Fuera de la transacción de sala a
 * propósito: un fallo de inventario nunca bloquea un pedido; lo recoge `reconciliarConsumos`.
 */
import { Timestamp } from 'firebase-admin/firestore'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import * as core from '@llenamos/core'
import { db, options } from '../shared'
import { StockBook } from './almacen'
import { col, loadInventorySettings, openContext, type Ctx } from './context'

const ts = Timestamp.fromMillis
const HOUR = 60 * 60_000
export type ConsumeOutcome = 'inactive' | 'gone' | 'skipped' | 'noop' | core.ConsumptionState

async function recipeFor(c: Ctx, itemId: string, variantId: string | null): Promise<core.RecipeWithId | null> {
  const snap = await c.tx.get(col(c, 'recipes').where('itemId', '==', itemId))
  return core.resolveRecipe(snap.docs.map((d) => ({ ...core.RecipeSchema.parse(d.data()), id: d.id })), itemId, variantId)
}

/** Lleva el consumo de una línea a lo que le toca por su estado. Devuelve el estado final o por qué no hizo nada. */
export async function consumeLine(rid: string, lid: string, lineId: string, now?: number): Promise<ConsumeOutcome> {
  return db.runTransaction(async (tx) => {
    const c = await openContext(tx, { rid, lid, now })
    if (!core.hasModule(c.restaurant, 'inventory')) return 'inactive'
    const settings = await loadInventorySettings(c)
    if (!settings.consumeOnSale) return 'inactive'
    const [lineSnap, costSnap] = await Promise.all([tx.get(col(c, 'orderLines').doc(lineId)), tx.get(col(c, 'lineCosts').doc(lineId))])
    if (!lineSnap.exists) return 'gone'
    const parsed = core.OrderLineSchema.safeParse(lineSnap.data())
    if (!parsed.success) return 'skipped'
    const line = parsed.data
    // La línea de un menú del día no consume: lo hacen sus platos.
    if (line.kind === 'menu' || !line.itemId) return 'skipped'
    const current = costSnap.exists ? core.LineCostSchema.parse(costSnap.data()) : null
    const steps = core.consumptionSteps(current?.state ?? 'none', core.lineConsumptionTarget(line.status, line.history))
    if (steps.length === 0) return 'noop'

    const book = new StockBook(c, settings)
    let state: core.ConsumptionState = current?.state ?? 'none'
    let cycle = current?.cycle ?? 0
    let costCents = current?.costCents ?? null
    let complete = current?.complete ?? true
    let recipeId = current?.recipeId ?? null
    let recipeVersion = current?.recipeVersion ?? null

    for (const step of steps) {
      if (step === 'consume') {
        const recipe = await recipeFor(c, line.itemId, line.variant?.id ?? null)
        const optionIds = line.modifiers.map((m) => m.optionId)
        const requirements = recipe ? core.recipeRequirements(recipe, { quantity: line.quantity, optionIds }) : []
        const manual = recipe && recipe.lines.length === 0 && recipe.manualCostCents !== null ? recipe.manualCostCents * line.quantity : null
        if (!recipe || (requirements.length === 0 && manual === null)) {
          // Sin receta (o vacía) la línea queda anotada y no se vuelve a evaluar.
          state = 'no_recipe'; cycle = current?.cycle ?? 0; costCents = null; complete = false; recipeId = null; recipeVersion = null
          break
        }
        const absent = await book.load(requirements.map((r) => r.ingredientId), true)
        const usable = requirements.filter((r) => !absent.includes(r.ingredientId))
        cycle += 1
        const plan = core.planConsumption(usable, book.states(usable.map((r) => r.ingredientId)))
        for (const m of plan.movements) {
          book.move(m.ingredientId, m.state, { id: core.consumptionMovementId(lineId, cycle, 'c', m.ingredientId), kind: 'sale', quantity: m.quantity, valueCents: m.valueCents, lineId })
        }
        costCents = manual ?? plan.costCents
        complete = plan.complete && absent.length === 0
        recipeId = recipe.id; recipeVersion = recipe.version
        state = 'consumed'
      } else if (step === 'reverse') {
        const moved = await tx.get(col(c, 'stockMovements').where('lineId', '==', lineId))
        const consumed = moved.docs
          .filter((d) => d.id.startsWith(`${lineId}.${cycle}.c.`))
          .map((d) => ({ ...core.StockMovementSchema.parse(d.data()) }))
        await book.load(consumed.map((m) => m.ingredientId), true)
        const usable = consumed.filter((m) => book.has(m.ingredientId))
        const plan = core.planReversal(usable, book.states(usable.map((m) => m.ingredientId)))
        for (const m of plan) {
          book.move(m.ingredientId, m.state, { id: core.consumptionMovementId(lineId, cycle, 'r', m.ingredientId), kind: 'sale_reversal', quantity: m.quantity, valueCents: m.valueCents, lineId })
        }
        state = 'reversed'
      } else {
        state = 'wasted'
      }
    }

    // El impuesto sale de la línea; las anteriores a la caja lo toman del plato.
    let taxRate: core.TaxRate | null = line.taxRate ?? null
    if (taxRate === null) {
      const item = await tx.get(col(c, 'menuItems').doc(line.itemId))
      taxRate = item.exists ? core.MenuItemSchema.parse(item.data()).taxRate : 10
    }
    const next = core.LineCostSchema.parse({
      orderId: line.orderId, itemId: line.itemId, variantId: line.variant?.id ?? null, quantity: line.quantity,
      recipeId, recipeVersion, state: state === 'none' ? 'reversed' : state, cycle, costCents, complete,
      grossCents: line.totalCents, taxRate, menuComponent: line.kind === 'menu_component', lineStatus: line.status, at: current?.at ?? line.firedAt ?? c.now,
    })
    const ref = col(c, 'lineCosts').doc(lineId)
    if (current) c.update(ref, core.lineCostForWrite(next, ts)); else c.create(ref, core.lineCostForWrite(next, ts))
    c.flush()
    return next.state
  }, { maxAttempts: 10 })
}

/** Disparador sobre cada escritura de una línea de pedido. */
export const consumirPorLinea = onDocumentWritten({ ...options, document: 'restaurants/{rid}/locations/{lid}/orderLines/{lineId}' }, async (event) => {
  const before = event.data?.before.data(), after = event.data?.after.data()
  // Si el estado no ha cambiado, la reconciliación ya cubre cualquier hueco.
  if (!after || (before && before.status === after.status)) return
  await consumeLine(event.params.rid, event.params.lid, event.params.lineId)
})

/** Revisa las líneas de las últimas 48 horas cuyo consumo no cuadre con su estado y las arregla. */
export async function reconcileConsumption(rid: string, lid: string, now = Date.now(), windowMs = 48 * HOUR) {
  const local = db.doc(`restaurants/${rid}/locations/${lid}`)
  const [restaurant, settingsSnap] = await Promise.all([db.doc(`restaurants/${rid}`).get(), local.collection('settings').doc('inventory').get()])
  const settings = settingsSnap.exists ? core.InventorySettingsSchema.parse(settingsSnap.data()) : core.defaultInventorySettings()
  if (!restaurant.exists || !core.hasModule(restaurant.data()!, 'inventory') || !settings.consumeOnSale) return { checked: 0, fixed: 0 }
  const lines = await local.collection('orderLines').where('placedAt', '>=', ts(now - windowMs)).get()
  let checked = 0, fixed = 0
  for (let i = 0; i < lines.docs.length; i += 200) {
    const chunk = lines.docs.slice(i, i + 200)
    const costs = await db.getAll(...chunk.map((d) => local.collection('lineCosts').doc(d.id)))
    for (const [j, doc] of chunk.entries()) {
      const line = core.OrderLineSchema.safeParse(doc.data())
      if (!line.success || line.data.kind === 'menu' || !line.data.itemId) continue
      checked++
      const state = costs[j]!.exists ? core.LineCostSchema.parse(costs[j]!.data()).state : 'none'
      if (core.consumptionSteps(state, core.lineConsumptionTarget(line.data.status, line.data.history)).length === 0) continue
      const outcome = await consumeLine(rid, lid, doc.id, now)
      if (outcome !== 'noop' && outcome !== 'skipped') fixed++
    }
  }
  return { checked, fixed }
}

export async function reconcileAll(now = Date.now()) {
  let checked = 0, fixed = 0
  for (const r of (await db.collection('restaurants').get()).docs) {
    for (const l of (await r.ref.collection('locations').get()).docs) {
      const out = await reconcileConsumption(r.id, l.id, now)
      checked += out.checked; fixed += out.fixed
    }
  }
  return { checked, fixed }
}
export const reconciliarConsumos = onSchedule({ ...options, schedule: 'every 60 minutes', timeoutSeconds: 540 }, async () => { await reconcileAll() })
