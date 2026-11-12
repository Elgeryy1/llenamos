import type { Pool } from 'pg'
import { ApiError } from '../../errors.js'
import { enqueueJob } from '../../jobs.js'
import { stableUuid } from '../../ids.js'
import type { MaintenanceTask } from '../../worker/maintenance.js'
import { forEachRestaurant } from '../../worker/tasks.js'
import { withTenant } from '../../worker/tenant.js'
import { MAX_ATTEMPTS } from '../../worker/queue.js'
import { PermanentFailure, Quarantine, RetryLater, type WorkerHandler } from '../../worker/types.js'
import { applyDepositPayment } from './deposit.js'
import { changeStatus, view } from './bookings.js'
import { loadContext } from './engine.js'
import { reservationContext } from './public.js'
import { resolveTenantById, withPublicScope } from './scope.js'
import { offerWaitlist, expireOffers } from './waitlist.js'

export const EXPIRE_OFFER_JOB = 'reservas.caducar_oferta'

/**
 * Trabajo `reservas.caducar_oferta` (uno por oferta, a la hora de caducidad): caduca las ofertas vencidas del local
 * y ofrece el hueco a la siguiente persona. Idempotente: repetirlo no encuentra nada vencido que caducar.
 */
export const expireOfferHandler: WorkerHandler = async ctx => {
  const locationId = ctx.item.payload.locationId
  if (typeof locationId !== 'string' || !locationId) throw new PermanentFailure('payload-invalido')
  try {
    await ctx.tenant(async client => {
      const tenant = await resolveTenantById(client, ctx.item.restaurantId, locationId)
      const now = ctx.now().getTime()
      await expireOffers(await loadContext(client, tenant, locationId, [now], { now, requireModule: false }))
    })
  } catch (error) {
    // Restaurante sin servicio: las ofertas vencidas se caducan sin ofrecer el hueco a nadie (no habría quien lo aceptara)
    // y así el barrido deja de encontrarlas. Un local borrado no se arregla reintentando.
    if (error instanceof ApiError && error.status === 412) {
      await ctx.tenant(client => client.query("UPDATE llenamos.waitlist SET status='expired',data=jsonb_set(data,'{status}','\"expired\"'),updated_at=now() WHERE restaurant_id=$1 AND location_id=$2 AND status='offered' AND offer_expires_at<=now()", [ctx.item.restaurantId, locationId]))
      return
    }
    if (error instanceof ApiError && error.status === 404) throw new PermanentFailure(error.code)
    throw error
  }
}

/**
 * Metadatos que lleva la sesión de Checkout de una señal de reserva (los pone quien la crea). El restaurante sale
 * del evento firmado con SU secreto, nunca de los metadatos: un evento de otro restaurante no toca esta reserva.
 */
export const DEPOSIT_METADATA = { kind: 'reservation_deposit', reservationId: 'reservationId', locationId: 'locationId' } as const

/**
 * `webhook.stripe`: un pago de señal completado confirma la reserva (idempotente por sesión). Los eventos que no
 * son de señal de reserva se ignoran aquí, porque otro módulo puede atenderlos. Un pago que no cuadra con la señal
 * (importe, moneda o sesión), sin reserva o local, o sobre una reserva ya cancelada va a cuarentena para revisarlo a mano:
 * es dinero cobrado sin reserva que lo respalde. Los metadatos antiguos de Firebase (`reservationPath`) se ignoran a propósito.
 */
export const stripeDepositHandler: WorkerHandler = async ctx => {
  const event = ctx.item.payload as { type?: string; object?: { id?: unknown; payment_status?: unknown; amount_total?: unknown; currency?: unknown; metadata?: Record<string, unknown> } }
  if (event.type !== 'checkout.session.completed' && event.type !== 'checkout.session.async_payment_succeeded') return
  const session = event.object, meta = session?.metadata
  if (meta?.kind !== DEPOSIT_METADATA.kind || session?.payment_status !== 'paid') return
  const { reservationId, locationId } = meta
  // Un pago de señal mal formado (sin reserva o sin local) es dinero cobrado: cuarentena, nunca un fallo que se purga.
  if (typeof session.id !== 'string' || typeof reservationId !== 'string' || !reservationId || typeof locationId !== 'string' || !locationId || typeof session.amount_total !== 'number' || typeof session.currency !== 'string')
    throw new Quarantine('senal-sin-reserva')
  let result
  try {
    result = await applyDepositPayment(ctx.pool, { restaurantId: ctx.item.restaurantId, locationId, reservationId, checkoutSessionId: session.id, amountCents: session.amount_total, currency: session.currency })
  } catch (error) {
    // Dinero cobrado sin reserva, sin local o sin servicio que lo respalde: nunca se pierde; queda en cuarentena a la vista.
    if (error instanceof ApiError && error.status === 404) throw new Quarantine('senal-sin-reserva')
    // Sin servicio ahora (suscripción vencida…) puede resolverse: se reintenta unas horas y, si sigue igual, cuarentena.
    if (error instanceof ApiError && error.status === 412) {
      if (ctx.item.attempts >= MAX_ATTEMPTS) throw new Quarantine('senal-sin-servicio')
      throw new RetryLater(3600, 'senal-sin-servicio')
    }
    if (error instanceof Error && error.message.includes('no corresponde')) throw new Quarantine('senal-no-corresponde')
    throw error
  }
  // Pagada pero la reserva ya estaba cancelada: se anota sin resucitarla y se alerta para devolver la señal a mano.
  if (result === 'paid_late') throw new Quarantine('senal-reserva-cancelada')
}

/**
 * `mensaje.respuesta`: confirmar o cancelar una reserva respondiendo al aviso por WhatsApp. Solo vale si responde
 * el mismo teléfono de la reserva y el aviso era de esa reserva; si la reserva ya no admite el cambio, no se hace
 * nada (el hecho no se pierde: queda como procesado, sin reintentos). La baja la atiende el worker común.
 */
export const reservationReplyHandler: WorkerHandler = async ctx => {
  const payload = ctx.item.payload as { action?: string; phone?: unknown; context?: { reservationId?: unknown } }
  if (payload.action !== 'confirmed' && payload.action !== 'cancelled') return
  const reservationId = payload.context?.reservationId
  if (typeof reservationId !== 'string' || typeof payload.phone !== 'string') return
  const rid = ctx.item.restaurantId
  try { await withPublicScope(ctx.pool, rid, async client => {
    const found = await client.query<{ location_id: string; phone: string | null }>("SELECT location_id,data->>'phone' AS phone FROM llenamos.reservations WHERE restaurant_id=$1 AND id=$2 AND NOT privacy_redacted", [rid, reservationId])
    const row = found.rows[0]
    if (!row || row.phone !== payload.phone) return
    const tenant = await resolveTenantById(client, rid, row.location_id)
    const { c, r } = await reservationContext(client, tenant, row.location_id, reservationId, { requireModule: false })
    const allowed = payload.action === 'confirmed' ? view(c, r).canConfirm : view(c, r).canCancel
    if (!allowed || (payload.action === 'confirmed' && r.status === 'confirmed')) return
    try {
      await changeStatus(c, r, payload.action === 'confirmed' ? 'confirmed' : 'cancelled', null, 'Respuesta por WhatsApp')
    } catch (error) {
      // Cambio imposible (reserva ya sentada, pasada…): se ignora, reintentarlo no lo arreglará.
      if (error instanceof ApiError && error.status === 412) return
      throw error
    }
    if (payload.action === 'cancelled') await offerWaitlist(c)
  }) } catch (error) {
    // Reserva, local o servicio que ya no existen: no hay nada que cambiar.
    if (error instanceof ApiError && [404, 412].includes(error.status)) return
    throw error
  }
}

/**
 * Red de seguridad de las ofertas: si el trabajo de una oferta se perdió, cada 5 minutos se encola uno por local con
 * ofertas vencidas (ID por local y tramo de 5 minutos, sin duplicados).
 */
export function reservasMaintenance(pool: Pool, now: () => number = Date.now): MaintenanceTask[] {
  return [{ name: 'reservas-ofertas', everyMs: 300_000, run: () => forEachRestaurant(pool, rid => withTenant(pool, rid, async client => {
    const bucket = Math.floor(now() / 300_000)
    const { rows } = await client.query<{ location_id: string }>("SELECT DISTINCT location_id FROM llenamos.waitlist WHERE restaurant_id=$1 AND status='offered' AND offer_expires_at<=now()", [rid])
    for (const { location_id } of rows)
      await enqueueJob(client, { id: stableUuid(EXPIRE_OFFER_JOB, 'sweep', rid, location_id, String(bucket)), restaurantId: rid, kind: EXPIRE_OFFER_JOB, deduplicationKey: `sweep:${location_id}:${bucket}`, payload: { locationId: location_id } })
    return rows.length
  })) }]
}
