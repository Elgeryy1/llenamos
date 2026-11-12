import { renderMessage, type Message } from '@llenamos/core'
import { tenantProviderEnv } from './tenant'
export async function sendMessage(message: Message, key: string, providerEnv?: NodeJS.ProcessEnv) {
 const rid = /^restaurants\/([^/]+)\/messages\/[^/]+$/.exec(key)?.[1]
 const env = providerEnv ?? (rid ? await tenantProviderEnv(rid) : { FUNCTIONS_EMULATOR: process.env.FUNCTIONS_EMULATOR })
 const rendered = renderMessage(message)
 const email = message.channel === 'email'
 const configured = email ? env.RESEND_API_KEY && env.EMAIL_FROM : env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID
 if (!configured) return { status: env.FUNCTIONS_EMULATOR === 'true' ? 'captured' : 'not_configured', rendered: { subject: rendered.subject, body: rendered.body }, provider: null, providerMessageId: null } as const
 const buttons = rendered.buttons.map(b => ({ type: 'reply', reply: { id: `${key}:${b.id}`, title: b.title } }))
 const payload = email ? { from: env.EMAIL_FROM, to: [message.to], subject: rendered.subject, text: rendered.body } : { messaging_product: 'whatsapp', to: message.to.slice(1), ...(buttons.length ? { type: 'interactive', interactive: { type: 'button', body: { text: rendered.body }, action: { buttons } } } : { type: 'text', text: { body: rendered.body } }) }
 // Los avisos de recogida pueden salir fuera de la ventana de atención: exigen plantilla aprobada.
 const takeaway = message.template === 'takeaway_accepted' || message.template === 'takeaway_ready'
 const templateName = env[message.template === 'takeaway_ready' ? 'WHATSAPP_TEMPLATE_TAKEAWAY_READY' : 'WHATSAPP_TEMPLATE_TAKEAWAY_ACCEPTED']
 if (!email && takeaway && !templateName) return { status: 'not_configured', rendered, provider: null, providerMessageId: null } as const
 const whatsappPayload = !email && takeaway ? { messaging_product: 'whatsapp', to: message.to.slice(1), type: 'template', template: {
  name: templateName, language: { code: message.language === 'en' ? 'en_GB' : message.language },
  components: [{ type: 'body', parameters: [String(message.data.guestName ?? ''), String(message.data.restaurantName ?? ''), String(message.data.reference ?? ''),
   new Intl.DateTimeFormat(message.language, { timeZone: String(message.data.timezone || 'Europe/Madrid'), dateStyle: 'medium', timeStyle: 'short' }).format(Number(message.data.startAt)),
   new Intl.NumberFormat(message.language, { style: 'currency', currency: 'EUR' }).format(Number(message.data.totalCents) / 100), String(message.data.manageUrl ?? '')].map(text => ({ type: 'text', text })) }],
 } } : payload
 const response = await fetch(email ? 'https://api.resend.com/emails' : `https://graph.facebook.com/v23.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${email ? env.RESEND_API_KEY : env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json', ...(email ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(whatsappPayload), signal: AbortSignal.timeout(15000) })
 if (!response.ok) throw new Error(`El proveedor ha rechazado el envío (${response.status}).`)
 const result = await response.json() as { id?: string; messages?: { id: string }[] }
 const providerMessageId = email ? result.id : result.messages?.[0]?.id
 if (!providerMessageId) throw new Error('El proveedor no ha devuelto un identificador de envío.')
 return { status: 'sent', rendered: { subject: rendered.subject, body: rendered.body }, provider: email ? 'resend' : 'whatsapp_cloud', providerMessageId } as const
}
