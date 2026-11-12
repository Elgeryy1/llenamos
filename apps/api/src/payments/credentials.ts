import type { Pool, PoolClient } from 'pg'
import { ApiError } from '../errors.js'
import type { IntegrationVault } from '../platform/integrations.js'
import type { StripeCredentials } from './stripe.js'

let vault: IntegrationVault | null = null
/** La API la fija al arrancar con la bóveda de integraciones; sin ella no hay cobros con Stripe. */
export const configureStripeVault = (next: IntegrationVault | null) => { vault = next }

/**
 * Abre la clave de Stripe del restaurante cuyo ámbito público ya fijó la API (`app.public_restaurant`). La función SQL
 * solo entrega la credencial de ese restaurante; de ella se extrae únicamente Stripe y el resto no sale de esta función.
 * Devuelve null si el restaurante no ha configurado Stripe: nunca hay clave de reserva ni de otro negocio.
 */
export async function openStripeCredentials(client: Pick<Pool | PoolClient, 'query'>, restaurantId: string): Promise<StripeCredentials | null> {
  if (!vault) throw new ApiError(503, 'failed-precondition', 'Falta la custodia de proveedores para cobrar con Stripe.')
  const { rows } = await client.query<{ ciphertext: string | null }>('SELECT llenamos.payments_stripe_ciphertext($1) AS ciphertext', [restaurantId])
  return stripeFrom(vault.open(restaurantId, rows[0]?.ciphertext ?? null).stripe)
}
export function stripeFrom(raw: Record<string, string> | undefined): StripeCredentials | null {
  if (!raw?.secretKey || !raw.webhookSecret) return null
  return { secretKey: raw.secretKey, webhookSecret: raw.webhookSecret, ...(raw.mobileWebhookSecret ? { mobileWebhookSecret: raw.mobileWebhookSecret } : {}), ...(raw.accountId ? { accountId: raw.accountId } : {}) }
}
