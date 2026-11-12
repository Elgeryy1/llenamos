import { describe, expect, it, vi } from 'vitest'
import { appOrigin, checkoutUrl, routing, stripeClient } from './stripe'
describe('Adaptador de cobro', () => {
  it('exige una elección explícita y una cuenta conectada para cada restaurante', () => {
    expect(() => routing('r', {})).toThrow('Falta decidir')
    expect(routing('r', { STRIPE_MOBILE_MODE: 'single' })).toEqual({ mode: 'single', account: null })
    expect(routing('r', { STRIPE_MOBILE_MODE: 'connect', STRIPE_CONNECTED_ACCOUNTS: '{"r":"acct_example"}' })).toEqual({ mode: 'connect', account: 'acct_example' })
    expect(() => routing('another', { STRIPE_MOBILE_MODE: 'connect', STRIPE_CONNECTED_ACCOUNTS: '{"r":"acct_example"}' })).toThrow('no tiene una cuenta')
    expect(() => routing('r', { STRIPE_MOBILE_MODE: 'connect', STRIPE_CONNECTED_ACCOUNTS: 'broken' })).toThrow('no es válida')
  })
  it('bloquea toda salida bancaria en demo y no inventa un pago sin clave', async () => {
    expect(stripeClient({ STRIPE_SECRET_KEY: 'sk_live_example', STRIPE_MOBILE_WEBHOOK_SECRET: 'secret', GCLOUD_PROJECT: 'demo-llenamos' }).configured).toBe(false)
    const fetcher = vi.fn<typeof fetch>()
    const provider = stripeClient({}, fetcher)
    await expect(provider.retrieve('cs_example', { mode: 'single', account: null })).rejects.toThrow('no están configurados')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('valida el origen y la redirección para no perder tokens o abrir otra web', () => {
    expect(appOrigin({ PUBLIC_APP_URL: 'http://localhost:3015', FUNCTIONS_EMULATOR: 'true' })).toBe('http://localhost:3015')
    expect(() => appOrigin({ PUBLIC_APP_URL: 'http://example.com' })).toThrow()
    expect(() => appOrigin({ PUBLIC_APP_URL: 'https://example.com/path' })).toThrow()
    expect(checkoutUrl('https://checkout.stripe.com/c/pay/cs_test')).toContain('checkout.stripe.com')
    expect(() => checkoutUrl('https://checkout.stripe.com.evil.test/c/pay')).toThrow()
    expect(() => checkoutUrl('https://evil@checkout.stripe.com/pay')).toThrow()
  })
})
