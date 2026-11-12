/** Modelo fiscal normalizado. No admite modificar facturas emitidas ni registros. */
import { z } from "zod"
import { DocIdSchema } from "../model"
import { TimestampSchema } from "../timestamp"
import { esFechaValida } from "../reservas/tiempo"
import { TaxRateSchema } from "../carta/modelo"
import { AmountCentsSchema, SignedCentsSchema, PosReasonSchema } from "./modelo"

// El formato se conserva literalmente: participa en la huella y en el XML.
export const FiscalDateSchema = z.string().regex(/^\d{2}-\d{2}-\d{4}$/).refine((s) => {
  const [d, m, y] = s.split("-")
  return esFechaValida(`${y}-${m}-${d}`)
}, "Fecha fiscal no válida.")
export const FiscalDateTimeSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
  .refine((s) => esFechaValida(s.slice(0, 10)) && Number(s.slice(11, 13)) < 24 && Number(s.slice(14, 16)) < 60 && Number(s.slice(17, 19)) < 60 && Number(s.slice(20, 22)) <= 14 && Number(s.slice(23, 25)) < 60 && (Number(s.slice(20, 22)) !== 14 || s.endsWith(":00")), "Fecha y huso no válidos.")
export const FiscalNifSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{9}$/, "NIF no válido.")
export const FiscalNumberSchema = z.string().trim().min(1).max(60).regex(/^[\x20-\x7e]+$/, "La serie y el número usan caracteres ASCII imprimibles.")
export const FiscalHashSchema = z.string().regex(/^[A-F0-9]{64}$/)
const Name = z.string().trim().min(1).max(120)
const Address = z.string().trim().min(1).max(250)
export const FiscalPartySchema = z.object({ name: Name, nif: FiscalNifSchema, address: Address })
/** Receptores extranjeros: el proveedor resuelve IDOtro sin inventar NIF español. */
export const FiscalRecipientSchema = z.object({
  name: Name, address: Address,
  identity: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("nif"), nif: FiscalNifSchema }),
    z.strictObject({ kind: z.literal("other"), country: z.string().regex(/^[A-Z]{2}$/), idType: z.enum(["02", "03", "04", "05", "06", "07"]), id: z.string().trim().min(1).max(20) }),
  ]),
})
export const InvoiceIdentitySchema = z.object({ issuerNif: FiscalNifSchema, number: FiscalNumberSchema, issueDate: FiscalDateSchema })
export type InvoiceIdentity = z.infer<typeof InvoiceIdentitySchema>
export const InvoiceTaxSchema = z.object({
  taxRate: TaxRateSchema, baseCents: SignedCentsSchema, taxCents: SignedCentsSchema,
  /** Esta fase solo calcula operaciones interiores de IVA en régimen general. 0 no significa exento. */
  tax: z.literal("01"), regimeKey: z.literal("01"), qualification: z.literal("S1"),
})
export const InvoiceLineSchema = z.object({
  description: z.string().trim().min(1).max(160), quantity: z.number().int().min(1).max(99),
  unitPriceCents: SignedCentsSchema, discountCents: AmountCentsSchema,
  grossCents: SignedCentsSchema, taxRate: TaxRateSchema, sourceLineId: DocIdSchema.nullable(),
}).refine((v) => BigInt(v.unitPriceCents) * BigInt(v.quantity) - BigInt(v.discountCents) === BigInt(v.grossCents), "El importe de la línea no coincide con cantidad, precio y descuento.")
export const InvoiceSchema = z.object({
  billId: DocIdSchema, partId: DocIdSchema,
  issuer: FiscalPartySchema, recipient: FiscalRecipientSchema.nullable(),
  seriesId: DocIdSchema, sequence: z.number().int().min(1), number: FiscalNumberSchema,
  issueDate: FiscalDateSchema, operationDate: FiscalDateSchema,
  type: z.enum(["F1", "F2", "F3", "R1", "R2", "R3", "R4", "R5"]),
  /** F1 por art. 7.2/7.3: conserva que se entregó una simplificada con destinatario. */
  qualifiedSimplified: z.boolean(),
  description: z.string().trim().min(1).max(500),
  lines: z.array(InvoiceLineSchema).min(1).max(1000), taxes: z.array(InvoiceTaxSchema).min(1).max(12),
  taxCents: SignedCentsSchema, totalCents: SignedCentsSchema,
  correction: z.object({
    mode: z.enum(["I", "S"]), reason: PosReasonSchema,
    invoices: z.array(InvoiceIdentitySchema).min(1).max(1000),
    correctedBaseCents: SignedCentsSchema.nullable(), correctedTaxCents: SignedCentsSchema.nullable(),
  }).nullable(),
  replacedInvoices: z.array(InvoiceIdentitySchema).max(1000),
}).superRefine((v, ctx) => {
  const error = (message: string) => ctx.addIssue({ code: "custom", message })
  if (["F1", "F3", "R1", "R2", "R3", "R4"].includes(v.type) && !v.recipient) error("Esta factura necesita los datos del destinatario.")
  if (v.type === "F2" && v.recipient) error("La simplificada con destinatario se registra como F1.")
  if (v.qualifiedSimplified && v.type !== "F1") error("La marca de simplificada cualificada requiere F1.")
  if (v.type.startsWith("R") !== (v.correction !== null)) error("La rectificativa necesita su referencia y motivo.")
  if (v.correction?.mode === "S" && (v.correction.correctedBaseCents === null || v.correction.correctedTaxCents === null)) error("La sustitución necesita los importes rectificados.")
  if (v.correction?.mode === "I" && (v.correction.correctedBaseCents !== null || v.correction.correctedTaxCents !== null)) error("La rectificación por diferencias no lleva importes de sustitución.")
  if ((v.type === "F3") !== (v.replacedInvoices.length > 0)) error("La sustitución de simplificadas necesita las facturas sustituidas.")
  if ([...v.replacedInvoices, ...(v.correction?.invoices ?? [])].some((r) => r.issuerNif !== v.issuer.nif)) error("Las facturas referenciadas pertenecen al mismo emisor.")
  if (v.type === "F2" && (v.totalCents < 0 || v.totalCents > 300_000)) error("En restauración la simplificada ordinaria admite hasta 3000 euros.")
  const sum = (xs: number[]) => xs.reduce((s, n) => s + BigInt(n), BigInt(0))
  if (sum(v.taxes.map((t) => t.taxCents)) !== BigInt(v.taxCents) || sum(v.taxes.map((t) => t.baseCents + t.taxCents)) !== BigInt(v.totalCents) || sum(v.lines.map((l) => l.grossCents)) !== BigInt(v.totalCents)) error("Los totales fiscales no coinciden.")
  if (new Set(v.taxes.map((t) => t.taxRate)).size !== v.taxes.length) error("Agrupa el IVA por tipo.")
  for (const t of v.taxes) {
    if (sum(v.lines.filter((l) => l.taxRate === t.taxRate).map((l) => l.grossCents)) !== BigInt(t.baseCents) + BigInt(t.taxCents)) error("Las líneas no coinciden con el desglose de IVA.")
  }
  if (v.lines.some((l) => !v.taxes.some((t) => t.taxRate === l.taxRate))) error("Falta un tipo de IVA en el desglose.")
})
export type Invoice = z.infer<typeof InvoiceSchema>
export const InvoiceSeriesSchema = z.object({
  prefix: z.string().regex(/^[A-Z0-9/]{1,40}$/), kind: z.enum(["ordinary", "rectifying"]),
  year: z.number().int().min(2000).max(9999), lastSequence: z.number().int().min(0),
  lastIssueDate: FiscalDateSchema.nullable(), active: z.boolean(),
})
export type InvoiceSeries = z.infer<typeof InvoiceSeriesSchema>
export const FiscalSystemSchema = z.object({
  producerName: Name, producerNif: FiscalNifSchema, name: z.string().trim().min(1).max(30),
  id: z.string().trim().min(1).max(2), version: z.string().trim().min(1).max(50),
  installation: z.string().trim().min(1).max(100), onlyVerifactu: z.boolean(),
  multiTaxpayer: z.boolean(), multipleTaxpayers: z.boolean(),
})
export const FiscalPreviousSchema = InvoiceIdentitySchema.extend({ recordId: DocIdSchema, hash: FiscalHashSchema })
const RecordBase = {
  recordId: DocIdSchema, chainId: DocIdSchema, chainSequence: z.number().int().min(1),
  version: z.literal("1.0"), system: FiscalSystemSchema, generatedAt: FiscalDateTimeSchema,
  previous: FiscalPreviousSchema.nullable(),
}
export const FiscalRecordInputSchema = z.discriminatedUnion("kind", [
  z.object({ ...RecordBase, kind: z.literal("alta"), invoice: InvoiceSchema,
    correctionOfRecordId: DocIdSchema.nullable(), subsanacion: z.boolean(), previousRejection: z.boolean() }),
  z.object({ ...RecordBase, kind: z.literal("anulacion"), invoice: InvoiceIdentitySchema,
    reason: PosReasonSchema, noPreviousRecord: z.boolean(), previousRejection: z.boolean() }),
]).superRefine((v, ctx) => {
  if ((v.chainSequence === 1) !== (v.previous === null)) ctx.addIssue({ code: "custom", message: "Solo el primer registro carece de anterior." })
  const nif = v.kind === "alta" ? v.invoice.issuer.nif : v.invoice.issuerNif
  if (v.previous && v.previous.issuerNif !== nif) ctx.addIssue({ code: "custom", message: "No se mezclan obligados en la cadena." })
  if (v.kind === "alta" && v.subsanacion !== (v.correctionOfRecordId !== null)) ctx.addIssue({ code: "custom", message: "La subsanación referencia el registro corregido." })
})
export type FiscalRecordInput = z.infer<typeof FiscalRecordInputSchema>
export const FiscalSubmissionSchema = z.object({
  status: z.enum(["queued", "accepted", "accepted_with_errors", "rejected", "retry", "not_configured"]),
  provider: z.string().min(1), externalId: z.string().nullable(), csv: z.string().nullable(),
  errorCode: z.string().nullable(), message: z.string().nullable(), retryAfterSeconds: z.number().int().min(0).nullable(),
})
export type FiscalSubmission = z.infer<typeof FiscalSubmissionSchema>
export const PosSettingsSchema = z.object({
  issuer: FiscalPartySchema, system: FiscalSystemSchema,
  fiscalRegime: z.enum(["verifactu", "ticketbai_araba", "ticketbai_bizkaia", "ticketbai_gipuzkoa"]),
  providerId: z.string().min(1).max(100), environment: z.enum(["test", "production"]),
  ordinarySeriesId: DocIdSchema, rectifyingSeriesId: DocIdSchema, mobilePayments: z.boolean(),
})

export type FiscalSystem = z.infer<typeof FiscalSystemSchema>
export type FiscalRecipient = z.infer<typeof FiscalRecipientSchema>
export type InvoiceTax = z.infer<typeof InvoiceTaxSchema>
export type InvoiceLine = z.infer<typeof InvoiceLineSchema>
export type PosSettings = z.infer<typeof PosSettingsSchema>
export const FiscalChainSchema = z.object({
  issuerNif: FiscalNifSchema, installation: z.string().min(1).max(100), regime: PosSettingsSchema.shape.fiscalRegime,
  head: FiscalPreviousSchema.extend({ sequence: z.number().int().min(1) }).nullable(),
})
export const FiscalOutboxSchema = z.object({
  recordId: DocIdSchema, chainId: DocIdSchema, locationId: DocIdSchema, invoiceId: DocIdSchema,
  status: FiscalSubmissionSchema.shape.status, attempts: z.number().int().min(0),
  nextAttemptAt: TimestampSchema, leaseUntil: TimestampSchema.nullable(), leaseOwner: z.string().nullable(),
})
export const FiscalResponseSchema = z.object({ recordId: DocIdSchema, at: TimestampSchema, response: FiscalSubmissionSchema })
export type FiscalChain = z.infer<typeof FiscalChainSchema>
export type FiscalOutbox = z.infer<typeof FiscalOutboxSchema>
export type FiscalResponse = z.infer<typeof FiscalResponseSchema>
export function fiscalOutboxForWrite<H>(v: FiscalOutbox, convert: (ms: number) => H) {
  return { ...v, nextAttemptAt: convert(v.nextAttemptAt), leaseUntil: v.leaseUntil === null ? null : convert(v.leaseUntil) }
}
export function fiscalResponseForWrite<H>(v: FiscalResponse, convert: (ms: number) => H) { return { ...v, at: convert(v.at) } }
