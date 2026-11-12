/**
 * Privacidad de los fichajes (DECISIONES.md, 2026-11-12). El registro de jornada se conserva `FICHAJES_RETENCION_ANIOS`
 * años (art. 34.9 del Estatuto de los Trabajadores): no hay borrado a petición, solo exportación. Pasado el plazo se
 * anonimiza (la fecha y las horas quedan, la persona no). La base lo hace cumplir: ver `021_fichajes_retencion.sql`.
 */
import type { PoolClient } from 'pg'
import * as core from '@llenamos/core'
import { TABLES, audit, clock, flushEvents, listAll, fail, require, type Ctx, type Input, type Scoped } from '../fase4/contexto.js'
import { ANONYMIZE_EVERY_MS, JOB_ANONYMIZE_ENTRIES, scheduleLocalJob } from '../fase4/trabajos.js'
import type { WorkerHandler } from '../../worker/types.js'

export const ANONIMO = 'anonimizado'
const EXPORT_ENTRIES = 6_000
const EXPORT_EVENTS = 24_000
const BATCH = 1_000

/** Primer día que ya cumple el plazo, con un día de margen sobre el de la base (que usa `current_date`). */
export function fechaLimite(now: number): string {
  const d = new Date(now)
  d.setUTCFullYear(d.getUTCFullYear() - core.FICHAJES_RETENCION_ANIOS)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/** Registro de jornada de una persona en este local: el propio, o el de otra persona si lo pide un encargado. */
export async function exportarMisFichajes(c: Ctx, d: Input<'exportarMisFichajes'>) {
  const uid = d.uid ?? c.uid!
  require(c, uid === c.uid ? 'fichaje.registrar' : 'personal.gestionar')
  const entries = await listAll(c, TABLES.entries, core.TimeEntrySchema, 'uid=$3', [uid], 'entry_date,start_at,id', EXPORT_ENTRIES)
  // Los eventos se piden por fichaje (índice por entry_id), no recorriendo el libro entero del local.
  const events: Awaited<ReturnType<typeof listAll<core.TimeEntryEvent>>> = []
  for (let i = 0; i < entries.length; i += 500) {
    const ids = entries.slice(i, i + 500).map(e => e.id)
    events.push(...await listAll(c, TABLES.entryEvents, core.TimeEntryEventSchema, 'entry_id=ANY($3::text[])', [ids], 'id', EXPORT_EVENTS))
    if (events.length > EXPORT_EVENTS) break
  }
  if (events.length > EXPORT_EVENTS) fail(`Hay demasiados registros (más de ${EXPORT_EVENTS}) para exportar de una vez.`)
  if (uid !== c.uid) await audit(c, 'staff.export_entries', 'Exportación del registro de jornada de una persona.', { uid, entries: entries.length })
  return { uid, generatedAt: c.now, retentionYears: core.FICHAJES_RETENCION_ANIOS, entries, events }
}

/**
 * Contexto del sistema para este proceso. No comprueba módulos ni suscripción: la obligación de anonimizar sigue
 * aunque el restaurante se dé de baja o pierda el módulo de personal. Tampoco toma el cerrojo del restaurante, porque
 * solo toca fichajes cerrados hace más de 4 años y no compite con `fichar`.
 */
function systemCtx(client: PoolClient, scope: Scoped, now: number): Ctx {
  return { client, rid: scope.restaurantId, lid: scope.locationId, uid: null, actorName: null, role: null, now, tz: 'UTC', topics: new Set() }
}

/**
 * Quita la identidad de los fichajes, sus eventos, sus turnos y su actividad pasado el plazo. Idempotente y por
 * lotes: cada pase parte del índice de lo pendiente (nunca recorre lo ya anonimizado ni lo reciente), saca un lote de
 * fichajes y anonimiza a la vez sus eventos y ellos, también los que quedaron abiertos.
 */
export async function anonymizeOldEntries(client: PoolClient, scope: Scoped, now = clock.now()): Promise<{ entries: number; events: number; shifts: number; activity: number; remaining: number }> {
  const c = systemCtx(client, scope, now)
  const cutoff = fechaLimite(now)
  const key = [c.rid, c.lid, cutoff]
  let entries = 0, events = 0, shifts = 0, activity = 0
  for (;;) {
    const ids = (await client.query<{ id: string }>(
      `SELECT id FROM llenamos.staff_time_entries WHERE restaurant_id=$1 AND location_id=$2 AND entry_date<$3 AND (doc->>'uid')<>$4 ORDER BY entry_date LIMIT ${BATCH}`, [...key, ANONIMO])).rows.map(r => r.id)
    if (!ids.length) break
    // Primero los eventos: su comprobación mira que el fichaje ya haya cumplido el plazo, no que esté anonimizado.
    events += (await client.query(
      `UPDATE llenamos.staff_time_entry_events SET doc = doc || jsonb_build_object('uid',$4::text,'by',$4::text) || CASE WHEN doc->>'reason' IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('reason',$4::text) END
       WHERE restaurant_id=$1 AND location_id=$2 AND entry_id=ANY($3::text[]) AND (doc->>'uid'<>$4 OR doc->>'by'<>$4)`, [c.rid, c.lid, ids, ANONIMO])).rowCount ?? 0
    // También el turno al que apuntaba: con él la persona seguiría identificable.
    entries += (await client.query(
      `UPDATE llenamos.staff_time_entries SET doc = doc || jsonb_build_object('uid',$4::text,'note',NULL,'shiftId',NULL)
       WHERE restaurant_id=$1 AND location_id=$2 AND id=ANY($3::text[])`, [c.rid, c.lid, ids, ANONIMO])).rowCount ?? 0
    if (ids.length < BATCH) break
  }
  for (;;) {
    const r = await client.query(
      `UPDATE llenamos.staff_shifts SET doc = doc || jsonb_build_object('uid',$4::text,'note',NULL)
       WHERE restaurant_id=$1 AND location_id=$2 AND id IN (SELECT id FROM llenamos.staff_shifts WHERE restaurant_id=$1 AND location_id=$2 AND (doc->>'date')<$3 AND (doc->>'uid')<>$4 LIMIT ${BATCH})`, [...key, ANONIMO])
    shifts += r.rowCount ?? 0
    if ((r.rowCount ?? 0) < BATCH) break
  }
  for (;;) {
    const r = await client.query(
      `UPDATE llenamos.fase4_activity SET actor_uid=NULL, actor_name=NULL, summary='Registro anonimizado.', details='{}'
       WHERE id IN (SELECT id FROM llenamos.fase4_activity WHERE restaurant_id=$1 AND location_id=$2 AND action LIKE 'staff.%' AND created_at < ($3::date)::timestamptz AND summary<>'Registro anonimizado.' LIMIT ${BATCH})`, key)
    activity += r.rowCount ?? 0
    if ((r.rowCount ?? 0) < BATCH) break
  }
  if (entries + events + shifts + activity > 0) await audit(c, 'retention.entries_anonymized', `Fichajes anonimizados tras ${core.FICHAJES_RETENCION_ANIOS} años: ${entries}.`, { entries, events, shifts, activity, before: cutoff })
  // Las pantallas abiertas se enteran de que esos fichajes ya no llevan nombre.
  if (entries > 0) { c.topics.add('personal.fichaje'); await flushEvents(c) }
  const left = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM (SELECT 1 FROM llenamos.staff_time_entries WHERE restaurant_id=$1 AND location_id=$2 AND (doc->>'uid')<>$3 LIMIT 1) t", [c.rid, c.lid, ANONIMO])
  return { entries, events, shifts, activity, remaining: left.rows[0]!.n }
}

/** Manejador del worker: anonimiza el local y, mientras queden fichajes atribuidos, programa el siguiente pase diario. */
export const anonimizarFichajesHandler: WorkerHandler = async (context) => {
  const locationId = String(context.item.payload.locationId ?? '')
  if (!locationId) return
  const scope = { restaurantId: context.item.restaurantId, locationId }
  await context.tenant(async client => {
    const now = context.now().getTime()
    const { remaining } = await anonymizeOldEntries(client, scope, now)
    if (remaining > 0) await scheduleLocalJob(client, scope.restaurantId, locationId, JOB_ANONYMIZE_ENTRIES, ANONYMIZE_EVERY_MS, now)
  })
}
