import { ApiError } from '../errors.js'
import { PermanentFailure, type WorkerHandler } from '../worker/types.js'
import type { FileStore } from './storage.js'

/** `archivo.borrar`: retira los bytes y luego la fila marcada como borrada. Idempotente. */
export const deleteFileHandler = (store: FileStore): WorkerHandler => async ctx => {
  const fileId = ctx.item.payload.fileId
  if (typeof fileId !== 'string') throw new PermanentFailure('payload-invalido')
  // Solo se borran bytes de una fila ya marcada como borrada: un trabajo mal formado no puede retirar un archivo activo.
  const state = await ctx.tenant(async client => (await client.query<{ status: string }>('SELECT status FROM llenamos.files WHERE id=$1 AND restaurant_id=$2', [fileId, ctx.item.restaurantId])).rows[0]?.status)
  if (state === 'active') throw new PermanentFailure('archivo-activo')
  try { await store.remove(ctx.item.restaurantId, fileId) }
  catch (error) { if (error instanceof ApiError) throw new PermanentFailure('archivo-invalido'); throw error }
  await ctx.tenant(async client => {
    await client.query('UPDATE llenamos.privacy_requests SET artifact_file_id=NULL WHERE restaurant_id=$1 AND artifact_file_id=$2', [ctx.item.restaurantId, fileId])
    await client.query("DELETE FROM llenamos.files WHERE id=$1 AND restaurant_id=$2 AND status='deleted'", [fileId, ctx.item.restaurantId])
  })
}
