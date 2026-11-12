/**
 * Libro de puntos en PostgreSQL. Saldo, tandas y libro se escriben en la misma transacción y con la fila de la
 * cuenta bloqueada (`SELECT … FOR UPDATE`), así dos canjes o dos acumulaciones del mismo cliente se serializan.
 * Las reglas son las de core (`@llenamos/core`): aquí solo se lee lo vivo (tandas con puntos) y se escribe.
 */
import type { PoolClient } from 'pg'
import * as core from '@llenamos/core'
import { failed } from './util.js'

/** Tope de tandas vivas por cliente que se cargan para operar (una por visita dentro de la vigencia). */
export const MAX_LIVE_LOTS = 500
export type Account = core.LoyaltyAccount & { lastMovementMs: number }

const accountOf = (r: any): Account => ({
  customerId: r.customer_id, status: r.status, balance: Number(r.balance), earned: Number(r.earned), redeemed: Number(r.redeemed), expired: Number(r.expired),
  termsVersion: r.terms_version, enrolledAt: Number(r.enrolled_at), enrolledBy: r.enrolled_by, revision: r.revision, lastMovementMs: Number(r.last_movement_ms),
})

export async function readAccount(client: PoolClient, rid: string, customerId: string, lock = false): Promise<Account | null> {
  const { rows } = await client.query(`SELECT * FROM llenamos.loyalty_accounts WHERE restaurant_id=$1 AND customer_id=$2${lock ? ' FOR UPDATE' : ''}`, [rid, customerId])
  return rows[0] ? accountOf(rows[0]) : null
}

const lotRows = (client: PoolClient, rid: string, customerId: string, limit: number) => client.query(
  'SELECT movement_id,at_ms,expires_at_ms,initial,remaining FROM llenamos.loyalty_lots WHERE restaurant_id=$1 AND customer_id=$2 AND remaining>0 ORDER BY at_ms,movement_id LIMIT $3',
  [rid, customerId, limit])

/** Ventanas de caducidad en las que se agrupan tandas al compactar: día, semana, mes. */
const COMPACT_BUCKETS_MS = [86_400_000, 7 * 86_400_000, 30 * 86_400_000]
const COMPACT_SCAN = 5000

/**
 * Junta las tandas vivas que caducan en la misma ventana (día, y si hace falta semana o mes) en la más antigua, que conserva
 * la caducidad MÁS TARDÍA del grupo: el cliente nunca pierde puntos antes de tiempo, a lo sumo los conserva más (hasta 1 día con ventana de día, 7 con la de semana y 30 con la de mes).
 * Las demás quedan a 0. El libro (`loyalty_movements`) no cambia; las tandas son una proyección. Las que no caducan se juntan todas.
 * Devuelve cuántas quedan vivas.
 */
export async function compactLots(client: PoolClient, rid: string, customerId: string): Promise<number> {
  const live = (await lotRows(client, rid, customerId, COMPACT_SCAN)).rows
  for (const size of COMPACT_BUCKETS_MS) {
    const alive = live.filter(l => l.remaining > 0)
    // Ventanas más gruesas solo si con las anteriores aún quedan demasiadas.
    if (alive.length <= MAX_LIVE_LOTS * 0.8 && size !== COMPACT_BUCKETS_MS[0]) break
    const groups = new Map<number, typeof live>()
    for (const r of alive) {
      const key = r.expires_at_ms === null ? -1 : Math.floor(Number(r.expires_at_ms) / size)
      groups.set(key, [...(groups.get(key) ?? []), r])
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue
      const [keep, ...rest] = group
      const expires = group.some(g => g.expires_at_ms === null) ? null : Math.max(...group.map(g => Number(g.expires_at_ms)))
      const total = group.reduce((sum, g) => sum + g.remaining, 0)
      await client.query('UPDATE llenamos.loyalty_lots SET remaining=$3,initial=greatest(initial,$3),expires_at_ms=$4 WHERE restaurant_id=$1 AND movement_id=$2', [rid, keep!.movement_id, total, expires])
      await client.query('UPDATE llenamos.loyalty_lots SET remaining=0 WHERE restaurant_id=$1 AND customer_id=$2 AND movement_id=ANY($3)', [rid, customerId, rest.map(g => g.movement_id)])
      keep!.remaining = total; keep!.expires_at_ms = expires
      for (const g of rest) g.remaining = 0
    }
    if (live.filter(l => l.remaining > 0).length <= MAX_LIVE_LOTS * 0.8) break
  }
  return live.filter(l => l.remaining > 0).length
}

/** Tandas con puntos (vivas o caducadas aún sin procesar). Nunca lee el libro. Con más de MAX_LIVE_LOTS se compactan en vez de fallar. */
export async function liveLots(client: PoolClient, rid: string, customerId: string): Promise<core.PointsLot[]> {
  let { rows } = await lotRows(client, rid, customerId, MAX_LIVE_LOTS + 1)
  if (rows.length > MAX_LIVE_LOTS) {
    await compactLots(client, rid, customerId)
    rows = (await lotRows(client, rid, customerId, MAX_LIVE_LOTS + 1)).rows
    if (rows.length > MAX_LIVE_LOTS) throw failed('Este cliente tiene demasiadas tandas de puntos vivas. Avisa a soporte.')
  }
  return rows.map(r => ({ movementId: r.movement_id, at: Number(r.at_ms), expiresAt: r.expires_at_ms === null ? null : Number(r.expires_at_ms), initial: r.initial, remaining: r.remaining }))
}

/** Cada tanda viva como un movimiento positivo: así se reutilizan `availablePoints`, `planExpirations`… de core. */
export const asMovements = (lots: readonly core.PointsLot[]): core.MovementWithId[] => lots.filter(l => l.remaining > 0).map(l => ({
  id: l.movementId, customerId: '', kind: 'earn' as const, points: l.remaining, balanceAfter: 0, at: l.at, expiresAt: l.expiresAt,
  locationId: null, billId: null, redemptionId: null, earnMovementId: null, reason: null, by: null,
}))
export const available = (lots: readonly core.PointsLot[], now: number) => core.availablePoints(asMovements(lots), now)

export interface MovementInput {
  id: string
  kind: core.LoyaltyMovementKind
  points: number
  at?: number
  expiresAt?: number | null
  locationId?: string | null
  billId?: string | null
  redemptionId?: string | null
  earnMovementId?: string | null
  reason?: string | null
  by?: string | null
}
export interface LedgerState { account: Account; lots: core.PointsLot[] }

/**
 * Escribe un movimiento: libro inmutable, tandas y contadores de la cuenta. Falla con 412 si dejara el saldo
 * en negativo. `state` se actualiza en memoria para encadenar varios movimientos en la misma transacción.
 */
export async function writeMovement(client: PoolClient, rid: string, state: LedgerState, m: MovementInput, now: number): Promise<void> {
  const at = Math.max(m.at ?? now, state.account.lastMovementMs + 1)
  let next: Account
  try { next = { ...core.applyLoyaltyMovement(state.account, m), lastMovementMs: at } } catch { throw failed('No hay puntos suficientes.') }
  let lots = state.lots
  if (m.points > 0) {
    const lot: core.PointsLot = { movementId: m.id, at, expiresAt: m.expiresAt ?? null, initial: m.points, remaining: m.points }
    await client.query('INSERT INTO llenamos.loyalty_lots(restaurant_id,movement_id,customer_id,at_ms,expires_at_ms,initial,remaining) VALUES($1,$2,$3,$4,$5,$6,$6)',
      [rid, lot.movementId, state.account.customerId, at, lot.expiresAt, lot.initial])
    lots = [...lots, lot]
  } else if (m.points < 0) {
    const replayed = (() => {
      try { return core.replayLots([...asMovements(lots), { id: m.id, customerId: '', kind: m.kind, points: m.points, balanceAfter: 0, at, expiresAt: null, locationId: null, billId: null, redemptionId: null, earnMovementId: m.earnMovementId ?? null, reason: null, by: null }]) }
      catch { throw failed('No hay puntos suficientes.') }
    })()
    const after = new Map(replayed.map(l => [l.movementId, l.remaining]))
    for (const lot of lots) {
      const remaining = after.get(lot.movementId) ?? 0
      if (remaining !== lot.remaining) await client.query('UPDATE llenamos.loyalty_lots SET remaining=$3 WHERE restaurant_id=$1 AND movement_id=$2', [rid, lot.movementId, remaining])
    }
    lots = lots.map(l => ({ ...l, remaining: after.get(l.movementId) ?? 0 })).filter(l => l.remaining > 0)
  }
  await client.query(`INSERT INTO llenamos.loyalty_movements(restaurant_id,id,customer_id,kind,points,balance_after,at_ms,expires_at_ms,location_id,bill_id,redemption_id,earn_movement_id,reason,by_uid)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
  [rid, m.id, state.account.customerId, m.kind, m.points, next.balance, at, m.expiresAt ?? null, m.locationId ?? null, m.billId ?? null, m.redemptionId ?? null, m.earnMovementId ?? null, m.reason ?? null, m.by ?? null])
  await client.query('UPDATE llenamos.loyalty_accounts SET balance=$3,earned=$4,redeemed=$5,expired=$6,last_movement_ms=$7,revision=$8 WHERE restaurant_id=$1 AND customer_id=$2',
    [rid, state.account.customerId, next.balance, next.earned, next.redeemed, next.expired, at, next.revision])
  state.account = next
  state.lots = lots
}

/** Pasa a `expire` las tandas caducadas con puntos. Devuelve cuántas. */
export async function expireLapsed(client: PoolClient, rid: string, state: LedgerState, now: number): Promise<number> {
  const planned = core.planExpirations(asMovements(state.lots), now)
  for (const e of planned) await writeMovement(client, rid, state, { id: e.id, kind: 'expire', points: e.points, earnMovementId: e.earnMovementId }, now)
  return planned.length
}

/** Cuenta activa bloqueada y sus tandas, lista para escribir. */
export async function openLedger(client: PoolClient, rid: string, customerId: string): Promise<LedgerState | null> {
  const account = await readAccount(client, rid, customerId, true)
  if (!account) return null
  return { account, lots: await liveLots(client, rid, customerId) }
}
