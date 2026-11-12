/**
 * Descuentos de una cuenta de caja (fase 5): cuánto descuenta un premio de puntos y cómo se
 * convierte un descuento (de premio o de promoción) en ajustes `discount` de la cuenta.
 * Funciones puras: el servidor las llama con la cuenta vigente leída en la misma transacción.
 */
import type { BillAdjustment } from "../caja/modelo"
import type { LoyaltyReward } from "./modelo"
import { allocateDiscount, discountAdjustmentId, type PromotionLine } from "./promociones"

/** Línea de la cuenta con su cantidad: un plato invitado vale como mucho el precio de una unidad. */
export type RewardLine = PromotionLine & { quantity: number }

export interface RewardDiscountPlan {
  /** Líneas que reciben el descuento (todas en un descuento; la primera con saldo en un plato). */
  lines: PromotionLine[]
  amountCents: number
}

/**
 * Descuento de un premio. `amount`: el valor del premio repartido entre la cuenta, sin pasar de
 * su saldo. `item`: una sola unidad del plato elegido, con el tope del premio. Importe 0 si el
 * premio no descuenta nada en esta cuenta.
 */
export function planRewardDiscount(reward: Pick<LoyaltyReward, "kind" | "valueCents" | "itemId">, lines: readonly RewardLine[]): RewardDiscountPlan {
  const candidates = lines.filter((l) => reward.kind === "amount" || (l.itemId === reward.itemId && l.balanceCents > 0))
  const selected = reward.kind === "item" ? candidates.slice(0, 1) : candidates
  const balance = selected.reduce((s, l) => s + l.balanceCents, 0)
  const unit = reward.kind === "item" && selected[0] ? Math.floor(selected[0].balanceCents / Math.max(1, selected[0].quantity)) : reward.valueCents
  const amountCents = Math.max(0, Math.min(reward.valueCents, balance, unit))
  return { lines: selected.map(({ lineId, itemId, categoryId, balanceCents }) => ({ lineId, itemId, categoryId, balanceCents })), amountCents }
}

/** Ajustes `discount` de la cuenta que representan un descuento repartido entre `lines`. */
export function discountAdjustments(p: {
  lines: readonly Pick<PromotionLine, "lineId" | "balanceCents">[]
  amountCents: number
  kind: "promotion" | "reward"
  sourceId: string
  reason: string
  at: number
  by: string
}): BillAdjustment[] {
  return allocateDiscount(p.lines, p.amountCents).map((part) => ({
    id: discountAdjustmentId(p.kind, p.sourceId, part.lineId),
    lineId: part.lineId,
    kind: "discount" as const,
    amountCents: part.amountCents,
    at: p.at,
    by: p.by,
    reason: p.reason,
    ...(p.kind === "promotion" ? { promotionId: p.sourceId } : { redemptionId: p.sourceId }),
  }))
}
