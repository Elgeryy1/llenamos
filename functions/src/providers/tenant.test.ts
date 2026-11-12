import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import type { Transaction } from 'firebase-admin/firestore'
import { db } from '../shared'
import { seal, unseal } from '../fase6-api/security'
import { administrativeSecretBindings } from '../fase6-billing'
import { integrationStatus, mergeIntegrationCredentials, prepareIntegrationPatch, tenantProviderEnv } from './tenant'
import { handleStripe } from '../deposit/stripe'
import { ingestWebhook } from '../fase3-mobile/worker'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
describe('Integraciones opcionales y custodia por restaurante', () => {
  it('las cadenas vacías conservan claves; eliminar es explícito', () => {
    const before = { stripe:{ secretKey:'privada', webhookSecret:'firma' }, email:{ apiKey:'correo' } }
    expect(mergeIntegrationCredentials(before, { stripe:{secretKey:'   '} })).toEqual(before)
    expect(mergeIntegrationCredentials(before, {}, ['stripe'])).toEqual({email:{apiKey:'correo'}})
    expect(before.stripe.secretKey).toBe('privada')
  })
  it('la ausencia no bloquea el alta y tener una clave fiscal no anuncia un adaptador operativo', () => {
    expect(integrationStatus({}).stripe.status).toBe('not_configured')
    expect(integrationStatus({fiscal:{provider:'pendiente',apiKey:'clave'}}).fiscal.status).toBe('adapter_pending')
    expect(integrationStatus({email:{apiKey:'clave'}}).email.configured).toBe(false)
  })
  it('no exige un secreto de correo ficticio en el manifiesto de funciones', () => {
    expect(administrativeSecretBindings(false)).toEqual(['PLATFORM_API_MASTER_KEY'])
    expect(administrativeSecretBindings(true)).toContain('RESEND_API_KEY')
  })
  it('cifra claves con contexto y nunca las devuelve en el estado administrativo', async () => {
    vi.stubEnv('PLATFORM_API_MASTER_KEY','b'.repeat(64))
    const get = vi.fn().mockResolvedValue({exists:false}), set = vi.fn(), remove = vi.fn()
    const prepared = await prepareIntegrationPatch({get,set,delete:remove} as unknown as Transaction,'restaurante-a',{stripe:{secretKey:'no-visible',webhookSecret:'firma'}})
    prepared.commit()
    expect(JSON.stringify(prepared.status)).not.toContain('no-visible')
    const stored = set.mock.calls.find(([ref]) => String(ref.path).includes('/integrationSecrets/'))!
    expect(JSON.stringify(stored[1])).not.toContain('no-visible')
    expect(unseal(stored[1].ciphertext,'restaurants/restaurante-a/integrationSecrets/providers')).toEqual({stripe:{secretKey:'no-visible',webhookSecret:'firma'}})
    expect(() => unseal(stored[1].ciphertext,'restaurants/restaurante-b/integrationSecrets/providers')).toThrow()
  })
  it('producción sin configuración nunca hereda las claves globales de otro restaurante', async () => {
    vi.stubEnv('GCLOUD_PROJECT','llenamos-produccion'); vi.stubEnv('FIRESTORE_EMULATOR_HOST','')
    vi.stubEnv('RESEND_API_KEY','otra-cuenta'); vi.stubEnv('STRIPE_SECRET_KEY','otra-stripe'); vi.stubEnv('WHATSAPP_TOKEN','otro-whatsapp')
    vi.spyOn(db,'doc').mockReturnValue({get:async()=>({exists:false})} as unknown as ReturnType<typeof db.doc>)
    const env = await tenantProviderEnv('restaurante-vacio')
    expect(env.RESEND_API_KEY).toBeUndefined(); expect(env.STRIPE_SECRET_KEY).toBeUndefined(); expect(env.WHATSAPP_TOKEN).toBeUndefined()
  })
  it('el contexto de la clave también protege los archivos guardados', () => {
    vi.stubEnv('PLATFORM_API_MASTER_KEY','c'.repeat(64))
    const value=seal({email:{apiKey:'secreto'}},'restaurants/a/integrationSecrets/providers')
    expect(()=>unseal(value,'restaurants/b/integrationSecrets/providers')).toThrow()
  })
  it('una señal firmada no puede operar sobre la reserva de otro restaurante', async () => {
    await expect(handleStripe({ id:'evt_test',type:'checkout.session.completed',data:{object:{id:'cs_test',payment_status:'paid',metadata:{reservationPath:'restaurants/b/locations/l/reservations/r'}}} },'a')).rejects.toThrow('restaurante receptor')
  })
  it('un webhook de pago móvil con firma válida rechaza metadata de otro restaurante antes de leerlo', async () => {
    const now=Date.now(), time=Math.floor(now/1000)
    const raw=Buffer.from(JSON.stringify({id:'evt_test',type:'checkout.session.completed',created:time,data:{object:{id:'cs_test',status:'complete',payment_status:'paid',amount_total:100,currency:'eur',livemode:false,expires_at:time+1800,metadata:{restaurantId:'b',locationId:'l',checkoutId:'c'}}}}))
    const signature=`t=${time},v1=${createHmac('sha256','fixture').update(`${time}.${raw.toString()}`).digest('hex')}`
    expect(await ingestWebhook(raw,signature,{STRIPE_MOBILE_WEBHOOK_SECRET:'fixture'},now,'a')).toBe(400)
  })
})
