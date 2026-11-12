import { describe, expect, it } from "vitest"
import { apiKeyAllows, hmacSha256Hex, nextWebhookAttempt, PlatformEventSchema, signPlatformWebhook, verifyPlatformWebhook, webhookBody, webhookDeliveryId } from "./integraciones"
import { sha256Hex } from "../sha256"
import { anonymizePersonalRecord, exportCustomerData, hasCurrentConsent, planCustomerErasure, provisionalRetentionPolicy, retentionDecision } from "./privacidad"
import type { Consent, PersonalDataRecord } from "./privacidad"
import { BackupManifestSchema, checkBackupFiles, restoredOutboxDisposition, restoreDrillDue, restoreDrillPasses } from "./continuidad"
import { CALLABLES, CALLABLE_SCHEMAS, CALLABLE_SCHEMAS_FASE6, CALLABLES_FASE6, FASE6_ACCESS, PERMISSIONS, SincronizarComandoInputSchema } from "../index"
import { inspectCommand, OfflineCommandSchema, syncStreamKey, commandFingerprint } from "./sin-conexion"
const secret = "0123456789abcdef0123456789abcdef"
const event = PlatformEventSchema.parse({ id: "e", type: "order.placed", version: 1, restaurantId: "r", locationId: "l", occurredAt: 1000, data: { entityId: "o", status: "accepted" } })
const personal: PersonalDataRecord = { restaurantId: "r", customerId: "c", kind: "reservation", id: "x", locationId: "l", occurredAt: 0, active: false, legalHold: false, personal: { name: "Ana", phone: "+34612345678", email: "ana@example.test", notes: "Nota", allergies: "Leche", tags: ["habitual"] } }
describe("API y firma saliente", () => {
  it("registra todas las firmas de fase 6 y su control de acceso", () => {
    expect(Object.keys(CALLABLE_SCHEMAS_FASE6)).toEqual(Object.keys(CALLABLES_FASE6))
    expect(Object.keys(FASE6_ACCESS)).toEqual(Object.keys(CALLABLES_FASE6))
    for (const n of Object.keys(CALLABLES_FASE6) as (keyof typeof CALLABLES_FASE6)[]) {
      expect(CALLABLES[n]).toBe(n)
      expect(CALLABLE_SCHEMAS[n]).toBe(CALLABLE_SCHEMAS_FASE6[n])
      const p = FASE6_ACCESS[n].permission
      if (!["authenticated", "logiqd", "per_command"].includes(p)) expect(PERMISSIONS).toContain(p)
      expect(CALLABLE_SCHEMAS_FASE6[n].input.safeParse({ actorUid: "inventado" }).success).toBe(false)
    }
  })
  it("compara HMAC con vectores RFC 4231 y Node con clave larga y UTF-8", () => {
    expect(hmacSha256Hex("\x0b".repeat(20), "Hi There")).toBe("b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7")
    // Valores contrastados con createHmac de Node, sin importar tipos de Node en core.
    expect(hmacSha256Hex(secret, "mensaje 🍽️")).toBe("28ff5b3ac196bcb7f52d8db91ce868e019ac94760d55245786f0a3f226f323e9")
    expect(hmacSha256Hex("á".repeat(100), "mensaje 🍽️")).toBe("1c36eaed0d0b49f13eab187a779c6d04959c8b94fd9297b57284ee6ef7904e19")
  })
  it("firma bytes exactos, rechaza firma mala, caducada y futura", () => {
    const body = webhookBody(event)
    const header = signPlatformWebhook(secret, 1000, body)
    expect(verifyPlatformWebhook(secret, header, body, 1_000_000)).toBe(true)
    expect(verifyPlatformWebhook(secret, header, `${body} `, 1_000_000)).toBe(false)
    expect(verifyPlatformWebhook(secret, header, body, 1_301_000)).toBe(false)
    expect(verifyPlatformWebhook(secret, header, body, 699_000)).toBe(false)
    expect(verifyPlatformWebhook(secret, `${header},v1=otra`, body, 1_000_000)).toBe(false)
    expect(verifyPlatformWebhook("corta", header, body, 1_000_000)).toBe(false)
    expect(webhookDeliveryId("a:b", "c")).not.toBe(webhookDeliveryId("a", "b:c"))
  })
  it("acota reintentos y claves por alcance, local, caducidad y revocación", () => {
    expect(nextWebhookAttempt(1, 1000)).toBe(31000)
    expect(nextWebhookAttempt(12, 1000)).toBeNull()
    const key = { name: "Prueba", prefix: "abc", tokenHash: sha256Hex(secret), scopes: ["menu.read" as const], locationIds: ["l"], expiresAt: 2000, revokedAt: null, lastUsedAt: null, createdBy: "u" }
    expect(apiKeyAllows(key, secret, "menu.read", "l", 1999)).toBe(true)
    expect(apiKeyAllows(key, secret, "orders.read", "l", 1999)).toBe(false)
    expect(apiKeyAllows(key, secret, "menu.read", "otro", 1999)).toBe(false)
    expect(apiKeyAllows(key, secret, "menu.read", "l", 2000)).toBe(false)
    expect(apiKeyAllows({ ...key, revokedAt: 1000 }, secret, "menu.read", "l", 1999)).toBe(false)
  })
})
describe("privacidad y retención", () => {
  it("la baja gana aunque los eventos lleguen desordenados o con empate", () => {
    const grant: Consent = { customerId: "c", purpose: "marketing_email", status: "granted", policyVersion: "1", at: 100, source: "public", evidenceId: "e" }
    const withdraw = { ...grant, at: 200, status: "withdrawn" as const }
    expect(hasCurrentConsent([withdraw, grant], "c", "marketing_email", 300)).toBe(false)
    expect(hasCurrentConsent([withdraw, grant], "c", "marketing_email", 150)).toBe(true)
    expect(hasCurrentConsent([grant, { ...withdraw, at: 100 }], "c", "marketing_email", 300)).toBe(false)
    expect(hasCurrentConsent([grant], "otro", "marketing_email", 300)).toBe(false)
  })
  it("exporta solo copias saneadas de la persona y restaurante elegidos", () => {
    expect(exportCustomerData("r", "c", [personal, { ...personal, restaurantId: "ajeno" }, { ...personal, customerId: "otro" }], 100).records).toEqual([personal])
    expect(() => exportCustomerData("r", "c", [{ ...personal, token: "secreto" } as PersonalDataRecord], 100)).toThrow()
    expect(anonymizePersonalRecord(personal).personal).toEqual({ name: null, phone: null, email: null, notes: null, allergies: null, tags: [] })
    expect(personal.personal.name).toBe("Ana")
  })
  it("separa servicio vivo, fiscal, conservación restringida y borrado", () => {
    const policy = provisionalRetentionPolicy()
    expect(retentionDecision(personal, policy, 0)).toBe("keep")
    expect(retentionDecision(personal, policy, 365 * 86_400_000)).toBe("anonymize")
    expect(retentionDecision({ ...personal, kind: "message" }, policy, 90 * 86_400_000)).toBe("delete")
    expect(retentionDecision({ ...personal, active: true }, policy, 999999999999, true)).toBe("keep")
    expect(retentionDecision({ ...personal, kind: "fiscal" }, policy, 999999999999, true)).toBe("restricted")
    expect(retentionDecision({ ...personal, legalHold: true }, policy, 999999999999, true)).toBe("restricted")
    expect(planCustomerErasure("r", "c", [personal, { ...personal, restaurantId: "otro" }], policy, 0)).toEqual([{ kind: "reservation", id: "x", locationId: "l", action: "anonymize" }])
  })
})
describe("continuidad y orden de sincronización", () => {
  it("comprueba manifiesto completo y no solo existencia de copia", () => {
    const files = [{ path: "r/data.json", sha256: sha256Hex("datos"), bytes: 5, records: 1 }]
    const manifest = BackupManifestSchema.parse({ restaurantId: "r", schemaVersion: 1, snapshotAt: 1000, status: "verified", files, encrypted: true, keyVersion: "v1", expiresAt: 2000 })
    expect(checkBackupFiles(manifest, files)).toBe(true)
    expect(checkBackupFiles(manifest, [{ ...files[0]!, bytes: 4 }])).toBe(false)
    expect(checkBackupFiles(manifest, [])).toBe(false)
    expect(checkBackupFiles({ ...manifest, status: "running", files: [] }, [])).toBe(false)
    expect(checkBackupFiles(manifest, [...files, ...files])).toBe(false)
  })
  it("exige tiempos y todas las verificaciones del simulacro", () => {
    const checks = { hashes: true, counts: true, fiscalChains: true, tenantIsolation: true, privacyTombstones: true, outboxes: true }
    const drill = { restaurantId: "r", backupId: "b", status: "passed" as const, startedAt: 1000, completedAt: 2000, isolatedTarget: "demo-aislado", outboundDisabled: true as const, checks, measuredRpoMs: 100, measuredRtoMs: 1000, error: null }
    const objectives = { provisional: true, rpoMs: 500, rtoMs: 2000, maxDrillAgeMs: 30 * 86_400_000 }
    expect(restoreDrillPasses(drill, objectives)).toBe(true)
    expect(restoreDrillPasses({ ...drill, checks: { ...checks, outboxes: false } }, objectives)).toBe(false)
    expect(restoreDrillPasses({ ...drill, measuredRtoMs: null }, objectives)).toBe(false)
    expect(restoreDrillDue(null, 0)).toBe(true)
    expect(restoreDrillDue(0, 30 * 86_400_000)).toBe(true)
    expect(restoredOutboxDisposition("payment", false)).toBe("reconcile")
    expect(restoredOutboxDisposition("print", false)).toBe("manual_review")
    expect(restoredOutboxDisposition("fiscal", true)).toBe("already_done")
  })
  it("recupera antes de revisar versiones, bloquea huecos y evita ejecutar dos veces", () => {
    const c = OfflineCommandSchema.parse({ actorUid: "u", restaurantId: "r", locationId: "l", deviceId: "dispositivo_00001", commandId: "comando_estable_01", sequence: 1, clientCreatedAt: 1000, operation: "marcarAgotado", preconditions: [{ kind: "item", id: "p", version: "1" }], payload: { restaurantId: "r", locationId: "l", itemId: "p", soldOut: true } })
    expect(SincronizarComandoInputSchema.parse({ command: c }).command).toEqual(c)
    expect(inspectCommand(c, 0, null, c.preconditions, 1001, 10000)).toEqual({ action: "execute" })
    expect(inspectCommand({ ...c, sequence: 2 }, 0, null, c.preconditions, 1001, 10000)).toEqual({ action: "wait", expectedSequence: 1 })
    expect(inspectCommand(c, 1, null, c.preconditions, 1001, 10000)).toEqual({ action: "reject", code: "key_reused" })
    expect(inspectCommand(c, 0, null, [], 1001, 10000)).toEqual({ action: "conflict", code: "stale_version" })
    expect(inspectCommand(c, 0, null, c.preconditions, 11001, 10000)).toEqual({ action: "conflict", code: "expired" })
    const result = { status: "applied" as const, response: { ok: true, soldOut: true }, versions: [] }
    expect(inspectCommand(c, 1, { commandId: c.commandId, streamKey: syncStreamKey(c), sequence: 1, fingerprint: commandFingerprint(c), result, recordedAt: 1001 }, [], 99999, 1)).toEqual({ action: "recover", result })
  })
})

it("guarda el asistente por pasos, exige revisión y oculta ids de precio al restaurante", async () => {
  const { GuardarAltaInputSchema, GuardarPlanPlataformaInputSchema, PublicPlanDefinitionSchema, provisionalPlanCatalog } = await import("../index")
  const input = { requestId: "peticion_estable_01", onboardingId: null, expectedRevision: null, step: "identity", draft: { name: "Taberna Lumbre", slug: "taberna-lumbre" } }
  expect(GuardarAltaInputSchema.safeParse(input).success).toBe(true)
  expect(GuardarAltaInputSchema.safeParse({ ...input, onboardingId: "alta" }).success).toBe(false)
  expect(GuardarAltaInputSchema.safeParse({ ...input, onboardingId: "alta", expectedRevision: 1 }).success).toBe(true)
  const plan = { ...provisionalPlanCatalog()[0]!, stripeMonthlyPriceId: "price_local_de_prueba" }
  expect(GuardarPlanPlataformaInputSchema.parse({ requestId: input.requestId, plan }).plan.stripeMonthlyPriceId).toBe("price_local_de_prueba")
  expect(PublicPlanDefinitionSchema.parse(plan)).not.toHaveProperty("stripeMonthlyPriceId")
})
