import { z } from 'zod'
import { ApiError } from '../errors.js'

/** Sesión de Checkout tal como la devuelve Stripe; solo lo que se usa, validado. */
export const StripeSession = z.object({
  id: z.string().regex(/^cs_[A-Za-z0-9_]+$/), url: z.string().nullable().optional(),
  status: z.enum(['open', 'complete', 'expired']), payment_status: z.string(),
  amount_total: z.number().int().nonnegative().nullable(), currency: z.string().nullable(),
  metadata: z.record(z.string(), z.string()), livemode: z.boolean(), expires_at: z.number().int(),
})
export type StripeSession = z.infer<typeof StripeSession>

/** Credenciales de Stripe del propio restaurante. Nunca hay clave global ni de otro negocio. */
export interface StripeCredentials { secretKey: string; webhookSecret?: string; mobileWebhookSecret?: string; accountId?: string }

/** Transporte de las llamadas a Stripe. Las pruebas lo sustituyen; en producción es `fetch`. */
let transport: typeof fetch | null = null
export const setStripeTransport = (next: typeof fetch | null) => { transport = next }

/**
 * Stripe rechazó la petición de forma definitiva (clave inválida, cuenta sin activar, parámetros no válidos): la sesión NO se
 * creó y repetirla no lo arregla. Se distingue de un corte o un 5xx, tras los que la sesión pudo crearse.
 */
export class StripeRejected extends ApiError {
  constructor(readonly stripeStatus: number) { super(502, 'unavailable', 'Stripe ha rechazado la petición. Revisa la configuración de Stripe del restaurante. No se ha cobrado nada.') }
}
const unavailable = () => new ApiError(503, 'unavailable', 'No se ha podido confirmar la respuesta de Stripe. Inténtalo de nuevo en unos minutos.')

export function checkoutUrl(value: string) {
  const u = new URL(value)
  if (u.protocol !== 'https:' || u.hostname !== 'checkout.stripe.com' || u.port || u.username || u.password) throw new ApiError(502, 'unavailable', 'Stripe no ha devuelto una dirección de pago válida.')
  return value
}
export const isLiveKey = (secretKey: string) => secretKey.startsWith('sk_live_')

async function request(credentials: StripeCredentials, fetcher: typeof fetch | undefined, path: string, options: { key?: string; body?: URLSearchParams } = {}) {
  const response = await (fetcher ?? transport ?? fetch)(`https://api.stripe.com/v1/checkout/sessions${path}`, {
    method: options.body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${credentials.secretKey}`, 'Stripe-Version': '2026-10-28.endive',
      ...(credentials.accountId ? { 'Stripe-Account': credentials.accountId } : {}),
      ...(options.key ? { 'Idempotency-Key': options.key } : {}), ...(options.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: options.body, signal: AbortSignal.timeout(15_000),
  }).catch(() => { throw unavailable() })
  // Un error o un tiempo agotado nunca libera lo reservado: la sesión pudo crearse. Se recupera con la misma clave.
  // 4xx salvo tiempo agotado, conflicto y límite de tasa: Stripe no ha creado nada y reintentar no cambia la respuesta.
  if (!response.ok) throw response.status >= 400 && response.status < 500 && ![408, 409, 429].includes(response.status) ? new StripeRejected(response.status) : unavailable()
  const parsed = StripeSession.safeParse(await response.json().catch(() => null))
  if (!parsed.success) throw unavailable()
  return parsed.data
}

export interface CheckoutLine { name: string; amountCents: number }
export interface CheckoutRequest {
  lines: CheckoutLine[]; metadata: Record<string, string>; successUrl: string; cancelUrl: string
  /** Segundos hasta la caducidad de la sesión (Stripe exige al menos 30 minutos). */
  expiresAt: number; language: string; idempotencyKey: string; clientReference?: string
}
/** `fetcher` permite al worker usar el transporte que le inyectan; sin él se usa el de la API (o `fetch`). */
export function stripeCheckout(credentials: StripeCredentials, fetcher?: typeof fetch) {
  return {
    create(v: CheckoutRequest) {
      const body = new URLSearchParams({ mode: 'payment', 'payment_method_types[0]': 'card', expires_at: String(v.expiresAt), locale: v.language, success_url: v.successUrl, cancel_url: v.cancelUrl })
      for (const [key, value] of Object.entries(v.metadata)) body.set(`metadata[${key}]`, value)
      if (v.clientReference) body.set('client_reference_id', v.clientReference)
      v.lines.forEach((line, i) => {
        body.set(`line_items[${i}][price_data][currency]`, 'eur')
        body.set(`line_items[${i}][price_data][product_data][name]`, line.name)
        body.set(`line_items[${i}][price_data][unit_amount]`, String(line.amountCents))
        body.set(`line_items[${i}][quantity]`, '1')
      })
      return request(credentials, fetcher, '', { key: v.idempotencyKey, body })
    },
    retrieve: (id: string) => request(credentials, fetcher, `/${encodeURIComponent(id)}`),
    expire: (id: string, key: string) => request(credentials, fetcher, `/${encodeURIComponent(id)}/expire`, { key, body: new URLSearchParams() }),
  }
}
