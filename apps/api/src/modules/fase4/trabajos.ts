import type { PoolClient } from 'pg'
import { stableUuid } from '../../ids.js'
import { enqueueJob } from '../../jobs.js'

export const JOB_REVIEW_ENTRIES = 'personal.revisar_fichajes'
export const JOB_ANONYMIZE_ENTRIES = 'personal.anonimizar_fichajes'
export const JOB_RECONCILE = 'inventario.reconciliar'
export const REVIEW_EVERY_MS = 15 * 60_000
export const ANONYMIZE_EVERY_MS = 24 * 60 * 60_000
export const RECONCILE_EVERY_MS = 60 * 60_000

/**
 * Encola el siguiente pase de un proceso periódico de un local, dentro de la transacción que lo justifica. La clave
 * lleva la ranura de tiempo, así que pedirlo muchas veces en la misma ranura deja un solo trabajo. Cada pase se
 * reprograma solo mientras queda algo que vigilar, por eso nadie tiene que sembrar los trabajos a mano.
 */
export async function scheduleLocalJob(client: PoolClient, restaurantId: string, locationId: string, kind: string, everyMs: number, now: number): Promise<void> {
  const slot = Math.floor(now / everyMs) + 1
  const key = `${locationId}:${slot}`
  await enqueueJob(client, { id: stableUuid(kind, restaurantId, key), restaurantId, kind, deduplicationKey: key, payload: { locationId }, scheduledAt: new Date(slot * everyMs) })
}
