/**
 * Cargas de ejemplo de Stripe y su firma, para probar la señal sin cuenta ni clave de Stripe.
 *
 * Firma igual que la documentada por Stripe: cabecera `Stripe-Signature: t=<segundos>,v1=<hmac>`
 * con HMAC SHA-256 de `"<t>.<cuerpo>"` y el secreto del endpoint (`STRIPE_WEBHOOK_SECRET`). Sin SDK.
 * Estas cargas son inventadas con la forma de un `checkout.session.completed`; no se han
 * contrastado contra Stripe real.
 */
import { createHmac } from 'node:crypto'

export interface CheckoutOptions {
 eventId?: string
 sessionId: string
 reservationPath: string
 amountCents: number
 currency?: string
 paymentStatus?: string
 type?: string
}

/** Un `checkout.session.completed` con la forma que lee `handleStripe` y algún campo de más. */
export function checkoutEvent(o: CheckoutOptions) {
 return {
  id: o.eventId ?? 'evt_test_1',
  object: 'event',
  api_version: '2025-01-27.acacia',
  livemode: false,
  type: o.type ?? 'checkout.session.completed',
  data: {
   object: {
    id: o.sessionId,
    object: 'checkout.session',
    mode: 'payment',
    payment_status: o.paymentStatus ?? 'paid',
    amount_total: o.amountCents,
    currency: o.currency ?? 'eur',
    customer_details: { email: 'cliente@example.test' },
    metadata: { reservationPath: o.reservationPath },
   },
  },
 }
}

/** Cabecera `Stripe-Signature` para unos bytes exactos. `t` en segundos. */
export function stripeSignature(raw: string, secret: string, t = Math.floor(Date.now() / 1000)) {
 return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`
}

/** Envía una carga firmada al `stripeWebhook` del emulador. */
export function postWebhook(url: string, body: unknown, signature: string | null, method = 'POST') {
 const raw = typeof body === 'string' ? body : JSON.stringify(body)
 return fetch(url, { method, headers: { 'Content-Type': 'application/json', ...(signature ? { 'Stripe-Signature': signature } : {}) }, ...(method === 'POST' ? { body: raw } : {}) })
}
