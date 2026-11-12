import type { Pool } from 'pg'
import type { QueueSource, WorkItem } from './types.js'

export const MAX_ATTEMPTS = 8
export const LEASE_SECONDS = 120

interface ClaimRow { id: string; restaurant_id: string; kind: string; payload: Record<string, unknown>; attempts: number; lease_id: string }
export interface Claimed { item: WorkItem; leaseId: string }

export async function claim(pool: Pool, source: QueueSource, limit: number, leaseSeconds = LEASE_SECONDS, maxAttempts = MAX_ATTEMPTS): Promise<Claimed[]> {
  const { rows } = await pool.query<ClaimRow>(`SELECT * FROM llenamos.worker_claim_${source}($1,$2,$3)`, [limit, leaseSeconds, maxAttempts])
  return rows.map(row => ({ leaseId: row.lease_id, item: { id: row.id, restaurantId: row.restaurant_id, kind: row.kind, payload: row.payload, attempts: row.attempts, source } }))
}

export type Outcome = 'done' | 'failed' | 'quarantined' | 'retry' | 'defer'
export async function extend(pool: Pool, source: QueueSource, id: string, leaseId: string, leaseSeconds = LEASE_SECONDS): Promise<boolean> {
  const { rows } = await pool.query<{ ok: boolean }>(`SELECT llenamos.worker_extend_${source}($1,$2,$3) AS ok`, [id, leaseId, leaseSeconds])
  return rows[0]?.ok === true
}

/** Falso si el lease ya no es nuestro (otro worker reclamó el elemento): el resultado se descarta. */
export async function finish(pool: Pool, source: QueueSource, id: string, leaseId: string, outcome: Outcome, error: string | null = null, delaySeconds = 0, maxAttempts = MAX_ATTEMPTS): Promise<boolean> {
  const { rows } = await pool.query<{ ok: boolean }>(`SELECT llenamos.worker_finish_${source}($1,$2,$3,$4,$5,$6) AS ok`, [id, leaseId, outcome, delaySeconds, error, maxAttempts])
  return rows[0]?.ok === true
}

/** Espera exponencial con tope de una hora y algo de dispersión para no sincronizar reintentos. */
export function backoffSeconds(attempt: number, random = Math.random): number {
  const base = Math.min(30 * 2 ** Math.max(0, attempt - 1), 3600)
  return Math.round(base * (0.75 + random() * 0.5))
}
