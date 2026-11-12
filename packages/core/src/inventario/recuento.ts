/**
 * Recuento y reconciliación.
 *
 * Contar lleva tiempo y el servicio sigue: mientras se cuenta se vende y se recibe. Por eso cada
 * línea guarda cuándo se contó (`countedAt`) y el ajuste compara lo contado con lo que el libro
 * decía **en ese instante**: cantidad actual menos lo movido desde `countedAt`. Una diferencia
 * positiva entra al coste medio (o al último coste si no había existencias); una negativa sale
 * valorada al coste medio y es la pérdida del recuento.
 */
import { addStock, removeStock, valueOfExtraUnits, type StockState } from "./coste"
import type { CountStatus, StockCountLine } from "./modelo"

export const COUNT_TRANSITIONS: Record<CountStatus, readonly CountStatus[]> = {
  draft: ["applied", "cancelled"],
  applied: [],
  cancelled: [],
}
export const canCountTransition = (from: CountStatus, to: CountStatus): boolean => COUNT_TRANSITIONS[from].includes(to)

/** Diferencia de un recuento: contado menos lo que el sistema tenía en el momento de contar. */
export function countDifference(p: { currentQuantity: number; movedSinceCount: number; counted: number }): number {
  for (const n of [p.currentQuantity, p.movedSinceCount, p.counted]) if (!Number.isSafeInteger(n)) throw new Error("Cantidad no válida.")
  if (p.counted < 0) throw new Error("No se puede contar una cantidad negativa.")
  return p.counted - (p.currentQuantity - p.movedSinceCount)
}

export interface CountAdjustment {
  ingredientId: string
  /** Diferencia con signo; el movimiento tiene esta cantidad. */
  quantity: number
  /** Con el mismo signo: positivo si sobra, negativo si falta (la pérdida valorada). */
  valueCents: number
  state: StockState
}

/**
 * Ajustes a aplicar. `movedSince` es, por ingrediente, la suma con signo de los movimientos
 * posteriores a `countedAt`. Las líneas sin contar y las que no tienen diferencia no generan
 * movimiento. Orden estable por id de ingrediente.
 */
export function planCountAdjustments(
  lines: readonly Pick<StockCountLine, "ingredientId" | "countedQuantity">[],
  stocks: ReadonlyMap<string, StockState>, movedSince: ReadonlyMap<string, number>,
): { adjustments: CountAdjustment[]; uncounted: string[]; unchanged: string[] } {
  const adjustments: CountAdjustment[] = []
  const uncounted: string[] = []
  const unchanged: string[] = []
  for (const l of [...lines].sort((a, b) => (a.ingredientId < b.ingredientId ? -1 : a.ingredientId > b.ingredientId ? 1 : 0))) {
    if (l.countedQuantity === null) { uncounted.push(l.ingredientId); continue }
    const antes = stocks.get(l.ingredientId) ?? { quantity: 0, valueCents: 0, lastCost: null }
    const diff = countDifference({ currentQuantity: antes.quantity, movedSinceCount: movedSince.get(l.ingredientId) ?? 0, counted: l.countedQuantity })
    if (diff === 0) { unchanged.push(l.ingredientId); continue }
    if (diff > 0) {
      const valor = valueOfExtraUnits(antes, diff)
      adjustments.push({ ingredientId: l.ingredientId, quantity: diff, valueCents: valor, state: addStock(antes, diff, valor, false).state })
    } else {
      const paso = removeStock(antes, -diff)
      adjustments.push({ ingredientId: l.ingredientId, quantity: diff, valueCents: -paso.valueCents, state: paso.state })
    }
  }
  return { adjustments, uncounted, unchanged }
}
