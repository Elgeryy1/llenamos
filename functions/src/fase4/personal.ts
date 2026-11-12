/** Callables de personal (fase 4): fichaje, correcciones, horas y cuadrante. */
import { randomBytes } from 'node:crypto'
import { Timestamp } from 'firebase-admin/firestore'
import { HttpsError } from 'firebase-functions/v2/https'
import * as core from '@llenamos/core'
import { Deferred, col, fail, loadStaffSettings, localMember, missing, newId, requireRevision, type Ctx, type Input } from './context'

const ts = Timestamp.fromMillis
const MINUTE = core.MINUTE_MS
/** Un fichaje o un turno cerrado dura como mucho 16 horas: margen para buscar los que se solapan. */
const LOOKBACK = 17 * 60 * MINUTE
const DAY = 24 * 60 * MINUTE

type Times = core.EntryTimes
const trunc = core.truncateToMinute

/* Lectura y escritura de fichajes ----------------------------------------------------------- */

async function readEntry(c: Ctx, id: string) {
  const ref = col(c, 'timeEntries').doc(id)
  const snap = await c.tx.get(ref)
  if (!snap.exists) missing('No se encuentra el fichaje.')
  return { ref, entry: core.TimeEntrySchema.parse(snap.data()) }
}

function auditEvent(c: Ctx, p: { entryId: string; uid: string; kind: core.TimeEventKind; source: core.ClockSource; by: string; reason: string | null; before: Times | null; after: Times | null }) {
  const event = core.TimeEntryEventSchema.parse({
    entryId: p.entryId, uid: p.uid, kind: p.kind, at: c.now, by: p.by, source: p.source, reason: p.reason,
    before: p.before ? core.snapshotOf(p.before) : null, after: p.after ? core.snapshotOf(p.after) : null,
  })
  c.create(col(c, 'timeEntryEvents').doc(), core.timeEntryEventForWrite(event, ts))
}

/** Los demás fichajes de la persona que podrían solaparse con unos instantes (este local y su fichaje abierto, esté donde esté). */
async function otherEntries(c: Ctx, uid: string, start: number, end: number | null, exceptId: string | null) {
  const upper = (end ?? c.now) + 1
  const snap = await c.tx.get(col(c, 'timeEntries').where('uid', '==', uid).where('startAt', '>=', ts(Math.max(0, start - LOOKBACK))).where('startAt', '<', ts(upper)))
  const found = new Map(snap.docs.filter((d) => d.id !== exceptId).map((d) => [d.id, core.TimeEntrySchema.parse(d.data())]))
  const lock = await c.tx.get(c.root.collection('staffClockLocks').doc(uid))
  if (lock.exists && lock.get('entryId') !== exceptId && !found.has(lock.get('entryId'))) {
    const open = await c.tx.get(c.root.collection('locations').doc(lock.get('locationId')).collection('timeEntries').doc(lock.get('entryId')))
    if (open.exists) found.set(open.id, core.TimeEntrySchema.parse(open.data()))
  }
  return [...found.values()].map((e) => ({ startAt: e.startAt, endAt: e.endAt, status: e.status }))
}

function managerTimes(d: { startAt: number; endAt: number; breaks: readonly { startAt: number; endAt: number }[] }): Times {
  const times = { startAt: trunc(d.startAt), endAt: trunc(d.endAt), breaks: d.breaks.map((b) => ({ startAt: trunc(b.startAt), endAt: trunc(b.endAt) })) }
  if (times.endAt <= times.startAt) fail('La salida tiene que ser posterior a la entrada.')
  return times
}
async function checkManagerTimes(c: Ctx, uid: string, times: Times, exceptId: string | null) {
  const issues = core.validateEntryTimes(times, { now: c.now, others: await otherEntries(c, uid, times.startAt, times.endAt, exceptId) })
  if (issues.length) fail(issues[0]!.message)
}
const lockRef = (c: Ctx, uid: string) => c.root.collection('staffClockLocks').doc(uid)
/** Libera el bloqueo de fichaje abierto, solo si apunta a este fichaje. */
async function releaseLock(c: Ctx, uid: string, entryId: string) {
  const lock = await c.tx.get(lockRef(c, uid))
  if (lock.exists && lock.get('entryId') === entryId) c.remove(lockRef(c, uid))
}

/* Fichar ------------------------------------------------------------------------------------ */

async function clock(c: Ctx, p: { uid: string; action: core.ClockAction; note: string | null; source: 'self' | 'kiosk'; by: string }): Promise<core.CallableOutput<'fichar'>> {
  const settings = await loadStaffSettings(c)
  const lock = await c.tx.get(lockRef(c, p.uid))
  let current: { id: string; lid: string; entry: core.TimeEntry } | null = null
  if (lock.exists) {
    const lockLid = String(lock.get('locationId')), entryId = String(lock.get('entryId'))
    const snap = await c.tx.get(c.root.collection('locations').doc(lockLid).collection('timeEntries').doc(entryId))
    // Un bloqueo que apunta a un fichaje ya cerrado o anulado está caducado: se ignora y se sustituye.
    if (snap.exists) {
      const entry = core.TimeEntrySchema.parse(snap.data())
      if (entry.status === 'open' && entry.uid === p.uid) current = { id: entryId, lid: lockLid, entry }
    }
  }
  if (current && current.lid !== c.lid) fail('Tienes un fichaje abierto en otro local. Ciérralo allí antes de fichar aquí.')
  const overdue = current !== null && c.now - current.entry.startAt >= settings.forgottenAfterMinutes * MINUTE
  const result = core.applyClockAction(current ? { startAt: current.entry.startAt, endAt: null, breaks: current.entry.breaks, forgotten: current.entry.forgotten || overdue } : null, p.action, c.now)
  if (!result.ok) fail(result.message)
  const before = current ? { startAt: current.entry.startAt, endAt: current.entry.endAt, breaks: current.entry.breaks } : null

  if (p.action === 'in') {
    const entryRef = col(c, 'timeEntries').doc()
    const entry = core.TimeEntrySchema.parse({
      uid: p.uid, date: core.horaLocal(result.at, c.tz).fecha, startAt: result.times.startAt, endAt: null, breaks: [], status: 'open',
      startSource: p.source, endSource: null, shiftId: null, forgotten: false, needsReview: false, workedMinutes: null, breakMinutes: 0, note: p.note, revision: 1,
    })
    c.create(entryRef, core.timeEntryForWrite(entry, ts))
    c.set(lockRef(c, p.uid), { locationId: c.lid, entryId: entryRef.id })
    auditEvent(c, { entryId: entryRef.id, uid: p.uid, kind: result.event, source: p.source, by: p.by, reason: null, before: null, after: result.times })
    return { entryId: entryRef.id, state: result.state, at: result.at, workedMinutes: null }
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
  c.update(col(c, 'timeEntries').doc(id), core.timeEntryForWrite(next, ts))
  if (closing) c.remove(lockRef(c, p.uid))
  auditEvent(c, { entryId: id, uid: p.uid, kind: result.event, source: p.source, by: p.by, reason: null, before, after: result.times })
  return { entryId: id, state: result.state, at: result.at, workedMinutes: next.workedMinutes }
}

export async function fichar(c: Ctx, d: Input<'fichar'>) {
  return clock(c, { uid: c.uid!, action: d.action, note: d.note, source: 'self', by: c.uid! })
}

export async function ficharEnPuesto(c: Ctx, d: Input<'ficharEnPuesto'>) {
  const settings = await loadStaffSettings(c)
  if (!settings.kioskEnabled) fail('El puesto de fichaje no está activado en este local.')
  await localMember(c, d.uid)
  const ref = col(c, 'staffPins').doc(d.uid)
  const snap = await c.tx.get(ref)
  if (!snap.exists) fail('Esta persona no tiene PIN de fichaje. Pide a un encargado que lo cree.')
  const stored = core.PinRecordSchema.parse(snap.data())
  const check = core.checkPin(stored, d.pin, d.uid, c.now)
  if (!check.ok) {
    // Los intentos fallidos se guardan aunque la operación falle: por eso se lanza después de confirmar.
    if (check.record !== stored) c.update(ref, core.pinRecordForWrite(check.record, ts))
    const message = check.reason === 'locked' ? 'Demasiados intentos. Espera unos minutos y vuelve a probar.' : `PIN incorrecto. Te quedan ${check.attemptsLeft} intentos.`
    return new Deferred(new HttpsError('permission-denied', message, { reason: check.reason, attemptsLeft: check.attemptsLeft, lockedUntil: check.lockedUntil }))
  }
  c.update(ref, core.pinRecordForWrite(check.record, ts))
  return clock(c, { uid: d.uid, action: d.action, note: null, source: 'kiosk', by: c.uid! })
}

export async function guardarPinFichaje(c: Ctx, d: Input<'guardarPinFichaje'>) {
  await localMember(c, d.uid)
  const ref = col(c, 'staffPins').doc(d.uid)
  const snap = await c.tx.get(ref)
  if (d.pin === null) {
    if (snap.exists) c.remove(ref)
  } else {
    const record = core.pinRecordForWrite(core.newPinRecord(d.pin, d.uid, randomBytes(16).toString('hex')), ts)
    if (snap.exists) c.update(ref, record); else c.create(ref, record)
  }
  c.audit('staff.pin_saved', d.pin === null ? 'PIN de fichaje quitado.' : 'PIN de fichaje guardado.', { uid: d.uid })
  return { ok: true as const }
}

export async function guardarConfiguracionPersonal(c: Ctx, d: Input<'guardarConfiguracionPersonal'>) {
  c.set(col(c, 'settings').doc('staff'), d.settings)
  c.audit('staff.settings_saved', 'Ajustes de personal guardados.')
  return { ok: true as const }
}

/* Correcciones de un encargado ------------------------------------------------------------- */

export async function crearFichajeManual(c: Ctx, d: Input<'crearFichajeManual'>) {
  await localMember(c, d.uid)
  const settings = await loadStaffSettings(c)
  const times = managerTimes(d)
  await checkManagerTimes(c, d.uid, times, null)
  const minutes = core.entryMinutes(times, settings)
  const ref = col(c, 'timeEntries').doc()
  const entry = core.TimeEntrySchema.parse({
    uid: d.uid, date: core.horaLocal(times.startAt, c.tz).fecha, startAt: times.startAt, endAt: times.endAt, breaks: times.breaks, status: 'closed',
    startSource: 'manager', endSource: 'manager', shiftId: null, forgotten: false, needsReview: true,
    workedMinutes: minutes.roundedMinutes, breakMinutes: minutes.breakMinutes, note: null, revision: 1,
  })
  c.create(ref, core.timeEntryForWrite(entry, ts))
  auditEvent(c, { entryId: ref.id, uid: d.uid, kind: 'manual_create', source: 'manager', by: c.uid!, reason: d.reason, before: null, after: times })
  c.audit('staff.entry_created', 'Fichaje creado a mano por un encargado.', { entryId: ref.id, uid: d.uid, reason: d.reason })
  return { entryId: ref.id, workedMinutes: minutes.roundedMinutes }
}

export async function corregirFichaje(c: Ctx, d: Input<'corregirFichaje'>) {
  const { ref, entry } = await readEntry(c, d.entryId)
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
  c.update(ref, core.timeEntryForWrite(next, ts))
  auditEvent(c, { entryId: d.entryId, uid: entry.uid, kind: 'correction', source: 'manager', by: c.uid!, reason: d.reason, before: entry, after: times })
  c.audit('staff.entry_corrected', 'Fichaje corregido por un encargado.', { entryId: d.entryId, uid: entry.uid, reason: d.reason })
  return { revision: next.revision, workedMinutes: minutes.roundedMinutes }
}

export async function cerrarFichajeOlvidado(c: Ctx, d: Input<'cerrarFichajeOlvidado'>) {
  const { ref, entry } = await readEntry(c, d.entryId)
  requireRevision(entry.revision, d.expectedRevision, 'El fichaje')
  if (entry.status !== 'open') fail('Ese fichaje ya no está abierto.')
  const settings = await loadStaffSettings(c)
  const endAt = trunc(d.endAt)
  if (endAt <= entry.startAt) fail('La salida tiene que ser posterior a la entrada.')
  // Una pausa abierta se cierra a la misma hora de salida.
  const times: Times = { startAt: entry.startAt, endAt, breaks: entry.breaks.map((b) => ({ startAt: b.startAt, endAt: b.endAt ?? endAt })) }
  await checkManagerTimes(c, entry.uid, times, d.entryId)
  const minutes = core.entryMinutes(times, settings)
  const next = core.TimeEntrySchema.parse({
    ...entry, endAt, breaks: times.breaks, status: 'closed', endSource: 'manager', forgotten: false, needsReview: true,
    workedMinutes: minutes.roundedMinutes, breakMinutes: minutes.breakMinutes, revision: entry.revision + 1,
  })
  c.update(ref, core.timeEntryForWrite(next, ts))
  await releaseLock(c, entry.uid, d.entryId)
  auditEvent(c, { entryId: d.entryId, uid: entry.uid, kind: 'close_forgotten', source: 'manager', by: c.uid!, reason: d.reason, before: entry, after: times })
  c.audit('staff.entry_closed', 'Fichaje abierto cerrado por un encargado.', { entryId: d.entryId, uid: entry.uid, reason: d.reason })
  return { revision: next.revision, workedMinutes: minutes.roundedMinutes }
}

export async function anularFichaje(c: Ctx, d: Input<'anularFichaje'>) {
  const { ref, entry } = await readEntry(c, d.entryId)
  requireRevision(entry.revision, d.expectedRevision, 'El fichaje')
  if (entry.status === 'voided') fail('Ese fichaje ya está anulado.')
  const next = core.TimeEntrySchema.parse({ ...entry, status: 'voided', forgotten: false, needsReview: false, revision: entry.revision + 1 })
  c.update(ref, core.timeEntryForWrite(next, ts))
  if (entry.status === 'open') await releaseLock(c, entry.uid, d.entryId)
  auditEvent(c, { entryId: d.entryId, uid: entry.uid, kind: 'void', source: 'manager', by: c.uid!, reason: d.reason, before: entry, after: null })
  c.audit('staff.entry_voided', 'Fichaje anulado por un encargado.', { entryId: d.entryId, uid: entry.uid, reason: d.reason })
  return { ok: true as const }
}

/* Horas -------------------------------------------------------------------------------------- */

export async function informeHoras(c: Ctx, d: Input<'informeHoras'>) {
  // Las propias horas bastan con fichar; las de otra persona o las de todos, con gestionar personal.
  c.require(d.uid !== null && d.uid === c.uid ? 'fichaje.registrar' : 'personal.gestionar')
  const settings = await loadStaffSettings(c)
  // Un fichaje que cruza la medianoche cuenta minutos en el día anterior a su fecha: se mira un día antes.
  let query = col(c, 'timeEntries').where('date', '>=', core.sumarDias(d.from, -1)).where('date', '<=', d.to)
  if (d.uid !== null) query = query.where('uid', '==', d.uid)
  const snap = await c.tx.get(query)
  const entries = snap.docs.map((doc) => core.TimeEntrySchema.parse(doc.data()))
  const rows = core.hoursReport(entries, { from: d.from, to: d.to, timezone: c.tz, settings, now: c.now })
  return { rows }
}

/** Registro de jornada de una persona (demo): sus fichajes y su auditoría en este local. */
export async function exportarMisFichajes(c: Ctx, d: Input<'exportarMisFichajes'>) {
  const uid = d.uid ?? c.uid
  c.require(uid === c.uid ? 'fichaje.registrar' : 'personal.gestionar')
  const [entries, events] = await Promise.all([c.tx.get(col(c, 'timeEntries').where('uid', '==', uid)), c.tx.get(col(c, 'timeEntryEvents').where('uid', '==', uid))])
  return {
    uid, generatedAt: c.now, retentionYears: core.FICHAJES_RETENCION_ANIOS,
    entries: entries.docs.map((doc) => ({ ...core.TimeEntrySchema.parse(doc.data()), id: doc.id })),
    events: events.docs.map((doc) => ({ ...core.TimeEntryEventSchema.parse(doc.data()), id: doc.id })),
  }
}

export async function horasParaPropinas(c: Ctx, d: Input<'horasParaPropinas'>) {
  const cashSnap = await c.tx.get(col(c, 'cashSessions').doc(d.cashSessionId))
  if (!cashSnap.exists) missing('No se encuentra esa caja.')
  const cash = core.CashSessionSchema.parse(cashSnap.data())
  const windowStart = cash.openedAt, windowEnd = cash.closedAt ?? c.now
  if (windowEnd < windowStart) fail('La ventana de la caja no es válida.')
  const settings = await loadStaffSettings(c)
  const [during, open] = await Promise.all([
    c.tx.get(col(c, 'timeEntries').where('startAt', '>=', ts(Math.max(0, windowStart - LOOKBACK))).where('startAt', '<', ts(windowEnd + 1))),
    c.tx.get(col(c, 'timeEntries').where('status', '==', 'open')),
  ])
  const byId = new Map<string, core.TimeEntry>()
  for (const doc of [...during.docs, ...open.docs]) byId.set(doc.id, core.TimeEntrySchema.parse(doc.data()))
  // Un fichaje abierto que ya pasó el límite cuenta como olvidado aunque el proceso aún no lo haya marcado.
  const entries = [...byId.values()].map((e) => ({ ...e, forgotten: e.forgotten || (e.status === 'open' && c.now - e.startAt >= settings.forgottenAfterMinutes * MINUTE) }))
  const { hours, incomplete } = core.tipHoursForWindow(entries, { startAt: windowStart, endAt: windowEnd }, settings)
  return { hours, incomplete, windowStart, windowEnd }
}

/* Cuadrante ---------------------------------------------------------------------------------- */

async function personShifts(c: Ctx, uid: string, from: number, to: number): Promise<core.StaffShiftWithId[]> {
  const snap = await c.tx.get(col(c, 'shifts').where('uid', '==', uid).where('startAt', '>=', ts(Math.max(0, from))).where('startAt', '<', ts(to)))
  return snap.docs.map((doc) => ({ ...core.StaffShiftSchema.parse(doc.data()), id: doc.id }))
}

export async function guardarTurno(c: Ctx, d: Input<'guardarTurno'>) {
  const s = d.shift
  await localMember(c, s.uid)
  const place = core.shiftPlacement(s.startAt, c.tz)
  const ref = d.shiftId === null ? col(c, 'shifts').doc() : col(c, 'shifts').doc(d.shiftId)
  let previous: core.StaffShift | null = null
  if (d.shiftId !== null) {
    const snap = await c.tx.get(ref)
    if (!snap.exists) missing('No se encuentra el turno.')
    previous = core.StaffShiftSchema.parse(snap.data())
    if (d.expectedRevision === null) fail('Falta la revisión del turno.')
    requireRevision(previous.revision, d.expectedRevision, 'El turno')
  }
  // Se leen los turnos de esa persona de más de una semana alrededor: bastan para solapes, descansos y horas de su semana.
  const around = (await personShifts(c, s.uid, s.startAt - 8 * DAY, s.endAt + 8 * DAY)).filter((x) => x.id !== ref.id)
  if (core.findShiftConflicts(around, { uid: s.uid, startAt: s.startAt, endAt: s.endAt, id: ref.id }).length) fail('Ese turno se pisa con otro de la misma persona.')
  const status = previous && previous.weekStart === place.weekStart ? previous.status : 'draft'
  const next = core.StaffShiftSchema.parse({
    uid: s.uid, startAt: s.startAt, endAt: s.endAt, position: s.position, note: s.note, date: place.date, weekStart: place.weekStart,
    status, publishedAt: status === 'published' ? previous?.publishedAt ?? c.now : null, revision: previous ? previous.revision + 1 : 1,
  })
  if (previous) c.update(ref, core.staffShiftForWrite(next, ts)); else c.create(ref, core.staffShiftForWrite(next, ts))
  const settings = await loadStaffSettings(c)
  const warnings = core.scheduleWarnings([...around, { ...next, id: ref.id }], settings).filter((w) => w.shiftIds.includes(ref.id))
  c.audit('staff.shift_saved', 'Turno del cuadrante guardado.', { shiftId: ref.id, uid: s.uid, date: place.date })
  return { shiftId: ref.id, revision: next.revision, warnings }
}

export async function borrarTurno(c: Ctx, d: Input<'borrarTurno'>) {
  const ref = col(c, 'shifts').doc(d.shiftId)
  const snap = await c.tx.get(ref)
  if (!snap.exists) missing('No se encuentra el turno.')
  const shift = core.StaffShiftSchema.parse(snap.data())
  requireRevision(shift.revision, d.expectedRevision, 'El turno')
  c.remove(ref)
  c.audit('staff.shift_deleted', 'Turno del cuadrante borrado.', { shiftId: d.shiftId, uid: shift.uid, date: shift.date })
  return { ok: true as const }
}

export async function publicarCuadrante(c: Ctx, d: Input<'publicarCuadrante'>) {
  core.weekDates(d.weekStart)
  const snap = await c.tx.get(col(c, 'shifts').where('weekStart', '==', d.weekStart))
  const week = snap.docs.map((doc) => ({ ref: doc.ref, shift: core.StaffShiftSchema.parse(doc.data()), id: doc.id }))
  if (week.length > 400) fail('Hay demasiados turnos en esa semana.')
  const settings = await loadStaffSettings(c)
  const startMs = week.length ? Math.min(...week.map((w) => w.shift.startAt)) : 0
  const endMs = week.length ? Math.max(...week.map((w) => w.shift.endAt)) : 0
  // Los turnos de los días vecinos permiten avisar de descansos entre semanas.
  const neighbours = week.length
    ? (await c.tx.get(col(c, 'shifts').where('startAt', '>=', ts(Math.max(0, startMs - DAY))).where('startAt', '<', ts(endMs + DAY)))).docs.map((doc) => ({ ...core.StaffShiftSchema.parse(doc.data()), id: doc.id }))
    : []
  for (const { ref, shift } of week) {
    const next = core.StaffShiftSchema.parse({ ...shift, status: d.publish ? 'published' : 'draft', publishedAt: d.publish ? c.now : null, revision: shift.revision + 1 })
    c.update(ref, core.staffShiftForWrite(next, ts))
  }
  const ids = new Set(week.map((w) => w.id))
  const warnings = core.scheduleWarnings(neighbours, settings).filter((w) => w.shiftIds.some((id) => ids.has(id)))
  c.audit('staff.schedule_published', d.publish ? 'Cuadrante publicado.' : 'Cuadrante pasado a borrador.', { weekStart: d.weekStart, shifts: week.length })
  return { shifts: week.length, warnings }
}

export async function copiarSemanaCuadrante(c: Ctx, d: Input<'copiarSemanaCuadrante'>) {
  core.weekDates(d.fromWeekStart); core.weekDates(d.toWeekStart)
  const [source, target] = await Promise.all([
    c.tx.get(col(c, 'shifts').where('weekStart', '==', d.fromWeekStart)),
    c.tx.get(col(c, 'shifts').where('weekStart', '==', d.toWeekStart)),
  ])
  const from = source.docs.map((doc) => ({ ...core.StaffShiftSchema.parse(doc.data()), id: doc.id }))
  if (from.length > 400) fail('Hay demasiados turnos en esa semana.')
  const existing = target.docs.map((doc) => ({ ...core.StaffShiftSchema.parse(doc.data()), id: doc.id }))
  const { copied, skipped } = core.copyWeek(from, d.fromWeekStart, d.toWeekStart, c.tz)
  const placed: { id: string; uid: string; startAt: number; endAt: number }[] = existing
  // `copied` conserva el orden de los turnos de origen que no se han saltado.
  const skippedIds = new Set(skipped.map((x) => x.shiftId))
  const kept = from.filter((f) => !skippedIds.has(f.id))
  let created = 0
  for (const [i, s] of copied.entries()) {
    if (core.findShiftConflicts(placed, { uid: s.uid, startAt: s.startAt, endAt: s.endAt }).length) {
      skipped.push({ shiftId: kept[i]!.id, reason: 'Se pisa con otro turno de esa semana.' })
      continue
    }
    const ref = newId(c, 'shifts')
    const place = core.shiftPlacement(s.startAt, c.tz)
    const shift = core.StaffShiftSchema.parse({ ...s, date: place.date, weekStart: place.weekStart, status: 'draft', publishedAt: null, revision: 1 })
    c.create(col(c, 'shifts').doc(ref), core.staffShiftForWrite(shift, ts))
    placed.push({ id: ref, uid: s.uid, startAt: s.startAt, endAt: s.endAt })
    created++
  }
  c.audit('staff.schedule_copied', 'Semana del cuadrante copiada como borrador.', { from: d.fromWeekStart, to: d.toWeekStart, copied: created })
  return { copied: created, skipped }
}
