/**
 * Descuento al vender, al anular y por merma, y su reconciliación.
 *
 * ENTRADA: `consumeLine(client, scope, lineId, now?)`. Sala (V4) la llama, a través de su gancho `registerLineStateHook`, **en la misma transacción que guarda
 * el cambio de estado de la línea** (con ella ya escrita): así el descuento y la línea confirman o se deshacen juntos y
 * sala no tiene que decidir nada. `consumeLine` toma el cerrojo del local y **relee la línea con `FOR SHARE`** a través de
 * `lineSource().line()`; nunca usa una foto que le pasen, porque dos llamadas desordenadas (una anulación y luego un
 * `fired` antiguo) descontarían y devolverían dos veces. El objetivo sale solo del estado actual y el historial
 * (`lineConsumptionTarget`), los ids de movimiento son deterministas (`consumptionMovementId`) y el estado vive en
 * `inv_line_costs`: llamarla dos veces, a la vez o fuera de orden no duplica ni olvida nada. Caja (V5) no descuenta
 * stock: solo sala es dueña de la línea, así que no hay doble descuento.
 *
 * Un fallo de inventario no debe bloquear un pedido: el gancho de sala (`registerLineStateHook`, ver `index.ts`) la llama
 * en un SAVEPOINT y deja que `inventario.reconciliar` (trabajo periódico del worker) lo recoja.
 */
import type { PoolClient } from 'pg'
import * as core from '@llenamos/core'
import { StockBook } from './almacen.js'
import { TABLES, clock, flushEvents, get, getMany, listAll, loadInventorySettings, openSystemCtx, create, replace, type Ctx, type KnownRestaurant, type Scoped } from '../fase4/contexto.js'
import { lineSource, menuCatalog } from '../fase4/puertos.js'
import { JOB_RECONCILE, RECONCILE_EVERY_MS, scheduleLocalJob } from '../fase4/trabajos.js'
import type { WorkerHandler } from '../../worker/types.js'

const HOUR = 60 * 60_000
export type ConsumeOutcome = 'inactive' | 'gone' | 'skipped' | 'noop' | core.ConsumptionState

async function recipeFor(c: Ctx, itemId: string, variantId: string | null): Promise<core.RecipeWithId | null> {
  const recipes = await listAll(c, TABLES.recipes, core.RecipeSchema, 'item_id=$3', [itemId], 'id', 50)
  return core.resolveRecipe(recipes, itemId, variantId)
}

/** Lleva el consumo de una línea a lo que le toca por su estado. Devuelve el estado final o por qué no hizo nada. */
export async function consumeLine(client: PoolClient, scope: Scoped, lineId: string, now?: number, known?: KnownRestaurant): Promise<ConsumeOutcome> {
  const c = await openSystemCtx(client, scope, 'inventory', 'inv', now ?? clock.now(), known)
  if (!c) return 'inactive'
  const settings = await loadInventorySettings(c)
  if (!settings.consumeOnSale) return 'inactive'
  // Con el cerrojo del local tomado, el estado vigente de la línea (no una foto): ver la cabecera.
  const line = await lineSource().line(client, scope, lineId)
  if (line === null) return 'gone'
  // La línea de un menú del día no consume: lo hacen sus platos.
  if (line.kind === 'menu' || !line.itemId) return 'skipped'
  const current = await get(c, TABLES.lineCosts, lineId, core.LineCostSchema)
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
      const optionIds = line.modifiers.map(m => m.optionId)
      const requirements = recipe ? core.recipeRequirements(recipe, { quantity: line.quantity, optionIds }) : []
      const manual = recipe && recipe.lines.length === 0 && recipe.manualCostCents !== null ? recipe.manualCostCents * line.quantity : null
      if (!recipe || (requirements.length === 0 && manual === null)) {
        // Sin receta (o vacía) la línea queda anotada y no se vuelve a evaluar.
        state = 'no_recipe'; cycle = current?.cycle ?? 0; costCents = null; complete = false; recipeId = null; recipeVersion = null
        break
      }
      const absent = await book.load(requirements.map(r => r.ingredientId), true)
      const usable = requirements.filter(r => !absent.includes(r.ingredientId))
      cycle += 1
      const plan = core.planConsumption(usable, book.states(usable.map(r => r.ingredientId)))
      for (const m of plan.movements) {
        await book.move(m.ingredientId, m.state, { id: core.consumptionMovementId(lineId, cycle, 'c', m.ingredientId), kind: 'sale', quantity: m.quantity, valueCents: m.valueCents, lineId })
      }
      costCents = manual ?? plan.costCents
      complete = plan.complete && absent.length === 0
      recipeId = recipe.id; recipeVersion = recipe.version
      state = 'consumed'
    } else if (step === 'reverse') {
      // Solo los movimientos de consumo del ciclo actual (`{lineId}.{ciclo}.c.*`), por la línea indexada.
      const moved = await listAll(c, TABLES.movements, core.StockMovementSchema, 'line_id=$3 AND id LIKE $4', [lineId, `${lineId.replace(/[\\%_]/g, '\\$&')}.${cycle}.c.%`], 'id', 200)
      await book.load(moved.map(m => m.ingredientId), true)
      const usable = moved.filter(m => book.has(m.ingredientId))
      const plan = core.planReversal(usable, book.states(usable.map(m => m.ingredientId)))
      for (const m of plan) {
        await book.move(m.ingredientId, m.state, { id: core.consumptionMovementId(lineId, cycle, 'r', m.ingredientId), kind: 'sale_reversal', quantity: m.quantity, valueCents: m.valueCents, lineId })
      }
      state = 'reversed'
    } else {
      state = 'wasted'
    }
  }

  // El impuesto sale de la línea; las anteriores a la caja lo toman del plato.
  let taxRate: core.TaxRate | null = line.taxRate ?? null
  if (taxRate === null) taxRate = (await menuCatalog().item(client, scope, line.itemId))?.taxRate ?? 10
  const next = core.LineCostSchema.parse({
    orderId: line.orderId, itemId: line.itemId, variantId: line.variant?.id ?? null, quantity: line.quantity,
    recipeId, recipeVersion, state: state === 'none' ? 'reversed' : state, cycle, costCents, complete,
    grossCents: line.totalCents, taxRate, menuComponent: line.kind === 'menu_component', lineStatus: line.status, at: current?.at ?? line.firedAt ?? c.now,
  })
  if (current) await replace(c, TABLES.lineCosts, lineId, next); else await create(c, TABLES.lineCosts, lineId, next)
  await scheduleLocalJob(client, scope.restaurantId, scope.locationId, JOB_RECONCILE, RECONCILE_EVERY_MS, c.now)
  await flushEvents(c)
  return next.state
}

/**
 * Revisa las líneas de las últimas 48 horas cuyo consumo no cuadre con su estado y las arregla (cada una se relee
 * dentro de `consumeLine`). Lo lanza el worker por local como `inventario.reconciliar`. Pagina por id con la fuente
 * de líneas de sala; sin ella (`not-deployed`) falla, nunca da el trabajo por hecho.
 */
export async function reconcileConsumption(client: PoolClient, scope: Scoped, now = clock.now(), windowMs = 48 * HOUR) {
  const c = await openSystemCtx(client, scope, 'inventory', 'inv', now)
  if (!c || !(await loadInventorySettings(c)).consumeOnSale) return { checked: 0, fixed: 0 }
  let checked = 0, fixed = 0, after: string | null = null
  for (;;) {
    const page = await lineSource().recent(client, scope, now - windowMs, after, 200)
    if (!page.length) break
    const costs = await getMany(c, TABLES.lineCosts, page.map(p => p.id), core.LineCostSchema)
    for (const { id, line } of page) {
      if (line.kind === 'menu' || !line.itemId) continue
      checked++
      const state = costs.get(id)?.state ?? 'none'
      if (core.consumptionSteps(state, core.lineConsumptionTarget(line.status, line.history)).length === 0) continue
      const outcome = await consumeLine(client, scope, id, now)
      if (outcome !== 'noop' && outcome !== 'skipped') fixed++
    }
    after = page[page.length - 1]!.id
    if (page.length < 200) break
  }
  return { checked, fixed }
}

/** Manejador del worker (cada hora mientras haya ventas): reconcilia el local y reprograma si hubo actividad. */
export const reconciliarConsumosHandler: WorkerHandler = async (context) => {
  const locationId = String(context.item.payload.locationId ?? '')
  if (!locationId) return
  const scope = { restaurantId: context.item.restaurantId, locationId }
  await context.tenant(async client => {
    const now = context.now().getTime()
    const { checked } = await reconcileConsumption(client, scope, now)
    if (checked > 0) await scheduleLocalJob(client, scope.restaurantId, locationId, JOB_RECONCILE, RECONCILE_EVERY_MS, now)
  })
}
