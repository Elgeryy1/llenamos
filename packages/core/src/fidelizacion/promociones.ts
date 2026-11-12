/**
 * Promociones validadas en el servidor (fase 5). La caja propone, el servidor decide: con la cuenta
 * vigente, el reloj del servidor y los cupos leídos en la misma transacción que aplica el descuento.
 *
 * - Una sola promoción por cuenta. Entre varias válidas gana el mayor descuento, después la mayor
 *   prioridad y después el id (orden estable).
 * - `exclusive` no se combina con un canje de puntos en la misma cuenta; `with_loyalty` sí.
 * - El descuento se reparte entre las líneas que entran por restos mayores y nunca pasa del saldo de
 *   una línea. Se guarda como ajustes `discount` de la cuenta, que la factura ya sabe restar.
 */
import { diaSemana, DIAS_SEMANA, horaAMinutos, horaLocal, sumarDias } from "../reservas/tiempo"
import type { Promotion, PromotionChannel } from "./modelo"

export type PromotionWithId = Promotion & { id: string }

export interface PromotionLine {
  lineId: string
  itemId: string | null
  categoryId: string | null
  /** Lo que queda por cobrar de la línea tras invitaciones, anulaciones y otros descuentos (IVA incluido). */
  balanceCents: number
}

export interface PromotionContext {
  now: number
  timezone: string
  locationId: string
  channel: PromotionChannel
  customerId: string | null
  /** Código escrito en caja, ya en mayúsculas; null si no se escribió ninguno. */
  code: string | null
  lines: readonly PromotionLine[]
  /** Saldo de la cuenta antes de esta promoción. */
  billBalanceCents: number
  /** Usos ya confirmados de esta promoción, en total y del cliente de la cuenta. */
  usage: { total: number; byCustomer: number }
  /** La cuenta ya tiene un canje de puntos aplicado. */
  hasLoyaltyRedemption: boolean
}

export const PROMOTION_REJECTIONS = [
  "not_active", "location", "channel", "dates", "weekday", "hours", "code", "min_spend",
  "usage_limit", "customer_required", "customer_limit", "no_lines", "stacking", "zero",
] as const
export type PromotionRejection = (typeof PROMOTION_REJECTIONS)[number]

export const PROMOTION_REJECTION_LABEL: Record<PromotionRejection, string> = {
  not_active: "La promoción no está activa.",
  location: "No vale en este local.",
  channel: "No vale para este tipo de pedido.",
  dates: "Está fuera de sus fechas.",
  weekday: "Hoy no vale.",
  hours: "No vale a esta hora.",
  code: "El código no es correcto.",
  min_spend: "La cuenta no llega al gasto mínimo.",
  usage_limit: "Se ha agotado el cupo de usos.",
  customer_required: "Hace falta un cliente en la cuenta.",
  customer_limit: "Este cliente ya la ha usado las veces permitidas.",
  no_lines: "Ningún plato de la cuenta entra en la promoción.",
  stacking: "No se puede juntar con un canje de puntos.",
  zero: "El descuento sale a cero.",
}

export type PromotionEvaluation =
  | { eligible: true; promotionId: string; discountCents: number; lineIds: string[] }
  | { eligible: false; promotionId: string; reason: PromotionRejection }

const isoWeekday = (fecha: string) => DIAS_SEMANA.indexOf(diaSemana(fecha)) + 1

/** ¿Vale a esta hora local? Una franja que cruza la medianoche cuenta para el día en que empieza. */
export function promotionTimeMatches(p: Pick<Promotion, "weekdays" | "timeWindows">, now: number, timezone: string): { ok: true } | { ok: false; reason: "weekday" | "hours" } {
  const { fecha, minutos } = horaLocal(now, timezone)
  const dayOk = (f: string) => p.weekdays.length === 0 || p.weekdays.includes(isoWeekday(f))
  if (p.timeWindows.length === 0) return dayOk(fecha) ? { ok: true } : { ok: false, reason: "weekday" }
  let anyDay = false
  for (const w of p.timeWindows) {
    const from = horaAMinutos(w.from)
    const to = horaAMinutos(w.to)
    if (from < to) {
      if (minutos >= from && minutos < to) {
        if (dayOk(fecha)) return { ok: true }
        anyDay = true
      }
    } else {
      if (minutos >= from) {
        if (dayOk(fecha)) return { ok: true }
        anyDay = true
      }
      if (minutos < to) {
        if (dayOk(sumarDias(fecha, -1))) return { ok: true }
        anyDay = true
      }
    }
  }
  return { ok: false, reason: anyDay ? "weekday" : "hours" }
}

export function evaluatePromotion(p: PromotionWithId, ctx: PromotionContext): PromotionEvaluation {
  const no = (reason: PromotionRejection): PromotionEvaluation => ({ eligible: false, promotionId: p.id, reason })
  if (p.status !== "active") return no("not_active")
  if (p.locationIds.length > 0 && !p.locationIds.includes(ctx.locationId)) return no("location")
  if (!p.channels.includes(ctx.channel)) return no("channel")
  if ((p.validFrom !== null && ctx.now < p.validFrom) || (p.validTo !== null && ctx.now >= p.validTo)) return no("dates")
  const time = promotionTimeMatches(p, ctx.now, ctx.timezone)
  if (!time.ok) return no(time.reason)
  if (p.code !== null && ctx.code !== p.code) return no("code")
  if (ctx.billBalanceCents < p.minSpendCents) return no("min_spend")
  if (p.usageLimit !== null && ctx.usage.total >= p.usageLimit) return no("usage_limit")
  if (p.perCustomerLimit !== null) {
    if (ctx.customerId === null) return no("customer_required")
    if (ctx.usage.byCustomer >= p.perCustomerLimit) return no("customer_limit")
  }
  if (p.stacking === "exclusive" && ctx.hasLoyaltyRedemption) return no("stacking")
  const lines = ctx.lines.filter((l) => {
    if (l.balanceCents <= 0) return false
    if (p.scope.kind === "bill") return true
    if (p.scope.kind === "items") return l.itemId !== null && p.scope.itemIds.includes(l.itemId)
    return l.categoryId !== null && p.scope.categoryIds.includes(l.categoryId)
  })
  if (lines.length === 0) return no("no_lines")
  const base = lines.reduce((s, l) => s + l.balanceCents, 0)
  let discount = p.discount.kind === "percent" ? Math.floor((base * p.discount.bp) / 10_000) : Math.min(p.discount.cents, base)
  if (p.maxDiscountCents !== null) discount = Math.min(discount, p.maxDiscountCents)
  if (discount <= 0) return no("zero")
  return { eligible: true, promotionId: p.id, discountCents: discount, lineIds: lines.map((l) => l.lineId) }
}

/** La mejor de las válidas, o null. `usageFor` da los usos de cada una. */
export function bestPromotion(
  promotions: readonly PromotionWithId[],
  ctx: Omit<PromotionContext, "usage">,
  usageFor: (promotionId: string) => PromotionContext["usage"],
): { best: Extract<PromotionEvaluation, { eligible: true }> | null; evaluations: PromotionEvaluation[] } {
  const evaluations = promotions.map((p) => evaluatePromotion(p, { ...ctx, usage: usageFor(p.id) }))
  const byId = new Map(promotions.map((p) => [p.id, p]))
  const eligible = evaluations.filter((e): e is Extract<PromotionEvaluation, { eligible: true }> => e.eligible)
  eligible.sort((a, b) => b.discountCents - a.discountCents || (byId.get(b.promotionId)?.priority ?? 0) - (byId.get(a.promotionId)?.priority ?? 0) || a.promotionId.localeCompare(b.promotionId))
  return { best: eligible[0] ?? null, evaluations }
}

/**
 * Reparte un descuento entre líneas en proporción a su saldo, por restos mayores (empate: orden de
 * entrada). La suma es exacta y ninguna línea recibe más que su saldo.
 */
export function allocateDiscount(lines: readonly Pick<PromotionLine, "lineId" | "balanceCents">[], discountCents: number): { lineId: string; amountCents: number }[] {
  const total = lines.reduce((s, l) => s + l.balanceCents, 0)
  if (!Number.isSafeInteger(discountCents) || discountCents < 0) throw new Error("Descuento no válido.")
  if (discountCents > total) throw new Error("El descuento pasa del saldo de las líneas.")
  if (discountCents === 0) return []
  const parts = lines.map((l, i) => {
    const exact = BigInt(l.balanceCents) * BigInt(discountCents)
    return { i, lineId: l.lineId, amount: Number(exact / BigInt(total)), rest: Number(exact % BigInt(total)), cap: l.balanceCents }
  })
  let left = discountCents - parts.reduce((s, p) => s + p.amount, 0)
  for (const p of [...parts].sort((a, b) => b.rest - a.rest || a.i - b.i)) {
    if (left === 0) break
    if (p.amount < p.cap) {
      p.amount += 1
      left -= 1
    }
  }
  return parts.filter((p) => p.amount > 0).map((p) => ({ lineId: p.lineId, amountCents: p.amount }))
}

/** Ids de los ajustes `discount` que crea una promoción o un canje: deterministas por cuenta. */
export function discountAdjustmentId(kind: "promotion" | "reward", sourceId: string, lineId: string): string {
  return `${kind === "promotion" ? "promo" : "reward"}.${sourceId}.${lineId}`
}
