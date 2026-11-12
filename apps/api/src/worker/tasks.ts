import type { Pool } from 'pg'
import type { FileStore } from '../files/storage.js'
import { enqueueJob } from '../jobs.js'
import { stableUuid } from '../ids.js'
import { withTenant } from './tenant.js'
import type { MaintenanceTask } from './maintenance.js'

export async function forEachRestaurant(pool: Pool, fn: (rid: string) => Promise<number>): Promise<number> {
  let after = '', changed = 0
  for (;;) {
    const { rows } = await pool.query<{ id: string }>('SELECT * FROM llenamos.worker_restaurants($1,200) AS id', [after])
    for (const row of rows) changed += await fn(row.id)
    if (rows.length < 200) return changed
    after = rows.at(-1)!.id
  }
}

export function workerMaintenance(pool: Pool, store: FileStore): MaintenanceTask[] {
  return [
    { name: 'temporales', everyMs: 600_000, run: () => store.sweepTemp() },
    // Exportaciones de privacidad caducadas: la fila pasa a borrada y el trabajo retira los bytes.
    { name: 'exportaciones', everyMs: 900_000, run: () => forEachRestaurant(pool, rid => withTenant(pool, rid, async client => {
      const { rows } = await client.query<{ id: string; artifact_file_id: string }>("SELECT id,artifact_file_id FROM llenamos.privacy_requests WHERE restaurant_id=$1 AND artifact_file_id IS NOT NULL AND expires_at<now() LIMIT 100", [rid])
      for (const row of rows) {
        await client.query("UPDATE llenamos.files SET status='deleted',deleted_at=now() WHERE id=$1 AND status='active'", [row.artifact_file_id])
        await enqueueJob(client, { id: stableUuid('archivo.borrar', row.artifact_file_id), restaurantId: rid, kind: 'archivo.borrar', deduplicationKey: row.artifact_file_id, payload: { fileId: row.artifact_file_id } })
      }
      return rows.length
    })) },
    // Bytes sin fila (caída entre el rename y el COMMIT): se borran pasada una hora.
    { name: 'huerfanos', everyMs: 86_400_000, run: () => forEachRestaurant(pool, async rid => {
      const known = await withTenant(pool, rid, async client => new Set((await client.query<{ id: string }>('SELECT id FROM llenamos.files WHERE restaurant_id=$1', [rid])).rows.map(row => row.id)))
      let removed = 0
      for await (const file of store.listRestaurant(rid)) if (!known.has(file.id) && Date.now() - file.mtimeMs > 3_600_000) { await store.remove(rid, file.id); removed++ }
      return removed
    }) },
  ]
}
