/**
 * Mínimos y avisos de stock bajo.
 *
 * Hay a lo sumo un aviso vivo por ingrediente (`stockAlerts/{ingredientId}`). Se abre al bajar
 * del mínimo, vuelve a sonar solo si empeora (bajo, agotado, negativo) y se resuelve al volver
 * por encima del mínimo. Un aviso reconocido no vuelve a avisar mientras no empeore. El aviso
 * es un documento visible en el panel y una entrada de actividad; no envía notificaciones push.
 */
import type { StockAlert, StockLevel } from "./modelo"

const GRAVEDAD: Record<StockLevel, number> = { ok: 0, low: 1, out: 2, negative: 3 }

/** Nivel según la cantidad y el mínimo. Con mínimo cero solo distingue agotado y negativo. */
export function stockLevel(quantity: number, minQuantity: number): StockLevel {
  if (quantity < 0) return "negative"
  if (quantity === 0) return "out"
  return minQuantity > 0 && quantity <= minQuantity ? "low" : "ok"
}

export type AlertAction =
  | { action: "none" }
  | { action: "open"; level: Exclude<StockLevel, "ok"> }
  | { action: "escalate"; level: Exclude<StockLevel, "ok"> }
  | { action: "update"; level: Exclude<StockLevel, "ok"> }
  | { action: "resolve" }

/** Qué hacer con el aviso de un ingrediente tras cambiar su cantidad. */
export function alertAction(previous: Pick<StockAlert, "status" | "level"> | null, level: StockLevel): AlertAction {
  const viva = previous !== null && previous.status !== "resolved"
  if (level === "ok") return viva ? { action: "resolve" } : { action: "none" }
  if (!viva) return { action: "open", level }
  if (GRAVEDAD[level] > GRAVEDAD[previous.level]) return { action: "escalate", level }
  if (level !== previous.level) return { action: "update", level }
  return { action: "none" }
}

/** Los avisos solo existen con aviso activado en los ajustes y un mínimo mayor que cero. */
export function alertsApply(settings: { lowStockAlerts: boolean }, ingredient: { minQuantity: number }): boolean {
  return settings.lowStockAlerts && ingredient.minQuantity > 0
}
