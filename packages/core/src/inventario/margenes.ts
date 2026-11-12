/**
 * Margen histórico por plato, a partir de las líneas vendidas con su coste congelado.
 *
 * Cuenta ingreso y coste del momento de la venta: cambiar después una receta o un precio de
 * proveedor no toca lo ya vendido. El ingreso es el precio de carta de la línea sin IVA. No
 * prorratea descuentos ni invitaciones de caja (fase 5). Los platos dentro de un menú del día
 * se separan: su ingreso está en el precio del menú, así que su coste no se compara con la línea.
 */
import { roundRatio } from "../caja/cuenta"
import { netOfGross } from "./recetas"
import type { LineCost } from "./modelo"

export interface DishMarginRow {
  itemId: string
  variantId: string | null
  inMenu: boolean
  /** Unidades vendidas (estado `consumed` o `no_recipe`). */
  units: number
  /** Las que tenían receta y coste. */
  coveredUnits: number
  grossCents: number
  netCents: number
  /** Ingreso sin IVA de las unidades con coste: base del margen. */
  coveredNetCents: number
  costCents: number
  /** Coste de lo anulado después de empezar a prepararlo. */
  wasteCostCents: number
  marginCents: number
  marginBp: number | null
}

export function summarizeDishMargins(lineCosts: readonly Pick<LineCost, "itemId" | "variantId" | "menuComponent" | "quantity" | "state" | "costCents" | "complete" | "grossCents" | "taxRate">[]): DishMarginRow[] {
  const rows = new Map<string, DishMarginRow>()
  for (const l of lineCosts) {
    if (l.state === "reversed") continue
    const key = JSON.stringify([l.itemId, l.variantId, l.menuComponent])
    let r = rows.get(key)
    if (!r) {
      r = { itemId: l.itemId, variantId: l.variantId, inMenu: l.menuComponent, units: 0, coveredUnits: 0, grossCents: 0, netCents: 0, coveredNetCents: 0, costCents: 0, wasteCostCents: 0, marginCents: 0, marginBp: null }
      rows.set(key, r)
    }
    if (l.state === "wasted") { r.wasteCostCents += l.costCents ?? 0; continue }
    const net = netOfGross(l.grossCents, l.taxRate)
    r.units += l.quantity
    r.grossCents += l.grossCents
    r.netCents += net
    if (l.state === "consumed" && l.costCents !== null && l.complete) {
      r.coveredUnits += l.quantity
      r.coveredNetCents += net
      r.costCents += l.costCents
    }
  }
  return [...rows.values()]
    .map((r) => {
      const marginCents = r.coveredNetCents - r.costCents
      const marginBp = r.coveredNetCents > 0 ? roundRatio(BigInt(marginCents) * BigInt(10000), BigInt(r.coveredNetCents)) : null
      return { ...r, marginCents, marginBp }
    })
    .sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : (a.variantId ?? "") < (b.variantId ?? "") ? -1 : 1))
}
