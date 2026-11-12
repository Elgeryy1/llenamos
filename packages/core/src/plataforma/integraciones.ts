/** API mínima y entregas salientes. Sin red ni secretos generados dentro de core. */
import { z } from "zod"
import { DocIdSchema } from "../model"
import { sha256, sha256Hex, toHex, utf8Bytes } from "../sha256"
import { TimestampSchema, MillisSchema } from "../timestamp"
import { canonicalJson } from "./sin-conexion"

export const API_SCOPES = ["menu.read", "orders.read"] as const
export const ApiScopeSchema = z.enum(API_SCOPES)
export type ApiScope = z.infer<typeof ApiScopeSchema>
const Hash = z.string().regex(/^[a-f0-9]{64}$/)
export const ApiKeySchema = z.object({
  name: z.string().trim().min(1).max(80), prefix: z.string().min(1).max(16), tokenHash: Hash,
  scopes: z.array(ApiScopeSchema).min(1).max(2), locationIds: z.array(DocIdSchema).min(1).max(100),
  expiresAt: TimestampSchema, revokedAt: TimestampSchema.nullable(), lastUsedAt: TimestampSchema.nullable(), createdBy: DocIdSchema,
})
export type ApiKey = z.infer<typeof ApiKeySchema>
export function apiKeyAllows(key: ApiKey, token: string, scope: ApiScope, locationId: string, now: number): boolean {
  return key.revokedAt === null && now < key.expiresAt && key.scopes.includes(scope) && key.locationIds.includes(locationId) && equalSignature(key.tokenHash, sha256Hex(token))
}
export const PLATFORM_EVENTS = ["reservation.created", "reservation.statusChanged", "order.placed", "orderLine.statusChanged", "payment.succeeded", "subscription.changed", "privacy.completed"] as const
export const PlatformEventTypeSchema = z.enum(PLATFORM_EVENTS)
/** El cuerpo público es una referencia; los detalles se leen por API y con permisos vigentes. */
export const PlatformEventSchema = z.object({
  id: DocIdSchema, type: PlatformEventTypeSchema, version: z.literal(1), restaurantId: DocIdSchema,
  locationId: DocIdSchema.nullable(), occurredAt: MillisSchema,
  data: z.strictObject({ entityId: DocIdSchema, status: z.string().max(80).nullable() }),
})
export type PlatformEvent = z.infer<typeof PlatformEventSchema>
export const WebhookEndpointSchema = z.object({
  url: z.url().refine((v) => /^https:\/\//.test(v), "El destino debe usar HTTPS."),
  events: z.array(PlatformEventTypeSchema).min(1).max(PLATFORM_EVENTS.length),
  locationIds: z.array(DocIdSchema).min(1).max(100), status: z.enum(["active", "suspended", "revoked"]),
  secretVersion: z.number().int().min(1), consecutiveFailures: z.number().int().min(0),
})
export type WebhookEndpoint = z.infer<typeof WebhookEndpointSchema>
export const WebhookDeliverySchema = z.object({
  endpointId: DocIdSchema, eventId: DocIdSchema, body: z.string().max(100000), bodyHash: Hash,
  status: z.enum(["queued", "leased", "delivered", "retry", "exhausted", "cancelled"]),
  attempts: z.number().int().min(0).max(12), nextAttemptAt: TimestampSchema,
  leaseUntil: TimestampSchema.nullable(), lastStatus: z.number().int().min(100).max(599).nullable(), lastError: z.string().max(300).nullable(),
})
export type WebhookDelivery = z.infer<typeof WebhookDeliverySchema>
export function webhookBody(event: PlatformEvent): string { return canonicalJson(PlatformEventSchema.parse(event)) }
export function webhookDeliveryId(endpointId: string, eventId: string): string { return sha256Hex(JSON.stringify([endpointId, eventId])) }

/** HMAC SHA-256 sobre los bytes UTF-8 exactos. Clave aleatoria de 32 bytes como mínimo. */
export function hmacSha256Hex(secret: string, message: string): string {
  let key = utf8Bytes(secret)
  if (key.length > 64) key = sha256(key)
  const inner = new Uint8Array(64 + utf8Bytes(message).length)
  const outer = new Uint8Array(96)
  for (let i = 0; i < 64; i++) { inner[i] = (key[i] ?? 0) ^ 0x36; outer[i] = (key[i] ?? 0) ^ 0x5c }
  inner.set(utf8Bytes(message), 64); outer.set(sha256(inner), 64)
  return toHex(sha256(outer))
}
/** Comparación de longitud fija sin retorno temprano por carácter; el servidor puede usar timingSafeEqual. */
export function equalSignature(a: string, b: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(a) || !/^[a-f0-9]{64}$/.test(b)) return false
  let diff = 0
  for (let i = 0; i < 64; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
export function signPlatformWebhook(secret: string, timestampSeconds: number, rawBody: string): string {
  if (utf8Bytes(secret).length < 32 || !Number.isSafeInteger(timestampSeconds) || timestampSeconds < 0) throw new Error("La clave o la fecha de firma no es válida.")
  return `t=${timestampSeconds},v1=${hmacSha256Hex(secret, `${timestampSeconds}.${rawBody}`)}`
}
export function verifyPlatformWebhook(secret: string, header: string, rawBody: string, now: number, toleranceSeconds = 300): boolean {
  const match = /^t=(0|[1-9]\d*),v1=([a-f0-9]{64})$/.exec(header)
  if (!match || !Number.isFinite(now) || !Number.isSafeInteger(toleranceSeconds) || toleranceSeconds < 0 || utf8Bytes(secret).length < 32) return false
  const t = Number(match[1])
  if (!Number.isSafeInteger(t) || Math.abs(now / 1000 - t) > toleranceSeconds) return false
  return equalSignature(match[2] ?? "", hmacSha256Hex(secret, `${t}.${rawBody}`))
}
export function nextWebhookAttempt(attempts: number, now: number): number | null {
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new Error("Número de intentos no válido.")
  if (attempts >= 12) return null
  return now + Math.min(21_600_000, 30_000 * 2 ** (attempts - 1))
}
export function apiKeyForWrite<H>(v: ApiKey, convert: (ms: number) => H) {
  return { ...v, expiresAt: convert(v.expiresAt), revokedAt: v.revokedAt === null ? null : convert(v.revokedAt), lastUsedAt: v.lastUsedAt === null ? null : convert(v.lastUsedAt) }
}
export function webhookDeliveryForWrite<H>(v: WebhookDelivery, convert: (ms: number) => H) {
  return { ...v, nextAttemptAt: convert(v.nextAttemptAt), leaseUntil: v.leaseUntil === null ? null : convert(v.leaseUntil) }
}
