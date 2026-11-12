import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import * as core from '@llenamos/core'
import { db } from '../shared'
import * as api from './index'
import { reviewOpenEntries } from './procesos'
import { HOUR, MIN, call, cleanup, createRestaurant, enabled, lid, req, type Fx } from './fixture'

let fx: Fx
// 10 de junio de 2026 en Madrid es horario de verano (UTC+2): las 21:50 locales son las 19:50 UTC.
const T = (h: number, m = 0, day = 10) => Date.UTC(2026, 5, day, h, m)
const ms = (v: unknown) => core.timestampToMillis(v)!
const entryDoc = async (id: string) => core.TimeEntrySchema.parse((await db.doc(`${fx.path}/timeEntries/${id}`).get()).data())
const events = async (id: string) => (await db.collection(`${fx.path}/timeEntryEvents`).where('entryId', '==', id).get()).docs.map((d) => d.data()).sort((a, b) => ms(a.at) - ms(b.at))
const fichar = (action: core.ClockAction, now: number, uid = 'ana') => call('fichar', { ...fx.mutation(), action, note: null }, uid, now)
const manual = (uid: string, start: number, end: number, extra: Record<string, unknown> = {}) =>
  call('crearFichajeManual', { ...fx.mutation(), uid, startAt: start, endAt: end, breaks: [], reason: 'Olvidó fichar', ...extra }, 'manager', T(23, 59, 20))

describe.skipIf(!enabled)('Personal: fichaje, correcciones, horas y cuadrante', { timeout: 60000 }, () => {
  beforeEach(async () => { fx = await createRestaurant('f4-personal') }, 60000)
  afterAll(cleanup, 120000)

  it('exporta 32 callables y exige sesión, rol, local y módulo', async () => {
    expect(api.names).toHaveLength(32)
    for (const name of api.names) expect(api[name].run).toBeTypeOf('function')
    const d = { ...fx.mutation(), action: 'in', note: null }
    for (const uid of [null, 'inactive', 'limited', 'foreign']) await expect(call('fichar', d, uid)).rejects.toMatchObject({ code: uid === null ? 'unauthenticated' : 'permission-denied' })
    // Un encargado gestiona; el camarero no.
    const cfg = { ...fx.mutation(), settings: core.defaultStaffSettings() }
    await expect(call('guardarConfiguracionPersonal', cfg, 'waiter')).rejects.toMatchObject({ code: 'permission-denied' })
    await expect(call('guardarConfiguracionPersonal', cfg, 'kitchen')).rejects.toMatchObject({ code: 'permission-denied' })
    await expect(call('guardarConfiguracionPersonal', cfg, 'manager')).resolves.toEqual({ ok: true })
    // Sin el módulo staff no se ficha.
    await db.doc(`restaurants/${fx.rid}`).update({ activeModules: ['floor'] })
    await expect(fichar('in', T(8))).rejects.toMatchObject({ code: 'failed-precondition' })
  })

  it('el doble fichar con el mismo requestId devuelve el original y con otro se rechaza', async () => {
    const d = { ...fx.mutation(), action: 'in' as const, note: null }
    const first = await call('fichar', d, 'ana', T(9))
    expect(first).toMatchObject({ state: 'working', at: T(9), workedMinutes: null })
    // Mala cobertura: el cliente repite la petición un minuto después con el mismo requestId.
    expect(await call('fichar', d, 'ana', T(9, 1))).toEqual(first)
    expect((await db.collection(`${fx.path}/timeEntries`).get()).size).toBe(1)
    // Otra intención con otro requestId no pasa por la misma entrada.
    await expect(fichar('in', T(9, 2))).rejects.toMatchObject({ code: 'failed-precondition', message: expect.stringContaining('Ya tienes el fichaje abierto') })
    // El mismo requestId con otra acción es otra entrada.
    await expect(call('fichar', { ...d, action: 'out' }, 'ana', T(9, 3))).rejects.toMatchObject({ code: 'already-exists' })
    await expect(fichar('break_end', T(9, 4))).rejects.toMatchObject({ code: 'failed-precondition' })
  })

  it('tres entradas simultáneas de la misma persona: solo una pasa y no queda ningún fichaje duplicado', async () => {
    const results = await Promise.allSettled([fichar('in', T(9)), fichar('in', T(9)), fichar('in', T(9))])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason.code === 'failed-precondition')).toBe(true)
    expect((await db.collection(`${fx.path}/timeEntries`).get()).size).toBe(1)
    expect((await db.collection(`${fx.path}/timeEntryEvents`).get()).size).toBe(1)
  })

  it('no se puede fichar abierto en dos locales a la vez', async () => {
    await call('fichar', { ...fx.mutation(), action: 'in', note: null }, 'ana', T(9))
    await expect(call('fichar', { restaurantId: fx.rid, locationId: 'otro', requestId: 'otro-1', action: 'in', note: null }, 'ana', T(9, 5))).rejects.toMatchObject({ code: 'failed-precondition', message: expect.stringContaining('otro local') })
    await expect(call('fichar', { restaurantId: fx.rid, locationId: 'otro', requestId: 'otro-2', action: 'out', note: null }, 'ana', T(9, 6))).rejects.toMatchObject({ code: 'failed-precondition' })
    // Tras salir en el primero sí puede entrar en el otro.
    await fichar('out', T(10))
    await expect(call('fichar', { restaurantId: fx.rid, locationId: 'otro', requestId: 'otro-3', action: 'in', note: null }, 'ana', T(10, 5))).resolves.toMatchObject({ state: 'working' })
  })

  it('fichar con pausas cruzando la medianoche reparte los minutos por día', async () => {
    // 21:50 a 02:10 locales con una pausa de 23:40 a 00:20: 110 minutos el día 10 y 110 el día 11.
    expect(await fichar('in', T(19, 50))).toMatchObject({ state: 'working' })
    await fichar('break_start', T(21, 40))
    // El proceso no puede marcarlo como olvidado en cinco horas.
    await expect(fichar('break_start', T(21, 45))).rejects.toMatchObject({ code: 'failed-precondition' })
    await fichar('break_end', T(22, 20))
    const out = await fichar('out', T(0, 10, 11))
    expect(out).toMatchObject({ state: 'out', workedMinutes: 220 })
    const entry = await entryDoc(out.entryId)
    expect(entry).toMatchObject({ date: '2026-06-10', status: 'closed', workedMinutes: 220, breakMinutes: 40, startSource: 'self', endSource: 'self', revision: 4 })
    expect((await events(out.entryId)).map((e) => e.kind)).toEqual(['clock_in', 'break_start', 'break_end', 'clock_out'])
    const report = await call('informeHoras', { ...fx.scope(), from: '2026-06-10', to: '2026-06-11', uid: null }, 'manager', T(12, 0, 12))
    expect(report.rows).toEqual([{ uid: 'ana', minutes: 220, entries: 1, openEntries: 0, forgottenEntries: 0, provisionalMinutes: 0, byDate: { '2026-06-10': 110, '2026-06-11': 110 } }])
    // El informe de un solo día recoge solo los minutos de ese día.
    const day2 = await call('informeHoras', { ...fx.scope(), from: '2026-06-11', to: '2026-06-11', uid: 'ana' }, 'manager', T(12, 0, 12))
    expect(day2.rows[0]).toMatchObject({ minutes: 110, byDate: { '2026-06-11': 110 } })
  })

  it('salir con una pausa abierta la cierra a esa hora, y el redondeo y las pausas pagadas salen de los ajustes', async () => {
    await call('guardarConfiguracionPersonal', { ...fx.mutation(), settings: { ...core.defaultStaffSettings(), roundingMinutes: 15, breaksPaid: false } }, 'manager')
    await fichar('in', T(9, 0))
    await fichar('break_start', T(11, 0))
    const out = await fichar('out', T(11, 20))
    // 120 min de trabajo, la pausa abierta de 20 min se descuenta y no se redondea de más.
    expect(out.workedMinutes).toBe(120)
    const entry = await entryDoc(out.entryId)
    expect(entry.breaks).toEqual([{ startAt: T(11, 0), endAt: T(11, 20) }])
    expect(entry.breakMinutes).toBe(20)
    // 8:55 a 12:08 sin pausas: 193 min, redondeados a 195.
    await call('guardarConfiguracionPersonal', { ...fx.mutation(), settings: { ...core.defaultStaffSettings(), roundingMinutes: 15 } }, 'manager')
    await fichar('in', T(13, 3, 10))
    expect((await fichar('out', T(16, 16, 10))).workedMinutes).toBe(195)
  })

  it('la corrección exige motivo y revisión, deja la foto de antes y después y no admite futuros ni solapes', async () => {
    const created = await manual('ana', T(8), T(16), { breaks: [{ startAt: T(12), endAt: T(12, 30) }] })
    expect(created.workedMinutes).toBe(450)
    const entry = await entryDoc(created.entryId)
    expect(entry).toMatchObject({ needsReview: true, startSource: 'manager', revision: 1, status: 'closed' })
    const fix = { ...fx.mutation(), entryId: created.entryId, expectedRevision: 1, startAt: T(8, 30), endAt: T(16), breaks: [], reason: 'Llegó tarde' }
    await expect(call('corregirFichaje', { ...fix, reason: '' }, 'manager', T(23, 59, 21))).rejects.toMatchObject({ code: 'invalid-argument' })
    await expect(call('corregirFichaje', fix, 'waiter', T(23, 59, 21))).rejects.toMatchObject({ code: 'permission-denied' })
    await expect(call('corregirFichaje', { ...fix, expectedRevision: 7 }, 'manager', T(23, 59, 21))).rejects.toMatchObject({ code: 'failed-precondition' })
    await expect(call('corregirFichaje', { ...fix, endAt: T(7) }, 'manager', T(23, 59, 21))).rejects.toMatchObject({ code: 'failed-precondition' })
    await expect(call('corregirFichaje', { ...fix, endAt: T(23, 59, 25) }, 'manager', T(23, 59, 21))).rejects.toMatchObject({ code: 'failed-precondition', message: expect.stringContaining('futuro') })
    const ok = await call('corregirFichaje', fix, 'manager', T(23, 59, 21))
    expect(ok).toEqual({ revision: 2, workedMinutes: 450 })
    const after = await entryDoc(created.entryId)
    expect(after).toMatchObject({ startAt: T(8, 30), revision: 2, workedMinutes: 450 })
    const log = await events(created.entryId)
    expect(log.map((e) => e.kind)).toEqual(['manual_create', 'correction'])
    expect(log[1]).toMatchObject({ by: 'manager', reason: 'Llegó tarde', source: 'manager' })
    expect(ms(log[1]!.before.startAt)).toBe(T(8)); expect(ms(log[1]!.after.startAt)).toBe(T(8, 30))
    // Un segundo fichaje que se pisa con el primero se rechaza.
    await expect(manual('ana', T(15), T(18))).rejects.toMatchObject({ code: 'failed-precondition', message: expect.stringContaining('solapa') })
    // Una corrección que lo haga chocar con otro de la misma persona también.
    const other = await manual('ana', T(17), T(20))
    await expect(call('corregirFichaje', { ...fix, ...fx.mutation(), entryId: other.entryId, expectedRevision: 1, startAt: T(15), endAt: T(20) }, 'manager', T(23, 59, 21))).rejects.toMatchObject({ code: 'failed-precondition' })
    // La actividad recoge lo que hace el encargado.
    const actions = (await db.collection(`restaurants/${fx.rid}/activity`).get()).docs.map((d) => d.get('action'))
    expect(actions).toEqual(expect.arrayContaining(['staff.entry_created', 'staff.entry_corrected']))
  })

  it('anular deja el fichaje fuera de las horas, con motivo y auditoría, y libera al abierto', async () => {
    const open = await fichar('in', T(9))
    const entry = await entryDoc(open.entryId)
    await expect(call('anularFichaje', { ...fx.mutation(), entryId: open.entryId, expectedRevision: 1, reason: 'Error' }, 'ana', T(9, 5))).rejects.toMatchObject({ code: 'permission-denied' })
    await call('anularFichaje', { ...fx.mutation(), entryId: open.entryId, expectedRevision: entry.revision, reason: 'Fichó sin querer' }, 'manager', T(9, 5))
    expect(await entryDoc(open.entryId)).toMatchObject({ status: 'voided', revision: 2 })
    expect((await events(open.entryId)).at(-1)).toMatchObject({ kind: 'void', reason: 'Fichó sin querer', after: null })
    expect((await db.doc(`restaurants/${fx.rid}/staffClockLocks/ana`).get()).exists).toBe(false)
    await expect(call('anularFichaje', { ...fx.mutation(), entryId: open.entryId, expectedRevision: 2, reason: 'Otra vez' }, 'manager', T(9, 6))).rejects.toMatchObject({ code: 'failed-precondition' })
    expect(await fichar('in', T(9, 10))).toMatchObject({ state: 'working' })
    const report = await call('informeHoras', { ...fx.scope(), from: '2026-06-10', to: '2026-06-10', uid: 'ana' }, 'manager', T(10))
    expect(report.rows[0]).toMatchObject({ entries: 0, openEntries: 1, provisionalMinutes: 50 })
  })

  it('un fichaje olvidado lo marca el proceso, no se cierra fichando y lo cierra un encargado', async () => {
    const open = await fichar('in', T(8))
    await reviewOpenEntries(T(15), fx.rid).then((r) => expect(r.marked).toBe(0))
    expect((await reviewOpenEntries(T(20, 1), fx.rid)).marked).toBe(1)
    // Repetir el proceso no duplica el aviso.
    expect((await reviewOpenEntries(T(21), fx.rid)).marked).toBe(0)
    const entry = await entryDoc(open.entryId)
    expect(entry).toMatchObject({ forgotten: true, status: 'open', revision: 2 })
    const warnings = (await db.collection(`restaurants/${fx.rid}/activity`).where('action', '==', 'staff.entry_forgotten').get()).docs
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.get('summary')).toContain('Persona ana')
    // Ni salir ni pausar ni entrar de nuevo: lo cierra un encargado.
    for (const action of ['out', 'break_start', 'in'] as const) await expect(fichar(action, T(21, 5))).rejects.toMatchObject({ code: 'failed-precondition', message: expect.stringContaining('encargado') })
    expect((await entryDoc(open.entryId)).status).toBe('open')
    const report = await call('informeHoras', { ...fx.scope(), from: '2026-06-10', to: '2026-06-10', uid: null }, 'manager', T(21))
    expect(report.rows[0]).toMatchObject({ minutes: 0, openEntries: 1, forgottenEntries: 1, provisionalMinutes: 0 })
    const close = { ...fx.mutation(), entryId: open.entryId, expectedRevision: 2, endAt: T(16), reason: 'Salió a las 18:00' }
    await expect(call('cerrarFichajeOlvidado', { ...close, endAt: T(7) }, 'manager', T(21))).rejects.toMatchObject({ code: 'failed-precondition' })
    expect(await call('cerrarFichajeOlvidado', close, 'manager', T(21))).toEqual({ revision: 3, workedMinutes: 480 })
    expect(await entryDoc(open.entryId)).toMatchObject({ status: 'closed', forgotten: false, needsReview: true, endSource: 'manager' })
    expect((await events(open.entryId)).at(-1)).toMatchObject({ kind: 'close_forgotten', reason: 'Salió a las 18:00', by: 'manager' })
    // La persona vuelve a poder fichar.
    expect(await fichar('in', T(21, 30))).toMatchObject({ state: 'working' })
  })

  it('el fichaje abierto que supera el límite no se cierra fichando aunque el proceso aún no lo haya marcado', async () => {
    await fichar('in', T(6))
    await expect(fichar('out', T(19, 30))).rejects.toMatchObject({ code: 'failed-precondition', message: expect.stringContaining('encargado') })
  })

  it('el puesto de fichaje exige ajuste activo, sesión de encargado y PIN, y bloquea tras cinco fallos', async () => {
    const pinDoc = () => db.doc(`${fx.path}/staffPins/ana`).get()
    const kiosk = (pin: string, action: core.ClockAction, now: number, uid = 'manager') => call('ficharEnPuesto', { ...fx.mutation(), uid: 'ana', pin, action }, uid, now)
    await expect(call('guardarPinFichaje', { ...fx.mutation(), uid: 'ana', pin: '4321' }, 'waiter', T(8))).rejects.toMatchObject({ code: 'permission-denied' })
    await expect(call('guardarPinFichaje', { ...fx.mutation(), uid: 'inactive', pin: '4321' }, 'manager', T(8))).rejects.toMatchObject({ code: 'failed-precondition' })
    await call('guardarPinFichaje', { ...fx.mutation(), uid: 'ana', pin: '4321' }, 'manager', T(8))
    const stored = (await pinDoc()).data()!
    expect(JSON.stringify(stored)).not.toContain('4321')
    expect(stored).toMatchObject({ failedAttempts: 0, lockedUntil: null })
    await expect(kiosk('4321', 'in', T(8, 1))).rejects.toMatchObject({ code: 'failed-precondition', message: expect.stringContaining('no está activado') })
    await call('guardarConfiguracionPersonal', { ...fx.mutation(), settings: { ...core.defaultStaffSettings(), kioskEnabled: true } }, 'manager', T(8))
    await expect(kiosk('4321', 'in', T(8, 1), 'waiter')).rejects.toMatchObject({ code: 'permission-denied' })
    // Cuatro fallos descuentan intentos; el quinto bloquea.
    for (const left of [4, 3, 2, 1]) await expect(kiosk('0000', 'in', T(8, 2))).rejects.toMatchObject({ code: 'permission-denied', details: { reason: 'wrong', attemptsLeft: left } })
    expect((await pinDoc()).get('failedAttempts')).toBe(4)
    await expect(kiosk('0000', 'in', T(8, 3))).rejects.toMatchObject({ code: 'permission-denied', details: { reason: 'locked' } })
    // Bloqueado: ni siquiera el PIN bueno vale hasta pasados cinco minutos.
    await expect(kiosk('4321', 'in', T(8, 5))).rejects.toMatchObject({ details: { reason: 'locked' } })
    expect((await db.collection(`${fx.path}/timeEntries`).get()).size).toBe(0)
    const ok = await kiosk('4321', 'in', T(8, 9))
    expect(ok).toMatchObject({ state: 'working' })
    expect(await entryDoc(ok.entryId)).toMatchObject({ uid: 'ana', startSource: 'kiosk' })
    expect((await events(ok.entryId))[0]).toMatchObject({ source: 'kiosk', by: 'manager', uid: 'ana' })
    expect((await pinDoc()).get('failedAttempts')).toBe(0)
    expect(await kiosk('4321', 'out', T(12))).toMatchObject({ state: 'out', workedMinutes: 231 })
    // Quitar el PIN.
    await call('guardarPinFichaje', { ...fx.mutation(), uid: 'ana', pin: null }, 'manager', T(12))
    expect((await pinDoc()).exists).toBe(false)
    await expect(kiosk('4321', 'in', T(12, 5))).rejects.toMatchObject({ code: 'failed-precondition' })
  })

  it('cada persona solo ve sus horas; las de otros o las de todos exigen gestionar personal', async () => {
    await manual('ana', T(8), T(12)); await manual('berta', T(8), T(10))
    const q = (uid: string | null) => ({ ...fx.scope(), from: '2026-06-10', to: '2026-06-10', uid })
    expect((await call('informeHoras', q('ana'), 'ana', T(23))).rows).toEqual([expect.objectContaining({ uid: 'ana', minutes: 240 })])
    await expect(call('informeHoras', q('berta'), 'ana', T(23))).rejects.toMatchObject({ code: 'permission-denied' })
    await expect(call('informeHoras', q(null), 'ana', T(23))).rejects.toMatchObject({ code: 'permission-denied' })
    expect((await call('informeHoras', q(null), 'manager', T(23))).rows.map((r) => [r.uid, r.minutes])).toEqual([['ana', 240], ['berta', 120]])
  })

  it('el cuadrante rechaza solapes, avisa del descanso y las horas, publica y copia sin pisar ni inventar horas', async () => {
    const shift = (uid: string, start: number, end: number, position = 'Sala') => ({ uid, startAt: start, endAt: end, position, note: '' })
    const save = (s: ReturnType<typeof shift>, id: string | null = null, rev: number | null = null, as = 'manager') => call('guardarTurno', { ...fx.mutation(), shiftId: id, expectedRevision: rev, shift: s }, as, T(8))
    // Semana del 8 al 14 de junio de 2026.
    const a = await save(shift('ana', T(10, 0, 8), T(18, 0, 8)))
    expect(a).toMatchObject({ revision: 1, warnings: [] })
    const doc = core.StaffShiftSchema.parse((await db.doc(`${fx.path}/shifts/${a.shiftId}`).get()).data())
    expect(doc).toMatchObject({ date: '2026-06-08', weekStart: '2026-06-08', status: 'draft', publishedAt: null })
    await expect(save(shift('ana', T(17, 0, 8), T(20, 0, 8)))).rejects.toMatchObject({ code: 'failed-precondition', message: expect.stringContaining('se pisa') })
    await expect(save(shift('ana', T(10, 0, 8), T(12, 0, 8)), 'inexistente', 1)).rejects.toMatchObject({ code: 'not-found' })
    await expect(save(shift('inactive', T(10), T(12)))).rejects.toMatchObject({ code: 'failed-precondition' })
    await expect(save(shift('ana', T(10, 0, 9), T(12, 0, 9)), null, null, 'waiter')).rejects.toMatchObject({ code: 'permission-denied' })
    const rest = await save(shift('ana', T(23, 0, 8), T(23, 30, 8)))
    expect(rest.warnings).toEqual([expect.objectContaining({ kind: 'short_rest', uid: 'ana' })])
    // Editar con una revisión vieja falla; con la buena sube la revisión.
    await expect(save(shift('ana', T(10, 0, 8), T(17, 0, 8)), a.shiftId, 9)).rejects.toMatchObject({ code: 'failed-precondition' })
    expect(await save(shift('ana', T(10, 0, 8), T(17, 0, 8)), a.shiftId, 1)).toMatchObject({ revision: 2 })
    // Muchas horas en la semana: 6 días de 8 h son 48 h por encima de las 40.
    let last: Awaited<ReturnType<typeof save>> | null = null
    for (const day of [9, 10, 11, 12]) last = await save(shift('berta', T(8, 0, day), T(16, 0, day)))
    last = await save(shift('berta', T(8, 0, 13), T(16, 0, 13)))
    last = await save(shift('berta', T(8, 0, 14), T(16, 0, 14)))
    expect(last.warnings).toEqual([expect.objectContaining({ kind: 'weekly_hours', uid: 'berta' })])

    // Los borradores no los ve el personal; al publicar sí. Publicar sube la revisión de todos los turnos de la semana.
    const published = await call('publicarCuadrante', { ...fx.mutation(), weekStart: '2026-06-08', publish: true }, 'manager', T(9))
    expect(published.shifts).toBe(8)
    expect(published.warnings.map((w) => w.kind)).toEqual(expect.arrayContaining(['short_rest', 'weekly_hours']))
    const statuses = (await db.collection(`${fx.path}/shifts`).get()).docs.map((d) => d.get('status'))
    expect(new Set(statuses)).toEqual(new Set(['published']))
    await expect(call('publicarCuadrante', { ...fx.mutation(), weekStart: '2026-06-09', publish: true }, 'manager', T(9))).rejects.toMatchObject({ code: 'failed-precondition' })
    await call('publicarCuadrante', { ...fx.mutation(), weekStart: '2026-06-08', publish: false }, 'manager', T(9, 1))
    expect(new Set((await db.collection(`${fx.path}/shifts`).get()).docs.map((d) => d.get('status')))).toEqual(new Set(['draft']))

    // Copiar la semana: los turnos se copian como borrador, y repetir no duplica ni pisa.
    const copy = await call('copiarSemanaCuadrante', { ...fx.mutation(), fromWeekStart: '2026-06-08', toWeekStart: '2026-06-15' }, 'manager', T(9, 2))
    expect(copy).toEqual({ copied: 8, skipped: [] })
    const again = await call('copiarSemanaCuadrante', { ...fx.mutation(), fromWeekStart: '2026-06-08', toWeekStart: '2026-06-15' }, 'manager', T(9, 3))
    expect(again.copied).toBe(0); expect(again.skipped).toHaveLength(8)
    const week2 = (await db.collection(`${fx.path}/shifts`).where('weekStart', '==', '2026-06-15').get()).docs.map((d) => core.StaffShiftSchema.parse(d.data()))
    expect(week2).toHaveLength(8); expect(week2.every((s) => s.status === 'draft')).toBe(true)
    expect(week2.find((s) => s.uid === 'ana' && s.date === '2026-06-15')).toMatchObject({ startAt: T(10, 0, 15) })

    // Borrar exige revisión.
    const target = (await db.collection(`${fx.path}/shifts`).where('weekStart', '==', '2026-06-15').get()).docs[0]!
    await expect(call('borrarTurno', { ...fx.mutation(), shiftId: target.id, expectedRevision: 4 }, 'manager', T(9))).rejects.toMatchObject({ code: 'failed-precondition' })
    await call('borrarTurno', { ...fx.mutation(), shiftId: target.id, expectedRevision: 1 }, 'manager', T(9))
    expect((await target.ref.get()).exists).toBe(false)
  })

  it('al copiar de una semana a la del cambio de hora, los turnos con una hora que no existe se saltan', async () => {
    // El 29 de marzo de 2026 a las 02:00 los relojes pasan a las 03:00: las 02:30 de ese domingo no existen.
    const wed = Date.UTC(2026, 2, 18, 10), sun = Date.UTC(2026, 2, 22, 1, 30) // domingo 22 de marzo 02:30 locales (UTC+1)
    for (const [start, end] of [[wed, wed + 8 * HOUR], [sun, sun + 3 * HOUR]] as const) {
      await call('guardarTurno', { ...fx.mutation(), shiftId: null, expectedRevision: null, shift: { uid: 'ana', startAt: start, endAt: end, position: 'Noche', note: '' } }, 'manager', T(8))
    }
    const copy = await call('copiarSemanaCuadrante', { ...fx.mutation(), fromWeekStart: '2026-03-16', toWeekStart: '2026-03-23' }, 'manager', T(8))
    expect(copy.copied).toBe(1)
    expect(copy.skipped).toHaveLength(1)
    expect(copy.skipped[0]!.reason).toContain('no existe')
  })

  it('horasParaPropinas devuelve los minutos fichados dentro de la caja de la fase 3 y sirven para repartir', async () => {
    const pos = await import('../fase3/index')
    const now = Math.floor(Date.now() / MIN) * MIN
    const cash = await pos.execute('abrirCaja', { ...fx.mutation(), registerId: 'principal', openingCents: 10000 }, req({}, 'manager'))
    await db.doc(`${fx.path}/cashSessions/${cash.cashSessionId}`).update({ openedAt: new Date(now - 4 * HOUR) })
    const at = (h: number) => now - h * HOUR
    // Ana: 5h a 1h antes con 30 minutos de pausa de 3h a 2h30 antes -> dentro de la caja trabaja 60 + 90.
    await manualAt('ana', at(5), at(1), [{ startAt: at(3), endAt: at(2.5) }])
    // Berta sigue abierta desde hace 2 horas: cuenta hasta el cierre de la ventana.
    await call('fichar', { ...fx.mutation(), action: 'in', note: null }, 'berta', at(2))
    // Un fichaje anulado no cuenta.
    const voided = await manualAt('waiter', at(4), at(3), [])
    await call('anularFichaje', { ...fx.mutation(), entryId: voided.entryId, expectedRevision: 1, reason: 'Duplicado' }, 'manager', now)
    // Fuera de la ventana: terminó antes de abrir la caja.
    await manualAt('kitchen', at(8), at(6), [])
    const hours = await call('horasParaPropinas', { ...fx.scope(), cashSessionId: cash.cashSessionId }, 'manager', now)
    expect(hours.hours).toEqual([{ uid: 'ana', minutes: 150 }, { uid: 'berta', minutes: 120 }])
    expect(hours.incomplete).toEqual([])
    expect(hours.windowEnd).toBe(now)
    // Un olvidado deja a esa persona como incompleta y sin minutos.
    await call('fichar', { ...fx.mutation(), action: 'in', note: null }, 'bar', at(20))
    const withForgotten = await call('horasParaPropinas', { ...fx.scope(), cashSessionId: cash.cashSessionId }, 'manager', now)
    expect(withForgotten.incomplete).toEqual(['bar'])
    expect(withForgotten.hours.map((h) => h.uid)).toEqual(['ana', 'berta'])
    // Permiso y módulos: caja.gestionar, staff y pos.
    await expect(call('horasParaPropinas', { ...fx.scope(), cashSessionId: cash.cashSessionId }, 'waiter', now)).rejects.toMatchObject({ code: 'permission-denied' })
    await expect(call('horasParaPropinas', { ...fx.scope(), cashSessionId: 'nada' }, 'manager', now)).rejects.toMatchObject({ code: 'not-found' })
    // Las horas se entregan a repartirPropinas sin tocarlas.
    await db.doc(`${fx.path}/timeEntries/${(await db.collection(`${fx.path}/timeEntries`).where('uid', '==', 'bar').get()).docs[0]!.id}`).update({ status: 'voided' })
    const closed = await pos.execute('cerrarCaja', { ...fx.mutation(), cashSessionId: cash.cashSessionId, countedCents: 10000, reason: null }, req({}, 'manager'))
    expect(closed.ok).toBe(true)
    const final = await call('horasParaPropinas', { ...fx.scope(), cashSessionId: cash.cashSessionId }, 'manager', now + HOUR)
    expect(final.windowEnd).toBeLessThanOrEqual(Date.now()); expect(final.hours.map((h) => h.uid)).toEqual(['ana', 'berta'])
    const share = await pos.execute('repartirPropinas', { ...fx.mutation(), cashSessionId: cash.cashSessionId, hours: final.hours }, req({}, 'manager'))
    expect(share.shares.map((s) => s.uid)).toEqual(['ana', 'berta'])
    await db.doc(`restaurants/${fx.rid}`).update({ activeModules: ['floor', 'pos'] })
    await expect(call('horasParaPropinas', { ...fx.scope(), cashSessionId: cash.cashSessionId }, 'manager', now)).rejects.toMatchObject({ code: 'failed-precondition' })
  })
})

async function manualAt(uid: string, start: number, end: number, breaks: { startAt: number; endAt: number }[]) {
  return call('crearFichajeManual', { ...fx.mutation(), uid, startAt: start, endAt: end, breaks, reason: 'Prueba' }, 'manager', Date.now())
}
void MIN; void lid
