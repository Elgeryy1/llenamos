import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { PlanDefinition,Subscription } from '@llenamos/core'

/** Puerto de Stripe Billing: la plataforma, no cada restaurante, es la cuenta que cobra. */
export interface BillingProvider {
  configured:boolean
  /** Modo de la clave (`sk_live_` frente a `sk_test_`); si se conoce, los eventos de otro modo se rechazan. */
  livemode?:boolean
  start(input:{restaurantId:string;intentId:string;plan:PlanDefinition;interval:'month'|'year';subscription:Subscription;key:string}):Promise<{id:string;url:string}>
  portal(customer:string,key:string):Promise<{url:string}>
  cancel(subscription:string,key:string):Promise<{endsAt:number}>
  current(subscription:string):Promise<unknown>
}
const Link=z.object({id:z.string(),url:z.url().refine(value=>new URL(value).protocol==='https:')})
function secretFrom(file:string|undefined) {
  if(!file)return ''
  try {return readFileSync(file,'utf8').trim()}catch{return ''}
}
/** Sin clave y origen HTTPS no hay cliente: ninguna llamada sale y ninguna respuesta se inventa. */
export function stripeBillingProvider(env:NodeJS.ProcessEnv=process.env,fetcher:typeof fetch=fetch):BillingProvider {
  const secret=secretFrom(env.STRIPE_BILLING_SECRET_KEY_FILE),origin=env.STRIPE_BILLING_RETURN_ORIGIN??''
  const configured=!!secret&&/^https:\/\/[^/\s]+$/.test(origin)
  async function request(path:string,form?:Record<string,string>,key?:string) {
    if(!configured)throw new Error('Stripe Billing no está configurado.')
    const result=await fetcher(`https://api.stripe.com/v1/${path}`,{method:form?'POST':'GET',headers:{Authorization:`Bearer ${secret}`,'Stripe-Version':'2025-06-30.basil',...(form?{'Content-Type':'application/x-www-form-urlencoded'}:{}),...(key?{'Idempotency-Key':key}:{})},...(form?{body:new URLSearchParams(form).toString()}:{}),signal:AbortSignal.timeout(15_000)})
    if(!result.ok)throw new Error('No se ha podido completar la petición de facturación.')
    return result.json() as Promise<unknown>
  }
  const returnUrl=`${origin}/panel/planes`
  return {
    configured,
    ...(configured?{livemode:secret.startsWith('sk_live_')||secret.startsWith('rk_live_')}:{}),
    async start(input) {
      const price=input.interval==='month'?input.plan.stripeMonthlyPriceId:input.plan.stripeAnnualPriceId
      if(!price?.startsWith('price_'))throw new Error('Falta el precio de servidor.')
      if(input.subscription.stripeSubscriptionId) {
        // La confirmación y el cobro ocurren en Stripe. Solo una factura verificada concede el nuevo plan.
        const current=z.object({items:z.object({data:z.array(z.object({id:z.string()})).length(1)})}).parse(await request(`subscriptions/${encodeURIComponent(input.subscription.stripeSubscriptionId)}`))
        return Link.parse(await request('billing_portal/sessions',{customer:input.subscription.stripeCustomerId!,return_url:returnUrl,'flow_data[type]':'subscription_update_confirm','flow_data[subscription_update_confirm][subscription]':input.subscription.stripeSubscriptionId,'flow_data[subscription_update_confirm][items][0][id]':current.items.data[0]!.id,'flow_data[subscription_update_confirm][items][0][price]':price,'flow_data[subscription_update_confirm][items][0][quantity]':'1','flow_data[after_completion][type]':'redirect','flow_data[after_completion][redirect][return_url]':returnUrl},input.key))
      }
      return Link.parse(await request('checkout/sessions',{mode:'subscription',success_url:returnUrl,cancel_url:returnUrl,'line_items[0][price]':price,'line_items[0][quantity]':'1','metadata[restaurantId]':input.restaurantId,'metadata[intentId]':input.intentId,'subscription_data[metadata][restaurantId]':input.restaurantId,'subscription_data[metadata][intentId]':input.intentId,...(input.subscription.stripeCustomerId?{customer:input.subscription.stripeCustomerId}:{})},input.key))
    },
    async portal(customer,key) {return Link.parse(await request('billing_portal/sessions',{customer,return_url:returnUrl},key))},
    async cancel(subscription,key) {
      const result=z.object({items:z.object({data:z.array(z.object({current_period_end:z.number().int()})).length(1)}),cancel_at_period_end:z.literal(true)}).parse(await request(`subscriptions/${encodeURIComponent(subscription)}`,{cancel_at_period_end:'true'},key))
      return {endsAt:result.items.data[0]!.current_period_end*1000}
    },
    current(subscription) {return request(`subscriptions/${encodeURIComponent(subscription)}?expand[]=latest_invoice&expand[]=latest_invoice.lines.data`)},
  }
}
let override:BillingProvider|undefined
/** Pruebas: sustituye el cliente de Stripe por uno falso sin red. */
export function useBillingProvider(provider:BillingProvider|undefined) {override=provider}
export const billingProvider=():BillingProvider=>override??stripeBillingProvider()
