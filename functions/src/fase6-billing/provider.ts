import { z } from 'zod'
import type { PlanDefinition, Subscription } from '@llenamos/core'

/** El puerto permite probar respuestas sin red. En demo el adaptador real siempre está apagado. */
export interface BillingProvider {
  configured: boolean
  start(input: { restaurantId: string; intentId: string; plan: PlanDefinition; interval: 'month'|'year'; subscription: Subscription; key: string }): Promise<{ id: string; url: string }>
  portal(customer: string, key: string): Promise<{ url: string }>
  cancel(subscription: string, key: string): Promise<{ endsAt: number }>
  current(subscription: string): Promise<unknown>
}
const Link = z.object({ id: z.string(), url: z.url().refine(v => new URL(v).protocol === 'https:') })
export function stripeBillingProvider(): BillingProvider {
  const secret = process.env.STRIPE_BILLING_SECRET_KEY
  const origin = process.env.STRIPE_BILLING_RETURN_ORIGIN
  const local = process.env.FUNCTIONS_EMULATOR === 'true' || process.env.GCLOUD_PROJECT?.startsWith('demo-') || !!process.env.FIRESTORE_EMULATOR_HOST
  const configured = !local && !!secret && !!origin && /^https:\/\//.test(origin)
  async function request(path: string, form?: Record<string,string>, key?: string) {
    if (!configured) throw new Error('Stripe Billing está desactivado en este entorno.')
    const result = await fetch(`https://api.stripe.com/v1/${path}`, { method: form ? 'POST' : 'GET', headers: { Authorization: `Bearer ${secret}`, 'Stripe-Version': '2025-06-30.basil', ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(form ? { body: new URLSearchParams(form).toString() } : {}), signal: AbortSignal.timeout(15000) })
    if (!result.ok) throw new Error('No se ha podido completar la petición de facturación.')
    return result.json() as Promise<unknown>
  }
  const returnUrl = `${origin}/panel/planes`
  return {
    configured,
    async start(input) {
      const price = input.interval === 'month' ? input.plan.stripeMonthlyPriceId : input.plan.stripeAnnualPriceId
      if (!price?.startsWith('price_')) throw new Error('Falta el precio de servidor.')
      if (input.subscription.stripeSubscriptionId) {
        // La confirmación y el cobro ocurren en Stripe. Solo una factura verificada concede el nuevo plan.
        const raw = await request(`subscriptions/${encodeURIComponent(input.subscription.stripeSubscriptionId)}`)
        const current = z.object({ items: z.object({ data: z.array(z.object({ id: z.string() })).length(1) }) }).parse(raw)
        return Link.parse(await request('billing_portal/sessions', { customer: input.subscription.stripeCustomerId!, return_url: returnUrl, 'flow_data[type]': 'subscription_update_confirm', 'flow_data[subscription_update_confirm][subscription]': input.subscription.stripeSubscriptionId, 'flow_data[subscription_update_confirm][items][0][id]': current.items.data[0]!.id, 'flow_data[subscription_update_confirm][items][0][price]': price, 'flow_data[subscription_update_confirm][items][0][quantity]': '1', 'flow_data[after_completion][type]': 'redirect', 'flow_data[after_completion][redirect][return_url]': returnUrl }, input.key))
      }
      return Link.parse(await request('checkout/sessions', { mode: 'subscription', success_url: returnUrl, cancel_url: returnUrl, 'line_items[0][price]': price, 'line_items[0][quantity]': '1', 'metadata[restaurantId]': input.restaurantId, 'metadata[intentId]': input.intentId, 'subscription_data[metadata][restaurantId]': input.restaurantId, 'subscription_data[metadata][intentId]': input.intentId, ...(input.subscription.stripeCustomerId ? { customer: input.subscription.stripeCustomerId } : {}) }, input.key))
    },
    async portal(customer, key) { return Link.parse(await request('billing_portal/sessions', { customer, return_url: returnUrl }, key)) },
    async cancel(subscription, key) {
      const result = z.object({ items: z.object({ data: z.array(z.object({ current_period_end: z.number().int() })).length(1) }), cancel_at_period_end: z.literal(true) }).parse(await request(`subscriptions/${encodeURIComponent(subscription)}`, { cancel_at_period_end: 'true' }, key))
      return { endsAt: result.items.data[0]!.current_period_end * 1000 }
    },
    current(subscription) { return request(`subscriptions/${encodeURIComponent(subscription)}?expand[]=latest_invoice&expand[]=latest_invoice.lines.data`) },
  }
}
