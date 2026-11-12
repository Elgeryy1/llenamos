/** Cuadrante (fase 4): turnos, publicación y copia de semanas. */
import * as core from '@llenamos/core'
import { TABLES, audit, create, fail, list, listAll, loadStaffSettings, localMember, must, newId, remove, replace, requireRevision, type Ctx, type Input } from '../fase4/contexto.js'

const MINUTE = core.MINUTE_MS
const DAY = 24 * 60 * MINUTE
/** Tope de turnos de una semana: la misma cifra que el origen. */
const WEEK_LIMIT = 400

async function personShifts(c: Ctx, uid: string, from: number, to: number): Promise<core.StaffShiftWithId[]> {
  return listAll(c, TABLES.shifts, core.StaffShiftSchema, 'uid=$3 AND start_at>=$4 AND start_at<$5', [uid, Math.max(0, from), to], 'start_at', 200)
}
const week = (c: Ctx, weekStart: string) => list(c, TABLES.shifts, core.StaffShiftSchema, 'week_start=$3', [weekStart], 'start_at,id', WEEK_LIMIT + 1)

export async function guardarTurno(c: Ctx, d: Input<'guardarTurno'>) {
  const s = d.shift
  await localMember(c, s.uid)
  const place = core.shiftPlacement(s.startAt, c.tz)
  const id = d.shiftId ?? newId()
  let previous: core.StaffShift | null = null
  if (d.shiftId !== null) {
    previous = await must(c, TABLES.shifts, d.shiftId, core.StaffShiftSchema, 'el turno')
    if (d.expectedRevision === null) fail('Falta la revisión del turno.')
    requireRevision(previous.revision, d.expectedRevision, 'El turno')
  }
  // Se leen los turnos de esa persona de más de una semana alrededor: bastan para solapes, descansos y horas de su semana.
  const around = (await personShifts(c, s.uid, s.startAt - 8 * DAY, s.endAt + 8 * DAY)).filter(x => x.id !== id)
  if (core.findShiftConflicts(around, { uid: s.uid, startAt: s.startAt, endAt: s.endAt, id }).length) fail('Ese turno se pisa con otro de la misma persona.')
  const status = previous && previous.weekStart === place.weekStart ? previous.status : 'draft'
  const next = core.StaffShiftSchema.parse({
    uid: s.uid, startAt: s.startAt, endAt: s.endAt, position: s.position, note: s.note, date: place.date, weekStart: place.weekStart,
    status, publishedAt: status === 'published' ? previous?.publishedAt ?? c.now : null, revision: previous ? previous.revision + 1 : 1,
  })
  if (previous) await replace(c, TABLES.shifts, id, next); else await create(c, TABLES.shifts, id, next)
  const settings = await loadStaffSettings(c)
  const warnings = core.scheduleWarnings([...around, { ...next, id }], settings).filter(w => w.shiftIds.includes(id))
  await audit(c, 'staff.shift_saved', 'Turno del cuadrante guardado.', { shiftId: id, uid: s.uid, date: place.date })
  return { shiftId: id, revision: next.revision, warnings }
}

export async function borrarTurno(c: Ctx, d: Input<'borrarTurno'>) {
  const shift = await must(c, TABLES.shifts, d.shiftId, core.StaffShiftSchema, 'el turno')
  requireRevision(shift.revision, d.expectedRevision, 'El turno')
  await remove(c, TABLES.shifts, d.shiftId)
  await audit(c, 'staff.shift_deleted', 'Turno del cuadrante borrado.', { shiftId: d.shiftId, uid: shift.uid, date: shift.date })
  return { ok: true as const }
}

export async function publicarCuadrante(c: Ctx, d: Input<'publicarCuadrante'>) {
  core.weekDates(d.weekStart)
  const shifts = await week(c, d.weekStart)
  if (shifts.length > WEEK_LIMIT) fail('Hay demasiados turnos en esa semana.')
  const settings = await loadStaffSettings(c)
  const startMs = shifts.length ? Math.min(...shifts.map(w => w.startAt)) : 0
  const endMs = shifts.length ? Math.max(...shifts.map(w => w.endAt)) : 0
  // Los turnos de los días vecinos permiten avisar de descansos entre semanas.
  const neighbours = shifts.length ? await listAll(c, TABLES.shifts, core.StaffShiftSchema, 'start_at>=$3 AND start_at<$4', [Math.max(0, startMs - DAY), endMs + DAY], 'start_at,id', 1500) : []
  for (const shift of shifts) {
    const { id, ...doc } = shift
    await replace(c, TABLES.shifts, id, core.StaffShiftSchema.parse({ ...doc, status: d.publish ? 'published' : 'draft', publishedAt: d.publish ? c.now : null, revision: shift.revision + 1 }))
  }
  const ids = new Set(shifts.map(w => w.id))
  const warnings = core.scheduleWarnings(neighbours, settings).filter(w => w.shiftIds.some(id => ids.has(id)))
  await audit(c, 'staff.schedule_published', d.publish ? 'Cuadrante publicado.' : 'Cuadrante pasado a borrador.', { weekStart: d.weekStart, shifts: shifts.length })
  return { shifts: shifts.length, warnings }
}

export async function copiarSemanaCuadrante(c: Ctx, d: Input<'copiarSemanaCuadrante'>) {
  core.weekDates(d.fromWeekStart); core.weekDates(d.toWeekStart)
  const from = await week(c, d.fromWeekStart)
  if (from.length > WEEK_LIMIT) fail('Hay demasiados turnos en esa semana.')
  const existing = await week(c, d.toWeekStart)
  const { copied, skipped } = core.copyWeek(from, d.fromWeekStart, d.toWeekStart, c.tz)
  const placed: { id: string; uid: string; startAt: number; endAt: number }[] = existing
  // `copied` conserva el orden de los turnos de origen que no se han saltado.
  const skippedIds = new Set(skipped.map(x => x.shiftId))
  const kept = from.filter(f => !skippedIds.has(f.id))
  let created = 0
  for (const [i, s] of copied.entries()) {
    if (core.findShiftConflicts(placed, { uid: s.uid, startAt: s.startAt, endAt: s.endAt }).length) {
      skipped.push({ shiftId: kept[i]!.id, reason: 'Se pisa con otro turno de esa semana.' })
      continue
    }
    const id = newId()
    const place = core.shiftPlacement(s.startAt, c.tz)
    await create(c, TABLES.shifts, id, core.StaffShiftSchema.parse({ ...s, date: place.date, weekStart: place.weekStart, status: 'draft', publishedAt: null, revision: 1 }))
    placed.push({ id, uid: s.uid, startAt: s.startAt, endAt: s.endAt })
    created++
  }
  await audit(c, 'staff.schedule_copied', 'Semana del cuadrante copiada como borrador.', { from: d.fromWeekStart, to: d.toWeekStart, copied: created })
  return { copied: created, skipped }
}
