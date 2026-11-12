/** Protocolo puro. El adaptador de IndexedDB y las transacciones pertenecen a la implementación. */
import { z } from "zod"
import { DocIdSchema } from "../model"
import { MillisSchema, TimestampSchema } from "../timestamp"
import { sha256Hex } from "../sha256"
import {
  EnviarPedidoInputSchema, EnviarPedidoOutputSchema, MarcharPaseInputSchema, MarcharPaseOutputSchema,
  CambiarEstadoLineasInputSchema, CambiarEstadoLineasOutputSchema, CambiarEstadoTareaInputSchema,
  CambiarEstadoTareaOutputSchema, MarcarAgotadoInputSchema, MarcarAgotadoOutputSchema,
} from "../api-sala"
import { AmountCentsSchema } from "../caja/modelo"
import { PlatformRevisionSchema } from "./planes"

export const StableCommandIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{16,100}$/, "Identificador de comando no válido.")
export const SyncScopeSchema = z.strictObject({ actorUid: DocIdSchema, restaurantId: DocIdSchema, locationId: DocIdSchema, deviceId: StableCommandIdSchema })
export type SyncScope = z.infer<typeof SyncScopeSchema>
export const ServerEntityVersionSchema = z.strictObject({
  kind: z.enum(["session", "takeaway", "line", "task", "item"]), id: DocIdSchema,
  /** Revisión opaca emitida por servidor. No se inventa a partir del reloj del navegador. */
  version: z.string().min(1).max(2000),
})
export const CommandPreconditionSchema = ServerEntityVersionSchema.extend({ afterCommandId: StableCommandIdSchema.optional() })
export type CommandPrecondition = z.infer<typeof CommandPreconditionSchema>
const Envelope = {
  ...SyncScopeSchema.shape, commandId: StableCommandIdSchema, sequence: PlatformRevisionSchema,
  clientCreatedAt: MillisSchema,
  preconditions: z.array(CommandPreconditionSchema).min(1).max(100).refine((v) => new Set(v.map((p) => JSON.stringify([p.kind, p.id]))).size === v.length, "Hay condiciones repetidas."),
}
export const OFFLINE_OPERATIONS = ["enviarPedido", "marcharPase", "cambiarEstadoLineas", "cambiarEstadoTarea", "marcarAgotado"] as const
export const OFFLINE_PAYLOAD_SCHEMAS = {
  enviarPedido: EnviarPedidoInputSchema.safeExtend({ requestId: StableCommandIdSchema, expectedDestination: z.string().min(1).max(2000), expectedPrices: z.string().min(1).max(100000), expectedTotalCents: AmountCentsSchema }),
  marcharPase: MarcharPaseInputSchema,
  cambiarEstadoLineas: CambiarEstadoLineasInputSchema,
  cambiarEstadoTarea: CambiarEstadoTareaInputSchema,
  marcarAgotado: MarcarAgotadoInputSchema,
} as const
export const OFFLINE_OUTPUT_SCHEMAS = {
  enviarPedido: EnviarPedidoOutputSchema, marcharPase: MarcharPaseOutputSchema,
  cambiarEstadoLineas: CambiarEstadoLineasOutputSchema, cambiarEstadoTarea: CambiarEstadoTareaOutputSchema,
  marcarAgotado: MarcarAgotadoOutputSchema,
} as const
export const OfflineCommandSchema = z.discriminatedUnion("operation", [
  z.strictObject({ ...Envelope, operation: z.literal("enviarPedido"), payload: OFFLINE_PAYLOAD_SCHEMAS.enviarPedido }),
  z.strictObject({ ...Envelope, operation: z.literal("marcharPase"), payload: OFFLINE_PAYLOAD_SCHEMAS.marcharPase }),
  z.strictObject({ ...Envelope, operation: z.literal("cambiarEstadoLineas"), payload: OFFLINE_PAYLOAD_SCHEMAS.cambiarEstadoLineas }),
  z.strictObject({ ...Envelope, operation: z.literal("cambiarEstadoTarea"), payload: OFFLINE_PAYLOAD_SCHEMAS.cambiarEstadoTarea }),
  z.strictObject({ ...Envelope, operation: z.literal("marcarAgotado"), payload: OFFLINE_PAYLOAD_SCHEMAS.marcarAgotado }),
]).superRefine((v, ctx) => {
  if (v.restaurantId !== v.payload.restaurantId || v.locationId !== v.payload.locationId) ctx.addIssue({ code: "custom", message: "El comando pertenece a otro local." })
  if (v.operation === "enviarPedido" && v.payload.requestId !== v.commandId) ctx.addIssue({ code: "custom", message: "Conserva el identificador original del envío." })
  const has = (kind: CommandPrecondition["kind"], id: string) => v.preconditions.some((p) => p.kind === kind && p.id === id)
  let complete = false
  switch (v.operation) {
    case "enviarPedido":
    case "marcharPase": complete = v.payload.sessionId ? has("session", v.payload.sessionId) : !!v.payload.takeawayId && has("takeaway", v.payload.takeawayId); break
    case "cambiarEstadoLineas": complete = v.payload.lineIds.every((id) => has("line", id)); break
    case "cambiarEstadoTarea": complete = has("task", v.payload.taskId); break
    case "marcarAgotado": complete = has("item", v.payload.itemId); break
  }
  if (!complete) ctx.addIssue({ code: "custom", message: "Falta la versión del destino o de alguna entidad afectada." })
})
export type OfflineCommand = z.infer<typeof OfflineCommandSchema>

/** JSON canónico limitado a valores JSON. No admite undefined, NaN ni objetos especiales. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`
  }
  throw new Error("El contenido debe ser JSON sin valores vacíos ni especiales.")
}
export function syncStreamKey(scope: SyncScope): string {
  return sha256Hex(canonicalJson(SyncScopeSchema.parse({ actorUid: scope.actorUid, restaurantId: scope.restaurantId, locationId: scope.locationId, deviceId: scope.deviceId })))
}
export function offlineCommandKey(command: Pick<OfflineCommand, keyof SyncScope | "commandId">): string {
  return sha256Hex(JSON.stringify([syncStreamKey(SyncScopeSchema.parse({ actorUid: command.actorUid, restaurantId: command.restaurantId, locationId: command.locationId, deviceId: command.deviceId })), command.commandId]))
}
export function commandFingerprint(command: OfflineCommand): string {
  return sha256Hex(canonicalJson(OfflineCommandSchema.parse(command)))
}
export const COMMAND_CONFLICT_CODES = ["stale_version", "destination_changed", "price_changed", "unavailable", "task_taken", "sequence_gap", "expired", "service_locked"] as const
export const CommandResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("applied"), response: z.json(), versions: z.array(ServerEntityVersionSchema) }),
  z.object({ status: z.literal("conflict"), code: z.enum(COMMAND_CONFLICT_CODES), message: z.string().min(1).max(500), currentVersions: z.array(ServerEntityVersionSchema) }),
  z.object({ status: z.literal("rejected"), code: z.enum(["permission_denied", "module_off", "invalid_command", "key_reused", "device_revoked"]), message: z.string().min(1).max(500) }),
  z.object({ status: z.literal("discarded"), reason: z.string().trim().min(1).max(200) }),
])
export type CommandResult = z.infer<typeof CommandResultSchema>
export const CommandReceiptSchema = z.object({
  commandId: StableCommandIdSchema, streamKey: z.string().regex(/^[a-f0-9]{64}$/), sequence: PlatformRevisionSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/), result: CommandResultSchema, recordedAt: TimestampSchema,
})
export type CommandReceipt = z.infer<typeof CommandReceiptSchema>
export function recoverCommand(command: OfflineCommand, receipt: CommandReceipt | null): CommandResult | null {
  if (!receipt) return null
  if (receipt.commandId !== command.commandId || receipt.streamKey !== syncStreamKey(command) || receipt.sequence !== command.sequence || receipt.fingerprint !== commandFingerprint(command)) {
    return { status: "rejected", code: "key_reused", message: "Este identificador ya se usó con otro contenido. Conserva el envío y revisa la incidencia." }
  }
  if (receipt.result.status === "applied") OFFLINE_OUTPUT_SCHEMAS[command.operation].parse(receipt.result.response)
  return receipt.result
}
/** Resuelve cambios locales encadenados usando recibos del mismo flujo, sin reescribir la intención. */
export function resolveCommandPreconditions(command: OfflineCommand, predecessors: readonly CommandReceipt[]): CommandPrecondition[] | null {
  const resolved: CommandPrecondition[] = []
  for (const condition of command.preconditions) {
    if (!condition.afterCommandId) { resolved.push(condition); continue }
    const receipt = predecessors.find((r) => r.commandId === condition.afterCommandId && r.streamKey === syncStreamKey(command) && r.sequence < command.sequence)
    if (!receipt || receipt.result.status !== "applied") return null
    const version = receipt.result.versions.find((v) => v.kind === condition.kind && v.id === condition.id)
    if (!version) return null
    resolved.push({ kind: condition.kind, id: condition.id, version: version.version })
  }
  return resolved
}
export function commandVersionConflicts(command: OfflineCommand, current: readonly CommandPrecondition[], predecessors: readonly CommandReceipt[] = []): CommandPrecondition[] {
  const resolved = resolveCommandPreconditions(command, predecessors)
  if (!resolved) return [...command.preconditions]
  return resolved.filter((p) => !current.some((c) => c.kind === p.kind && c.id === p.id && c.version === p.version))
}
export const LocalCommandStateSchema = z.enum(["queued", "sending", "uncertain", "retry", "conflict", "rejected", "applied", "discarded"])
export const LocalQueueEntrySchema = z.strictObject({
  command: OfflineCommandSchema, state: LocalCommandStateSchema, attempts: z.number().int().min(0),
  nextAttemptAt: MillisSchema, result: CommandResultSchema.nullable(), lastError: z.string().max(500).nullable(),
})
export type LocalQueueEntry = z.infer<typeof LocalQueueEntrySchema>
/** Solo una cabeza por flujo. Las incidencias y resultados inciertos bloquean lo posterior. */
export function nextLocalCommand(entries: readonly LocalQueueEntry[], scope: SyncScope, now: number): LocalQueueEntry | null {
  const key = syncStreamKey(scope)
  const pending = entries.filter((e) => syncStreamKey(e.command) === key && e.state !== "applied" && e.state !== "discarded").sort((a, b) => a.command.sequence - b.command.sequence)
  const head = pending[0]
  if (!head || !["queued", "retry", "uncertain"].includes(head.state) || head.nextAttemptAt > now) return null
  return head
}
export function enqueueLocalCommand(entries: readonly LocalQueueEntry[], input: OfflineCommand): LocalQueueEntry[] {
  const command = OfflineCommandSchema.parse(input)
  const key = syncStreamKey(command)
  const stream = entries.filter((e) => syncStreamKey(e.command) === key)
  const same = stream.find((e) => e.command.commandId === command.commandId)
  if (same) {
    if (commandFingerprint(same.command) !== commandFingerprint(command)) throw new Error("No cambies el contenido de un comando guardado.")
    return [...entries]
  }
  if (stream.some((e) => e.command.sequence === command.sequence)) throw new Error("La secuencia ya está ocupada.")
  // El adaptador asigna y guarda la secuencia en la misma transacción de IndexedDB.
  if (stream.length && command.sequence !== Math.max(...stream.map((e) => e.command.sequence)) + 1) throw new Error("Falta un comando anterior.")
  return [...entries, { command, state: "queued", attempts: 0, nextAttemptAt: 0, result: null, lastError: null }]
}
export function applyCommandReceipt(entry: LocalQueueEntry, receipt: CommandReceipt): LocalQueueEntry {
  const result = recoverCommand(entry.command, receipt)
  if (!result) throw new Error("Falta la respuesta del comando.")
  return { ...entry, state: result.status, result, lastError: null }
}
export function retryLocalCommand(entry: LocalQueueEntry, now: number, message: string): LocalQueueEntry {
  if (!["sending", "uncertain", "retry", "queued"].includes(entry.state)) throw new Error("La incidencia requiere revisión.")
  const attempts = entry.attempts + 1
  return { ...entry, state: "uncertain", attempts, nextAttemptAt: now + Math.min(60_000, 1000 * 2 ** Math.min(attempts - 1, 6)), lastError: message.slice(0, 500) }
}
export const OFFLINE_MESSAGES = {
  pending: "Guardado en este dispositivo. Pendiente de sincronizar. Cocina y caja aún no lo han recibido.",
  kitchen: "Cambio guardado en este dispositivo. Sala aún no lo ha recibido.",
  uncertain: "No sabemos si se ha confirmado. Recuperaremos la respuesta del mismo envío.",
  conflict: "Los datos han cambiado. Revisa el conflicto antes de continuar.",
  card: "Necesitas conexión para cobrar con tarjeta. No se ha realizado ningún cargo.",
  fiscal: "Necesitas conexión para emitir una factura fiscal. Esta vista es una prefactura sin número fiscal.",
  cash: "Anotación local de efectivo pendiente de revisar. No confirma el cobro ni emite una factura.",
} as const
/** El efectivo recogido se puede anotar, pero nunca se convierte automáticamente en Payment. */
export const OfflineCashNoteSchema = z.strictObject({
  ...SyncScopeSchema.shape, noteId: StableCommandIdSchema, billId: DocIdSchema, partId: DocIdSchema,
  expectedRevision: PlatformRevisionSchema, amountCents: AmountCentsSchema.refine((v) => v > 0),
  tipCents: AmountCentsSchema, tenderedCents: AmountCentsSchema, clientCreatedAt: MillisSchema,
  status: z.enum(["pending_review", "reconciled", "discarded"]), paymentId: DocIdSchema.nullable(),
}).refine((v) => v.tenderedCents >= v.amountCents + v.tipCents && Number.isSafeInteger(v.amountCents + v.tipCents), "La entrega no cubre el importe y la propina.")
  .refine((v) => (v.status === "reconciled") === (v.paymentId !== null), "La anotación conciliada necesita su cobro confirmado.")
export type OfflineCashNote = z.infer<typeof OfflineCashNoteSchema>
export function commandReceiptForWrite<H>(r: CommandReceipt, convert: (ms: number) => H) { return { ...r, recordedAt: convert(r.recordedAt) } }

/** Decisión previa a la transacción. Auth y permisos vigentes se comprueban antes, también al recuperar. */
export function inspectCommand(command: OfflineCommand, lastSettledSequence: number, previous: CommandReceipt | null, versions: readonly CommandPrecondition[], now: number, maxAgeMs: number, predecessors: readonly CommandReceipt[] = []):
  | { action: "execute" }
  | { action: "recover"; result: CommandResult }
  | { action: "wait"; expectedSequence: number }
  | { action: "conflict"; code: "expired" | "stale_version" }
  | { action: "reject"; code: "key_reused" } {
  const result = recoverCommand(command, previous)
  if (result) return { action: "recover", result }
  if (command.sequence <= lastSettledSequence) return { action: "reject", code: "key_reused" }
  if (command.sequence !== lastSettledSequence + 1) return { action: "wait", expectedSequence: lastSettledSequence + 1 }
  // La hora del dispositivo solo informa. Un reloj adelantado también requiere revisión.
  if (command.clientCreatedAt > now + 300_000 || now - command.clientCreatedAt > maxAgeMs) return { action: "conflict", code: "expired" }
  if (commandVersionConflicts(command, versions, predecessors).length) return { action: "conflict", code: "stale_version" }
  return { action: "execute" }
}

/** Un proceso interrumpido no puede dejar la cabeza eternamente en sending. */
export function recoverLocalQueueAfterReload(entries: readonly LocalQueueEntry[]): LocalQueueEntry[] {
  return entries.map((entry) => entry.state === "sending" ? { ...entry, state: "uncertain", nextAttemptAt: 0 } : { ...entry })
}
/** Una respuesta HTTP recibida puede ser un conflicto de dominio, no un efecto aplicado. */
export function commandResultForResponse(command: OfflineCommand, response: unknown, versions: CommandPrecondition[]): CommandResult {
  const parsed = OFFLINE_OUTPUT_SCHEMAS[command.operation].parse(response)
  if ("status" in parsed && parsed.status === "rejected") {
    const priceChanged = parsed.problems.some((p) => p.code === "price_changed")
    return { status: "conflict", code: priceChanged ? "price_changed" : "unavailable", message: priceChanged ? "El precio ha cambiado. Revisa el pedido." : "El pedido necesita revisión antes de enviarlo.", currentVersions: versions }
  }
  if ("result" in parsed && parsed.result === "taken") {
    return { status: "conflict", code: "task_taken", message: "Otra persona ya atiende esta tarea. Revisa quién la tiene.", currentVersions: versions }
  }
  return { status: "applied", response: z.json().parse(parsed), versions }
}
