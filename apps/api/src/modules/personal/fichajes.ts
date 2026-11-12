/** Fichaje, correcciones y horas (fase 4). Misma lógica que `functions/src/fase4/personal.ts`, sobre SQL. */
import * as core from '@llenamos/core'
import { ApiError } from '../../errors.js'
import {
  TABLES, audit, create, fail, get, list, listAll, loadStaffSettings, localMember, missing, must, newId, remove, replace, require, requireRevision, saveSettings,
  type Ctx, type Input,
} from '../fase4/contexto.js'
import { ANONYMIZE_EVERY_MS, JOB_ANONYMIZE_ENTRIES, JOB_REVIEW_ENTRIES, REVIEW_EVERY_MS, scheduleLocalJob } from '../fase4/trabajos.js'
import { cashWindowSource } from '../fase4/puertos.js'
import { PinDocSchema, checkPinDoc, newPinDoc } from './pin.js'

const MINUTE = core.MINUTE_MS
/** Un fichaje o un turno cerrado dura como mucho 16 horas: margen para buscar los que se solapan. */
const LOOKBACK = 17 * 60 * MINUTE
/** Tope de filas y de días de un informe: nada de leer el histórico entero. */
const REPORT_ROWS = 20_000
const REPORT_DAYS = 366
type Times = core.EntryTimes
const trunc = core.truncateToMinute

async function readEntry(c: Ctx, id: string) {
  const entry = await must(c, TABLES.entries, id, core.TimeEntrySchema, 'el fichaje')
  return entry
}

async function auditEvent(c: Ctx, p: { entryId: string; uid: string; kind: core.TimeEventKind; source: core.ClockSource; by: string; reason: string | null; before: Times | null; after: Times | null }) {
  const event = core.TimeEntryEventSchema.parse({
    entryId: p.entryId, uid: p.uid, kind: p.kind, at: c.now, by: p.by, source: p.source, reason: p.reason,
    before: p.before ? core.snapshotOf(p.before) : null, after: p.after ? core.snapshotOf(p.after) : null,
  })
  await create(c, TABLES.entryEvents, newId(), event)
}

/** Los demás fichajes de la persona que podrían solaparse con unos instantes (este local y su fichaje abierto, esté donde esté). */
async function otherEntries(c: Ctx, uid: string, start: number, end: number | null, exceptId: string | null) {
  const upper = (end ?? c.now) + 1
  const found = new Map((await listAll(c, TABLES.entries, core.TimeEntrySchema, 'uid=$3 AND start_at>=$4 AND start_at<$5', [uid, Math.max(0, start - LOOKBACK), upper], 'start_at', 200))
    .filter(e => e.id !== exceptId).map(e => [e.id, e]))
  const lock = (await c.client.query<{ location_id: string; entry_id: string }>('SELECT location_id,entry_id FROM llenamos.staff_clock_locks WHERE restaurant_id=$1 AND uid=$2', [c.rid, uid])).rows[0]
  if (lock && lock.entry_id !== exceptId && !found.has(lock.entry_id)) {
    const open = await get(c, TABLES.entries, lock.entry_id, core.TimeEntrySchema, lock.location_id)
    if (open) found.set(lock.entry_id, { ...open, id: lock.entry_id })
  }
  return [...found.values()].map(e => ({ startAt: e.startAt, endAt: e.endAt, status: e.status }))
}

function managerTimes(d: { startAt: number; endAt: number; breaks: readonly { startAt: number; endAt: number }[] }): Times {
  const times = { startAt: trunc(d.startAt), endAt: trunc(d.endAt), breaks: d.breaks.map(b => ({ startAt: trunc(b.startAt), endAt: trunc(b.endAt) })) }
  if (times.endAt <= times.startAt) fail('La salida tiene que ser posterior a la entrada.')
  return times
}
async function checkManagerTimes(c: Ctx, uid: string, times: Times, exceptId: string | null) {
  const issues = core.validateEntryTimes(times, { now: c.now, others: await otherEntries(c, uid, times.startAt, times.endAt, exceptId) })
  if (issues.length) fail(issues[0]!.message)
}
const setLock = (c: Ctx, uid: string, entryId: string) => c.client.query(
  `INSERT INTO llenamos.staff_clock_locks(restaurant_id,uid,location_id,entry_id) VALUES($1,$2,$3,$4)
   ON CONFLICT(restaurant_id,uid) DO UPDATE SET location_id=EXCLUDED.location_id,entry_id=EXCLUDED.entry_id`, [c.rid, uid, c.lid, entryId])
/** Libera el bloqueo de fichaje abierto, solo si apunta a este fichaje. */
const releaseLock = (c: Ctx, uid: string, entryId: string) => c.client.query('DELETE FROM llenamos.staff_clock_locks WHERE restaurant_id=$1 AND uid=$2 AND entry_id=$3', [c.rid, uid, entryId])

/* Fichar ------------------------------------------------------------------------------------ */

async function clockAction(c: Ctx, p: { uid: string; action: core.ClockAction; note: string | null; source: 'self' | 'kiosk'; by: string }): Promise<core.CallableOutput<'fichar'>> {
  const settings = await loadStaffSettings(c)
  const lock = (await c.client.query<{ location_id: string; entry_id: string }>('SELECT location_id,entry_id FROM llenamos.staff_clock_locks WHERE restaurant_id=$1 AND uid=$2', [c.rid, p.uid])).rows[0]
  let current: { id: string; lid: string; entry: core.TimeEntry } | null = null
  if (lock) {
    const entry = await get(c, TABLES.entries, lock.entry_id, core.TimeEntrySchema, lock.location_id)
    // Un bloqueo que apunta a un fichaje ya cerrado o anulado está caducado: se ignora y se sustituye.
    if (entry && entry.status === 'open' && entry.uid === p.uid) current = { id: lock.entry_id, lid: lock.location_id, entry }
  }
  if (current && current.lid !== c.lid) fail('Tienes un fichaje abierto en otro local. Ciérralo allí antes de fichar aquí.')
  const overdue = current !== null && c.now - current.entry.startAt >= settings.forgottenAfterMinutes * MINUTE
  const result = core.applyClockAction(current ? { startAt: current.entry.startAt, endAt: null, breaks: current.entry.breaks, forgotten: current.entry.forgotten || overdue } : null, p.action, c.now)
  if (!result.ok) fail(result.message)
  const before = current ? { startAt: current.entry.startAt, endAt: current.entry.endAt, breaks: current.entry.breaks } : null

  if (p.action === 'in') {
    const id = newId()
    const entry = core.TimeEntrySchema.parse({
      uid: p.uid, date: core.horaLocal(result.at, c.tz).fecha, startAt: result.times.startAt, endAt: null, breaks: [], status: 'open',
      startSource: p.source, endSource: null, shiftId: null, forgotten: false, needsReview: false, workedMinutes: null, breakMinutes: 0, note: p.note, revision: 1,
    })
    await create(c, TABLES.entries, id, entry)
    await setLock(c, p.uid, id)
    await scheduleLocalJob(c.client, c.rid, c.lid, JOB_REVIEW_ENTRIES, REVIEW_EVERY_MS, c.now)
    await scheduleLocalJob(c.client, c.rid, c.lid, JOB_ANONYMIZE_ENTRIES, ANONYMIZE_EVERY_MS, c.now)
    await auditEvent(c, { entryId: id, uid: p.uid, kind: result.event, source: p.source, by: p.by, reason: null, before: null, after: result.times })
    return { entryId: id, state: result.state, at: result.at, workedMinutes: null }
  }

  const { id, entry } = current!
  const closing = p.action === 'out'
  const minutes = closing ? core.entryMinutes(result.times, settings) : null
  const next = core.TimeEntrySchema.parse({
    ...entry, endAt: result.times.endAt, breaks: result.times.breaks,
    status: closing ? 'closed' : 'open', endSource: closing ? p.source : null,
    workedMinutes: minutes ? minutes.roundedMinutes : null, breakMinutes: minutes ? minutes.breakMinutes : 0,
    note: p.note ?? entry.note, revision: entry.revision + 1,
  })
  await replace(c, TABLES.entries, id, next)
  if (closing) await releaseLock(c, p.uid, id)
  await auditEvent(c, { entryId: id, uid: p.uid, kind: result.event, source: p.source, by: p.by, reason: null, before, after: result.times })
  return { entryId: id, state: result.state, at: result.at, workedMinutes: next.workedMinutes }
}

export async function fichar(c: Ctx, d: Input<'fichar'>) {
  return clockAction(c, { uid: c.uid!, action: d.action, note: d.note, source: 'self', by: c.uid! })
}

/**
 * Fichar a otra persona desde el puesto con su PIN. Los intentos fallidos se guardan aunque la
 * operación falle; como el servidor deshace la transacción si el handler lanza, el fallo se entrega
 * con `afterCommit` y la respuesta provisional (válida para el contrato) nunca llega al cliente.
 */
export async function ficharEnPuesto(c: Ctx, d: Input<'ficharEnPuesto'>, afterCommit: (task: (output: unknown) => Promise<unknown>) => void) {
  const settings = await loadStaffSettings(c)
  if (!settings.kioskEnabled) fail('El puesto de fichaje no está activado en este local.')
  await localMember(c, d.uid)
  const stored = await get(c, TABLES.pins, d.uid, PinDocSchema)
  if (!stored) fail('Esta persona no tiene PIN de fichaje. Pide a un encargado que lo cree.')
  const check = await checkPinDoc(stored, d.pin, d.uid, c.now)
  if (!check.ok) {
    if (check.record !== stored) await replace(c, TABLES.pins, d.uid, check.record)
    const message = check.reason === 'locked' ? 'Demasiados intentos. Espera unos minutos y vuelve a probar.' : `PIN incorrecto. Te quedan ${check.attemptsLeft} intentos.`
    afterCommit(async () => { throw new ApiError(403, 'permission-denied', message) })
    return { entryId: 'denegado', state: 'out' as const, at: c.now, workedMinutes: null }
  }
  await replace(c, TABLES.pins, d.uid, check.record)
  return clockAction(c, { uid: d.uid, action: d.action, note: null, source: 'kiosk', by: c.uid! })
}

export async function guardarPinFichaje(c: Ctx, d: Input<'guardarPinFichaje'>) {
  await localMember(c, d.uid)
  const old = await get(c, TABLES.pins, d.uid, PinDocSchema)
  if (d.pin === null) {
    if (old) await remove(c, TABLES.pins, d.uid)
  } else {
    const record = await newPinDoc(d.pin, d.uid)
    if (old) await replace(c, TABLES.pins, d.uid, record); else await create(c, TABLES.pins, d.uid, record)
  }
  await audit(c, 'staff.pin_saved', d.pin === null ? 'PIN de fichaje quitado.' : 'PIN de fichaje guardado.', { uid: d.uid })
  return { ok: true as const }
}

export async function guardarConfiguracionPersonal(c: Ctx, d: Input<'guardarConfiguracionPersonal'>) {
  await saveSettings(c, 'staff', d.settings)
  await audit(c, 'staff.settings_saved', 'Ajustes de personal guardados.')
  return { ok: true as const }
}

/* Correcciones de un encargado ------------------------------------------------------------- */

export async function crearFichajeManual(c: Ctx, d: Input<'crearFichajeManual'>) {
  await localMember(c, d.uid)
  const settings = await loadStaffSettings(c)
  const times = managerTimes(d)
  await checkManagerTimes(c, d.uid, times, null)
  const minutes = core.entryMinutes(times, settings)
  const id = newId()
  const entry = core.TimeEntrySchema.parse({
    uid: d.uid, date: core.horaLocal(times.startAt, c.tz).fecha, startAt: times.startAt, endAt: times.endAt, breaks: times.breaks, status: 'closed',
    startSource: 'manager', endSource: 'manager', shiftId: null, forgotten: false, needsReview: true,
    workedMinutes: minutes.roundedMinutes, breakMinutes: minutes.breakMinutes, note: null, revision: 1,
  })
  await create(c, TABLES.entries, id, entry)
  await scheduleLocalJob(c.client, c.rid, c.lid, JOB_ANONYMIZE_ENTRIES, ANONYMIZE_EVERY_MS, c.now)
  await auditEvent(c, { entryId: id, uid: d.uid, kind: 'manual_create', source: 'manager', by: c.uid!, reason: d.reason, before: null, after: times })
  await audit(c, 'staff.entry_created', 'Fichaje creado a mano por un encargado.', { entryId: id, uid: d.uid, reason: d.reason })
  return { entryId: id, workedMinutes: minutes.roundedMinutes }
}

export async function corregirFichaje(c: Ctx, d: Input<'corregirFichaje'>) {
  const entry = await readEntry(c, d.entryId)
  requireRevision(entry.revision, d.expectedRevision, 'El fichaje')
  if (entry.status === 'voided') fail('Ese fichaje está anulado.')
  if (entry.status === 'open') fail('Ese fichaje sigue abierto. Si se quedó sin cerrar, ciérralo como fichaje olvidado.')
  const settings = await loadStaffSettings(c)
  const times = managerTimes(d)
  await checkManagerTimes(c, entry.uid, times, d.entryId)
  const minutes = core.entryMinutes(times, settings)
  const next = core.TimeEntrySchema.parse({
    ...entry, date: core.horaLocal(times.startAt, c.tz).fecha, startAt: times.startAt, endAt: times.endAt, breaks: times.breaks,
    workedMinutes: minutes.roundedMinutes, breakMinutes: minutes.breakMinutes, needsReview: true, forgotten: false, revision: entry.revision + 1,
  })
  await replace(c, TABLES.entries, d.entryId, next)
  await auditEvent(c, { entryId: d.entryId, uid: entry.uid, kind: 'correction', source: 'manager', by: c.uid!, reason: d.reason, before: entry, after: times })
  await audit(c, 'staff.entry_corrected', 'Fichaje corregido por un encargado.', { entryId: d.entryId, uid: entry.uid, reason: d.reason })
  return { revision: next.revision, workedMinutes: minutes.roundedMinutes }
}

export async function cerrarFichajeOlvidado(c: Ctx, d: Input<'cerrarFichajeOlvidado'>) {
  const entry = await readEntry(c, d.entryId)
  requireRevision(entry.revision, d.expectedRevision, 'El fichaje')
  if (entry.status !== 'open') fail('Ese fichaje ya no está abierto.')
  const settings = await loadStaffSettings(c)
  const endAt = trunc(d.endAt)
  if (endAt <= entry.startAt) fail('La salida tiene que ser posterior a la entrada.')
  // Una pausa abierta se cierra a la misma hora de salida.
  const times: Times = { startAt: entry.startAt, endAt, breaks: entry.breaks.map(b => ({ startAt: b.startAt, endAt: b.endAt ?? endAt })) }
  await checkManagerTimes(c, entry.uid, times, d.entryId)
  const minutes = core.entryMinutes(times, settings)
  const next = core.TimeEntrySchema.parse({
    ...entry, endAt, breaks: times.breaks, status: 'closed', endSource: 'manager', forgotten: false, needsReview: true,
    workedMinutes: minutes.roundedMinutes, breakMinutes: minutes.breakMinutes, revision: entry.revision + 1,
  })
  await replace(c, TABLES.entries, d.entryId, next)
  await releaseLock(c, entry.uid, d.entryId)
  await auditEvent(c, { entryId: d.entryId, uid: entry.uid, kind: 'close_forgotten', source: 'manager', by: c.uid!, reason: d.reason, before: entry, after: times })
  await audit(c, 'staff.entry_closed', 'Fichaje abierto cerrado por un encargado.', { entryId: d.entryId, uid: entry.uid, reason: d.reason })
  return { revision: next.revision, workedMinutes: minutes.roundedMinutes }
}

export async function anularFichaje(c: Ctx, d: Input<'anularFichaje'>) {
  const entry = await readEntry(c, d.entryId)
  requireRevision(entry.revision, d.expectedRevision, 'El fichaje')
  if (entry.status === 'voided') fail('Ese fichaje ya está anulado.')
  const next = core.TimeEntrySchema.parse({ ...entry, status: 'voided', forgotten: false, needsReview: false, revision: entry.revision + 1 })
  await replace(c, TABLES.entries, d.entryId, next)
  if (entry.status === 'open') await releaseLock(c, entry.uid, d.entryId)
  await auditEvent(c, { entryId: d.entryId, uid: entry.uid, kind: 'void', source: 'manager', by: c.uid!, reason: d.reason, before: entry, after: null })
  await audit(c, 'staff.entry_voided', 'Fichaje anulado por un encargado.', { entryId: d.entryId, uid: entry.uid, reason: d.reason })
  return { ok: true as const }
}

/* Horas -------------------------------------------------------------------------------------- */

export async function informeHoras(c: Ctx, d: Input<'informeHoras'>) {
  // Las propias horas bastan con fichar; las de otra persona o las de todos, con gestionar personal.
  require(c, d.uid !== null && d.uid === c.uid ? 'fichaje.registrar' : 'personal.gestionar')
  if ((Date.parse(d.to) - Date.parse(d.from)) / 86_400_000 > REPORT_DAYS) fail('El periodo es demasiado largo. Pide un año como máximo.')
  const settings = await loadStaffSettings(c)
  // Un fichaje que cruza la medianoche cuenta minutos en el día anterior a su fecha: se mira un día antes.
  const params: unknown[] = [core.sumarDias(d.from, -1), d.to]
  if (d.uid !== null) params.push(d.uid)
  const found = await list(c, TABLES.entries, core.TimeEntrySchema, `entry_date>=$3 AND entry_date<=$4${d.uid !== null ? ' AND uid=$5' : ''}`, params, 'entry_date,start_at', REPORT_ROWS + 1)
  if (found.length > REPORT_ROWS) fail('Hay demasiados fichajes en ese periodo. Acórtalo.')
  return { rows: core.hoursReport(found, { from: d.from, to: d.to, timezone: c.tz, settings, now: c.now }) }
}

export async function horasParaPropinas(c: Ctx, d: Input<'horasParaPropinas'>) {
  const cash = await cashWindowSource().session(c.client, { restaurantId: c.rid, locationId: c.lid }, d.cashSessionId) ?? missing('No se encuentra esa caja.')
  const windowStart = cash.openedAt, windowEnd = cash.closedAt ?? c.now
  if (windowEnd < windowStart) fail('La ventana de la caja no es válida.')
  const settings = await loadStaffSettings(c)
  const during = await listAll(c, TABLES.entries, core.TimeEntrySchema, 'start_at>=$3 AND start_at<$4', [Math.max(0, windowStart - LOOKBACK), windowEnd + 1], 'start_at', 2000)
  const open = await listAll(c, TABLES.entries, core.TimeEntrySchema, "status='open'", [], 'start_at', 500)
  const byId = new Map([...during, ...open].map(e => [e.id, e]))
  // Un fichaje abierto que ya pasó el límite cuenta como olvidado aunque el proceso aún no lo haya marcado.
  const entries = [...byId.values()].map(e => ({ ...e, forgotten: e.forgotten || (e.status === 'open' && c.now - e.startAt >= settings.forgottenAfterMinutes * MINUTE) }))
  const { hours, incomplete } = core.tipHoursForWindow(entries, { startAt: windowStart, endAt: windowEnd }, settings)
  return { hours, incomplete, windowStart, windowEnd }
}
