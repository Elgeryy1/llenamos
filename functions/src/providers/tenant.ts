import { Timestamp, type Transaction } from 'firebase-admin/firestore'
import * as core from '@llenamos/core'
import { db } from '../shared'
import { seal, unseal } from '../fase6-api/security'

type Provider = (typeof core.RESTAURANT_PROVIDERS)[number]
export type TenantCredentials = Partial<Record<Provider, Record<string, string>>>
export function mergeIntegrationCredentials(previous: TenantCredentials, patch: core.RestaurantIntegrationsInput = {}, remove: Provider[] = []): TenantCredentials {
  const next = structuredClone(previous)
  for (const provider of core.RESTAURANT_PROVIDERS) {
    if (remove.includes(provider)) { delete next[provider]; continue }
    const fields = patch[provider]
    if (!fields) continue
    const values = Object.fromEntries(Object.entries(fields).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !!entry[1].trim()).map(([key,value]) => [key,value.trim()]))
    if (Object.keys(values).length) next[provider] = { ...next[provider], ...values }
  }
  return next
}
export function integrationStatus(credentials: TenantCredentials): core.RestaurantIntegrationStatus {
  const result = core.emptyIntegrationStatus()
  const required: Record<Provider,string[]> = { stripe:['secretKey','webhookSecret'], whatsapp:['token','phoneNumberId','appSecret','verifyToken'], email:['apiKey','from'], fiscal:['provider','apiKey'], repite:['apiKey','merchantId'] }
  for (const provider of core.RESTAURANT_PROVIDERS) {
    const configured = required[provider].every(field => !!credentials[provider]?.[field])
    result[provider] = { configured, status: configured ? ['fiscal','repite'].includes(provider) ? 'adapter_pending' : 'configured' : 'not_configured' }
  }
  return result
}
/** Lee antes de cualquier escritura de la transacción; nunca devuelve claves al operador. */
export async function prepareIntegrationPatch(tx: Transaction, rid: string, patch?: core.RestaurantIntegrationsInput, remove: Provider[] = []) {
  const ref = db.doc(`restaurants/${core.DocIdSchema.parse(rid)}/integrationSecrets/providers`)
  const old = await tx.get(ref)
  const previous: TenantCredentials = old.exists ? unseal(old.get('ciphertext'), ref.path) : {}
  const next = mergeIntegrationCredentials(previous, patch, remove), status = integrationStatus(next)
  return { status, commit: () => {
    if (!patch && !remove.length) return
    tx.set(db.doc(`restaurants/${rid}/providerStatus/current`), { ...status,
      whatsapp: { ...status.whatsapp, takeawayAccepted: !!next.whatsapp?.templateTakeawayAccepted, takeawayReady: !!next.whatsapp?.templateTakeawayReady }, updatedAt: Timestamp.now() })
    if (!Object.keys(next).length) { if (old.exists) tx.delete(ref); return }
    tx.set(ref, { ciphertext: seal(next, ref.path), updatedAt: Timestamp.now(), version: 1 })
  } }
}
export async function loadTenantCredentials(rid: string): Promise<TenantCredentials> {
  const ref = db.doc(`restaurants/${core.DocIdSchema.parse(rid)}/integrationSecrets/providers`), snapshot = await ref.get()
  return snapshot.exists ? unseal(snapshot.get('ciphertext'), ref.path) : {}
}
export async function providerAvailability(tx: Transaction, rid: string) {
  const status = await tx.get(db.doc(`restaurants/${core.DocIdSchema.parse(rid)}/providerStatus/current`))
  const demo = process.env.GCLOUD_PROJECT === 'demo-llenamos' && !!process.env.FIRESTORE_EMULATOR_HOST
  return { stripe: status.get('stripe.configured') === true || (demo && !!process.env.STRIPE_SECRET_KEY),
    whatsapp: status.get('whatsapp.configured') === true || (demo && !!process.env.WHATSAPP_TOKEN && !!process.env.WHATSAPP_PHONE_NUMBER_ID),
    whatsappAccepted: status.get('whatsapp.takeawayAccepted') === true || (demo && !!process.env.WHATSAPP_TEMPLATE_TAKEAWAY_ACCEPTED),
    whatsappReady: status.get('whatsapp.takeawayReady') === true || (demo && !!process.env.WHATSAPP_TEMPLATE_TAKEAWAY_READY) }
}
/** No hay fallback a credenciales de otra cuenta o restaurante en producción. */
export async function tenantProviderEnv(rid: string): Promise<NodeJS.ProcessEnv> {
  if (process.env.GCLOUD_PROJECT === 'demo-llenamos' && process.env.FIRESTORE_EMULATOR_HOST) return { ...process.env }
  const c = await loadTenantCredentials(rid)
  return { GCLOUD_PROJECT:process.env.GCLOUD_PROJECT, PUBLIC_APP_URL:process.env.PUBLIC_APP_URL,
    RESEND_API_KEY:c.email?.apiKey, EMAIL_FROM:c.email?.from,
    WHATSAPP_TOKEN:c.whatsapp?.token, WHATSAPP_PHONE_NUMBER_ID:c.whatsapp?.phoneNumberId,
    WHATSAPP_APP_SECRET:c.whatsapp?.appSecret, WHATSAPP_VERIFY_TOKEN:c.whatsapp?.verifyToken,
    WHATSAPP_TEMPLATE_TAKEAWAY_ACCEPTED:c.whatsapp?.templateTakeawayAccepted, WHATSAPP_TEMPLATE_TAKEAWAY_READY:c.whatsapp?.templateTakeawayReady,
    STRIPE_SECRET_KEY:c.stripe?.secretKey, STRIPE_WEBHOOK_SECRET:c.stripe?.webhookSecret,
    STRIPE_MOBILE_WEBHOOK_SECRET:c.stripe?.mobileWebhookSecret, STRIPE_ACCOUNT_ID:c.stripe?.accountId, STRIPE_MOBILE_MODE:'single',
  }
}
