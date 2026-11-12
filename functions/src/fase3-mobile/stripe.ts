import { z } from 'zod'
import { HttpsError } from 'firebase-functions/v2/https'

export const StripeSession = z.object({
  id: z.string().regex(/^cs_[A-Za-z0-9_]+$/), url: z.string().nullable().optional(),
  status: z.enum(['open', 'complete', 'expired']), payment_status: z.string(),
  amount_total: z.number().int().nonnegative().nullable(), currency: z.string().nullable(),
  metadata: z.record(z.string(), z.string()), livemode: z.boolean(),
  expires_at: z.number().int(),
})
export type Session = z.infer<typeof StripeSession>
export type Routing = { mode: 'single' | 'connect'; account: string | null }
export type Env = Record<string, string | undefined>
export function routing(rid: string, env: Env = process.env): Routing {
  if (env.STRIPE_MOBILE_MODE === 'single') return { mode: 'single', account: null }
  if (env.STRIPE_MOBILE_MODE !== 'connect') throw new HttpsError('failed-precondition', 'Falta decidir la cuenta que recibe el cobro.')
  let accounts: Record<string, string>
  try { accounts = z.record(z.string(), z.string().regex(/^acct_[A-Za-z0-9]+$/)).parse(JSON.parse(env.STRIPE_CONNECTED_ACCOUNTS ?? '{}')) }
  catch { throw new HttpsError('failed-precondition', 'La configuración de cuentas conectadas no es válida.') }
  if (!accounts[rid]) throw new HttpsError('failed-precondition', 'Este restaurante no tiene una cuenta de cobro configurada.')
  return { mode: 'connect', account: accounts[rid] }
}
export function appOrigin(env: Env = process.env) {
  const url = new URL(env.PUBLIC_APP_URL ?? 'http://localhost:3015')
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
    (url.protocol !== 'https:' && !(env.FUNCTIONS_EMULATOR === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname))))
    throw new HttpsError('failed-precondition', 'Falta configurar la dirección segura de la web.')
  return url.origin
}
export function checkoutUrl(value: string) {
  const u = new URL(value)
  if (u.protocol !== 'https:' || u.hostname !== 'checkout.stripe.com' || u.port || u.username || u.password)
    throw new Error('Stripe no ha devuelto una dirección de pago válida.')
  return value
}
/** El transporte se inyecta en pruebas. En demo se impide cualquier petición bancaria real. */
export function stripeClient(env: Env = process.env, transport?: typeof fetch) {
  const configured = !!env.STRIPE_SECRET_KEY && !!env.STRIPE_MOBILE_WEBHOOK_SECRET &&
    (!!transport || (env.FUNCTIONS_EMULATOR !== 'true' && !env.GCLOUD_PROJECT?.startsWith('demo-')))
  async function request(path: string, route: Routing, key?: string, body?: URLSearchParams) {
    if (!configured) throw new HttpsError('failed-precondition', 'Los pagos móviles no están configurados. Pide al personal que te cobre.')
    const response = await (transport ?? fetch)(`https://api.stripe.com/v1/checkout/sessions${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Stripe-Version': '2026-10-28.endive',
        ...(route.account ? { 'Stripe-Account': route.account } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}), ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body, signal: AbortSignal.timeout(15000),
    })
    // Un error o timeout nunca libera la reserva de saldo: puede haberse creado la sesión.
    if (!response.ok) throw new HttpsError('unavailable', 'No se ha podido confirmar la respuesta de Stripe. Recupera el mismo intento.')
    return StripeSession.parse(await response.json())
  }
  return { configured,
    retrieve: (id: string, route: Routing) => request(`/${encodeURIComponent(id)}`, route),
    expire: (id: string, route: Routing, key: string) => request(`/${encodeURIComponent(id)}/expire`, route, key, new URLSearchParams()),
    create: (v: { rid: string; lid: string; id: string; amount: number; tip: number; name: string; origin: string; route: Routing; key: string; now: number; lang: string }) => {
      const body = new URLSearchParams({ mode: 'payment', 'payment_method_types[0]': 'card',
        // Stripe exige un mínimo de 30 minutos. El enlace privado caduca antes.
        expires_at: String(Math.floor(v.now / 1000) + 1800), locale: v.lang,
        success_url: `${v.origin}/p/volver?checkout=${encodeURIComponent(v.id)}`,
        cancel_url: `${v.origin}/p/volver?checkout=${encodeURIComponent(v.id)}&cancelled=1`,
        'metadata[restaurantId]': v.rid, 'metadata[locationId]': v.lid, 'metadata[checkoutId]': v.id,
        'metadata[tipCents]': String(v.tip), 'metadata[amountCents]': String(v.amount),
      })
      for (const [i, amount, name] of [[0, v.amount, v.name], ...(v.tip ? [[1, v.tip, 'Propina voluntaria']] : [])] as [number, number, string][]) {
        body.set(`line_items[${i}][price_data][currency]`, 'eur')
        body.set(`line_items[${i}][price_data][product_data][name]`, name)
        body.set(`line_items[${i}][price_data][unit_amount]`, String(amount))
        body.set(`line_items[${i}][quantity]`, '1')
      }
      return request('', v.route, v.key, body)
    },
  }
}
