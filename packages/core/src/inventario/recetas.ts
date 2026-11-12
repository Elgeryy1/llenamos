/**
 * Escandallos: necesidades por receta, coste teórico, margen y raciones posibles.
 *
 * Una receta liga un plato (y opcionalmente una variante) con sus ingredientes por ración. Los
 * extras elegidos suman sus propios ingredientes. El rendimiento (`yieldBp`) sube lo que hay que
 * comprar: 200 g netos con 80 % de rendimiento piden 250 g. Todo con enteros; los redondeos son
 * siempre hacia arriba en cantidades (nunca se pide de menos) y al más cercano en dinero.
 */
import { roundRatio } from "../caja/cuenta"
import type { TaxRate } from "../carta/modelo"
import { ceilDiv, costOfQuantity, type UnitCost } from "./coste"
import type { Recipe, RecipeEditable, RecipeLine, RecipeWithId } from "./modelo"

/** Cantidad a descontar por ración: neta dividida por el rendimiento, redondeada hacia arriba. */
export function requiredQuantity(line: Pick<RecipeLine, "quantity" | "yieldBp">): number {
  return ceilDiv(line.quantity * 10000, line.yieldBp)
}

export interface Requirement { ingredientId: string; quantity: number }

/**
 * Ingredientes que consume una línea de pedido: cantidad de raciones por (líneas de la receta +
 * líneas de cada extra elegido), sumados por ingrediente y ordenados por id.
 */
export function recipeRequirements(
  recipe: Pick<Recipe, "lines" | "optionLines">, order: { quantity: number; optionIds?: readonly string[] },
): Requirement[] {
  if (!Number.isSafeInteger(order.quantity) || order.quantity < 1) throw new Error("La cantidad debe ser un entero mayor que cero.")
  const total = new Map<string, number>()
  const sumar = (l: RecipeLine) => total.set(l.ingredientId, (total.get(l.ingredientId) ?? 0) + requiredQuantity(l) * order.quantity)
  recipe.lines.forEach(sumar)
  for (const id of new Set(order.optionIds ?? [])) (recipe.optionLines[id] ?? []).forEach(sumar)
  return [...total].map(([ingredientId, quantity]) => ({ ingredientId, quantity })).sort((a, b) => (a.ingredientId < b.ingredientId ? -1 : a.ingredientId > b.ingredientId ? 1 : 0))
}

export interface RecipeCost {
  /** Coste por ración con los costes medios actuales (sin IVA). */
  costCents: number
  /** false si falta el coste de algún ingrediente o la receta está vacía. */
  complete: boolean
  missing: string[]
}

/** Coste teórico de una ración (más los extras elegidos). Cada ingrediente se redondea y luego se suma. */
export function recipeCost(
  recipe: Pick<Recipe, "lines" | "optionLines" | "manualCostCents">, costOf: (ingredientId: string) => UnitCost | null, optionIds: readonly string[] = [],
): RecipeCost {
  const hayIngredientes = recipe.lines.length > 0 || optionIds.some((o) => (recipe.optionLines[o] ?? []).length > 0)
  if (!hayIngredientes) return recipe.manualCostCents !== null ? { costCents: recipe.manualCostCents, complete: true, missing: [] } : { costCents: 0, complete: false, missing: [] }
  const missing: string[] = []
  let costCents = 0
  for (const r of recipeRequirements(recipe, { quantity: 1, optionIds })) {
    const c = costOf(r.ingredientId)
    if (c === null) missing.push(r.ingredientId)
    else costCents += costOfQuantity(c, r.quantity)
  }
  return { costCents, complete: missing.length === 0, missing }
}

/** Receta de un plato: la de su variante si existe; si no, la común (sin variante). Solo activas. */
export function resolveRecipe(recipes: readonly RecipeWithId[], itemId: string, variantId: string | null): RecipeWithId | null {
  const delPlato = recipes.filter((r) => r.active && r.itemId === itemId)
  return (variantId !== null ? delPlato.find((r) => r.variantId === variantId) : undefined) ?? delPlato.find((r) => r.variantId === null) ?? null
}

/** Precio sin IVA a partir del bruto (IVA incluido) de la carta. */
export function netOfGross(grossCents: number, taxRate: TaxRate): number {
  return roundRatio(BigInt(grossCents) * BigInt(100), BigInt(100 + taxRate))
}

export interface DishMargin {
  netCents: number
  marginCents: number
  /** Margen sobre el precio sin IVA, en puntos básicos (6500 = 65 %). null si el precio es cero. */
  marginBp: number | null
  /** Coste sobre el precio sin IVA, en puntos básicos. */
  foodCostBp: number | null
}

export function dishMargin(p: { grossCents: number; taxRate: TaxRate; costCents: number }): DishMargin {
  const netCents = netOfGross(p.grossCents, p.taxRate)
  const marginCents = netCents - p.costCents
  return {
    netCents, marginCents,
    marginBp: netCents > 0 ? roundRatio(BigInt(marginCents) * BigInt(10000), BigInt(netCents)) : null,
    foodCostBp: netCents > 0 ? roundRatio(BigInt(p.costCents) * BigInt(10000), BigInt(netCents)) : null,
  }
}

/**
 * Raciones que se pueden hacer con lo que hay (el menor cociente entre existencias y necesidad).
 * null si la receta no tiene ingredientes. Es un dato para ayudar a rellenar el contador diario
 * de raciones, que sigue siendo manual y es el único que bloquea la venta.
 */
export function portionsPossible(recipe: Pick<Recipe, "lines" | "optionLines">, stockOf: (ingredientId: string) => number): number | null {
  if (recipe.lines.length === 0) return null
  let min = Number.MAX_SAFE_INTEGER
  for (const r of recipeRequirements(recipe, { quantity: 1 })) {
    const hay = stockOf(r.ingredientId)
    min = Math.min(min, hay <= 0 ? 0 : Math.floor(hay / r.quantity))
  }
  return min
}

function canonical(r: Pick<RecipeEditable, "lines" | "optionLines" | "manualCostCents">): string {
  const orden = (ls: readonly RecipeLine[]) => [...ls].sort((a, b) => (a.ingredientId < b.ingredientId ? -1 : 1)).map((l) => [l.ingredientId, l.quantity, l.yieldBp])
  return JSON.stringify([orden(r.lines), Object.keys(r.optionLines).sort().map((k) => [k, orden(r.optionLines[k] ?? [])]), r.manualCostCents])
}

/** La versión sube solo si cambia lo que consume o cuesta (ingredientes, extras, rendimiento, coste manual). */
export function nextRecipeVersion(previous: Pick<Recipe, "version" | "lines" | "optionLines" | "manualCostCents">, next: Pick<RecipeEditable, "lines" | "optionLines" | "manualCostCents">): number {
  return canonical(previous) === canonical(next) ? previous.version : previous.version + 1
}
