/**
 * Ganchos de acumulación y de sellos. Caja y reservas los llaman DENTRO de su transacción (el mismo `client`)
 * con los hechos ya leídos; aquí no se lee nada de cuentas ni reservas. Son idempotentes (ids deterministas).
 */
import type { PoolClient } from 'pg'
import * as core from '@llenamos/core'
import { available, expireLapsed, openLedger, writeMovement } from './puntos.js'
import { loyaltySettings, moduleActive, notify, repiteSettings, stableUuid } from './util.js'
import { now } from './ports.js'
import { queueStamp } from './repite.js'

export interface SettledBillFacts {
  restaurantId: string
  locationId: string
  billId: string
  /** Cliente de la cuenta; sin cliente no hay puntos ni sello. */
  customerId: string | null
  /** Lo cobrado de la cuenta, sin propina: la base con la que se ganan los puntos. */
  totalCents: number
  settledAt: number | null
  now?: number
}

/** Cuenta cobrada → puntos. Marca como `settled` los canjes aplicados de la cuenta. Devuelve si dio puntos. */
export async function accruePoints(client: PoolClient, f: SettledBillFacts): Promise<boolean> {
  const rid = f.restaurantId, t = f.now ?? now()
  if (!f.customerId || !(await moduleActive(client, rid, 'loyalty'))) return false
  await client.query("UPDATE llenamos.loyalty_redemptions SET status='settled' WHERE restaurant_id=$1 AND location_id=$2 AND bill_id=$3 AND status='applied'", [rid, f.locationId, f.billId])
  const settings = await loyaltySettings(client, rid)
  const state = await openLedger(client, rid, f.customerId)
  const at = f.settledAt ?? t
  if (!state || state.account.status !== 'active' || state.account.enrolledAt > at || !settings.enabled) return false
  const id = core.loyaltyMovementId.earn(f.billId)
  if ((await client.query('SELECT 1 FROM llenamos.loyalty_movements WHERE restaurant_id=$1 AND id=$2', [rid, id])).rowCount) return false
  const points = core.pointsForSpend(f.totalCents, settings)
  if (!points) return false
  await expireLapsed(client, rid, state, t)
  await writeMovement(client, rid, state, { id, kind: 'earn', points, billId: f.billId, locationId: f.locationId, at, expiresAt: core.lotExpiresAt(at, settings) }, t)
  await notify(client, rid, 'fidelizacion.cuenta', f.customerId)
  return true
}

export interface RefundFacts {
  restaurantId: string
  locationId: string
  billId: string
  /** Id del cobro de devolución: da el id del movimiento `earn_reversal.{paymentId}`. */
  paymentId: string
  customerId: string | null
  /** Lo cobrado al liquidar la cuenta, sin propina (la misma base de `accruePoints`). */
  originalPaidCents: number
  /** Suma de las devoluciones correctas de la cuenta, incluida esta. */
  refundedCents: number
  now?: number
}

/** Devolución → corrección de los puntos de esa cuenta, en proporción y sin saldo negativo. */
export async function reversePoints(client: PoolClient, f: RefundFacts): Promise<boolean> {
  const rid = f.restaurantId, t = f.now ?? now()
  if (!f.customerId || !(await moduleActive(client, rid, 'loyalty'))) return false
  const state = await openLedger(client, rid, f.customerId)
  if (!state || state.account.status !== 'active') return false
  const id = core.loyaltyMovementId.earnReversal(f.paymentId), earnId = core.loyaltyMovementId.earn(f.billId)
  if ((await client.query('SELECT 1 FROM llenamos.loyalty_movements WHERE restaurant_id=$1 AND id=$2', [rid, id])).rowCount) return false
  const earn = (await client.query("SELECT points,at_ms FROM llenamos.loyalty_movements WHERE restaurant_id=$1 AND id=$2 AND kind='earn'", [rid, earnId])).rows[0]
  if (!earn) return false
  const earlier = (await client.query("SELECT id,points,at_ms FROM llenamos.loyalty_movements WHERE restaurant_id=$1 AND earn_movement_id=$2 AND kind='earn_reversal' ORDER BY at_ms LIMIT 200", [rid, earnId])).rows
  const row = (r: { id: string; points: number; at_ms: string }, kind: core.LoyaltyMovementKind): core.MovementWithId => ({ id: r.id, customerId: f.customerId!, kind, points: r.points, balanceAfter: 0, at: Number(r.at_ms), expiresAt: null, locationId: null, billId: f.billId, redemptionId: null, earnMovementId: kind === 'earn_reversal' ? earnId : null, reason: null, by: null })
  const plan = core.planEarnReversal({
    movements: [row({ id: earnId, ...earn }, 'earn'), ...earlier.map(r => row(r, 'earn_reversal'))], billId: f.billId,
    originalPaidCents: f.originalPaidCents, paidAfterRefundsCents: Math.max(0, f.originalPaidCents - f.refundedCents), now: t, available: available(state.lots, t),
  })
  // Una devolución que no quita puntos no escribe un movimiento de 0.
  if (!plan.points) return false
  await expireLapsed(client, rid, state, t)
  await writeMovement(client, rid, state, { id, kind: 'earn_reversal', points: -plan.points, billId: f.billId, earnMovementId: earnId, reason: 'Devolución de cobro', locationId: f.locationId }, t)
  await notify(client, rid, 'fidelizacion.cuenta', f.customerId)
  return true
}

export interface ExpireOptions { now?: number; limit?: number; cursor?: string | null }
export interface ExpireResult { lots: number; customers: number; nextCursor: string | null }
/** Tipo de trabajo (`llenamos.jobs`) con el que el worker pide la caducidad diaria de un restaurante. */
export const EXPIRE_JOB_KIND = 'fidelizacion.expirar_puntos'

/** Deja el trabajo de caducidad del día de un restaurante (ID estable por restaurante y día). */
export async function enqueueExpirationJob(client: PoolClient, rid: string, day: string, at = now()): Promise<void> {
  await client.query(`INSERT INTO llenamos.jobs(id,restaurant_id,kind,deduplication_key,payload,scheduled_at) VALUES($1,$2,$3,$4,$5,to_timestamp($6::bigint/1000.0)) ON CONFLICT DO NOTHING`,
    [stableUuid(`${rid}:${EXPIRE_JOB_KIND}:${day}`), rid, EXPIRE_JOB_KIND, day, { restaurantId: rid, day }, at])
}

/**
 * Caduca una página de tandas vencidas (`limit`, 100 por defecto) ordenadas por (caducidad, id). Devuelve el cursor
 * de la página siguiente o null al acabar. El worker repite con el cursor hasta que sea null (cada página, en su
 * transacción). Las tandas ya caducadas salen solas del índice, así que reiniciar sin cursor también es seguro.
 */
export async function expirePoints(client: PoolClient, rid: string, o: ExpireOptions = {}): Promise<ExpireResult> {
  const t = o.now ?? now(), limit = Math.min(Math.max(o.limit ?? 100, 1), 500)
  if (!(await moduleActive(client, rid, 'loyalty'))) return { lots: 0, customers: 0, nextCursor: null }
  const [cursorMs, cursorId] = o.cursor ? [Number(o.cursor.split(':')[0]), o.cursor.slice(o.cursor.indexOf(':') + 1)] : [-1, '']
  const { rows } = await client.query(`SELECT movement_id,customer_id,expires_at_ms FROM llenamos.loyalty_lots
    WHERE restaurant_id=$1 AND remaining>0 AND expires_at_ms IS NOT NULL AND expires_at_ms<=$2 AND (expires_at_ms,movement_id)>($3,$4)
    ORDER BY expires_at_ms,movement_id LIMIT $5`, [rid, t, cursorMs, cursorId, limit])
  let lots = 0
  const customers = [...new Set(rows.map(r => r.customer_id as string))]
  for (const customerId of customers) {
    const state = await openLedger(client, rid, customerId)
    if (!state || state.account.status !== 'active') continue
    lots += await expireLapsed(client, rid, state, t)
    await notify(client, rid, 'fidelizacion.cuenta', customerId)
  }
  const last = rows.at(-1)
  return { lots, customers: customers.length, nextCursor: rows.length === limit && last ? `${last.expires_at_ms}:${last.movement_id}` : null }
}

/** Reserva sentada o terminada → sello (clave de visita de la reserva). */
export async function stampReservation(client: PoolClient, f: { restaurantId: string; reservationId: string; customerId: string | null; status: string; now?: number }): Promise<boolean> {
  const rid = f.restaurantId
  if (!f.customerId || !['seated', 'finished'].includes(f.status) || !(await moduleActive(client, rid, 'repite'))) return false
  if (!core.repiteStampApplies(await repiteSettings(client, rid), 'seated')) return false
  await queueStamp(client, rid, f.customerId, core.repiteVisitKey({ restaurantId: rid, reservationId: f.reservationId, sessionId: null }), 'seated', false, f.now)
  return true
}
/** Cuenta cobrada → sello. Con reserva manda la reserva; sin ella, la mesa; para llevar, el pedido. */
export async function stampBill(client: PoolClient, f: { restaurantId: string; billId: string; customerId: string | null; status: string; sessionId: string | null; reservationId: string | null; takeawayId: string | null; now?: number }): Promise<boolean> {
  const rid = f.restaurantId
  if (!f.customerId || f.status !== 'settled' || !(await moduleActive(client, rid, 'repite'))) return false
  if (!core.repiteStampApplies(await repiteSettings(client, rid), 'paid')) return false
  const key = core.repiteVisitKey({ restaurantId: rid, reservationId: f.reservationId, sessionId: f.sessionId, takeawayId: f.takeawayId })
  await queueStamp(client, rid, f.customerId, key, 'paid', false, f.now)
  return true
}
