/**
 * Procesos de personal (fase 4). Los lanza el worker (V2) por local con el trabajo periódico `personal.revisar_fichajes`
 * (cada 15 minutos mientras haya fichajes abiertos; lo siembra el primer fichaje de entrada), dentro de una
 * transacción del restaurante sin identidad de miembro: el acceso lo da `can_access_restaurant` al worker.
 */
import type { PoolClient } from 'pg'
import * as core from '@llenamos/core'
import { TABLES, audit, clock, listAll, loadStaffSettings, openSystemCtx, replace, flushEvents, type Scoped } from '../fase4/contexto.js'
import { JOB_REVIEW_ENTRIES, REVIEW_EVERY_MS, scheduleLocalJob } from '../fase4/trabajos.js'
import type { WorkerHandler } from '../../worker/types.js'

/**
 * Marca como olvidados los fichajes abiertos que pasan el límite de los ajustes y lo deja en la
 * actividad para el encargado. No cierra nada ni inventa horas: lo cierra un encargado.
 */
export async function reviewOpenEntries(client: PoolClient, scope: Scoped, now = clock.now()): Promise<{ marked: number; open: number }> {
  const c = await openSystemCtx(client, scope, 'staff', 'staff', now)
  if (!c) return { marked: 0, open: 0 }
  const open = await listAll(c, TABLES.entries, core.TimeEntrySchema, "status='open'", [], 'start_at,id', 500)
  if (!open.length) return { marked: 0, open: 0 }
  const settings = await loadStaffSettings(c)
  let marked = 0
  for (const id of core.findForgottenEntries(open, now, settings)) {
    const { id: _id, ...entry } = open.find(e => e.id === id)!
    await replace(c, TABLES.entries, id, core.TimeEntrySchema.parse({ ...entry, forgotten: true, revision: entry.revision + 1 }))
    const person = (await client.query<{ display_name: string }>('SELECT display_name FROM llenamos.fase4_local_members($1,$2) WHERE uid=$3', [c.rid, c.lid, entry.uid])).rows[0]
    await audit(c, 'staff.entry_forgotten', `Fichaje sin cerrar de ${person?.display_name ?? 'una persona'}.`, { entryId: id, uid: entry.uid, startAt: entry.startAt })
    marked++
  }
  await flushEvents(c)
  return { marked, open: open.length }
}

/** Manejador del worker: revisa el local del trabajo y, si quedan fichajes abiertos, programa el siguiente pase. */
export const revisarFichajesHandler: WorkerHandler = async (context) => {
  const locationId = String(context.item.payload.locationId ?? '')
  if (!locationId) return
  const scope = { restaurantId: context.item.restaurantId, locationId }
  await context.tenant(async client => {
    const now = context.now().getTime()
    const { open } = await reviewOpenEntries(client, scope, now)
    if (open > 0) await scheduleLocalJob(client, scope.restaurantId, locationId, JOB_REVIEW_ENTRIES, REVIEW_EVERY_MS, now)
  })
}
