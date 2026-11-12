import { renderMessage, type Message } from '@llenamos/core'
import type { Credentials } from '../platform/integrations.js'
import { PermanentFailure, RetryLater } from './types.js'

export type SendResult =
  | { status: 'sent'; provider: 'resend' | 'whatsapp_cloud'; providerMessageId: string; subject: string | null }
  | { status: 'not_configured'; provider: null; providerMessageId: null; subject: string | null }

const WHATSAPP_VERSION = 'v23.0'

/**
 * Envío real por el proveedor del propio restaurante. Sin credenciales completas devuelve `not_configured`;
 * no hay captura ni éxito simulado. `key` es el ID estable del outbox: Resend lo usa como Idempotency-Key.
 */
export async function sendMessage(message: Message, key: string, credentials: Credentials, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<SendResult> {
  const rendered = renderMessage(message)
  const email = message.channel === 'email'
  const mail = credentials.email, wa = credentials.whatsapp
  const configured = email ? !!(mail?.apiKey && mail.from) : !!(wa?.token && wa.phoneNumberId)
  if (!configured) return { status: 'not_configured', provider: null, providerMessageId: null, subject: rendered.subject }
  // Los avisos de recogida pueden salir fuera de la ventana de atención: exigen plantilla aprobada.
  const takeaway = message.template === 'takeaway_accepted' || message.template === 'takeaway_ready'
  const templateName = message.template === 'takeaway_ready' ? wa?.templateTakeawayReady : wa?.templateTakeawayAccepted
  if (!email && takeaway && !templateName) return { status: 'not_configured', provider: null, providerMessageId: null, subject: rendered.subject }
  const buttons = rendered.buttons.map(b => ({ type: 'reply', reply: { id: `${key}:${b.id}`, title: b.title } }))
  const text = { messaging_product: 'whatsapp', to: message.to.slice(1), ...(buttons.length
    ? { type: 'interactive', interactive: { type: 'button', body: { text: rendered.body }, action: { buttons } } }
    : { type: 'text', text: { body: rendered.body } }) }
  // Solo se arma para las plantillas de recogida: con un correo o un texto de WhatsApp no hay `startAt` ni `totalCents` y daría `Invalid time value`.
  const template = () => ({ messaging_product: 'whatsapp', to: message.to.slice(1), type: 'template', template: {
    name: templateName, language: { code: message.language === 'en' ? 'en_GB' : message.language },
    components: [{ type: 'body', parameters: [String(message.data.guestName ?? ''), String(message.data.restaurantName ?? ''), String(message.data.reference ?? ''),
      new Intl.DateTimeFormat(message.language, { timeZone: String(message.data.timezone || 'Europe/Madrid'), dateStyle: 'medium', timeStyle: 'short' }).format(Number(message.data.startAt)),
      new Intl.NumberFormat(message.language, { style: 'currency', currency: 'EUR' }).format(Number(message.data.totalCents) / 100), String(message.data.manageUrl ?? '')].map(value => ({ type: 'text', text: value })) }],
  } })
  const body = email ? { from: mail!.from, to: [message.to], subject: rendered.subject, text: rendered.body } : takeaway ? template() : text
  let response: Response
  try {
    response = await fetchImpl(email ? 'https://api.resend.com/emails' : `https://graph.facebook.com/${WHATSAPP_VERSION}/${wa!.phoneNumberId}/messages`, {
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${email ? mail!.apiKey : wa!.token}`, 'Content-Type': 'application/json', ...(email ? { 'Idempotency-Key': key } : {}) },
      body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    })
  } catch { if (signal?.aborted) throw signal.reason; throw new RetryLater(0, 'provider-unreachable') }
  if (response.status === 429 || response.status >= 500) {
    const wait = Number(response.headers.get('retry-after'))
    throw new RetryLater(Number.isFinite(wait) && wait > 0 ? Math.min(wait, 3600) : 0, `provider-${response.status}`)
  }
  if (!response.ok) throw new PermanentFailure(`provider-${response.status}`, 'El proveedor ha rechazado el envío.')
  const result = await response.json().catch(() => ({})) as { id?: string; messages?: { id: string }[] }
  const providerMessageId = email ? result.id : result.messages?.[0]?.id
  if (!providerMessageId) throw new PermanentFailure('provider-sin-id', 'El proveedor no ha devuelto un identificador de envío.')
  return { status: 'sent', provider: email ? 'resend' : 'whatsapp_cloud', providerMessageId, subject: rendered.subject }
}
