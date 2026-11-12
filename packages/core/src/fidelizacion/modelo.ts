/**
 * Fidelización (fase 5): ajustes del programa de puntos, cuentas, libro de movimientos, premios,
 * canjes y promociones. Todo lo escribe el servidor. Dinero en céntimos enteros y puntos enteros.
 * Core no lee el reloj: los instantes entran como dato (ms UTC) y en Firestore son `Timestamp`.
 */
import { z } from "zod"
import { AmountCentsSchema } from "../caja/modelo"
import { HoraSchema } from "../reservas/tiempo"
import { DocIdSchema } from "../model"
import { MillisSchema, TimestampSchema } from "../timestamp"

export const PointsSchema = z.number().int().min(0).max(100_000_000)
export const SignedPointsSchema = z.number().int().min(-100_000_000).max(100_000_000)
const Revision = z.number().int().min(1)
const Text = (max: number) => z.string().trim().min(1).max(max)

/* Programa de puntos ------------------------------------------------------ */

export const LoyaltySettingsSchema = z.strictObject({
  enabled: z.boolean(),
  /** Puntos por cada euro (100 céntimos) cobrado, sin propina. 0 apaga la acumulación. */
  pointsPerEuro: z.number().int().min(0).max(100),
  /** Gasto mínimo de la cuenta para dar puntos, en céntimos. */
  minSpendCents: AmountCentsSchema,
  /** Días que vale cada tanda de puntos desde que se gana. null = no caducan. */
  expiryDays: z.number().int().min(30).max(1825).nullable(),
  /** Versión de las condiciones del programa que acepta el cliente al darse de alta. */
  termsVersion: Text(40),
})
export type LoyaltySettings = z.infer<typeof LoyaltySettingsSchema>

export function defaultLoyaltySettings(): LoyaltySettings {
  return { enabled: false, pointsPerEuro: 1, minSpendCents: 0, expiryDays: 365, termsVersion: "1" }
}

export const LOYALTY_ACCOUNT_STATUSES = ["active", "closed"] as const
/** Cuenta de puntos de un cliente (`loyaltyAccounts/{customerId}`). Saldo: solo servidor. */
export const LoyaltyAccountSchema = z.object({
  customerId: DocIdSchema,
  status: z.enum(LOYALTY_ACCOUNT_STATUSES),
  balance: PointsSchema,
  earned: PointsSchema,
  redeemed: PointsSchema,
  expired: PointsSchema,
  /** Condiciones aceptadas al darse de alta y quién lo registró (uid del personal). */
  termsVersion: Text(40),
  enrolledAt: TimestampSchema,
  enrolledBy: z.string().min(1),
  revision: Revision,
})
export type LoyaltyAccount = z.infer<typeof LoyaltyAccountSchema>

export const LOYALTY_MOVEMENT_KINDS = ["earn", "redeem", "redeem_reversal", "earn_reversal", "adjust", "expire"] as const
export type LoyaltyMovementKind = (typeof LOYALTY_MOVEMENT_KINDS)[number]
/**
 * Movimiento inmutable del libro (`loyaltyMovements/{id}`). `points` lleva signo. Los ids de los
 * automáticos son deterministas: `earn.{billId}`, `earn_reversal.{paymentId}`, `expire.{earnId}`.
 */
export const LoyaltyMovementSchema = z.object({
  customerId: DocIdSchema,
  kind: z.enum(LOYALTY_MOVEMENT_KINDS),
  points: SignedPointsSchema,
  /** Saldo tras el movimiento: nunca negativo. */
  balanceAfter: PointsSchema,
  at: TimestampSchema,
  /** Solo en `earn` y en `adjust` positivo: cuándo caduca esa tanda (null si no caduca). */
  expiresAt: TimestampSchema.nullable(),
  locationId: DocIdSchema.nullable(),
  billId: DocIdSchema.nullable(),
  redemptionId: DocIdSchema.nullable(),
  /** `expire` y `earn_reversal`: el movimiento `earn` al que se refiere. */
  earnMovementId: DocIdSchema.nullable(),
  reason: z.string().max(200).nullable(),
  by: z.string().nullable(),
})
export type LoyaltyMovement = z.infer<typeof LoyaltyMovementSchema>

/** Premio del catálogo (`loyaltyRewards/{id}`): un descuento en céntimos o un plato invitado. */
export const LoyaltyRewardInputSchema = z.strictObject({
  name: Text(80),
  pointsCost: z.number().int().min(1).max(1_000_000),
  kind: z.enum(["amount", "item"]),
  /** amount: céntimos de descuento. item: tope del plato invitado (su precio, como mucho esto). */
  valueCents: AmountCentsSchema.refine((v) => v > 0, "El premio necesita un valor."),
  itemId: DocIdSchema.nullable(),
  active: z.boolean(),
}).superRefine((v, ctx) => {
  if (v.kind === "item" && v.itemId === null) ctx.addIssue({ code: "custom", path: ["itemId"], message: "Elige el plato del premio." })
  if (v.kind === "amount" && v.itemId !== null) ctx.addIssue({ code: "custom", path: ["itemId"], message: "Un descuento no lleva plato." })
})
export const LoyaltyRewardSchema = z.object({
  name: Text(80), pointsCost: z.number().int().min(1), kind: z.enum(["amount", "item"]),
  valueCents: AmountCentsSchema, itemId: DocIdSchema.nullable(), active: z.boolean(), revision: Revision,
})
export type LoyaltyReward = z.infer<typeof LoyaltyRewardSchema>

export const REDEMPTION_STATUSES = ["applied", "reversed", "settled"] as const
/** Canje de un premio contra una cuenta (`loyaltyRedemptions/{id}`). */
export const LoyaltyRedemptionSchema = z.object({
  customerId: DocIdSchema,
  rewardId: DocIdSchema,
  locationId: DocIdSchema,
  billId: DocIdSchema,
  points: z.number().int().min(1),
  discountCents: AmountCentsSchema,
  status: z.enum(REDEMPTION_STATUSES),
  at: TimestampSchema,
  by: z.string().min(1),
})
export type LoyaltyRedemption = z.infer<typeof LoyaltyRedemptionSchema>

/* Promociones ------------------------------------------------------------- */

export const PROMOTION_CHANNELS = ["dine_in", "takeaway", "qr"] as const
export type PromotionChannel = (typeof PROMOTION_CHANNELS)[number]
export const PROMOTION_STATUSES = ["draft", "active", "paused", "archived"] as const
export type PromotionStatus = (typeof PROMOTION_STATUSES)[number]

const TimeWindowSchema = z.strictObject({ from: HoraSchema, to: HoraSchema })
  .refine((v) => v.from !== v.to, "La franja no puede empezar y acabar a la misma hora.")

/**
 * Lo que escribe el encargado. `to` menor que `from` cruza la medianoche (22:00 a 02:00).
 * `stacking`: `exclusive` no se combina con un canje de puntos; `with_loyalty` sí. Nunca se suman
 * dos promociones en la misma cuenta.
 */
export const PromotionInputSchema = z.strictObject({
  name: Text(80),
  description: z.string().trim().max(300).default(""),
  discount: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("percent"), bp: z.number().int().min(1).max(10_000) }),
    z.strictObject({ kind: z.literal("amount"), cents: AmountCentsSchema.refine((v) => v > 0, "El descuento necesita un importe.") }),
  ]),
  scope: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("bill") }),
    z.strictObject({ kind: z.literal("items"), itemIds: z.array(DocIdSchema).min(1).max(200) }),
    z.strictObject({ kind: z.literal("categories"), categoryIds: z.array(DocIdSchema).min(1).max(50) }),
  ]),
  /** Vacío = todos los locales. */
  locationIds: z.array(DocIdSchema).max(50),
  channels: z.array(z.enum(PROMOTION_CHANNELS)).min(1),
  validFrom: MillisSchema.nullable(),
  validTo: MillisSchema.nullable(),
  /** Días de la semana ISO (1 lunes … 7 domingo) del día local de la cuenta. Vacío = todos. */
  weekdays: z.array(z.number().int().min(1).max(7)).max(7),
  /** Vacío = todo el día. */
  timeWindows: z.array(TimeWindowSchema).max(4),
  minSpendCents: AmountCentsSchema,
  /** Tope del descuento por cuenta, en céntimos; null sin tope. */
  maxDiscountCents: AmountCentsSchema.nullable(),
  /** Cupo total de usos y por cliente; null sin cupo. Por cliente exige cliente en la cuenta. */
  usageLimit: z.number().int().min(1).max(1_000_000).nullable(),
  perCustomerLimit: z.number().int().min(1).max(1000).nullable(),
  /** Código que se escribe en caja (mayúsculas y cifras); null = automática. */
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{3,20}$/, "Usa de 3 a 20 letras o cifras.").nullable(),
  stacking: z.enum(["exclusive", "with_loyalty"]),
  /** Para desempatar: gana el mayor descuento, después la mayor prioridad y después el id. */
  priority: z.number().int().min(0).max(100),
}).superRefine((v, ctx) => {
  if (v.validFrom !== null && v.validTo !== null && v.validTo <= v.validFrom) ctx.addIssue({ code: "custom", path: ["validTo"], message: "La promoción acaba después de empezar." })
  if (new Set(v.weekdays).size !== v.weekdays.length) ctx.addIssue({ code: "custom", path: ["weekdays"], message: "Hay días repetidos." })
})
export type PromotionInput = z.output<typeof PromotionInputSchema>

export const PromotionSchema = z.object({
  name: z.string(), description: z.string(),
  discount: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("percent"), bp: z.number().int().min(1).max(10_000) }),
    z.object({ kind: z.literal("amount"), cents: AmountCentsSchema }),
  ]),
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("bill") }),
    z.object({ kind: z.literal("items"), itemIds: z.array(DocIdSchema) }),
    z.object({ kind: z.literal("categories"), categoryIds: z.array(DocIdSchema) }),
  ]),
  locationIds: z.array(DocIdSchema), channels: z.array(z.enum(PROMOTION_CHANNELS)),
  validFrom: TimestampSchema.nullable(), validTo: TimestampSchema.nullable(),
  weekdays: z.array(z.number().int().min(1).max(7)), timeWindows: z.array(z.object({ from: HoraSchema, to: HoraSchema })),
  minSpendCents: AmountCentsSchema, maxDiscountCents: AmountCentsSchema.nullable(),
  usageLimit: z.number().int().min(1).nullable(), perCustomerLimit: z.number().int().min(1).nullable(),
  code: z.string().nullable(), stacking: z.enum(["exclusive", "with_loyalty"]), priority: z.number().int().min(0),
  status: z.enum(PROMOTION_STATUSES),
  /** Usos confirmados: lo lleva el servidor en la misma transacción que aplica la promoción. */
  uses: z.number().int().min(0),
  revision: Revision,
})
export type Promotion = z.infer<typeof PromotionSchema>

/** Promoción aplicada a una cuenta (`locations/{lid}/billPromotions/{billId}`): una por cuenta. */
export const BillPromotionSchema = z.object({
  promotionId: DocIdSchema,
  billId: DocIdSchema,
  customerId: DocIdSchema.nullable(),
  discountCents: AmountCentsSchema,
  /** Ajustes `discount` de la cuenta que la representan. */
  adjustmentIds: z.array(DocIdSchema).min(1),
  status: z.enum(["applied", "removed"]),
  at: TimestampSchema,
  by: z.string().min(1),
})
export type BillPromotion = z.infer<typeof BillPromotionSchema>

/* Adaptadores de escritura ------------------------------------------------ */

export function loyaltyMovementForWrite<H>(v: LoyaltyMovement, convert: (ms: number) => H) {
  return { ...v, at: convert(v.at), expiresAt: v.expiresAt === null ? null : convert(v.expiresAt) }
}
export function loyaltyAccountForWrite<H>(v: LoyaltyAccount, convert: (ms: number) => H) {
  return { ...v, enrolledAt: convert(v.enrolledAt) }
}
export function promotionForWrite<H>(v: Promotion, convert: (ms: number) => H) {
  return { ...v, validFrom: v.validFrom === null ? null : convert(v.validFrom), validTo: v.validTo === null ? null : convert(v.validTo) }
}
