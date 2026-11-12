import type { PoolClient } from 'pg'

export interface JobRequest {
  /** ID estable (uuid). */
  id: string
  restaurantId: string
  /** Tipo de trabajo del worker, p. ej. `privacidad.procesar`. */
  kind: string
  /** Un trabajo con la misma clave y tipo en el restaurante no se duplica. */
  deduplicationKey: string
  payload: Record<string, unknown>
  scheduledAt?: Date
}

/** Encola un trabajo diferido dentro de la transacción del hecho; repetirlo con la misma clave no duplica. */
export async function enqueueJob(client: PoolClient, job: JobRequest): Promise<void> {
  await client.query(
    'INSERT INTO llenamos.jobs(id,restaurant_id,kind,deduplication_key,payload,scheduled_at) VALUES($1,$2,$3,$4,$5,coalesce($6,now())) ON CONFLICT DO NOTHING',
    [job.id, job.restaurantId, job.kind, job.deduplicationKey, job.payload, job.scheduledAt ?? null])
}
