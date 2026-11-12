/** Inventario de copias personales: ninguna eliminación se decide por coincidencia de nombre. */
import { z } from "zod"
import { DocIdSchema } from "../model"
import { TimestampSchema, MillisSchema } from "../timestamp"

export const PERSONAL_DATA_KINDS = ["customer", "reservation", "waitlist", "takeaway", "session", "order", "line", "task", "message", "activity", "submission", "receipt", "checkout", "loyalty", "export", "fiscal"] as const
export const PersonalDataKindSchema = z.enum(PERSONAL_DATA_KINDS)
export const ConsentSchema = z.object({
  customerId: DocIdSchema, purpose: z.enum(["marketing_email", "marketing_whatsapp", "digital_receipt"]),
  status: z.enum(["granted", "withdrawn"]), policyVersion: z.string().min(1).max(80),
  at: TimestampSchema, source: z.enum(["public", "staff", "import"]), evidenceId: DocIdSchema,
})
export type Consent = z.infer<typeof ConsentSchema>
export function hasCurrentConsent(events: readonly Consent[], customerId: string, purpose: Consent["purpose"], now: number): boolean {
  const matching = events.filter((e) => e.customerId === customerId && e.purpose === purpose && e.at <= now)
  const lastAt = Math.max(...matching.map((e) => e.at))
  const latest = matching.filter((e) => e.at === lastAt)
  // En empate, la baja gana: no se vuelve a dar permiso por el orden de lectura.
  return latest.length > 0 && latest.every((e) => e.status === "granted")
}
export const PrivacyJobSchema = z.object({
  customerId: DocIdSchema, kind: z.enum(["export", "erase"]),
  status: z.enum(["requested", "verified", "running", "completed", "blocked", "failed"]),
  requestedBy: DocIdSchema, verifiedBy: DocIdSchema.nullable(), requestedAt: TimestampSchema,
  completedAt: TimestampSchema.nullable(), artifactPath: z.string().nullable(), expiresAt: TimestampSchema.nullable(),
  cursor: z.string().nullable(), processed: z.number().int().min(0), error: z.string().max(300).nullable(),
})
export type PrivacyJob = z.infer<typeof PrivacyJobSchema>
export const PRIVACY_JOB_TRANSITIONS: Record<PrivacyJob["status"], readonly PrivacyJob["status"][]> = {
  requested: ["verified", "blocked"], verified: ["running", "blocked"], running: ["completed", "blocked", "failed"],
  blocked: ["verified"], failed: ["running", "blocked"], completed: [],
}
/** Proyección saneada por el adaptador servidor; nunca se vuelcan documentos completos al exportar. */
export const PersonalDataRecordSchema = z.strictObject({
  restaurantId: DocIdSchema, customerId: DocIdSchema, kind: PersonalDataKindSchema, id: DocIdSchema,
  locationId: DocIdSchema.nullable(), occurredAt: MillisSchema, active: z.boolean(), legalHold: z.boolean(),
  /** Solo estos campos personales entran en la exportación, sin tokens, IP ni notas de terceros. */
  personal: z.strictObject({
    name: z.string().nullable(), phone: z.string().nullable(), email: z.string().nullable(),
    notes: z.string().nullable(), allergies: z.string().nullable(), tags: z.array(z.string()),
  }),
})
export type PersonalDataRecord = z.infer<typeof PersonalDataRecordSchema>
export const RetentionPolicySchema = z.strictObject({
  provisional: z.boolean(),
  operationalDays: z.number().int().min(1), messageDays: z.number().int().min(1),
  exportHours: z.number().int().min(1).max(168), backupDays: z.number().int().min(1),
  /** Sin plazo aprobado para lo fiscal no se elimina automáticamente ningún original. */
  fiscalDays: z.number().int().min(1).nullable(),
})
export type RetentionPolicy = z.infer<typeof RetentionPolicySchema>
export function provisionalRetentionPolicy(): RetentionPolicy {
  return { provisional: true, operationalDays: 365, messageDays: 90, exportHours: 24, backupDays: 30, fiscalDays: null }
}
export function retentionDecision(record: PersonalDataRecord, policy: RetentionPolicy, now: number, eraseRequested = false): "keep" | "anonymize" | "delete" | "restricted" {
  if (record.kind === "fiscal" || record.legalHold) return "restricted"
  if (record.active) return "keep"
  const days = record.kind === "message" ? policy.messageDays : record.kind === "export" ? policy.exportHours / 24 : policy.operationalDays
  if (!eraseRequested && now < record.occurredAt + days * 86_400_000) return "keep"
  return ["customer", "waitlist", "message", "export"].includes(record.kind) ? "delete" : "anonymize"
}
export function exportCustomerData(restaurantId: string, customerId: string, records: readonly PersonalDataRecord[], now: number) {
  return {
    version: 1 as const, restaurantId, customerId, generatedAt: MillisSchema.parse(now),
    records: records.map((r) => PersonalDataRecordSchema.parse(r)).filter((r) => r.restaurantId === restaurantId && r.customerId === customerId)
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)),
  }
}
export function planCustomerErasure(restaurantId: string, customerId: string, records: readonly PersonalDataRecord[], policy: RetentionPolicy, now: number) {
  return records.map((r) => PersonalDataRecordSchema.parse(r)).filter((r) => r.restaurantId === restaurantId && r.customerId === customerId)
    .map((r) => ({ kind: r.kind, id: r.id, locationId: r.locationId, action: retentionDecision(r, policy, now, true) }))
}
export function anonymizePersonalRecord(record: PersonalDataRecord): PersonalDataRecord {
  return { ...record, personal: { name: null, phone: null, email: null, notes: null, allergies: null, tags: [] } }
}
export function consentForWrite<H>(v: Consent, convert: (ms: number) => H) { return { ...v, at: convert(v.at) } }
export function privacyJobForWrite<H>(v: PrivacyJob, convert: (ms: number) => H) {
  return { ...v, requestedAt: convert(v.requestedAt), completedAt: v.completedAt === null ? null : convert(v.completedAt), expiresAt: v.expiresAt === null ? null : convert(v.expiresAt) }
}
