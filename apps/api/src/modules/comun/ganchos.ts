import type { PoolClient } from 'pg'
import { enqueueJob } from '../../jobs.js'
import { stableUuid } from '../../ids.js'

/**
 * Ganchos de caja: un cobro que liquida una cuenta y una devolución avisan a quien se haya registrado (fidelización: puntos y
 * sello; reservas: ventas por origen…). Caja solo llama a `emitBillSettled` / `emitBillRefunded` con los hechos ya leídos; no
 * sabe quién escucha. Un gancho que falla NUNCA aborta el cobro: corre dentro de un SAVEPOINT, se deshace solo su parte y
 * se deja un trabajo `ganchos.reintentar` (ID estable por gancho, cuenta y cobro) para repetirlo desde el worker.
 */
export interface BillSettledEvent {
  restaurantId: string
  locationId: string
  billId: string
  customerId: string | null
  /** Lo cobrado de la cuenta sin propina (la base de los puntos). */
  totalCents: number
  settledAt: number
  targetKind: 'session' | 'takeaway'
  targetId: string
}
export interface BillRefundedEvent {
  restaurantId: string
  locationId: string
  billId: string
  /** Id del cobro de devolución. */
  paymentId: string
  customerId: string | null
  originalPaidCents: number
  /** Suma de las devoluciones de la cuenta, incluida esta. */
  refundedCents: number
}
export interface BillHook<E> { name: string; run: (client: PoolClient, event: E) => Promise<unknown> }

export const RETRY_HOOK_JOB = 'ganchos.reintentar'
type Kind = 'settled' | 'refunded'
const settled: BillHook<BillSettledEvent>[] = []
const refunded: BillHook<BillRefundedEvent>[] = []

/** Registra (o sustituye por nombre) un gancho de cuenta liquidada. */
export function onBillSettled(hook: BillHook<BillSettledEvent>) { replace(settled, hook) }
export function onBillRefunded(hook: BillHook<BillRefundedEvent>) { replace(refunded, hook) }
function replace<E>(list: BillHook<E>[], hook: BillHook<E>) {
  const at = list.findIndex(h => h.name === hook.name)
  if (at >= 0) list[at] = hook; else list.push(hook)
}
/** Solo pruebas. */
export function clearBillHooks() { settled.length = 0; refunded.length = 0 }

async function safely<E extends { restaurantId: string; billId: string }>(client: PoolClient, kind: Kind, hook: BillHook<E>, event: E, key: string): Promise<boolean> {
  await client.query('SAVEPOINT gancho_caja')
  try {
    await hook.run(client, event)
    await client.query('RELEASE SAVEPOINT gancho_caja')
    return true
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT gancho_caja')
    await client.query('RELEASE SAVEPOINT gancho_caja')
    // Sin contenido: solo el gancho, el restaurante y el código del fallo.
    console.error(JSON.stringify({ level: 'error', event: 'gancho_fallido', hook: hook.name, kind, restaurantId: event.restaurantId, code: (error as { code?: string }).code ?? (error as Error).name }))
    try {
      await client.query('SAVEPOINT gancho_reintento')
      await enqueueJob(client, { id: stableUuid(RETRY_HOOK_JOB, event.restaurantId, hook.name, kind, key), restaurantId: event.restaurantId, kind: RETRY_HOOK_JOB,
        deduplicationKey: `${hook.name}:${kind}:${key}`.slice(0, 256), payload: { hook: hook.name, kind, event }, scheduledAt: new Date(Date.now() + 30_000) })
      await client.query('RELEASE SAVEPOINT gancho_reintento')
    } catch { await client.query('ROLLBACK TO SAVEPOINT gancho_reintento'); await client.query('RELEASE SAVEPOINT gancho_reintento') }
    return false
  }
}

export async function emitBillSettled(client: PoolClient, event: BillSettledEvent): Promise<void> {
  for (const hook of settled) await safely(client, 'settled', hook, event, event.billId)
}
export async function emitBillRefunded(client: PoolClient, event: BillRefundedEvent): Promise<void> {
  for (const hook of refunded) await safely(client, 'refunded', hook, event, `${event.billId}:${event.paymentId}`)
}

/** Repite un gancho que falló (lo llama el worker con el payload del trabajo). Devuelve false si el gancho ya no está registrado. */
export async function replayHook(client: PoolClient, payload: { hook: string; kind: Kind; event: unknown }): Promise<boolean> {
  const hook = (payload.kind === 'settled' ? settled : refunded).find(h => h.name === payload.hook) as BillHook<unknown> | undefined
  if (!hook) return false
  await hook.run(client, payload.event)
  return true
}
