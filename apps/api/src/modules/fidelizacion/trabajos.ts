import type { PoolClient } from 'pg'
import { PermanentFailure, type WorkerHandler } from '../../worker/types.js'
import { RETRY_HOOK_JOB, onBillRefunded, onBillSettled, replayHook } from '../comun/ganchos.js'
import { recordReservationEvent } from '../analisis/procesos.js'
import { accruePoints, expirePoints, EXPIRE_JOB_KIND, reversePoints, stampBill, stampReservation } from './ganchos.js'
import { processRepite, REPITE_JOB_KIND } from './repite.js'

export const RESERVATION_CHANGED_JOB = 'clientes.reserva_cambiada'

/** Puntos y sello cuando caja liquida una cuenta, y corrección de puntos cuando devuelve un cobro. Cada uno con su propio SAVEPOINT. */
export function registerLoyaltyHooks() {
  onBillSettled({ name: 'fidelizacion.puntos', run: (client, e) => accruePoints(client, { restaurantId: e.restaurantId, locationId: e.locationId, billId: e.billId, customerId: e.customerId, totalCents: e.totalCents, settledAt: e.settledAt }) })
  onBillSettled({ name: 'fidelizacion.sello', run: async (client, e) => {
    // Una cuenta a 0 € (invitación total) no es una visita que premiar.
    if (e.totalCents <= 0) return
    // Con reserva manda la reserva (la misma clave de visita que el sello al sentarse): un sello por visita.
    const reservationId = e.targetKind === 'session'
      ? (await client.query<{ r: string | null }>("SELECT doc->>'reservationId' AS r FROM llenamos.sala_table_sessions WHERE restaurant_id=$1 AND location_id=$2 AND id=$3", [e.restaurantId, e.locationId, e.targetId])).rows[0]?.r ?? null
      : null
    await stampBill(client, { restaurantId: e.restaurantId, billId: e.billId, customerId: e.customerId, status: 'settled', sessionId: e.targetKind === 'session' ? e.targetId : null, reservationId, takeawayId: e.targetKind === 'takeaway' ? e.targetId : null, now: e.settledAt })
  } })
  onBillRefunded({ name: 'fidelizacion.puntos_devolucion', run: (client, e) => reversePoints(client, { restaurantId: e.restaurantId, locationId: e.locationId, billId: e.billId, paymentId: e.paymentId, customerId: e.customerId, originalPaidCents: e.originalPaidCents, refundedCents: e.refundedCents }) })
}

/** `ganchos.reintentar`: repite un gancho de caja que falló (puntos, sello…). Idempotente por los ids deterministas de cada gancho. */
export const retryHookHandler: WorkerHandler = async ctx => {
  const p = ctx.item.payload as { hook?: string; kind?: 'settled' | 'refunded'; event?: unknown }
  if (typeof p.hook !== 'string' || (p.kind !== 'settled' && p.kind !== 'refunded')) throw new PermanentFailure('payload-invalido')
  const ran = await ctx.tenant(client => replayHook(client, { hook: p.hook!, kind: p.kind!, event: p.event }))
  if (!ran) throw new PermanentFailure('gancho-desconocido')
}

/** `clientes.reserva_cambiada` (lo encola un disparador de reservas): sello de Repite al sentar y evento de no presentado o cancelada. */
export const reservationChangedHandler: WorkerHandler = async ctx => {
  const rid = ctx.item.restaurantId
  const { reservationId, locationId } = ctx.item.payload as { reservationId?: string; locationId?: string }
  if (typeof reservationId !== 'string' || typeof locationId !== 'string') throw new PermanentFailure('payload-invalido')
  await ctx.tenant(async (client: PoolClient) => {
    const { rows } = await client.query<{ customer_id: string; status: string; start_at: Date; data: { partySize?: number; deposit?: { amountCents?: number } } }>(
      'SELECT customer_id,status,start_at,data FROM llenamos.reservations WHERE restaurant_id=$1 AND location_id=$2 AND id=$3 AND NOT privacy_redacted', [rid, locationId, reservationId])
    const r = rows[0]
    if (!r) return
    // Una persona borrada no genera datos nuevos (ni sello ni eventos) aunque su reserva cambie de estado.
    const card = (await client.query<{ redacted: boolean }>('SELECT redacted FROM llenamos.customer_marketing WHERE restaurant_id=$1 AND customer_id=$2', [rid, r.customer_id])).rows[0]
    if (card?.redacted) return
    await stampReservation(client, { restaurantId: rid, reservationId, customerId: r.customer_id, status: r.status })
    const noShows = (await client.query<{ no_shows: number }>('SELECT no_shows FROM llenamos.customer_marketing WHERE restaurant_id=$1 AND customer_id=$2', [rid, r.customer_id])).rows[0]?.no_shows ?? 0
    await recordReservationEvent(client, rid, { locationId, reservationId, status: r.status, partySize: r.data.partySize ?? 1, customerId: r.customer_id, customerNoShows: noShows, hasDeposit: (r.data.deposit?.amountCents ?? 0) > 0, startAt: r.start_at.getTime() })
  })
}

/** `fidelizacion.procesar_repite`: llama a Repite fuera de la transacción (cada lectura y cada escritura en la suya). Sin adaptador, deja `not_configured`. */
export const repiteHandler: WorkerHandler = async ctx => {
  const rid = ctx.item.restaurantId
  // Cada pasada ve como mucho 20 operaciones: se repite mientras queden vencidas (cada una se procesa o se cierra, así que siempre avanza).
  for (let pass = 0; pass < 50 && !ctx.signal.aborted; pass++) {
    await processRepite(fn => ctx.tenant(fn), rid)
    const left = await ctx.tenant(async client => (await client.query(
      "SELECT 1 FROM llenamos.repite_queue WHERE restaurant_id=$1 AND status IN ('queued','leased') AND next_attempt_at_ms<=$2 AND (lease_until_ms IS NULL OR lease_until_ms<=$2) LIMIT 1", [rid, Date.now()])).rowCount)
    if (!left) return
  }
}

/** `fidelizacion.expirar_puntos`: una página de tandas por transacción hasta acabar. */
export const expirePointsHandler: WorkerHandler = async ctx => {
  let cursor: string | null = null
  for (let page = 0; page < 10_000 && !ctx.signal.aborted; page++) {
    const result: { nextCursor: string | null } = await ctx.tenant(client => expirePoints(client, ctx.item.restaurantId, { cursor }))
    if (!result.nextCursor) return
    cursor = result.nextCursor
  }
  throw new Error('caducidad-incompleta')
}

export const loyaltyWorkerHandlers: ReadonlyArray<readonly [string, WorkerHandler]> = [
  [REPITE_JOB_KIND, repiteHandler], [EXPIRE_JOB_KIND, expirePointsHandler], [RETRY_HOOK_JOB, retryHookHandler], [RESERVATION_CHANGED_JOB, reservationChangedHandler],
]
