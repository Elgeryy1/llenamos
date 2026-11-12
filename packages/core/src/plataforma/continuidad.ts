/** Copias verificables y restauración aislada. No se reenvían efectos externos al restaurar. */
import { z } from "zod"
import { DocIdSchema } from "../model"
import { TimestampSchema } from "../timestamp"
import { sha256Hex } from "../sha256"
import { canonicalJson } from "./sin-conexion"

const Hash = z.string().regex(/^[a-f0-9]{64}$/)
export const BackupManifestSchema = z.object({
  restaurantId: DocIdSchema, schemaVersion: z.number().int().min(1), snapshotAt: TimestampSchema,
  status: z.enum(["running", "verified", "failed", "expired"]),
  files: z.array(z.strictObject({ path: z.string().min(1).max(500), sha256: Hash, bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), records: z.number().int().min(0) }))
    .refine((v) => new Set(v.map((f) => f.path)).size === v.length, "Hay archivos repetidos."),
  encrypted: z.literal(true), keyVersion: z.string().min(1), expiresAt: TimestampSchema,
})
export type BackupManifest = z.infer<typeof BackupManifestSchema>
export const RestoreDrillSchema = z.object({
  restaurantId: DocIdSchema, backupId: DocIdSchema, status: z.enum(["requested", "restoring", "validating", "passed", "failed"]),
  startedAt: TimestampSchema, completedAt: TimestampSchema.nullable(),
  isolatedTarget: z.string().min(1), outboundDisabled: z.literal(true),
  checks: z.object({ hashes: z.boolean(), counts: z.boolean(), fiscalChains: z.boolean(), tenantIsolation: z.boolean(), privacyTombstones: z.boolean(), outboxes: z.boolean() }),
  measuredRpoMs: z.number().int().min(0).nullable(), measuredRtoMs: z.number().int().min(0).nullable(), error: z.string().max(300).nullable(),
})
export type RestoreDrill = z.infer<typeof RestoreDrillSchema>
export const RecoveryObjectivesSchema = z.strictObject({ provisional: z.boolean(), rpoMs: z.number().int().min(1), rtoMs: z.number().int().min(1), maxDrillAgeMs: z.number().int().min(1) })
export type RecoveryObjectives = z.infer<typeof RecoveryObjectivesSchema>
export function backupManifestHash(manifest: BackupManifest): string { return sha256Hex(canonicalJson(BackupManifestSchema.parse(manifest))) }
export function checkBackupFiles(manifest: BackupManifest, actual: readonly { path: string; sha256: string; bytes: number; records: number }[]): boolean {
  return manifest.status === "verified" && manifest.files.length > 0 && actual.length === manifest.files.length && new Set(actual.map((f) => f.path)).size === actual.length && manifest.files.every((f) => actual.some((a) => a.path === f.path && a.sha256 === f.sha256 && a.bytes === f.bytes && a.records === f.records))
}
export function restoreDrillPasses(drill: RestoreDrill, objectives: RecoveryObjectives): boolean {
  return drill.status === "passed" && drill.error === null && drill.completedAt !== null && drill.completedAt >= drill.startedAt &&
    Object.values(drill.checks).every(Boolean) && drill.measuredRpoMs !== null && drill.measuredRtoMs !== null &&
    drill.measuredRpoMs <= objectives.rpoMs && drill.measuredRtoMs <= objectives.rtoMs && drill.measuredRtoMs === drill.completedAt - drill.startedAt
}
/** Aproximación conservadora de mes: como máximo 30 días entre simulacros. */
export function restoreDrillDue(lastCompletedAt: number | null, now: number, maxAgeMs = 30 * 86_400_000): boolean {
  return lastCompletedAt === null || now >= lastCompletedAt + maxAgeMs
}
export function restoredOutboxDisposition(kind: "message" | "webhook" | "payment" | "fiscal" | "print", externallyConfirmed: boolean): "already_done" | "reconcile" | "manual_review" {
  if (externallyConfirmed) return "already_done"
  return kind === "print" || kind === "message" ? "manual_review" : "reconcile"
}
export function backupManifestForWrite<H>(v: BackupManifest, convert: (ms: number) => H) { return { ...v, snapshotAt: convert(v.snapshotAt), expiresAt: convert(v.expiresAt) } }
export function restoreDrillForWrite<H>(v: RestoreDrill, convert: (ms: number) => H) { return { ...v, startedAt: convert(v.startedAt), completedAt: v.completedAt === null ? null : convert(v.completedAt) } }
