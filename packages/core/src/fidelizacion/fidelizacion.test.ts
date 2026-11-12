import { describe, expect, it } from "vitest"
import {
  allocateDiscount, applyLoyaltyMovement, availablePoints, bestPromotion, createLocalRepite, evaluatePromotion, loyaltyMovementId,
  lotExpiresAt, nextRepiteAttempt, planEarnReversal, planExpirations, planRedemption, pointsExpiringBefore, pointsForSpend,
  PromotionInputSchema, repiteStampApplies, repiteVisitKey, settleRepiteOperation, defaultRepiteSettings, LoyaltyRewardInputSchema,
  type LoyaltyAccount, type MovementWithId, type PromotionContext, type PromotionWithId,
} from "../index"

const DAY = 86_400_000
const T0 = Date.UTC(2026, 0, 1, 12)
const settings = { enabled: true, pointsPerEuro: 1, minSpendCents: 0, expiryDays: 365 }

function mov(id: string, kind: MovementWithId["kind"], points: number, at: number, extra: Partial<MovementWithId> = {}): MovementWithId {
  return {
    id, customerId: "c1", kind, points, balanceAfter: 0, at, expiresAt: points > 0 ? lotExpiresAt(at, settings) : null,
    locationId: null, billId: null, redemptionId: null, earnMovementId: null, reason: null, by: null, ...extra,
  }
}

describe("puntos: acumular", () => {
  it("redondea siempre hacia abajo y respeta mínimo y programa apagado", () => {
    expect(pointsForSpend(1999, settings)).toBe(19)
    expect(pointsForSpend(99, settings)).toBe(0)
    expect(pointsForSpend(1999, { ...settings, pointsPerEuro: 3 })).toBe(59)
    expect(pointsForSpend(1500, { ...settings, minSpendCents: 2000 })).toBe(0)
    expect(pointsForSpend(5000, { ...settings, enabled: false })).toBe(0)
    expect(() => pointsForSpend(10.5, settings)).toThrow()
  })
  it("una sola vez por cuenta pagada: el id del movimiento es el de la cuenta", () => {
    expect(loyaltyMovementId.earn("b1")).toBe("earn.b1")
    expect(loyaltyMovementId.earn("b1")).toBe(loyaltyMovementId.earn("b1"))
    expect(loyaltyMovementId.expire("earn.b1")).toBe("expire.earn.b1")
  })
})

describe("puntos: canje y caducidad", () => {
  const book = [mov("earn.b1", "earn", 50, T0), mov("earn.b2", "earn", 30, T0 + 100 * DAY)]
  it("el canje nunca deja saldo negativo", () => {
    expect(planRedemption(book, 80, T0 + 101 * DAY)).toEqual({ ok: true, points: 80, balanceAfter: 0 })
    expect(planRedemption(book, 81, T0 + 101 * DAY)).toMatchObject({ ok: false, reason: "insufficient", available: 80 })
    expect(planRedemption(book, 0, T0 + 101 * DAY)).toMatchObject({ ok: false, reason: "invalid" })
  })
  it("los puntos caducados no se canjean aunque el proceso no haya pasado", () => {
    const after = T0 + 366 * DAY
    expect(availablePoints(book, after)).toBe(30)
    expect(planRedemption(book, 31, after)).toMatchObject({ ok: false, available: 30 })
    expect(pointsExpiringBefore(book, T0 + 300 * DAY, T0 + 366 * DAY)).toBe(50)
  })
  it("el canje gasta primero lo que caduca antes y la caducidad solo quita lo que queda", () => {
    const withRedeem = [...book, mov("redeem.x", "redeem", -40, T0 + 200 * DAY)]
    const exp = planExpirations(withRedeem, T0 + 366 * DAY)
    expect(exp).toEqual([{ id: "expire.earn.b1", earnMovementId: "earn.b1", points: -10 }])
    const done = [...withRedeem, mov("expire.earn.b1", "expire", -10, T0 + 366 * DAY, { earnMovementId: "earn.b1" })]
    expect(planExpirations(done, T0 + 400 * DAY)).toEqual([])
    expect(availablePoints(done, T0 + 400 * DAY)).toBe(30)
  })
  it("un libro que dejaría saldo negativo es un error", () => {
    expect(() => availablePoints([...book, mov("redeem.y", "redeem", -100, T0 + 101 * DAY)], T0 + 102 * DAY)).toThrow(/negativo/)
  })
  it("sin caducidad los puntos duran siempre", () => {
    const forever = [mov("adj", "adjust", 10, T0, { expiresAt: null })]
    expect(availablePoints(forever, T0 + 5000 * DAY)).toBe(10)
    expect(planExpirations(forever, T0 + 5000 * DAY)).toEqual([])
  })
})

describe("puntos: devolución de la cuenta", () => {
  it("quita en proporción a lo devuelto, como mucho el saldo, y apunta lo no recuperado", () => {
    const earn = mov("earn.b1", "earn", 50, T0)
    expect(planEarnReversal({ movements: [earn], billId: "b1", originalPaidCents: 5000, paidAfterRefundsCents: 2500, now: T0 + DAY })).toEqual({ points: 25, unrecovered: 0 })
    const spent = [earn, mov("redeem.r", "redeem", -45, T0 + DAY)]
    expect(planEarnReversal({ movements: spent, billId: "b1", originalPaidCents: 5000, paidAfterRefundsCents: 0, now: T0 + 2 * DAY })).toEqual({ points: 5, unrecovered: 45 })
    // Una segunda devolución no vuelve a quitar lo ya quitado.
    const once = [earn, mov("earn_reversal.p1", "earn_reversal", -25, T0 + DAY, { earnMovementId: "earn.b1" })]
    expect(planEarnReversal({ movements: once, billId: "b1", originalPaidCents: 5000, paidAfterRefundsCents: 2500, now: T0 + 2 * DAY })).toEqual({ points: 0, unrecovered: 0 })
    // Con el saldo conocido por las tandas vivas no hace falta reproducir el libro entero.
    expect(planEarnReversal({ movements: [earn], billId: "b1", originalPaidCents: 5000, paidAfterRefundsCents: 0, now: T0 + 2 * DAY, available: 5 })).toEqual({ points: 5, unrecovered: 45 })
    expect(planEarnReversal({ movements: [], billId: "b1", originalPaidCents: 5000, paidAfterRefundsCents: 0, now: T0 })).toEqual({ points: 0, unrecovered: 0 })
  })
  it("los contadores de la cuenta cuadran y nunca bajan de cero", () => {
    const acc: LoyaltyAccount = { customerId: "c1", status: "active", balance: 0, earned: 0, redeemed: 0, expired: 0, termsVersion: "1", enrolledAt: T0, enrolledBy: "u1", revision: 1 }
    const a1 = applyLoyaltyMovement(acc, { kind: "earn", points: 50 })
    const a2 = applyLoyaltyMovement(a1, { kind: "redeem", points: -20 })
    const a3 = applyLoyaltyMovement(a2, { kind: "expire", points: -10 })
    expect(a3).toMatchObject({ balance: 20, earned: 50, redeemed: 20, expired: 10, revision: 4 })
    expect(() => applyLoyaltyMovement(a3, { kind: "redeem", points: -21 })).toThrow(/negativo/)
  })
  it("un premio de plato necesita plato y uno de descuento no lo lleva", () => {
    expect(LoyaltyRewardInputSchema.safeParse({ name: "Postre", pointsCost: 100, kind: "item", valueCents: 600, itemId: null, active: true }).success).toBe(false)
    expect(LoyaltyRewardInputSchema.safeParse({ name: "5 €", pointsCost: 100, kind: "amount", valueCents: 500, itemId: null, active: true }).success).toBe(true)
  })
})

/* Promociones ------------------------------------------------------------------------ */

const TZ = "Europe/Madrid"
// Martes 10 de noviembre de 2026 a las 21:30 en Madrid.
const TUE_2130 = Date.UTC(2026, 10, 10, 20, 30)
const base = PromotionInputSchema.parse({
  name: "Martes", discount: { kind: "percent", bp: 1000 }, scope: { kind: "bill" }, locationIds: [], channels: ["dine_in"],
  validFrom: null, validTo: null, weekdays: [], timeWindows: [], minSpendCents: 0, maxDiscountCents: null,
  usageLimit: null, perCustomerLimit: null, code: null, stacking: "exclusive", priority: 0,
})
const promo = (id: string, over: Partial<PromotionWithId> = {}): PromotionWithId => ({ ...base, id, status: "active", uses: 0, revision: 1, ...over })
const ctx: PromotionContext = {
  now: TUE_2130, timezone: TZ, locationId: "centro", channel: "dine_in", customerId: "c1", code: null,
  lines: [{ lineId: "l1", itemId: "paella", categoryId: "arroces", balanceCents: 3000 }, { lineId: "l2", itemId: "vino", categoryId: "bebidas", balanceCents: 1999 }],
  billBalanceCents: 4999, usage: { total: 0, byCustomer: 0 }, hasLoyaltyRedemption: false,
}

describe("promociones validadas en el servidor", () => {
  it("porcentaje redondeado hacia abajo con tope", () => {
    expect(evaluatePromotion(promo("p"), ctx)).toEqual({ eligible: true, promotionId: "p", discountCents: 499, lineIds: ["l1", "l2"] })
    expect(evaluatePromotion(promo("p", { maxDiscountCents: 300 }), ctx)).toMatchObject({ discountCents: 300 })
    expect(evaluatePromotion(promo("p", { discount: { kind: "amount", cents: 9000 } }), ctx)).toMatchObject({ discountCents: 4999 })
  })
  it("condiciones: estado, local, canal, fechas, código, mínimo y ámbito", () => {
    const reason = (over: Partial<PromotionWithId>, c: Partial<PromotionContext> = {}) => {
      const r = evaluatePromotion(promo("p", over), { ...ctx, ...c })
      return r.eligible ? "ok" : r.reason
    }
    expect(reason({ status: "paused" })).toBe("not_active")
    expect(reason({ locationIds: ["otro"] })).toBe("location")
    expect(reason({ channels: ["takeaway"] })).toBe("channel")
    expect(reason({ validTo: TUE_2130 })).toBe("dates")
    expect(reason({ validFrom: TUE_2130 + 1 })).toBe("dates")
    expect(reason({ code: "OTONO" })).toBe("code")
    expect(reason({ code: "OTONO" }, { code: "OTONO" })).toBe("ok")
    expect(reason({ minSpendCents: 5000 })).toBe("min_spend")
    expect(reason({ scope: { kind: "items", itemIds: ["postre"] } })).toBe("no_lines")
    expect(evaluatePromotion(promo("p", { scope: { kind: "categories", categoryIds: ["arroces"] } }), ctx)).toMatchObject({ discountCents: 300, lineIds: ["l1"] })
  })
  it("cupos totales y por cliente", () => {
    const r = (over: Partial<PromotionWithId>, c: Partial<PromotionContext>) => evaluatePromotion(promo("p", over), { ...ctx, ...c })
    expect(r({ usageLimit: 10 }, { usage: { total: 10, byCustomer: 0 } })).toMatchObject({ eligible: false, reason: "usage_limit" })
    expect(r({ perCustomerLimit: 1 }, { customerId: null })).toMatchObject({ eligible: false, reason: "customer_required" })
    expect(r({ perCustomerLimit: 1 }, { usage: { total: 3, byCustomer: 1 } })).toMatchObject({ eligible: false, reason: "customer_limit" })
  })
  it("días y franjas, también cruzando la medianoche", () => {
    expect(evaluatePromotion(promo("p", { weekdays: [2] }), ctx).eligible).toBe(true)
    expect(evaluatePromotion(promo("p", { weekdays: [3] }), ctx)).toMatchObject({ reason: "weekday" })
    expect(evaluatePromotion(promo("p", { timeWindows: [{ from: "13:00", to: "16:00" }] }), ctx)).toMatchObject({ reason: "hours" })
    // Franja de martes de 21:00 a 01:00: el miércoles a las 00:30 todavía vale, el miércoles a las 21:30 no.
    const night = { weekdays: [2], timeWindows: [{ from: "21:00", to: "01:00" }] }
    expect(evaluatePromotion(promo("p", night), ctx).eligible).toBe(true)
    expect(evaluatePromotion(promo("p", night), { ...ctx, now: Date.UTC(2026, 10, 10, 23, 30) }).eligible).toBe(true)
    expect(evaluatePromotion(promo("p", night), { ...ctx, now: Date.UTC(2026, 10, 11, 20, 30) })).toMatchObject({ reason: "weekday" })
  })
  it("compatibilidad: una exclusiva no se junta con un canje de puntos", () => {
    expect(evaluatePromotion(promo("p"), { ...ctx, hasLoyaltyRedemption: true })).toMatchObject({ reason: "stacking" })
    expect(evaluatePromotion(promo("p", { stacking: "with_loyalty" }), { ...ctx, hasLoyaltyRedemption: true }).eligible).toBe(true)
  })
  it("gana el mayor descuento; empate por prioridad y después por id", () => {
    const list = [promo("b", { discount: { kind: "amount", cents: 500 } }), promo("a", { discount: { kind: "amount", cents: 500 } }), promo("c", { discount: { kind: "amount", cents: 400 }, priority: 99 })]
    const { best, evaluations } = bestPromotion(list, ctx, () => ({ total: 0, byCustomer: 0 }))
    expect(best?.promotionId).toBe("a")
    expect(evaluations).toHaveLength(3)
    const prio = bestPromotion([...list, promo("z", { discount: { kind: "amount", cents: 500 }, priority: 5 })], ctx, () => ({ total: 0, byCustomer: 0 }))
    expect(prio.best?.promotionId).toBe("z")
  })
  it("el reparto entre líneas es exacto y no pasa del saldo de ninguna", () => {
    const parts = allocateDiscount([{ lineId: "a", balanceCents: 1 }, { lineId: "b", balanceCents: 1 }, { lineId: "c", balanceCents: 1 }], 2)
    expect(parts.reduce((s, p) => s + p.amountCents, 0)).toBe(2)
    expect(parts.every((p) => p.amountCents <= 1)).toBe(true)
    expect(allocateDiscount([{ lineId: "a", balanceCents: 3000 }, { lineId: "b", balanceCents: 1999 }], 499)).toEqual([{ lineId: "a", amountCents: 299 }, { lineId: "b", amountCents: 200 }])
    expect(() => allocateDiscount([{ lineId: "a", balanceCents: 10 }], 11)).toThrow()
  })
  it("la entrada del encargado se valida: fechas en orden y código en mayúsculas", () => {
    expect(PromotionInputSchema.parse({ ...base, code: "otono26" }).code).toBe("OTONO26")
    expect(PromotionInputSchema.safeParse({ ...base, validFrom: 10, validTo: 5 }).success).toBe(false)
    expect(PromotionInputSchema.safeParse({ ...base, weekdays: [1, 1] }).success).toBe(false)
    expect(PromotionInputSchema.safeParse({ ...base, uses: 3 }).success).toBe(false)
  })
})

/* Repite ------------------------------------------------------------------------------ */

describe("Repite: adaptador y doble local", () => {
  it("la clave de visita es la misma al sentar y al cobrar", () => {
    const seated = repiteVisitKey({ restaurantId: "r1", reservationId: "res1", sessionId: "s1" })
    const paid = repiteVisitKey({ restaurantId: "r1", reservationId: "res1", sessionId: "s1" })
    expect(seated).toBe(paid)
    expect(repiteVisitKey({ restaurantId: "r1", reservationId: null, sessionId: "s1" })).toBe("r1.s.s1")
    expect(() => repiteVisitKey({ restaurantId: "r1", reservationId: null, sessionId: null })).toThrow()
  })
  it("solo da sello si está conectado y el momento coincide", () => {
    const s = { ...defaultRepiteSettings(), enabled: true, merchantId: "lumbre" }
    expect(repiteStampApplies(s, "seated")).toBe(true)
    expect(repiteStampApplies(s, "paid")).toBe(false)
    expect(repiteStampApplies({ ...s, stampOn: "both" }, "paid")).toBe(true)
    expect(repiteStampApplies({ ...s, merchantId: null }, "seated")).toBe(false)
  })
  it("sello al sentar y al cobrar la misma visita: uno solo", async () => {
    let now = T0
    const local = createLocalRepite({ merchantIds: ["lumbre"], stampsForReward: 3, now: () => now })
    const card = await local.adapter.createCard({ merchantId: "lumbre", externalRef: "ref_abcdefghijklmnop", displayName: "Ana", language: "es", idempotencyKey: "card.c1" })
    expect(card.ok).toBe(true)
    if (!card.ok) return
    const again = await local.adapter.createCard({ merchantId: "lumbre", externalRef: "ref_abcdefghijklmnop", displayName: "Ana", language: "es", idempotencyKey: "otra" })
    expect(again.ok && again.value.cardId).toBe(card.value.cardId)
    const visit = repiteVisitKey({ restaurantId: "r1", reservationId: "res1", sessionId: "s1" })
    const a = await local.adapter.addStamp({ merchantId: "lumbre", cardId: card.value.cardId, visitKey: visit, trigger: "seated", occurredAt: now, idempotencyKey: `stamp.${visit}` })
    now += 2 * 3_600_000
    const b = await local.adapter.addStamp({ merchantId: "lumbre", cardId: card.value.cardId, visitKey: visit, trigger: "paid", occurredAt: now, idempotencyKey: `stamp.${visit}.paid` })
    const c = await local.adapter.addStamp({ merchantId: "lumbre", cardId: card.value.cardId, visitKey: visit, trigger: "seated", occurredAt: now, idempotencyKey: `stamp.${visit}` })
    expect(a.ok && a.value).toMatchObject({ stamps: 1, duplicate: false })
    expect(b.ok && b.value.duplicate).toBe(true)
    expect(c.ok && c.value.duplicate).toBe(true)
    expect(local.stampsCount()).toBe(1)
    const state = await local.adapter.getCard({ merchantId: "lumbre", cardId: card.value.cardId })
    expect(state.ok && state.value.stamps).toBe(1)
  })
  it("otro comercio no puede tocar la tarjeta y los errores se reintentan con espera", async () => {
    const local = createLocalRepite({ merchantIds: ["lumbre", "otro"], now: () => T0 })
    const card = await local.adapter.createCard({ merchantId: "lumbre", externalRef: "ref_abcdefghijklmnop", displayName: "Ana", language: "es", idempotencyKey: "k" })
    if (!card.ok) throw new Error("sin tarjeta")
    const other = await local.adapter.getCard({ merchantId: "otro", cardId: card.value.cardId })
    expect(other).toMatchObject({ ok: false, error: { code: "not_found" } })
    expect(await local.adapter.getCard({ merchantId: "nadie", cardId: card.value.cardId })).toMatchObject({ ok: false, error: { code: "unauthorized" } })
    local.failNext({ code: "unavailable", message: "Caído", retryable: true })
    const failed = await local.adapter.addStamp({ merchantId: "lumbre", cardId: card.value.cardId, visitKey: "v", trigger: "paid", occurredAt: T0, idempotencyKey: "stamp.v" })
    expect(settleRepiteOperation({ attempts: 0 }, failed, T0)).toMatchObject({ status: "queued", attempts: 1, nextAttemptAt: T0 + 30_000 })
    const ok = await local.adapter.addStamp({ merchantId: "lumbre", cardId: card.value.cardId, visitKey: "v", trigger: "paid", occurredAt: T0, idempotencyKey: "stamp.v" })
    expect(settleRepiteOperation({ attempts: 1 }, ok, T0)).toMatchObject({ status: "done", nextAttemptAt: null })
    expect(nextRepiteAttempt(12, T0)).toBeNull()
    expect(nextRepiteAttempt(11, T0)).toBe(T0 + 6 * 3_600_000)
    expect(settleRepiteOperation({ attempts: 0 }, { ok: false, error: { code: "not_configured", message: "", retryable: false } }, T0).status).toBe("not_configured")
  })
  it("el aviso «te echamos de menos» solo va a tarjetas en el Wallet y una vez por semana", async () => {
    let now = T0
    const local = createLocalRepite({ merchantIds: ["lumbre"], now: () => now })
    const card = await local.adapter.createCard({ merchantId: "lumbre", externalRef: "ref_abcdefghijklmnop", displayName: "Ana", language: "es", idempotencyKey: "k" })
    if (!card.ok) throw new Error("sin tarjeta")
    const send = (key: string) => local.adapter.sendWeMissYou({ merchantId: "lumbre", cardId: card.value.cardId, idempotencyKey: key })
    expect(await send("m1")).toMatchObject({ ok: true, value: { status: "not_in_wallet" } })
    local.markInWallet(card.value.cardId)
    expect(await send("m2")).toMatchObject({ ok: true, value: { status: "scheduled" } })
    expect(await send("m2")).toMatchObject({ ok: true, value: { duplicate: true } })
    now += 3 * DAY
    expect(await send("m3")).toMatchObject({ ok: true, value: { status: "rate_limited" } })
    const report = await local.adapter.monthReport({ merchantId: "lumbre", month: "2026-01" })
    expect(report).toMatchObject({ ok: true, value: { month: "2026-01", newCustomers: 1, previous: null } })
    expect(await local.adapter.monthReport({ merchantId: "lumbre", month: "2026-13" })).toMatchObject({ ok: false, error: { code: "invalid" } })
    // Borrado por privacidad: idempotente y la tarjeta deja de existir.
    expect(await local.adapter.removeCard({ merchantId: "lumbre", cardId: card.value.cardId, idempotencyKey: "remove.c1" })).toMatchObject({ ok: true, value: { removed: true, duplicate: false } })
    expect(await local.adapter.removeCard({ merchantId: "lumbre", cardId: card.value.cardId, idempotencyKey: "remove.c1" })).toMatchObject({ ok: true, value: { duplicate: true } })
    expect(await local.adapter.getCard({ merchantId: "lumbre", cardId: card.value.cardId })).toMatchObject({ ok: false, error: { code: "not_found" } })
  })
})
