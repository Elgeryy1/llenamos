/**
 * Descuento al vender, al anular y por merma.
 *
 * Decisión: el almacén se descuenta cuando la línea **marcha** (entra en `fired`), no al pedir
 * ni al servir. Antes de marchar (`pending`, `held`) no se consume; al desmarchar una línea que
 * aún no se ha empezado, o anularla desde `fired`, se devuelve. Una línea anulada después de
 * empezar a prepararla (`preparing`, `ready`, `served`) ya no se devuelve: es una pérdida, y el
 * coste queda como `wasted`. El objetivo se calcula solo con el estado actual y el historial de la
 * línea, así un disparador repetido o perdido no duplica ni olvida nada.
 */
import { addStock, removeStock, type StockState } from "./coste"
import type { LineCostState } from "./modelo"
import type { Requirement } from "./recetas"
import type { LineStatus } from "../sala/modelo"

export type ConsumptionTarget = "consumed" | "reversed" | "wasted"
export type ConsumptionState = "none" | LineCostState
export type ConsumptionStep = "consume" | "reverse" | "mark_wasted"

const EMPEZADAS: readonly LineStatus[] = ["preparing", "ready", "served"]

/** Qué estado de consumo le toca a una línea según su estado actual y su historial. */
export function lineConsumptionTarget(status: LineStatus, history: readonly { to: LineStatus }[]): ConsumptionTarget {
  if (status === "fired" || status === "preparing" || status === "ready" || status === "served") return "consumed"
  if (status === "cancelled") return history.some((h) => EMPEZADAS.includes(h.to)) ? "wasted" : "reversed"
  return "reversed"
}

/** Pasos para llevar el consumo del estado actual al objetivo. `wasted` y `no_recipe` no se mueven. */
export function consumptionSteps(current: ConsumptionState, target: ConsumptionTarget): ConsumptionStep[] {
  if (current === "wasted" || current === "no_recipe") return []
  if (current === "consumed") return target === "reversed" ? ["reverse"] : target === "wasted" ? ["mark_wasted"] : []
  // none y reversed: no hay nada consumido ahora.
  if (target === "consumed") return ["consume"]
  if (target === "wasted") return ["consume", "mark_wasted"]
  return []
}

/** Estado del consumo tras aplicar los pasos. */
export function stateAfterSteps(current: ConsumptionState, steps: readonly ConsumptionStep[]): ConsumptionState {
  let s = current
  for (const step of steps) s = step === "consume" ? "consumed" : step === "reverse" ? "reversed" : "wasted"
  return s
}

export interface PlannedMovement {
  ingredientId: string
  /** Con signo: negativa al consumir, positiva al devolver. */
  quantity: number
  /** Con el mismo signo que la cantidad. */
  valueCents: number
  shortfall: number
  unpriced: boolean
  state: StockState
}

/**
 * Descuenta las necesidades de una línea de las existencias dadas. Nunca falla por falta de
 * stock: deja la cantidad en negativo y valora lo que falta al último coste (ver `removeStock`).
 */
export function planConsumption(requirements: readonly Requirement[], stocks: ReadonlyMap<string, StockState>): { movements: PlannedMovement[]; costCents: number; complete: boolean } {
  const movements: PlannedMovement[] = []
  for (const r of requirements) {
    const antes = stocks.get(r.ingredientId) ?? { quantity: 0, valueCents: 0, lastCost: null }
    const paso = removeStock(antes, r.quantity)
    movements.push({ ingredientId: r.ingredientId, quantity: -r.quantity, valueCents: -paso.valueCents, shortfall: paso.shortfall, unpriced: paso.unpriced, state: paso.state })
  }
  return { movements, costCents: movements.reduce((s, m) => s - m.valueCents, 0), complete: movements.every((m) => !m.unpriced) }
}

/** Devuelve exactamente lo consumido (misma cantidad y mismo valor) a las existencias actuales. */
export function planReversal(consumed: readonly { ingredientId: string; quantity: number; valueCents: number }[], stocks: ReadonlyMap<string, StockState>): PlannedMovement[] {
  return consumed.map((c) => {
    const antes = stocks.get(c.ingredientId) ?? { quantity: 0, valueCents: 0, lastCost: null }
    const paso = addStock(antes, -c.quantity, -c.valueCents, false)
    return { ingredientId: c.ingredientId, quantity: -c.quantity, valueCents: -c.valueCents, shortfall: 0, unpriced: false, state: paso.state }
  })
}

/** Id determinista del movimiento de un consumo (`c`) o de su devolución (`r`). */
export function consumptionMovementId(lineId: string, cycle: number, kind: "c" | "r", ingredientId: string): string {
  return `${lineId}.${cycle}.${kind}.${ingredientId}`
}
