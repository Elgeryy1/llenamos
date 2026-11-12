import type { PoolClient } from 'pg'

export interface JobRequest {
  /** ID estable (uuid) derivado de la clave de deduplicación. */
  id: string
  restaurantId: string
  /** Tipo de trabajo del worker, p. ej. `marketing.procesar_campana`. */
  kind: string
  deduplicationKey: string
  payload: Record<string, unknown>
  scheduledAt: Date
}

/** Programa un trabajo dentro de la transacción del hecho. Repetirlo con la misma clave no crea otro. */
export async function enqueueJob(client: PoolClient, job: JobRequest): Promise<void> {
  await client.query(
    'INSERT INTO llenamos.jobs(id,restaurant_id,kind,deduplication_key,payload,scheduled_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (restaurant_id,kind,deduplication_key) DO NOTHING',
    [job.id, job.restaurantId, job.kind, job.deduplicationKey, job.payload, job.scheduledAt])
}
