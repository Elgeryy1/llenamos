/**
 * Libro de existencias dentro de una transacción: carga ingredientes con su coste y su aviso,
 * guarda cada movimiento (inmutable) con la cantidad y el valor resultantes, y mantiene el aviso
 * de stock bajo en la misma transacción. Toda operación que cambie existencias pasa por aquí, bajo
 * el cerrojo consultivo del local, así que dos movimientos nunca leen el mismo estado a la vez.
 */
import * as core from '@llenamos/core'
import { TABLES, audit, create, getMany, missing, newId, replace, type Ctx } from '../fase4/contexto.js'

/** Evita el -0 al negar una cantidad. */
export const neg = (n: number) => (n === 0 ? 0 : -n)

interface Row {
  ingredient: core.Ingredient
  cost: core.IngredientCost
  costExists: boolean
  alert: core.StockAlert | null
  state: core.StockState
}
export interface Move {
  kind: core.MovementKind
  /** Con signo: entradas positivas, salidas negativas. */
  quantity: number
  /** Con el mismo signo que la cantidad. */
  valueCents: number
  id?: string
  reason?: string | null
  wasteReason?: core.WasteReason | null
  lineId?: string | null
  receiptId?: string | null
  countId?: string | null
  requestId?: string | null
}

export class StockBook {
  private rows = new Map<string, Row>()
  constructor(private c: Ctx, readonly settings: core.InventorySettings) {}

  /** Carga ingredientes (con coste y aviso). Con `tolerant`, los que no existen se devuelven en vez de fallar. */
  async load(ids: readonly string[], tolerant = false): Promise<string[]> {
    const todo = [...new Set(ids)].filter(id => !this.rows.has(id))
    if (!todo.length) return []
    const [ingredients, costs, alerts] = await Promise.all([
      getMany(this.c, TABLES.ingredients, todo, core.IngredientSchema),
      getMany(this.c, TABLES.costs, todo, core.IngredientCostSchema),
      getMany(this.c, TABLES.alerts, todo, core.StockAlertSchema),
    ])
    const absent: string[] = []
    for (const id of todo) {
      const ingredient = ingredients.get(id)
      if (!ingredient) { absent.push(id); continue }
      const cost = costs.get(id)
      const parsedCost = cost ?? { valueCents: 0, lastCost: null }
      this.rows.set(id, { ingredient, cost: parsedCost, costExists: !!cost, alert: alerts.get(id) ?? null, state: { quantity: ingredient.quantity, valueCents: parsedCost.valueCents, lastCost: parsedCost.lastCost } })
    }
    if (absent.length && !tolerant) missing('No se encuentra un ingrediente. Puede que se haya quitado.')
    return absent
  }

  /** Alta de un ingrediente nuevo: escribe el documento, su coste a cero y deja el libro listo para moverlo. */
  async seedNew(id: string, ingredient: core.Ingredient) {
    await create(this.c, TABLES.ingredients, id, ingredient)
    await create(this.c, TABLES.costs, id, { valueCents: 0, lastCost: null })
    this.rows.set(id, { ingredient, cost: { valueCents: 0, lastCost: null }, costExists: true, alert: null, state: { quantity: ingredient.quantity, valueCents: 0, lastCost: null } })
  }

  has(id: string) { return this.rows.has(id) }
  private row(id: string): Row {
    const r = this.rows.get(id)
    if (!r) throw new Error(`Ingrediente sin cargar: ${id}`)
    return r
  }
  ingredient(id: string): core.Ingredient { return this.row(id).ingredient }
  state(id: string): core.StockState { return this.row(id).state }
  costOf(id: string): core.UnitCost | null { return this.has(id) ? core.averageCost(this.row(id).state) : null }
  states(ids: readonly string[]): Map<string, core.StockState> { return new Map(ids.filter(id => this.has(id)).map(id => [id, this.row(id).state])) }

  /** Registra un movimiento y deja el ingrediente en el estado dado. Devuelve el id del movimiento. */
  async move(id: string, next: core.StockState, m: Move): Promise<string> {
    const r = this.row(id)
    const movementId = m.id ?? newId()
    const movement = core.StockMovementSchema.parse({
      ingredientId: id, kind: m.kind, quantity: m.quantity, valueCents: m.valueCents === 0 ? 0 : m.valueCents, quantityAfter: next.quantity, at: this.c.now, by: this.c.uid,
      reason: m.reason ?? null, wasteReason: m.wasteReason ?? null, lineId: m.lineId ?? null, receiptId: m.receiptId ?? null, countId: m.countId ?? null, requestId: m.requestId ?? null,
    })
    await create(this.c, TABLES.movements, movementId, movement)
    r.ingredient = { ...r.ingredient, quantity: next.quantity }
    await replace(this.c, TABLES.ingredients, id, r.ingredient)
    const cost = { valueCents: next.valueCents, lastCost: next.lastCost }
    if (r.costExists) await replace(this.c, TABLES.costs, id, cost)
    else { await create(this.c, TABLES.costs, id, cost); r.costExists = true }
    r.cost = cost
    r.state = next
    await this.evaluateAlert(id)
    return movementId
  }

  /** Tras cambiar el mínimo o el estado de un ingrediente sin mover existencias. */
  async reevaluate(id: string, ingredient: core.Ingredient) {
    this.row(id).ingredient = ingredient
    await this.evaluateAlert(id)
  }

  /** Abre, empeora, actualiza o resuelve el aviso de stock bajo (ver `alertAction`). */
  private async evaluateAlert(id: string) {
    const r = this.row(id)
    const quantity = r.state.quantity
    const level = core.alertsApply(this.settings, r.ingredient) ? core.stockLevel(quantity, r.ingredient.minQuantity) : 'ok'
    const act = core.alertAction(r.alert, level)
    const now = this.c.now
    const save = async (a: core.StockAlert) => {
      if (r.alert) await replace(this.c, TABLES.alerts, id, a); else await create(this.c, TABLES.alerts, id, a)
      r.alert = a
    }
    const label = (l: string) => (l === 'negative' ? 'existencias negativas' : l === 'out' ? 'agotado' : 'stock bajo')
    if (act.action === 'open') {
      await save({ level: act.level, quantity, minQuantity: r.ingredient.minQuantity, status: 'open', openedAt: now, lastChangedAt: now, acknowledgedBy: null, resolvedAt: null })
      await audit(this.c, 'stock.low', `${r.ingredient.name}: ${label(act.level)}.`, { ingredientId: id, level: act.level, quantity })
    } else if (act.action === 'escalate') {
      await save({ ...r.alert!, level: act.level, quantity, minQuantity: r.ingredient.minQuantity, status: 'open', lastChangedAt: now, acknowledgedBy: null })
      await audit(this.c, 'stock.low', `${r.ingredient.name}: ${label(act.level)}.`, { ingredientId: id, level: act.level, quantity })
    } else if (act.action === 'update') {
      await save({ ...r.alert!, level: act.level, quantity, minQuantity: r.ingredient.minQuantity, lastChangedAt: now })
    } else if (act.action === 'resolve') {
      await save({ ...r.alert!, status: 'resolved', quantity, resolvedAt: now, lastChangedAt: now })
    } else if (r.alert && r.alert.status !== 'resolved' && r.alert.quantity !== quantity) {
      await save({ ...r.alert, quantity })
    }
  }
}
