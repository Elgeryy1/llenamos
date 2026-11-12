import { afterEach, describe, expect, it, vi } from 'vitest'
import { provisionalPlanCatalog, type Subscription } from '@llenamos/core'
import { stripeBillingProvider } from './provider'

const subscription: Subscription = { planId:'sala',planVersion:1,status:'trialing',interval:'month',trialEndsAt:Date.now()+10000,periodEndsAt:null,graceEndsAt:null,cancelAtPeriodEnd:false,stripeCustomerId:null,stripeSubscriptionId:null,revision:1 }
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })
describe('Adaptador Billing con HTTP sustituido, sin acceso a Stripe', () => {
  it('bloquea siempre los entornos demo y de emuladores aunque haya claves', () => {
    vi.stubEnv('GCLOUD_PROJECT','demo-llenamos'); vi.stubEnv('STRIPE_BILLING_SECRET_KEY','sk_ficticia'); vi.stubEnv('STRIPE_BILLING_RETURN_ORIGIN','https://ejemplo.test')
    expect(stripeBillingProvider().configured).toBe(false)
  })
  it('usa el precio del servidor, retorno fijo y clave idempotente en Checkout', async () => {
    vi.stubEnv('GCLOUD_PROJECT','fixture-sin-red'); vi.stubEnv('FIRESTORE_EMULATOR_HOST',''); vi.stubEnv('FUNCTIONS_EMULATOR','false'); vi.stubEnv('STRIPE_BILLING_SECRET_KEY','sk_ficticia'); vi.stubEnv('STRIPE_BILLING_RETURN_ORIGIN','https://ejemplo.test')
    const fetcher = vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({ id:'cs_fixture',url:'https://checkout.stripe.com/fixture' }),{ status:200 }))
    const plan = { ...provisionalPlanCatalog()[1]!,stripeMonthlyPriceId:'price_fixture' }
    const adapter = stripeBillingProvider()
    expect(adapter.configured).toBe(true)
    await adapter.start({ restaurantId:'local',intentId:'intento',plan,interval:'month',subscription,key:'clave_estable' })
    const [url, options] = fetcher.mock.calls[0]!
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions')
    const body = new URLSearchParams(options!.body as string)
    expect(body.get('line_items[0][price]')).toBe('price_fixture')
    expect(body.get('success_url')).toBe('https://ejemplo.test/panel/planes')
    expect(body.get('metadata[intentId]')).toBe('intento')
    expect((options!.headers as Record<string,string>)['Idempotency-Key']).toBe('clave_estable')
  })
})
