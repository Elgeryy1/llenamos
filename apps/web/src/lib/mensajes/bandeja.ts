/**
 * Bandeja de mensajes del panel (`/panel/mensajes`): lectura de
 * `restaurants/{rid}/messages` con el esquema de core, filtros y textos.
 * Los mensajes solo los escribe el servidor; aquí no se cambia nada.
 */
import {
  MESSAGE_CHANNEL_LABEL,
  MESSAGE_STATUS_LABEL,
  MESSAGE_TEMPLATE_LABEL,
  MessageSchema,
  type Message,
  type MessageChannel,
  type MessageStatus,
} from "@llenamos/core"
import { DataShapeError } from "@/lib/data/parse"

export type MessageDoc = Message & { id: string }

/** Lee un mensaje. Si no encaja con el contrato, se dice qué campos fallan. */
export function parseMessage(id: string, data: unknown): MessageDoc {
  const r = MessageSchema.safeParse(data)
  if (!r.success) {
    const fields = [...new Set(r.error.issues.map((i) => i.path.join(".") || "documento"))]
    throw new DataShapeError(`messages/${id}`, fields)
  }
  return { id, ...r.data }
}

/** Grupos del filtro de la bandeja (lo que le importa al restaurante, no los estados uno a uno). */
export const INBOX_FILTERS = ["all", "queued", "sent", "captured", "problems", "cancelled"] as const
export type InboxFilter = (typeof INBOX_FILTERS)[number]

export const INBOX_FILTER_LABEL: Record<InboxFilter, string> = {
  all: "Todos",
  queued: "Pendientes",
  sent: "Enviados",
  captured: "Capturados en local",
  problems: "Con problemas",
  cancelled: "Anulados",
}

const FILTER_STATUSES: Record<Exclude<InboxFilter, "all">, readonly MessageStatus[]> = {
  queued: ["queued"],
  sent: ["sent"],
  captured: ["captured"],
  problems: ["failed", "not_configured"],
  cancelled: ["cancelled"],
}

export function matchesFilter(m: Pick<Message, "status">, filter: InboxFilter): boolean {
  return filter === "all" || FILTER_STATUSES[filter].includes(m.status)
}

export interface InboxQuery {
  filter: InboxFilter
  channel: MessageChannel | "all"
  /** Busca en el destinatario, el texto, la plantilla y el nombre del cliente. */
  text: string
}

function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
}

export function searchableText(m: MessageDoc): string {
  const guest = typeof m.data.guestName === "string" ? m.data.guestName : ""
  const reference = typeof m.data.reference === "string" ? m.data.reference : ""
  return normalize(
    [m.to, guest, reference, MESSAGE_TEMPLATE_LABEL[m.template], m.rendered?.subject ?? "", m.rendered?.body ?? ""].join(" "),
  )
}

/** Filtra y ordena: lo más reciente (por hora de envío) primero. */
export function filterInbox(messages: readonly MessageDoc[], q: InboxQuery): MessageDoc[] {
  const needle = normalize(q.text.trim())
  return messages
    .filter((m) => matchesFilter(m, q.filter))
    .filter((m) => q.channel === "all" || m.channel === q.channel)
    .filter((m) => needle === "" || searchableText(m).includes(needle))
    .sort((a, b) => b.sendAt - a.sendAt || a.id.localeCompare(b.id))
}

export function countByFilter(messages: readonly MessageDoc[]): Record<InboxFilter, number> {
  const out = Object.fromEntries(INBOX_FILTERS.map((f) => [f, 0])) as Record<InboxFilter, number>
  for (const m of messages) for (const f of INBOX_FILTERS) if (matchesFilter(m, f)) out[f]++
  return out
}

/** Pendientes que ya deberían haber salido: lo que procesaría «Procesar pendientes». */
export function dueCount(messages: readonly MessageDoc[], now: number): number {
  return messages.filter((m) => m.status === "queued" && m.sendAt <= now).length
}

/* Textos --------------------------------------------------------------------------- */

export type StatusTone = "ok" | "local" | "waiting" | "error" | "muted"

/** Tono del punto de estado (siempre va con su palabra al lado). */
export function statusTone(status: MessageStatus): StatusTone {
  switch (status) {
    case "sent":
      return "ok"
    case "captured":
      return "local"
    case "queued":
      return "waiting"
    case "failed":
    case "not_configured":
      return "error"
    case "cancelled":
      return "muted"
  }
}

export function statusLabel(status: MessageStatus): string {
  return MESSAGE_STATUS_LABEL[status]
}

export function channelLabel(channel: MessageChannel): string {
  return MESSAGE_CHANNEL_LABEL[channel]
}

/** «Confirmación por WhatsApp». */
export function messageTitle(m: Pick<Message, "template" | "channel">): string {
  const t = MESSAGE_TEMPLATE_LABEL[m.template]
  return `${t.charAt(0).toUpperCase()}${t.slice(1)} por ${MESSAGE_CHANNEL_LABEL[m.channel]}`
}

/** Explicación del estado para quien mira la bandeja. */
export function statusExplanation(m: Pick<Message, "status" | "lastError" | "attempts" | "sendAt">, now: number): string {
  switch (m.status) {
    case "queued":
      return m.sendAt <= now
        ? "Ya debería haber salido. Pulsa «Procesar pendientes» para enviarlo ahora."
        : "Está programado y saldrá solo a su hora."
    case "sent":
      return "Entregado al proveedor de envío."
    case "captured":
      return "No se ha enviado: estás en modo local. Este es el texto que le llegaría al cliente."
    case "not_configured":
      return "No se ha enviado porque este canal no está configurado en el servidor."
    case "failed":
      return m.lastError
        ? `Ha fallado tras ${m.attempts} ${m.attempts === 1 ? "intento" : "intentos"}: ${m.lastError}`
        : `Ha fallado tras ${m.attempts} ${m.attempts === 1 ? "intento" : "intentos"}.`
    case "cancelled":
      return "Se anuló porque la reserva cambió o se canceló antes de enviarlo."
  }
}

/** Nombre del cliente si el mensaje lo lleva en sus datos. */
export function guestOf(m: Pick<Message, "data">): string | null {
  const g = m.data.guestName
  return typeof g === "string" && g.trim() ? g : null
}

/** Resultado de «Procesar pendientes» en una frase. */
export function processSummary(r: { processed: number; sent: number; captured: number; notConfigured: number; failed: number }): string {
  if (r.processed === 0) return "No había mensajes pendientes de enviar."
  const parts: string[] = []
  if (r.sent) parts.push(`${r.sent} ${r.sent === 1 ? "enviado" : "enviados"}`)
  if (r.captured) parts.push(`${r.captured} ${r.captured === 1 ? "capturado" : "capturados"} en local`)
  if (r.notConfigured) parts.push(`${r.notConfigured} sin canal configurado`)
  if (r.failed) parts.push(`${r.failed} ${r.failed === 1 ? "fallido" : "fallidos"}`)
  return `${r.processed} ${r.processed === 1 ? "mensaje procesado" : "mensajes procesados"}: ${parts.join(", ")}.`
}
