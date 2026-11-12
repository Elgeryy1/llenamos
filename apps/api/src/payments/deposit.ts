import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { ApiError } from '../errors.js'
import { recordCheckoutSession } from '../modules/reservas/deposit.js'
import { reservationLink } from '../modules/reservas/notices.js'
import { withPublicScope } from '../modules/reservas/scope.js'
import { openStripeCredentials } from './credentials.js'
import { checkoutUrl, isLiveKey, stripeCheckout } from './stripe.js'

const hash = (...parts: string[]) => createHash('sha256').update(parts.join('\u0000')).digest('hex')
/** Metadatos de la sesión; coinciden con `DEPOSIT_METADATA` del manejador `webhook.stripe` de reservas. */
const metadataOf = (rid: string, lid: string, reservationId: string) => ({ kind: 'reservation_deposit', restaurantId: rid, locationId: lid, reservationId })

export interface DepositCheckout { rid: string; locationId: string; reservationId: string; reference: string; slug: string; token: string; amountCents: number; checkoutSessionId: string | null; language?: string }

/**
 * Crea (o recupera) la sesión de Checkout de la señal con la Stripe del restaurante y la guarda en la reserva.
 * `null` si el restaurante no tiene Stripe configurado: nunca se usa otra clave. La clave de idempotencia depende de la
 * reserva, el importe y la sesión anterior, así que un reintento tras un corte devuelve la misma sesión y una sesión
 * caducada permite abrir otra. No se cobra aquí: el dinero lo confirma el webhook firmado del restaurante.
 */
export async function startDepositCheckout(pool: Pool, d: DepositCheckout): Promise<{ url: string } | null> {
  const credentials = await withPublicScope(pool, d.rid, client => openStripeCredentials(client, d.rid))
  if (!credentials) return null
  const stripe = stripeCheckout(credentials)
  // Una sesión anterior aún abierta se reutiliza: evita abrir varias a la vez para la misma señal.
  if (d.checkoutSessionId) {
    // Si no se puede consultar la sesión anterior no se abre otra: podría seguir abierta y pagarse en la pestaña vieja.
    const old = await stripe.retrieve(d.checkoutSessionId)
    if (old.status === 'open' && old.url && old.metadata.reservationId === d.reservationId && old.amount_total === d.amountCents) return { url: checkoutUrl(old.url) }
    if (old.status === 'complete' && old.payment_status === 'paid') throw new ApiError(412, 'failed-precondition', 'El pago de la señal ya se ha realizado y se está confirmando. Recarga la página en unos segundos.')
  }
  // Caducidad fija por tramo de 30 minutos: un reintento tras un corte repite exactamente la misma petición (misma clave
  // de idempotencia) y Stripe no la rechaza por parámetros distintos. La sesión dura entre 30 y 60 minutos.
  const slot = Math.floor(Date.now() / 1_800_000)
  const back = reservationLink(d.slug, d.reference, d.token)
  const session = await stripe.create({
    lines: [{ name: `Señal de reserva ${d.reference}`, amountCents: d.amountCents }], metadata: metadataOf(d.rid, d.locationId, d.reservationId),
    successUrl: back, cancelUrl: back, expiresAt: (slot + 2) * 1800, language: d.language ?? 'es',
    idempotencyKey: `deposit_${hash(d.rid, d.locationId, d.reservationId, String(d.amountCents), d.checkoutSessionId ?? '', String(slot))}`,
  })
  const meta = session.metadata
  if (meta.kind !== 'reservation_deposit' || meta.reservationId !== d.reservationId || meta.restaurantId !== d.rid || session.amount_total !== d.amountCents || session.currency !== 'eur' || session.livemode !== isLiveKey(credentials.secretKey) || !session.url)
    throw new ApiError(502, 'unavailable', 'La respuesta de Stripe no coincide con la señal. No se ha cobrado nada.')
  const url = checkoutUrl(session.url)
  await recordCheckoutSession(pool, d.rid, d.locationId, d.reservationId, session.id)
  return { url }
}
