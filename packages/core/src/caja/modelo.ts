/** Documentos de caja. Solo servidor; dinero en céntimos, horas en ms al leer. */
import { z } from "zod"
import { DocIdSchema } from "../model"
import { TaxRateSchema } from "../carta/modelo"
import { TimestampSchema } from "../timestamp"
import { TokenHashSchema } from "../ids"

export const AmountCentsSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const SignedCentsSchema = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)
export const PosReasonSchema = z.string().trim().min(1, "Escribe el motivo.").max(200)
export const PosRevisionSchema = z.number().int().min(1)
export const PosTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("session"), id: DocIdSchema }),
  z.strictObject({ kind: z.literal("takeaway"), id: DocIdSchema }),
])
export type PosTarget = z.infer<typeof PosTargetSchema>
export const BillLineSchema = z.object({
  lineId: DocIdSchema, parentLineId: DocIdSchema.nullable(), name: z.string().min(1).max(160),
  quantity: z.number().int().min(1).max(99), grossCents: AmountCentsSchema,
  taxRate: TaxRateSchema, guest: z.number().int().min(1).max(50).nullable(),
})
export type BillLine = z.infer<typeof BillLineSchema>
/**
 * `discount` (fase 5) lo escribe solo el servidor al aplicar una promoción o canjear puntos, con
 * `promotionId` o `redemptionId`; para el total y la factura cuenta igual que una invitación parcial.
 * `ajustarCuenta` sigue admitiendo solo `invitation` y `void`.
 */
export const BILL_ADJUSTMENT_KINDS = ["invitation", "void", "discount"] as const
export const BillAdjustmentSchema = z.object({
  id: DocIdSchema, lineId: DocIdSchema, kind: z.enum(BILL_ADJUSTMENT_KINDS),
  amountCents: AmountCentsSchema.refine((v) => v > 0), reason: PosReasonSchema,
  at: TimestampSchema, by: z.string().min(1),
  promotionId: DocIdSchema.nullable().optional(), redemptionId: DocIdSchema.nullable().optional(),
})
export type BillAdjustment = z.infer<typeof BillAdjustmentSchema>
export const BILL_STATUSES = ["open", "locked", "settled", "cancelled"] as const
export type BillStatus = (typeof BILL_STATUSES)[number]
export const BillSchema = z.object({
  target: PosTargetSchema, customerId: z.string().nullable(), status: z.enum(BILL_STATUSES),
  revision: PosRevisionSchema, lines: z.array(BillLineSchema).max(1000),
  adjustments: z.array(BillAdjustmentSchema), totalCents: AmountCentsSchema,
  paidCents: AmountCentsSchema, refundedCents: AmountCentsSchema,
  openedAt: TimestampSchema, lockedAt: TimestampSchema.nullable(), settledAt: TimestampSchema.nullable(),
})
export type Bill = z.infer<typeof BillSchema>
/** Cada céntimo de cada línea pertenece a una sola parte. Los menús incluyen sus hijos. */
export const BillAllocationSchema = z.object({ lineId: DocIdSchema, amountCents: AmountCentsSchema })
export const BillPartSchema = z.object({
  billId: DocIdSchema, label: z.string().trim().min(1).max(60), revision: PosRevisionSchema,
  allocations: z.array(BillAllocationSchema).min(1).max(1000), totalCents: AmountCentsSchema,
  paidCents: AmountCentsSchema, invoiceId: DocIdSchema.nullable(),
})
export type BillPart = z.infer<typeof BillPartSchema>
export const PAYMENT_STATUSES = ["pending", "succeeded", "failed", "cancelled"] as const
export const PaymentSchema = z.object({
  billId: DocIdSchema, partId: DocIdSchema, cashSessionId: DocIdSchema,
  kind: z.enum(["charge", "refund"]), originalPaymentId: DocIdSchema.nullable(),
  method: z.enum(["cash", "card", "stripe", "deposit"]), status: z.enum(PAYMENT_STATUSES),
  amountCents: AmountCentsSchema, tipCents: AmountCentsSchema,
  tenderedCents: AmountCentsSchema, changeCents: AmountCentsSchema,
  externalId: z.string().max(200).nullable(), requestId: DocIdSchema,
  reason: PosReasonSchema.nullable(), at: TimestampSchema, by: z.string().nullable(),
}).superRefine((v, ctx) => {
  if ((v.kind === "charge" && v.amountCents === 0) || (v.kind === "refund" && v.amountCents === 0 && v.tipCents === 0)) ctx.addIssue({ code: "custom", message: "El movimiento necesita un importe." })
  if (v.kind === "refund" && (v.tenderedCents !== 0 || v.changeCents !== 0)) ctx.addIssue({ code: "custom", message: "La devolución no lleva entrega ni cambio." })
  if (v.kind === "refund" && (!v.originalPaymentId || !v.reason)) ctx.addIssue({ code: "custom", message: "La devolución necesita cobro original y motivo." })
  if (v.kind === "charge" && v.originalPaymentId !== null) ctx.addIssue({ code: "custom", message: "Un cobro no devuelve otro pago." })
  if (v.method === "cash" && v.kind === "charge" && v.tenderedCents - v.changeCents !== v.amountCents + v.tipCents) ctx.addIssue({ code: "custom", message: "El cambio no coincide." })
  if (v.method !== "cash" && (v.tenderedCents !== 0 || v.changeCents !== 0)) ctx.addIssue({ code: "custom", message: "Solo el efectivo lleva entrega y cambio." })
})
export type Payment = z.infer<typeof PaymentSchema>
export const CashMovementSchema = z.object({
  cashSessionId: DocIdSchema, kind: z.enum(["in", "out", "tip_payout"]),
  amountCents: AmountCentsSchema.refine((v) => v > 0), reason: PosReasonSchema,
  at: TimestampSchema, by: z.string().min(1), requestId: DocIdSchema,
  distributionId: DocIdSchema.nullable().optional(),
}).superRefine((v, ctx) => {
  if (v.kind === "tip_payout" && !v.distributionId) ctx.addIssue({ code: "custom", message: "El pago de propinas referencia un reparto." })
})
export type CashMovement = z.infer<typeof CashMovementSchema>
export const CashSessionSchema = z.object({
  registerId: DocIdSchema, status: z.enum(["open", "closed"]), openingCents: AmountCentsSchema,
  openedAt: TimestampSchema, openedBy: z.string().min(1), closedAt: TimestampSchema.nullable(),
  closedBy: z.string().nullable(), countedCents: AmountCentsSchema.nullable(),
  expectedCents: SignedCentsSchema.nullable(), differenceCents: SignedCentsSchema.nullable(),
  closeReason: PosReasonSchema.nullable(),
})
export type CashSession = z.infer<typeof CashSessionSchema>
export const TipDistributionSchema = z.object({
  cashSessionId: DocIdSchema, totalCents: AmountCentsSchema, at: TimestampSchema, by: z.string().min(1),
  shares: z.array(z.object({ uid: z.string().min(1), minutes: z.number().int().min(0), amountCents: AmountCentsSchema })),
})
export const MobileCheckoutSchema = z.object({
  billId: DocIdSchema, partId: DocIdSchema, revision: PosRevisionSchema,
  amountCents: AmountCentsSchema, tipCents: AmountCentsSchema,
  status: z.enum(["pending", "paid", "expired", "failed", "reconciliation_required"]),
  stripeSessionId: z.string().nullable(), expiresAt: TimestampSchema, tokenHash: TokenHashSchema,
})
export const DigitalReceiptSchema = z.object({
  invoiceId: DocIdSchema, tokenHash: TokenHashSchema, expiresAt: TimestampSchema,
  email: z.email().nullable(), consentAt: TimestampSchema.nullable(),
  delivery: z.enum(["none", "queued", "captured", "sent", "not_configured", "failed"]),
})
export const PrinterSchema = z.object({
  name: z.string().trim().min(1).max(60), bridgeId: DocIdSchema,
  paperMm: z.union([z.literal(58), z.literal(80)]), columns: z.union([z.literal(32), z.literal(48)]),
  stationIds: z.array(DocIdSchema), tickets: z.boolean(), drawer: z.boolean(), active: z.boolean(),
})
export const PrintJobSchema = z.object({
  printerId: DocIdSchema, kind: z.enum(["kitchen", "invoice", "prebill", "drawer"]),
  sourceId: DocIdSchema, copy: z.number().int().min(0),
  status: z.enum(["queued", "leased", "printed", "failed", "uncertain", "cancelled"]),
  payloadHash: TokenHashSchema, payloadBase64: z.string().max(500_000),
  attempts: z.number().int().min(0), leaseUntil: TimestampSchema.nullable(),
  leaseOwner: z.string().nullable(), lastError: z.string().max(300).nullable(),
})

/** Convierte únicamente horas conocidas; las fechas fiscales siguen siendo texto literal. */
export function billForWrite<H>(v: Bill, convert: (ms: number) => H) {
  return { ...v, openedAt: convert(v.openedAt), lockedAt: v.lockedAt === null ? null : convert(v.lockedAt),
    settledAt: v.settledAt === null ? null : convert(v.settledAt), adjustments: v.adjustments.map((a) => ({ ...a, at: convert(a.at) })) }
}
export function paymentForWrite<H>(v: Payment, convert: (ms: number) => H) { return { ...v, at: convert(v.at) } }
export function cashSessionForWrite<H>(v: CashSession, convert: (ms: number) => H) {
  return { ...v, openedAt: convert(v.openedAt), closedAt: v.closedAt === null ? null : convert(v.closedAt) }
}
export function cashMovementForWrite<H>(v: CashMovement, convert: (ms: number) => H) { return { ...v, at: convert(v.at) } }
export function printJobForWrite<H>(v: z.infer<typeof PrintJobSchema>, convert: (ms: number) => H) {
  return { ...v, leaseUntil: v.leaseUntil === null ? null : convert(v.leaseUntil) }
}
export function mobileCheckoutForWrite<H>(v: z.infer<typeof MobileCheckoutSchema>, convert: (ms: number) => H) { return { ...v, expiresAt: convert(v.expiresAt) } }
export function digitalReceiptForWrite<H>(v: z.infer<typeof DigitalReceiptSchema>, convert: (ms: number) => H) {
  return { ...v, expiresAt: convert(v.expiresAt), consentAt: v.consentAt === null ? null : convert(v.consentAt) }
}

/** Exclusión de pagos concurrentes, incluida Checkout antes de volver del proveedor. */
export const PaymentReservationSchema = z.object({
  billId: DocIdSchema, partId: DocIdSchema, revision: PosRevisionSchema,
  amountCents: AmountCentsSchema, checkoutId: DocIdSchema.nullable(), expiresAt: TimestampSchema,
})
/** Solicitud durable para el agente de impresión; el agente de caja no genera bytes. */
export const PrintRequestSchema = z.object({
  kind: z.enum(["kitchen", "invoice", "prebill", "drawer"]), sourceId: DocIdSchema,
  printerId: DocIdSchema.nullable(), copy: z.number().int().min(0),
  status: z.enum(["queued", "processed", "not_configured", "failed"]),
  requestedBy: z.string().nullable(), requestedAt: TimestampSchema,
})
/** Datos verificados por el webhook, para el servicio interno del backend. No es callable. */
export const ConfirmedExternalPaymentSchema = z.strictObject({
  restaurantId: DocIdSchema, locationId: DocIdSchema, billId: DocIdSchema, partId: DocIdSchema,
  cashSessionId: DocIdSchema, expectedRevision: PosRevisionSchema, requestId: DocIdSchema,
  checkoutId: DocIdSchema, externalId: z.string().min(1).max(200), currency: z.literal("EUR"),
  amountCents: AmountCentsSchema.refine((n) => n > 0), tipCents: AmountCentsSchema,
})
export type ConfirmedExternalPayment = z.infer<typeof ConfirmedExternalPaymentSchema>
export type TipDistribution = z.infer<typeof TipDistributionSchema>
export type MobileCheckout = z.infer<typeof MobileCheckoutSchema>
export type DigitalReceipt = z.infer<typeof DigitalReceiptSchema>
export type Printer = z.infer<typeof PrinterSchema>
export type PrintJob = z.infer<typeof PrintJobSchema>
export type PrintRequest = z.infer<typeof PrintRequestSchema>
export type PaymentReservation = z.infer<typeof PaymentReservationSchema>
export function tipDistributionForWrite<H>(v: TipDistribution, convert: (ms: number) => H) { return { ...v, at: convert(v.at) } }
export function paymentReservationForWrite<H>(v: PaymentReservation, convert: (ms: number) => H) { return { ...v, expiresAt: convert(v.expiresAt) } }
export function printRequestForWrite<H>(v: PrintRequest, convert: (ms: number) => H) { return { ...v, requestedAt: convert(v.requestedAt) } }

/** Proyección sin payload ni credenciales, apta para el panel con caja.ver. */
export const PrintStatusSchema = z.object({
  printerId: DocIdSchema, sourceId: DocIdSchema, kind: z.enum(["kitchen", "invoice", "prebill", "drawer"]),
  status: z.enum(["queued", "leased", "printed", "failed", "uncertain", "cancelled", "not_configured"]),
  attempts: z.number().int().min(0), lastError: z.string().max(300).nullable(),
})
export type PrintStatus = z.infer<typeof PrintStatusSchema>
