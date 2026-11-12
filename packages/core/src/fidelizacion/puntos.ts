/**
 * Puntos de fidelidad (fase 5). Funciones puras: el servidor lee el libro, decide con estas
 * funciones y escribe movimiento, saldo y actividad en una transacción.
 *
 * - Se gana una sola vez por cuenta pagada (`earn.{billId}`), redondeando siempre hacia abajo.
 * - Cada tanda positiva (ganar, ajuste a favor, devolución de un canje) caduca por su cuenta.
 * - Lo que sale (canje, ajuste en contra, caducidad, devolución de la cuenta) se descuenta de las
 *   tandas que caducan antes (FIFO). Nunca queda saldo negativo.
 * - Un punto caducado no se puede canjear aunque el proceso de caducidad aún no haya pasado.
 */
import type { LoyaltyAccount, LoyaltyMovement, LoyaltySettings } from "./modelo"

const DAY_MS = 86_400_000

export type MovementWithId = LoyaltyMovement & { id: string }

/** Ids deterministas de los movimientos automáticos: un reintento no duplica. */
export const loyaltyMovementId = {
  earn: (billId: string) => `earn.${billId}`,
  earnReversal: (paymentId: string) => `earn_reversal.${paymentId}`,
  expire: (earnMovementId: string) => `expire.${earnMovementId}`,
  redeem: (redemptionId: string) => `redeem.${redemptionId}`,
  redeemReversal: (redemptionId: string) => `redeem_reversal.${redemptionId}`,
}

/**
 * Puntos que da una cuenta pagada. La base es lo cobrado de la cuenta (total tras invitaciones,
 * descuentos y canjes), sin propina. Por debajo del mínimo, o con el programa apagado, cero.
 */
export function pointsForSpend(paidCents: number, settings: Pick<LoyaltySettings, "enabled" | "pointsPerEuro" | "minSpendCents">): number {
  if (!Number.isSafeInteger(paidCents) || paidCents < 0) throw new Error("Importe no válido.")
  if (!settings.enabled || settings.pointsPerEuro === 0 || paidCents < settings.minSpendCents) return 0
  return Math.floor((paidCents * settings.pointsPerEuro) / 100)
}

/** Cuándo caduca una tanda ganada en `at`. */
export function lotExpiresAt(at: number, settings: Pick<LoyaltySettings, "expiryDays">): number | null {
  return settings.expiryDays === null ? null : at + settings.expiryDays * DAY_MS
}

export interface PointsLot {
  movementId: string
  at: number
  expiresAt: number | null
  initial: number
  remaining: number
}

const isPositive = (m: LoyaltyMovement) => m.points > 0
const alive = (lot: PointsLot, at: number) => lot.remaining > 0 && (lot.expiresAt === null || lot.expiresAt > at)
const fifo = (a: PointsLot, b: PointsLot) =>
  (a.expiresAt ?? Number.MAX_SAFE_INTEGER) - (b.expiresAt ?? Number.MAX_SAFE_INTEGER) || a.at - b.at || a.movementId.localeCompare(b.movementId)

function take(lots: PointsLot[], points: number, at: number, first: string | null): number {
  let left = points
  const own = first === null ? undefined : lots.find((l) => l.movementId === first)
  if (own && own.remaining > 0) {
    const n = Math.min(own.remaining, left)
    own.remaining -= n
    left -= n
  }
  for (const lot of lots.filter((l) => alive(l, at)).sort(fifo)) {
    if (left === 0) break
    const n = Math.min(lot.remaining, left)
    lot.remaining -= n
    left -= n
  }
  return left
}

/** Reproduce el libro en orden y devuelve las tandas con lo que les queda. */
export function replayLots(movements: readonly MovementWithId[]): PointsLot[] {
  const lots: PointsLot[] = []
  const ordered = [...movements].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
  for (const m of ordered) {
    if (isPositive(m)) {
      lots.push({ movementId: m.id, at: m.at, expiresAt: m.expiresAt, initial: m.points, remaining: m.points })
      continue
    }
    if (m.points === 0) continue
    // La caducidad descuenta exactamente su tanda, aunque ya no esté viva.
    if (m.kind === "expire") {
      const lot = lots.find((l) => l.movementId === m.earnMovementId)
      if (!lot || lot.remaining < -m.points) throw new Error(`La caducidad ${m.id} no cuadra con su tanda.`)
      lot.remaining += m.points
      continue
    }
    const left = take(lots, -m.points, m.at, m.kind === "earn_reversal" ? m.earnMovementId : null)
    if (left > 0) throw new Error(`El movimiento ${m.id} deja el saldo en negativo.`)
  }
  return lots
}

/** Puntos que se pueden canjear ahora (sin las tandas caducadas). */
export function availablePoints(movements: readonly MovementWithId[], now: number): number {
  return replayLots(movements).filter((l) => alive(l, now)).reduce((s, l) => s + l.remaining, 0)
}

/** Puntos que caducan antes de `until` (para avisar en la ficha). */
export function pointsExpiringBefore(movements: readonly MovementWithId[], now: number, until: number): number {
  return replayLots(movements).filter((l) => alive(l, now) && l.expiresAt !== null && l.expiresAt <= until).reduce((s, l) => s + l.remaining, 0)
}

export type RedemptionPlan = { ok: true; points: number; balanceAfter: number } | { ok: false; reason: "insufficient" | "invalid"; available: number }

/** Canje: nunca deja el saldo en negativo. */
export function planRedemption(movements: readonly MovementWithId[], points: number, now: number): RedemptionPlan {
  const available = availablePoints(movements, now)
  if (!Number.isSafeInteger(points) || points <= 0) return { ok: false, reason: "invalid", available }
  if (points > available) return { ok: false, reason: "insufficient", available }
  return { ok: true, points, balanceAfter: available - points }
}

/** Caducidades pendientes: una por tanda vencida con puntos, con id determinista. */
export function planExpirations(movements: readonly MovementWithId[], now: number): { id: string; earnMovementId: string; points: number }[] {
  const done = new Set(movements.filter((m) => m.kind === "expire").map((m) => m.earnMovementId))
  return replayLots(movements)
    .filter((l) => l.remaining > 0 && l.expiresAt !== null && l.expiresAt <= now && !done.has(l.movementId))
    .sort(fifo)
    .map((l) => ({ id: loyaltyMovementId.expire(l.movementId), earnMovementId: l.movementId, points: -l.remaining }))
}

/**
 * Devolución de una cuenta que ya dio puntos: se conservan los puntos en proporción a lo que queda
 * cobrado (redondeando hacia abajo) y se quita la diferencia, como mucho lo que haya de saldo. No
 * depende de los ajustes de hoy: si cambió el valor del punto, lo ganado no se recalcula. Lo que no
 * se puede recuperar porque ya se canjeó queda en `unrecovered` para enseñarlo, sin saldo negativo.
 */
export function planEarnReversal(p: {
  movements: readonly MovementWithId[]
  billId: string
  /** Lo cobrado al liquidar la cuenta (la base con la que se ganaron los puntos), sin propina. */
  originalPaidCents: number
  /** Lo cobrado tras todas las devoluciones de la cuenta, sin propina. */
  paidAfterRefundsCents: number
  now: number
  /** Puntos canjeables ahora, si el llamador los conoce por las tandas vivas (sin leer todo el libro). */
  available?: number
}): { points: number; unrecovered: number } {
  const earnId = loyaltyMovementId.earn(p.billId)
  const earn = p.movements.find((m) => m.id === earnId)
  if (!earn) return { points: 0, unrecovered: 0 }
  if (p.paidAfterRefundsCents < 0 || p.paidAfterRefundsCents > p.originalPaidCents) throw new Error("Importes de devolución no válidos.")
  const reversed = p.movements.filter((m) => m.kind === "earn_reversal" && m.earnMovementId === earnId).reduce((s, m) => s - m.points, 0)
  const kept = p.originalPaidCents === 0 ? 0 : Math.floor((earn.points * p.paidAfterRefundsCents) / p.originalPaidCents)
  const due = Math.max(0, earn.points - reversed - kept)
  const available = p.available ?? availablePoints(p.movements, p.now)
  const points = Math.min(due, available)
  return { points, unrecovered: due - points }
}

/** Contadores de la cuenta tras un movimiento. Falla si el saldo quedaría negativo. */
export function applyLoyaltyMovement(account: LoyaltyAccount, movement: Pick<LoyaltyMovement, "kind" | "points">): LoyaltyAccount {
  const balance = account.balance + movement.points
  if (balance < 0) throw new Error("El saldo de puntos no puede quedar en negativo.")
  const out = { ...account, balance, revision: account.revision + 1 }
  if (movement.kind === "earn" || (movement.kind === "adjust" && movement.points > 0)) out.earned += movement.points
  if (movement.kind === "earn_reversal" || (movement.kind === "adjust" && movement.points < 0)) out.earned += movement.points
  if (movement.kind === "redeem") out.redeemed -= movement.points
  if (movement.kind === "redeem_reversal") out.redeemed -= movement.points
  if (movement.kind === "expire") out.expired -= movement.points
  return out
}
