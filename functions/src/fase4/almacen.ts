/**
 * Libro de existencias dentro de una transacción: carga ingredientes con su coste y su aviso,
 * guarda cada movimiento (inmutable) con la cantidad y el valor resultantes, y mantiene el aviso
 * de stock bajo en la misma transacción. Toda operación que cambie existencias pasa por aquí.
 */
import { Timestamp } from 'firebase-admin/firestore'
import * as core from '@llenamos/core'
import { col, newId, missing, type Ctx } from './context'

const ts = Timestamp.fromMillis
/** Evita el -0, que no es un entero para Firestore. */
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
    const todo = [...new Set(ids)].filter((id) => !this.rows.has(id))
    if (!todo.length) return []
    const refs = todo.flatMap((id) => [col(this.c, 'ingredients').doc(id), col(this.c, 'ingredientCosts').doc(id), col(this.c, 'stockAlerts').doc(id)])
    const snaps = await this.c.tx.getAll(...refs)
    const absent: string[] = []
    todo.forEach((id, i) => {
      const [ing, cost, alert] = [snaps[i * 3]!, snaps[i * 3 + 1]!, snaps[i * 3 + 2]!]
      if (!ing.exists) { absent.push(id); return }
      const ingredient = core.IngredientSchema.parse(ing.data())
      const parsedCost = cost.exists ? core.IngredientCostSchema.parse(cost.data()) : { valueCents: 0, lastCost: null }
      this.rows.set(id, {
        ingredient, cost: parsedCost, costExists: cost.exists, alert: alert.exists ? core.StockAlertSchema.parse(alert.data()) : null,
        state: { quantity: ingredient.quantity, valueCents: parsedCost.valueCents, lastCost: parsedCost.lastCost },
      })
    })
    if (absent.length && !tolerant) missing('No se encuentra un ingrediente. Puede que se haya quitado.')
    return absent
  }

  /** Alta de un ingrediente nuevo: escribe el documento, su coste a cero y deja el libro listo para moverlo. */
  seedNew(id: string, ingredient: core.Ingredient) {
    this.c.create(col(this.c, 'ingredients').doc(id), ingredient)
    this.c.create(col(this.c, 'ingredientCosts').doc(id), { valueCents: 0, lastCost: null })
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
  states(ids: readonly string[]): Map<string, core.StockState> { return new Map(ids.filter((id) => this.has(id)).map((id) => [id, this.row(id).state])) }

  /** Registra un movimiento y deja el ingrediente en el estado dado. Devuelve el id del movimiento. */
  move(id: string, next: core.StockState, m: Move): string {
    const r = this.row(id)
    const movementId = m.id ?? newId(this.c, 'stockMovements')
    const movement = core.StockMovementSchema.parse({
      ingredientId: id, kind: m.kind, quantity: m.quantity, valueCents: m.valueCents === 0 ? 0 : m.valueCents, quantityAfter: next.quantity, at: this.c.now, by: this.c.uid,
      reason: m.reason ?? null, wasteReason: m.wasteReason ?? null, lineId: m.lineId ?? null, receiptId: m.receiptId ?? null, countId: m.countId ?? null, requestId: m.requestId ?? null,
    })
    this.c.create(col(this.c, 'stockMovements').doc(movementId), core.stockMovementForWrite(movement, ts))
    this.c.update(col(this.c, 'ingredients').doc(id), { quantity: next.quantity })
    const cost = { valueCents: next.valueCents, lastCost: next.lastCost }
    if (r.costExists) this.c.update(col(this.c, 'ingredientCosts').doc(id), cost)
    else { this.c.create(col(this.c, 'ingredientCosts').doc(id), cost); r.costExists = true }
    r.ingredient = { ...r.ingredient, quantity: next.quantity }
    r.cost = cost
    r.state = next
    this.evaluateAlert(id)
    return movementId
  }

  /** Tras cambiar el mínimo o el estado de un ingrediente sin mover existencias. */
  reevaluate(id: string, ingredient: core.Ingredient) {
    this.row(id).ingredient = ingredient
    this.evaluateAlert(id)
  }

  /** Abre, empeora, actualiza o resuelve el aviso de stock bajo (ver `alertAction`). */
  private evaluateAlert(id: string) {
    const r = this.row(id)
    const quantity = r.state.quantity
    const level = core.alertsApply(this.settings, r.ingredient) ? core.stockLevel(quantity, r.ingredient.minQuantity) : 'ok'
    const act = core.alertAction(r.alert, level)
    const ref = col(this.c, 'stockAlerts').doc(id)
    const now = this.c.now
    const existed = r.alert !== null
    const save = (a: core.StockAlert, fields: Record<string, unknown>) => {
      if (existed) this.c.update(ref, fields); else this.c.create(ref, core.stockAlertForWrite(a, ts))
      r.alert = a
    }
    const label = (l: string) => (l === 'negative' ? 'existencias negativas' : l === 'out' ? 'agotado' : 'stock bajo')
    if (act.action === 'open') {
      const a: core.StockAlert = { level: act.level, quantity, minQuantity: r.ingredient.minQuantity, status: 'open', openedAt: now, lastChangedAt: now, acknowledgedBy: null, resolvedAt: null }
      save(a, core.stockAlertForWrite(a, ts))
      this.c.audit('stock.low', `${r.ingredient.name}: ${label(act.level)}.`, { ingredientId: id, level: act.level, quantity })
    } else if (act.action === 'escalate') {
      const a: core.StockAlert = { ...r.alert!, level: act.level, quantity, minQuantity: r.ingredient.minQuantity, status: 'open', lastChangedAt: now, acknowledgedBy: null }
      save(a, { level: act.level, quantity, minQuantity: r.ingredient.minQuantity, status: 'open', lastChangedAt: ts(now), acknowledgedBy: null })
      this.c.audit('stock.low', `${r.ingredient.name}: ${label(act.level)}.`, { ingredientId: id, level: act.level, quantity })
    } else if (act.action === 'update') {
      const a: core.StockAlert = { ...r.alert!, level: act.level, quantity, minQuantity: r.ingredient.minQuantity, lastChangedAt: now }
      save(a, { level: act.level, quantity, minQuantity: r.ingredient.minQuantity, lastChangedAt: ts(now) })
    } else if (act.action === 'resolve') {
      const a: core.StockAlert = { ...r.alert!, status: 'resolved', quantity, resolvedAt: now, lastChangedAt: now }
      save(a, { status: 'resolved', quantity, resolvedAt: ts(now), lastChangedAt: ts(now) })
    } else if (r.alert && r.alert.status !== 'resolved' && r.alert.quantity !== quantity) {
      save({ ...r.alert, quantity }, { quantity })
    }
  }
}
