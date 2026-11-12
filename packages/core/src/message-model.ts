/**
 * Mensajes a clientes (outbox): `restaurants/{rid}/messages/{mid}`. Solo los escribe el servidor.
 *
 * Quien crea o cambia una reserva encola sus mensajes en la misma transacción
 * (`status: "queued"`, con `sendAt`); el procesador los envía, o en local los deja
 * `captured` con el texto ya renderizado. Nunca se finge un envío: sin proveedor
 * configurado quedan `not_configured`.
 */
import { z } from "zod"
import { DocIdSchema, LanguageSchema } from "./model"
import { E164_REGEX } from "./phone"
import { TimestampSchema } from "./timestamp"

export const MESSAGE_CHANNELS = ["email", "whatsapp"] as const
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number]
export const MessageChannelSchema = z.enum(MESSAGE_CHANNELS)

export const MESSAGE_CHANNEL_LABEL: Record<MessageChannel, string> = {
  email: "correo",
  whatsapp: "WhatsApp",
}

export const MESSAGE_TEMPLATES = [
  "digital_receipt",
  "takeaway_accepted",
  "takeaway_ready",
  "confirmation",
  "pending",
  "reminder",
  "cancellation",
  "waitlist_offer",
  "deposit_request",
  "review_request",
  // Fase 5: campañas con permiso y resumen diario al personal.
  "marketing_campaign",
  "daily_summary",
] as const
export type MessageTemplate = (typeof MESSAGE_TEMPLATES)[number]
export const MessageTemplateSchema = z.enum(MESSAGE_TEMPLATES)

export const MESSAGE_TEMPLATE_LABEL: Record<MessageTemplate, string> = {
  digital_receipt: "recibo digital",
  takeaway_accepted: "pedido para llevar aceptado",
  takeaway_ready: "pedido para llevar listo",
  confirmation: "confirmación",
  pending: "reserva pendiente",
  reminder: "recordatorio",
  cancellation: "cancelación",
  waitlist_offer: "oferta de lista de espera",
  deposit_request: "petición de señal",
  review_request: "petición de reseña",
  marketing_campaign: "campaña",
  daily_summary: "resumen diario",
}

export const MESSAGE_STATUSES = ["queued", "sent", "captured", "not_configured", "failed", "cancelled"] as const
export type MessageStatus = (typeof MESSAGE_STATUSES)[number]
export const MessageStatusSchema = z.enum(MESSAGE_STATUSES)

export const MESSAGE_STATUS_LABEL: Record<MessageStatus, string> = {
  queued: "pendiente de enviar",
  sent: "enviado",
  captured: "no enviado: modo local",
  not_configured: "no enviado: canal no configurado",
  failed: "fallido",
  cancelled: "anulado",
}

/** Datos para rellenar la plantilla: solo valores simples (textos, números, sí o no). */
export const MessageDataSchema = z.record(
  z.string().max(60),
  z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]),
)
export type MessageData = z.infer<typeof MessageDataSchema>

export const RenderedMessageSchema = z.object({
  /** Asunto del correo; null en WhatsApp. */
  subject: z.string().max(300).nullable(),
  body: z.string().max(20_000),
})
export type RenderedMessage = z.infer<typeof RenderedMessageSchema>

/** Campos de un mensaje antes de comprobar que el destinatario cuadra con el canal. */
const MessageFieldsSchema = z.object({
  channel: MessageChannelSchema,
  /** Correo (canal email) o teléfono en E.164 (canal whatsapp). */
  to: z.string().min(1).max(254),
  template: MessageTemplateSchema,
  language: LanguageSchema,
  data: MessageDataSchema,
  takeawayId: DocIdSchema.optional(),
  reservationId: DocIdSchema.nullable(),
  waitlistId: DocIdSchema.nullable(),
  status: MessageStatusSchema,
  /** Cuándo debe salir (ms UTC). */
  sendAt: TimestampSchema,
  attempts: z.number().int().min(0),
  lastError: z.string().max(1000).nullable(),
  /** "resend", "whatsapp_cloud"… o null si no se ha intentado. */
  provider: z.string().max(40).nullable(),
  providerMessageId: z.string().max(200).nullable(),
  /** Texto tal cual le llega (o le llegaría) al cliente; null hasta que se procesa. */
  rendered: RenderedMessageSchema.nullable(),
  /**
   * Fase 5. Los mensajes de marketing llevan propósito (`marketing_email` o `marketing_whatsapp`),
   * cliente y campaña: la fase 6 cancela por propósito al retirar un permiso y el procesador vuelve a
   * comprobar el consentimiento antes de enviar. Los avisos de reserva no llevan propósito.
   */
  purpose: z.enum(["marketing_email", "marketing_whatsapp"]).nullable().optional(),
  customerId: DocIdSchema.nullable().optional(),
  campaignId: DocIdSchema.nullable().optional(),
})

const EMAIL_SIMPLE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const MessageSchema = MessageFieldsSchema.superRefine((m, ctx) => {
  if (m.channel === "email" && !EMAIL_SIMPLE.test(m.to)) {
    ctx.addIssue({ code: "custom", path: ["to"], message: "Un mensaje por correo necesita un correo de destino." })
  }
  if (m.channel === "whatsapp" && !E164_REGEX.test(m.to)) {
    ctx.addIssue({ code: "custom", path: ["to"], message: "Un mensaje por WhatsApp necesita un teléfono en formato +34…." })
  }
})
export type Message = z.infer<typeof MessageSchema>

/**
 * Una fila de la bandeja de avisos. El destinatario puede ser cualquier texto (también vacío o `suprimido`):
 * tras una petición de privacidad, o en un aviso cancelado sin destinatario, el dato ya no es un correo ni un teléfono
 * y una sola fila así no debe tumbar la lista entera.
 */
export const MessageRowSchema = MessageFieldsSchema.extend({ to: z.string().max(254) })
export type MessageRow = z.infer<typeof MessageRowSchema>

/** Lo que se pasa a `enqueueMessage(tx, rid, …)`: el resto lo rellena el outbox. */
export const MessageRequestSchema = MessageFieldsSchema.pick({
  channel: true,
  to: true,
  template: true,
  language: true,
  data: true,
  takeawayId: true,
  reservationId: true,
  waitlistId: true,
  sendAt: true,
  purpose: true,
  customerId: true,
  campaignId: true,
})
export type MessageRequest = z.infer<typeof MessageRequestSchema>

/** Mensaje nuevo en cola a partir de lo que se pide encolar. */
export function queuedMessage(request: MessageRequest): Message {
  return {
    ...request,
    status: "queued",
    attempts: 0,
    lastError: null,
    provider: null,
    providerMessageId: null,
    rendered: null,
  }
}

export type MessageWrite<H> = Omit<Message, "sendAt"> & { sendAt: H }

export function messageForWrite<H>(message: Message, toTimestamp: (ms: number) => H): MessageWrite<H> {
  return { ...message, sendAt: toTimestamp(message.sendAt) }
}
