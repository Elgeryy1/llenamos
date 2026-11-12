import { z } from 'zod'

export const RESTAURANT_PROVIDERS = ['stripe', 'whatsapp', 'email', 'fiscal', 'repite'] as const
export const RestaurantProviderSchema = z.enum(RESTAURANT_PROVIDERS)
const Value = z.string().trim().max(4096).optional()
/** Escritura únicamente: una cadena vacía conserva el valor; eliminar exige removeIntegrations. */
export const RestaurantIntegrationsInputSchema = z.strictObject({
  stripe: z.strictObject({ secretKey: Value, webhookSecret: Value, mobileWebhookSecret: Value, accountId: Value }).optional(),
  whatsapp: z.strictObject({ token: Value, phoneNumberId: Value, appSecret: Value, verifyToken: Value, templateTakeawayAccepted: Value, templateTakeawayReady: Value }).optional(),
  email: z.strictObject({ apiKey: Value, from: Value }).optional(),
  fiscal: z.strictObject({ provider: Value, apiKey: Value }).optional(),
  repite: z.strictObject({ apiKey: Value, merchantId: Value }).optional(),
})
export type RestaurantIntegrationsInput = z.infer<typeof RestaurantIntegrationsInputSchema>
export const RestaurantIntegrationStatusSchema = z.record(RestaurantProviderSchema, z.object({
  configured: z.boolean(), status: z.enum(['not_configured', 'configured', 'adapter_pending']),
}))
export type RestaurantIntegrationStatus = z.infer<typeof RestaurantIntegrationStatusSchema>
export function emptyIntegrationStatus(): RestaurantIntegrationStatus {
  return Object.fromEntries(RESTAURANT_PROVIDERS.map(key => [key, { configured: false, status: 'not_configured' }])) as RestaurantIntegrationStatus
}
