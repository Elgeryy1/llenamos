/**
 * Coste de las existencias: coste medio ponderado exacto, con enteros.
 *
 * Cada ingrediente guarda su cantidad (entero en unidad base, puede quedar negativa) y el valor
 * total de lo que hay (céntimos). El coste medio es `valor / cantidad`. Al consumir se resta el
 * valor proporcional con redondeo y el último consumo se lleva el resto exacto, así el valor
 * nunca se desvía por redondeos. Los costes van **sin IVA**. Si se vende con existencias a cero
 * o negativas (el almacén no siempre está al día), la venta no se bloquea: lo que falta se valora
 * al último coste conocido y la cantidad queda negativa hasta el próximo recuento o recepción.
 */
import { z } from "zod"
import { roundRatio } from "../caja/cuenta"
import { BaseUnitSchema, type BaseUnit } from "./unidades"

export const CentsSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const QuantitySchema = z.number().int().min(0).max(1_000_000_000_000)
export const SignedQuantitySchema = z.number().int().min(-1_000_000_000_000).max(1_000_000_000_000)

/** División entera hacia arriba de enteros no negativos, sin decimales flotantes. */
export function ceilDiv(a: number, b: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < 1) throw new Error("División no válida.")
  return Number((BigInt(a) + BigInt(b) - BigInt(1)) / BigInt(b))
}

/** `cents` céntimos por cada `perBase` unidades base (por ejemplo 850 por 1000 g). */
export const UnitCostSchema = z.object({ cents: CentsSchema, perBase: z.number().int().min(1).max(1_000_000_000_000) })
export type UnitCost = z.infer<typeof UnitCostSchema>

export function costOfQuantity(cost: UnitCost, quantity: number): number {
  if (!Number.isSafeInteger(quantity) || quantity < 0) throw new Error("Cantidad no válida.")
  return roundRatio(BigInt(quantity) * BigInt(cost.cents), BigInt(cost.perBase))
}

/** Coste por unidad base de un formato de proveedor (precio del formato y unidades base que trae). */
export function unitCostOfFormat(priceCents: number, baseQuantity: number): UnitCost {
  return UnitCostSchema.parse({ cents: priceCents, perBase: baseQuantity })
}

/** Coste por kg, l o ud para enseñarlo: 850 c por 1000 g → { cents: 850, unit: "kg" }. */
export function costPerDisplayUnit(cost: UnitCost, base: BaseUnit): { cents: number; unit: "kg" | "l" | "ud" } {
  const escala = base === "u" ? 1 : 1000
  return { cents: roundRatio(BigInt(cost.cents) * BigInt(escala), BigInt(cost.perBase)), unit: base === "g" ? "kg" : base === "ml" ? "l" : "ud" }
}

export const StockStateSchema = z.object({
  quantity: SignedQuantitySchema,
  valueCents: CentsSchema,
  lastCost: UnitCostSchema.nullable(),
})
export type StockState = z.infer<typeof StockStateSchema>

export function emptyStock(): StockState { return { quantity: 0, valueCents: 0, lastCost: null } }

/** Coste medio actual, o el último conocido si no hay existencias. */
export function averageCost(s: StockState): UnitCost | null {
  return s.quantity > 0 ? { cents: s.valueCents, perBase: s.quantity } : s.lastCost
}

export interface StockStep {
  state: StockState
  /** Valor del movimiento, siempre positivo; el signo lo pone el tipo de movimiento. */
  valueCents: number
  /** Unidades que faltaban en existencias al consumir. */
  shortfall: number
  /** Falta cantidad y tampoco hay coste conocido: esas unidades se valoran a cero. */
  unpriced: boolean
}

/**
 * Entra stock con un valor dado (recepción, devolución de un consumo, apertura). Si había
 * déficit, las unidades que lo cubren ya se valoraron al consumirlas: solo lo que sobra suma valor.
 * `updateLastCost` es true en recepciones y aperturas con precio real.
 */
export function addStock(s: StockState, quantity: number, valueCents: number, updateLastCost: boolean): StockStep {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error("La cantidad de entrada debe ser mayor que cero.")
  const nueva = s.quantity + quantity
  const valor = s.quantity >= 0 ? s.valueCents + valueCents : nueva <= 0 ? 0 : roundRatio(BigInt(valueCents) * BigInt(nueva), BigInt(quantity))
  const lastCost = updateLastCost ? { cents: valueCents, perBase: quantity } : s.lastCost
  return { state: { quantity: nueva, valueCents: valor, lastCost }, valueCents, shortfall: 0, unpriced: false }
}

/** Sale stock (venta, merma, devolución a proveedor, ajuste a la baja). Valora al coste medio. */
export function removeStock(s: StockState, quantity: number): StockStep {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error("La cantidad de salida debe ser mayor que cero.")
  if (s.quantity >= quantity) {
    const valor = quantity === s.quantity ? s.valueCents : roundRatio(BigInt(s.valueCents) * BigInt(quantity), BigInt(s.quantity))
    return { state: { quantity: s.quantity - quantity, valueCents: s.valueCents - valor, lastCost: s.lastCost }, valueCents: valor, shortfall: 0, unpriced: false }
  }
  const disponible = Math.max(0, s.quantity)
  const falta = quantity - disponible
  const extra = s.lastCost ? costOfQuantity(s.lastCost, falta) : 0
  return {
    state: { quantity: s.quantity - quantity, valueCents: 0, lastCost: s.lastCost },
    valueCents: s.valueCents + extra, shortfall: falta, unpriced: s.lastCost === null,
  }
}

/** Valor de unidades que aparecen sin factura (recuento al alza): coste medio o último coste. */
export function valueOfExtraUnits(s: StockState, quantity: number): number {
  const c = averageCost(s)
  return c ? costOfQuantity(c, quantity) : 0
}
