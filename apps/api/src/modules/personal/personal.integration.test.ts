import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as core from '@llenamos/core'
import { MODULES } from '../index.js'
import { clock } from '../fase4/contexto.js'
import { registerCashWindowSource } from '../fase4/puertos.js'
import { withIdentity } from '../../database.js'
import { enabled, identity, startHarness, type Harness } from '../fase4/arnes.js'
import { reviewOpenEntries } from './procesos.js'
import { buildHandlers, createWorker } from '../../worker/index.js'

const T = (h: number, m = 0, day = 10) => Date.UTC(2026, 5, day, h, m)
let h: Harness
let now = T(8)
const at = (value: number) => { now = value; clock.now = () => now }
const ids = (rows: { id: string }[]) => rows.map(row => row.id)

describe.skipIf(!enabled)('Personal en PostgreSQL', { timeout: 60_000 }, () => {
  beforeAll(async () => { h = await startHarness('personal'); at(T(8)) }, 60_000)
  afterAll(async () => { clock.now = () => Date.now(); registerCashWindowSource(null); await h?.close() })

  it('registra las 15 operaciones de personal con el contrato de core y sus lecturas en vivo', () => {
    const module = MODULES.find(m => m.name === 'personal')!
    expect(module.operations.map(([name]) => name).sort()).toEqual(Object.keys(core.CALLABLES_FASE4_PERSONAL).sort())
    expect(module.liveQueries!.map(q => q.name).sort()).toEqual(['personalAjustes', 'personalEventosFichaje', 'personalFichajes', 'personalFichajesAbiertos', 'personalTurnos'])
  })

  it('fichar: entrada, pausa y salida con el reloj del servidor, y la repetición con el mismo requestId no duplica', async () => {
    const send = (action: core.ClockAction, when: number, uid = 'ana-a', requestId?: string) => { at(when); return h.call('fichar', { ...h.mutation(), ...(requestId ? { requestId } : {}), action, note: null }, uid) }
    const first = await send('in', T(19, 50))
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    const sameId = h.mutation().requestId
    const entered = await send('break_start', T(21, 40), 'ana-a', sameId)
    const again = await send('break_start', T(21, 41), 'ana-a', sameId)
    expect(again.body).toEqual(entered.body)
    const double = await send('in', T(21, 45))
    expect(double.status).toBe(412)
    expect((await send('break_end', T(22, 20))).status).toBe(200)
    const out = await send('out', T(0, 10, 11))
    expect(out.body.result.workedMinutes).toBe(220)
    expect((await h.admin.query("SELECT count(*)::int AS n FROM llenamos.staff_time_entries WHERE uid='ana-a'")).rows[0].n).toBe(1)
    expect((await h.admin.query("SELECT count(*)::int AS n FROM llenamos.staff_clock_locks WHERE uid='ana-a'")).rows[0].n).toBe(0)
    expect((await h.admin.query('SELECT count(*)::int AS n FROM llenamos.staff_time_entry_events')).rows[0].n).toBe(4)
    // Una corrección del encargado deja la foto de antes y de después, y el informe reparte los minutos por día.
    at(T(8, 0, 11))
    const fixed = await h.ok('corregirFichaje', { ...h.mutation(), entryId: out.body.result.entryId, expectedRevision: 4, startAt: T(19, 50), endAt: T(0, 30, 11), breaks: [{ startAt: T(21, 40), endAt: T(22, 20) }], reason: 'Salió media hora más tarde' }, 'manager-a')
    expect(fixed.workedMinutes).toBe(240)
    const stale = await h.call('corregirFichaje', { ...h.mutation(), entryId: out.body.result.entryId, expectedRevision: 4, startAt: T(19, 50), endAt: T(0, 30, 11), breaks: [], reason: 'Otra' }, 'manager-a')
    expect(stale.status).toBe(412)
    at(T(9, 0, 11))
    const report = await h.ok('informeHoras', { ...h.scope(), from: '2026-06-10', to: '2026-06-11', uid: 'ana-a' }, 'manager-a')
    expect(report.rows[0]).toMatchObject({ minutes: 240, byDate: { '2026-06-10': 110, '2026-06-11': 130 } })
    // Las propias horas basta con fichar; las de otra persona o las de todos exigen gestionar personal.
    expect((await h.call('informeHoras', { ...h.scope(), from: '2026-06-10', to: '2026-06-11', uid: 'ana-a' }, 'ana-a')).status).toBe(200)
    expect((await h.call('informeHoras', { ...h.scope(), from: '2026-06-10', to: '2026-06-11', uid: 'ana-a' }, 'berta-a')).status).toBe(403)
    expect((await h.call('informeHoras', { ...h.scope(), from: '2026-06-10', to: '2026-06-11', uid: null }, 'ana-a')).status).toBe(403)
    expect((await h.call('informeHoras', { ...h.scope(), from: '2024-01-01', to: '2026-06-11', uid: null }, 'manager-a')).status).toBe(412)
  })

  it('concurrencia: cinco entradas a la vez de la misma persona dejan un solo fichaje abierto', async () => {
    at(T(7, 0, 14))
    const results = await Promise.all(Array.from({ length: 5 }, () => h.call('fichar', { ...h.mutation(), action: 'in', note: null }, 'kitchen-a')))
    expect(results.map(r => r.status).sort()).toEqual([200, 412, 412, 412, 412])
    expect((await h.admin.query("SELECT count(*)::int AS n FROM llenamos.staff_time_entries WHERE uid='kitchen-a' AND status='open'")).rows[0].n).toBe(1)
    expect((await h.admin.query("SELECT count(*)::int AS n FROM llenamos.staff_clock_locks WHERE uid='kitchen-a'")).rows[0].n).toBe(1)
    await h.ok('fichar', { ...h.mutation(), action: 'out', note: null }, 'kitchen-a')
  })

  it('rol sin permiso, otro restaurante, otro local y persona de baja: todo denegado sin tocar datos', async () => {
    at(T(10))
    const shift = { shiftId: null, expectedRevision: null, shift: { uid: 'ana-a', startAt: T(12), endAt: T(16), position: 'Sala', note: '' } }
    expect((await h.call('guardarTurno', { ...h.mutation(), ...shift }, 'waiter-a')).status).toBe(403)
    expect((await h.call('guardarTurno', { ...h.mutation(), ...shift }, 'kitchen-a')).status).toBe(403)
    expect((await h.call('crearFichajeManual', { ...h.mutation(), uid: 'ana-a', startAt: T(9), endAt: T(10), breaks: [], reason: 'x' }, 'bar-a')).status).toBe(403)
    // Propietario del restaurante B pidiendo el A: ni el rol ni el aislamiento SQL se lo permiten.
    expect((await h.call('guardarConfiguracionPersonal', { ...h.mutation('a'), settings: core.defaultStaffSettings() }, 'owner-b')).status).toBe(403)
    expect((await h.call('fichar', { ...h.mutation('a'), action: 'in', note: null }, 'owner-b')).status).toBe(403)
    expect((await h.call('guardarConfiguracionPersonal', { ...h.mutation(), settings: core.defaultStaffSettings() }, 'inactive-a')).status).toBe(403)
    expect((await h.call('guardarConfiguracionPersonal', { ...h.mutation(), settings: core.defaultStaffSettings() }, 'limited-a')).status).toBe(403)
    // Un local que no existe en ese restaurante.
    expect((await h.call('guardarConfiguracionPersonal', { restaurantId: 'rest-a', locationId: 'fantasma', requestId: 'r1', settings: core.defaultStaffSettings() })).status).toBe(404)
    // Aislamiento por RLS: con la identidad de B no se ve ni una fila de A, ni se puede escribir en ella.
    expect(Number((await h.admin.query('SELECT count(*) AS n FROM llenamos.staff_time_entries')).rows[0].n)).toBeGreaterThan(0)
    await withIdentity(h.app, identity('owner-b'), 'rest-b', async client => {
      expect((await client.query('SELECT count(*)::int AS n FROM llenamos.staff_time_entries')).rows[0].n).toBe(0)
    })
    await expect(withIdentity(h.app, identity('owner-b'), 'rest-b', client => client.query(`INSERT INTO llenamos.staff_pins(restaurant_id,location_id,id,doc) VALUES('rest-a','centro','x','{}')`))).rejects.toThrow(/row-level security/)
    // El rol de ejecución no puede reescribir el libro de auditoría: solo quitar la identidad pasado el plazo (021).
    await expect(withIdentity(h.app, identity('owner-a'), 'rest-a', client => client.query('UPDATE llenamos.staff_time_entry_events SET doc=doc'))).rejects.toThrow(/solo admite anonimizar/)
    await expect(withIdentity(h.app, identity('owner-a'), 'rest-a', client => client.query('DELETE FROM llenamos.staff_time_entry_events'))).rejects.toThrow(/permission denied/)
  })

  it('el aislamiento SQL de B no ve los fichajes de A aunque pida su id', async () => {
    const own = (await h.admin.query("SELECT id FROM llenamos.staff_time_entries LIMIT 1")).rows[0].id
    at(T(11, 0, 11))
    const stolen = await h.call('anularFichaje', { ...h.mutation('b'), entryId: own, expectedRevision: 1, reason: 'robo' }, 'owner-b')
    // Para B ese fichaje no existe: RLS no deja ni confirmar que está en otro restaurante.
    expect(stolen.status).toBe(404)
    expect((await h.admin.query('SELECT doc->>\'status\' AS s FROM llenamos.staff_time_entries WHERE id=$1', [own])).rows[0].s).not.toBe('voided')
  })

  it('fichaje manual, solapes, cierre del olvidado y anulación liberan el bloqueo de fichaje abierto', async () => {
    at(T(9, 0, 12))
    const manual = await h.ok('crearFichajeManual', { ...h.mutation(), uid: 'berta-a', startAt: T(8, 0, 12), endAt: T(8, 45, 12), breaks: [], reason: 'Olvidó fichar' }, 'manager-a')
    expect(manual.workedMinutes).toBe(45)
    const overlap = await h.call('crearFichajeManual', { ...h.mutation(), uid: 'berta-a', startAt: T(8, 30, 12), endAt: T(8, 50, 12), breaks: [], reason: 'Solape' }, 'manager-a')
    expect(overlap.status).toBe(412)
    expect((await h.call('crearFichajeManual', { ...h.mutation(), uid: 'owner-b', startAt: T(7, 0, 12), endAt: T(7, 30, 12), breaks: [], reason: 'Otra casa' }, 'manager-a')).status).toBe(412)
    // Fichaje que se queda abierto: lo marca el proceso y lo cierra un encargado.
    at(T(9, 5, 12))
    const opened = await h.ok('fichar', { ...h.mutation(), action: 'in', note: null }, 'berta-a')
    at(T(23, 0, 12))
    const reviewed = await withIdentity(h.app, identity('owner-a'), 'rest-a', client => reviewOpenEntries(client, h.scope(), T(23, 0, 12)))
    expect(reviewed.marked).toBe(1)
    expect((await h.admin.query('SELECT doc->>\'forgotten\' AS f FROM llenamos.staff_time_entries WHERE id=$1', [opened.entryId])).rows[0].f).toBe('true')
    expect((await withIdentity(h.app, identity('owner-a'), 'rest-a', client => reviewOpenEntries(client, h.scope(), T(23, 5, 12)))).marked).toBe(0)
    const closed = await h.ok('cerrarFichajeOlvidado', { ...h.mutation(), entryId: opened.entryId, expectedRevision: 2, endAt: T(17, 0, 12), reason: 'Salió a las cinco' }, 'manager-a')
    expect(closed.workedMinutes).toBe(475)
    expect((await h.admin.query("SELECT count(*)::int AS n FROM llenamos.staff_clock_locks WHERE uid='berta-a'")).rows[0].n).toBe(0)
    const voided = await h.ok('anularFichaje', { ...h.mutation(), entryId: opened.entryId, expectedRevision: 3, reason: 'Duplicado' }, 'manager-a')
    expect(voided.ok).toBe(true)
    expect((await h.call('anularFichaje', { ...h.mutation(), entryId: opened.entryId, expectedRevision: 4, reason: 'Otra vez' }, 'manager-a')).status).toBe(412)
  })

  it('puesto de fichaje: el PIN erróneo cuenta el intento aunque falle, se bloquea y el correcto ficha', async () => {
    at(T(12))
    const settings = { ...core.defaultStaffSettings(), kioskEnabled: true }
    await h.ok('guardarConfiguracionPersonal', { ...h.mutation(), settings }, 'manager-a')
    expect((await h.call('ficharEnPuesto', { ...h.mutation(), uid: 'ana-a', pin: '1234', action: 'in' }, 'manager-a')).status).toBe(412)
    await h.ok('guardarPinFichaje', { ...h.mutation(), uid: 'ana-a', pin: '4321' }, 'manager-a')
    const wrong = await h.call('ficharEnPuesto', { ...h.mutation(), uid: 'ana-a', pin: '1111', action: 'in' }, 'manager-a')
    expect(wrong.status).toBe(403)
    expect(wrong.body.error.message).toMatch(/PIN incorrecto/)
    expect((await h.admin.query("SELECT doc->>'failedAttempts' AS attempts FROM llenamos.staff_pins WHERE id='ana-a'")).rows[0].attempts).toBe('1')
    expect((await h.admin.query("SELECT count(*)::int AS n FROM llenamos.staff_time_entries WHERE doc->>'status'='open' AND uid='ana-a'")).rows[0].n).toBe(0)
    const good = await h.call('ficharEnPuesto', { ...h.mutation(), uid: 'ana-a', pin: '4321', action: 'in' }, 'manager-a')
    expect(good.status, JSON.stringify(good.body)).toBe(200)
    expect(good.body.result.state).toBe('working')
    for (let i = 0; i < 6; i++) await h.call('ficharEnPuesto', { ...h.mutation(), uid: 'ana-a', pin: '0000', action: 'out' }, 'manager-a')
    const locked = await h.call('ficharEnPuesto', { ...h.mutation(), uid: 'ana-a', pin: '4321', action: 'out' }, 'manager-a')
    expect(locked.status).toBe(403)
    expect(locked.body.error.message).toMatch(/Demasiados intentos/)
    // Alguien que no trabaja en este local no ficha en el puesto.
    expect((await h.call('ficharEnPuesto', { ...h.mutation(), uid: 'owner-b', pin: '4321', action: 'in' }, 'manager-a')).status).toBe(412)
  })

  it('cuadrante: solapes, revisión, publicar, copiar semana y turnos publicados para quien no gestiona', async () => {
    at(T(10, 0, 8))
    const mk = (uid: string, day: number, from: number, to: number, extra: object = {}) =>
      h.call('guardarTurno', { ...h.mutation(), shiftId: null, expectedRevision: null, shift: { uid, startAt: T(from, 0, day), endAt: T(to, 0, day), position: 'Sala', note: '' }, ...extra }, 'manager-a')
    const a = await mk('ana-a', 15, 12, 20)
    expect(a.status, JSON.stringify(a.body)).toBe(200)
    expect((await mk('ana-a', 15, 18, 22)).status).toBe(412)
    const b = await mk('berta-a', 16, 12, 20)
    expect(b.status).toBe(200)
    const long = await mk('ana-a', 16, 12, 20)
    expect(long.status).toBe(200)
    const stale = await h.call('borrarTurno', { ...h.mutation(), shiftId: a.body.result.shiftId, expectedRevision: 9 }, 'manager-a')
    expect(stale.status).toBe(412)
    const published = await h.ok('publicarCuadrante', { ...h.mutation(), weekStart: '2026-06-15', publish: true }, 'manager-a')
    expect(published.shifts).toBe(3)
    const copy = await h.ok('copiarSemanaCuadrante', { ...h.mutation(), fromWeekStart: '2026-06-15', toWeekStart: '2026-06-22' }, 'manager-a')
    expect(copy.copied).toBe(3)
    const copyAgain = await h.ok('copiarSemanaCuadrante', { ...h.mutation(), fromWeekStart: '2026-06-15', toWeekStart: '2026-06-22' }, 'manager-a')
    expect(copyAgain.copied).toBe(0)
    expect(copyAgain.skipped).toHaveLength(3)
    expect((await h.admin.query("SELECT count(*)::int AS n FROM llenamos.staff_shifts WHERE week_start='2026-06-22' AND status='draft'")).rows[0].n).toBe(3)
    const gone = await h.ok('borrarTurno', { ...h.mutation(), shiftId: b.body.result.shiftId, expectedRevision: 2 }, 'manager-a')
    expect(gone.ok).toBe(true)
  })

  it('horas para propinas: la caja sale de la tabla real de caja (009), con aislamiento y sin puerto simulado', async () => {
    at(T(20, 0, 13))
    registerCashWindowSource(null)
    const absent = await h.call('horasParaPropinas', { ...h.scope(), cashSessionId: 'caja1' }, 'manager-a')
    expect(absent.status).toBe(404)
    await h.ok('crearFichajeManual', { ...h.mutation(), uid: 'berta-a', startAt: T(16, 0, 13), endAt: T(19, 30, 13), breaks: [], reason: 'Prueba' }, 'manager-a')
    const session = core.CashSessionSchema.parse({ registerId: 'principal', status: 'closed', openingCents: 0, openedAt: T(17, 0, 13), openedBy: 'x', closedAt: T(19, 0, 13), closedBy: 'x', countedCents: 0, expectedCents: 0, differenceCents: 0, closeReason: null })
    await h.admin.query("INSERT INTO llenamos.pos_cash_sessions(restaurant_id,location_id,id,register_id,status,opened_at,data) VALUES('rest-a','centro','caja1','principal','closed',to_timestamp($1/1000.0),$2)", [session.openedAt, session])
    const hours = await h.ok('horasParaPropinas', { ...h.scope(), cashSessionId: 'caja1' }, 'manager-a')
    expect(hours.hours).toEqual([{ uid: 'berta-a', minutes: 120 }])
    expect((await h.call('horasParaPropinas', { ...h.scope(), cashSessionId: 'caja1' }, 'kitchen-a')).status).toBe(403)
    // Otro restaurante: ni con su propio alcance ve la caja de A, ni con el de A tiene permiso.
    expect((await h.call('horasParaPropinas', { ...h.scope('b'), cashSessionId: 'caja1' }, 'owner-b')).status).toBe(404)
    expect((await h.call('horasParaPropinas', { ...h.scope('a'), cashSessionId: 'caja1' }, 'owner-b')).status).toBe(403)
  })

  it('lecturas en vivo: foto acotada, permisos por rol y aislamiento', async () => {
    at(T(21, 0, 13))
    const live = (name: string) => MODULES.find(m => m.name === 'personal')!.liveQueries!.find(q => q.name === name)!
    const snap = (name: string, input: unknown, uid: string, _v = '') => withIdentity(h.app, identity(uid), (input as { restaurantId: string }).restaurantId, client => live(name).snapshot(client, input, { uid }) as Promise<any>)
    const entries = await snap('personalFichajes', { ...h.scope(), from: '2026-06-10', to: '2026-06-13', uid: null }, 'manager-a', 'b')
    expect(entries.entries.length).toBeGreaterThanOrEqual(3)
    await expect(snap('personalFichajes', { ...h.scope(), from: '2026-06-10', to: '2026-06-13', uid: null }, 'ana-a', 'd')).rejects.toMatchObject({ status: 403 })
    const mine = await snap('personalFichajes', { ...h.scope(), from: '2026-06-10', to: '2026-06-13', uid: 'ana-a' }, 'ana-a', 'd')
    expect(mine.entries.length).toBeGreaterThan(0)
    expect(mine.entries.every((e: { uid: string }) => e.uid === 'ana-a')).toBe(true)
    await expect(snap('personalFichajes', { ...h.scope(), from: '2020-01-01', to: '2026-06-13', uid: null }, 'manager-a', 'b')).rejects.toMatchObject({ status: 403 })
    const week = await snap('personalTurnos', { ...h.scope(), weekStart: '2026-06-22', onlyPublished: false }, 'ana-a', 'd')
    expect(week.shifts).toEqual([])
    const published = await snap('personalTurnos', { ...h.scope(), weekStart: '2026-06-15', onlyPublished: false }, 'ana-a', 'd')
    expect(published.shifts).toHaveLength(2)
    expect(published.shifts.every((s: { status: string }) => s.status === 'published')).toBe(true)
    expect(live('personalTurnos').topics({})).toContain('personal.turno')
    await expect(snap('personalAjustes', h.scope(), 'ana-a', 'd')).rejects.toMatchObject({ status: 403 })
    expect((await snap('personalAjustes', h.scope(), 'manager-a', 'b')).settings.kioskEnabled).toBe(true)
    await expect(snap('personalFichajesAbiertos', h.scope('b'), 'manager-a', 'b')).rejects.toMatchObject({ status: 403 })
    expect(ids(entries.entries).length).toBeGreaterThanOrEqual(3)
    const events = await snap('personalEventosFichaje', { ...h.scope(), entryId: entries.entries[0].id }, 'manager-a', 'b')
    expect(events.events.length).toBeGreaterThanOrEqual(1)
    expect(events.events.every((e: { entryId: string }) => e.entryId === entries.entries[0].id)).toBe(true)
    await expect(snap('personalEventosFichaje', { ...h.scope(), entryId: entries.entries[0].id }, 'ana-a')).rejects.toMatchObject({ status: 403 })
  })

  it('el PIN no queda en idempotency, usa scrypt y el bloqueo crece con cada tanda de fallos', async () => {
    at(T(12, 0, 15))
    await h.ok('guardarPinFichaje', { ...h.mutation(), uid: 'berta-a', pin: '246810' }, 'manager-a')
    await h.call('ficharEnPuesto', { ...h.mutation(), uid: 'berta-a', pin: '246810', action: 'in' }, 'manager-a')
    expect((await h.admin.query("SELECT count(*)::int AS n FROM llenamos.idempotency WHERE operation IN ('ficharEnPuesto','guardarPinFichaje')")).rows[0].n).toBe(0)
    // La huella es de scrypt (no el sha256 de una pasada de core) y no coincide con ninguna huella barata del PIN.
    const doc = (await h.admin.query("SELECT doc FROM llenamos.staff_pins WHERE id='berta-a'")).rows[0].doc
    expect(doc.pinHash).toMatch(/^[0-9a-f]{64}$/)
    expect(doc.pinHash).not.toBe(core.pinHash('246810', 'berta-a', doc.salt))
    await h.ok('fichar', { ...h.mutation(), action: 'out', note: null }, 'berta-a')
    // Cinco fallos bloquean 5 minutos; pasado ese tiempo, otros cinco bloquean 10.
    const wrong = () => h.call('ficharEnPuesto', { ...h.mutation(), uid: 'berta-a', pin: '000000', action: 'in' }, 'manager-a')
    for (let i = 0; i < 5; i++) await wrong()
    const first = (await h.admin.query("SELECT (doc->>'lockedUntil')::bigint AS u, doc->>'lockRounds' AS r FROM llenamos.staff_pins WHERE id='berta-a'")).rows[0]
    expect(Number(first.u) - now).toBe(5 * 60_000)
    at(now + 6 * 60_000)
    for (let i = 0; i < 5; i++) await wrong()
    const second = (await h.admin.query("SELECT (doc->>'lockedUntil')::bigint AS u, doc->>'lockRounds' AS r FROM llenamos.staff_pins WHERE id='berta-a'")).rows[0]
    expect(Number(second.u) - now).toBe(10 * 60_000)
    expect(second.r).toBe('2')
    // El PIN correcto, ya sin bloqueo, reinicia todo.
    at(now + 11 * 60_000)
    expect((await h.call('ficharEnPuesto', { ...h.mutation(), uid: 'berta-a', pin: '246810', action: 'in' }, 'manager-a')).status).toBe(200)
    expect((await h.admin.query("SELECT doc->>'lockRounds' AS r, doc->>'failedAttempts' AS f FROM llenamos.staff_pins WHERE id='berta-a'")).rows[0]).toEqual({ r: '0', f: '0' })
  })

  it('puesto de fichaje: persona de baja, de otro local o de otro restaurante, y PIN erróneos en paralelo', async () => {
    at(T(9, 0, 16))
    await h.ok('guardarConfiguracionPersonal', { ...h.mutation(), settings: { ...core.defaultStaffSettings(), kioskEnabled: true } }, 'manager-a')
    await h.ok('guardarPinFichaje', { ...h.mutation(), uid: 'waiter-a', pin: '1357' }, 'manager-a')
    // «inactive-a» está de baja y «limited-a» solo trabaja en el local «otro»: no son del puesto del centro.
    for (const uid of ['inactive-a', 'limited-a', 'owner-b']) {
      const r = await h.call('guardarPinFichaje', { ...h.mutation(), uid, pin: '1357' }, 'manager-a')
      expect([uid, r.status]).toEqual([uid, 412])
      expect((await h.call('ficharEnPuesto', { ...h.mutation(), uid, pin: '1357', action: 'in' }, 'manager-a')).status).toBe(412)
    }
    expect(Number((await h.admin.query("SELECT count(*) AS n FROM llenamos.staff_pins WHERE id IN ('inactive-a','limited-a','owner-b')")).rows[0].n)).toBe(0)
    // Diez intentos erróneos a la vez: el cerrojo los ordena, el contador no se pierde y queda bloqueado.
    const results = await Promise.all(Array.from({ length: 10 }, () => h.call('ficharEnPuesto', { ...h.mutation(), uid: 'waiter-a', pin: '9999', action: 'in' }, 'manager-a')))
    expect(results.every(r => r.status === 403)).toBe(true)
    expect(results.filter(r => /PIN incorrecto/.test(r.body.error.message))).toHaveLength(4)
    expect(results.filter(r => /Demasiados intentos/.test(r.body.error.message))).toHaveLength(6)
    const pin = (await h.admin.query("SELECT doc FROM llenamos.staff_pins WHERE id='waiter-a'")).rows[0].doc
    expect(pin.lockedUntil).toBe(now + 5 * 60_000)
    expect((await h.call('ficharEnPuesto', { ...h.mutation(), uid: 'waiter-a', pin: '1357', action: 'in' }, 'manager-a')).body.error.message).toMatch(/Demasiados intentos/)
  })

  it('fase4_local_members solo devuelve uid, nombre y rol a quien tiene acceso a ese local', async () => {
    const ok = await withIdentity(h.app, identity('manager-a'), 'rest-a', c => c.query('SELECT * FROM llenamos.fase4_local_members($1,$2)', ['rest-a', 'centro']))
    expect(ok.fields.map(f => f.name)).toEqual(['uid', 'display_name', 'role'])
    expect(ok.rows.map(r => r.uid)).toEqual(expect.arrayContaining(['ana-a', 'berta-a', 'manager-a']))
    expect(ok.rows.map(r => r.uid)).not.toContain('limited-a')
    // Un miembro de otro restaurante no ve nada de este, ni aunque nombre su id.
    const other = await withIdentity(h.app, identity('owner-b'), 'rest-b', c => c.query('SELECT * FROM llenamos.fase4_local_members($1,$2)', ['rest-a', 'centro']))
    expect(other.rows).toEqual([])
    // Alguien limitado al local «otro» no ve las personas del centro.
    const limited = await withIdentity(h.app, identity('limited-a'), 'rest-a', c => c.query('SELECT * FROM llenamos.fase4_local_members($1,$2)', ['rest-a', 'centro']))
    expect(limited.rows).toEqual([])
  })

  it('el worker, sin identidad de miembro, revisa fichajes olvidados y reprograma el siguiente pase', async () => {
    const handlers = new Map(MODULES.find(m => m.name === 'personal')!.workerHandlers)
    const handler = handlers.get('personal.revisar_fichajes')!
    expect(handler).toBeTypeOf('function')
    at(T(8, 0, 17))
    await h.ok('fichar', { ...h.mutation(), action: 'in', note: null }, 'bar-a')
    const jobs = (await h.admin.query("SELECT payload,scheduled_at FROM llenamos.jobs WHERE kind='personal.revisar_fichajes' AND restaurant_id='rest-a' ORDER BY scheduled_at DESC")).rows
    expect(jobs.length).toBeGreaterThanOrEqual(1)
    expect(jobs[0].payload).toEqual({ locationId: 'centro' })
    expect(jobs[0].scheduled_at.getTime()).toBeGreaterThan(now)
    // Mismo ranura: otra entrada no duplica el trabajo.
    await h.ok('fichar', { ...h.mutation(), action: 'out', note: null }, 'bar-a')
    await h.ok('fichar', { ...h.mutation(), action: 'in', note: null }, 'bar-a')
    expect((await h.admin.query("SELECT count(*)::int AS n FROM llenamos.jobs WHERE kind='personal.revisar_fichajes' AND scheduled_at=$1", [jobs[0].scheduled_at])).rows[0].n).toBe(1)
    const later = T(23, 0, 17)
    await handler(await h.workerContext('rest-a', 'personal.revisar_fichajes', { locationId: 'centro' }, later))
    const entry = (await h.admin.query("SELECT doc FROM llenamos.staff_time_entries WHERE uid='bar-a' AND status='open'")).rows[0].doc
    expect(entry.forgotten).toBe(true)
    const note = (await h.admin.query("SELECT summary,actor_uid FROM llenamos.fase4_activity WHERE action='staff.entry_forgotten' AND details->>'uid'='bar-a' ORDER BY id DESC LIMIT 1")).rows[0]
    expect(note).toEqual({ summary: 'Fichaje sin cerrar de Persona bar-a.', actor_uid: null })
    expect((await h.admin.query("SELECT count(*)::int AS n FROM llenamos.jobs WHERE kind='personal.revisar_fichajes' AND scheduled_at>$1", [new Date(later)])).rows[0].n).toBe(1)
    // El worker acotado a B no toca nada de A.
    const none = await handler(await h.workerContext('rest-b', 'personal.revisar_fichajes', { locationId: 'centro' }, later)).then(() => 'ok', (e: { status?: number }) => e.status)
    expect(none === 'ok' || none === 404).toBe(true)
    expect((await h.admin.query("SELECT doc->>'forgotten' AS f FROM llenamos.staff_time_entries WHERE uid='bar-a' AND status='open'")).rows[0].f).toBe('true')
  })

  it('el worker real reclama el trabajo sembrado por un fichaje y lo ejecuta con su manejador registrado', async () => {
    at(T(8, 0, 18))
    await h.ok('fichar', { ...h.mutation(), action: 'in', note: null }, 'waiter-a')
    const pending = (await h.admin.query("SELECT id FROM llenamos.jobs WHERE kind='personal.revisar_fichajes' AND status='pending' AND scheduled_at<now()")).rows
    expect(pending.length).toBeGreaterThanOrEqual(1)
    const worker = createWorker({ pool: await h.worker(), handlers: buildHandlers(MODULES), openCredentials: () => ({}), log: () => undefined })
    for (let i = 0; i < 6; i++) if (!await worker.runOnce()) break
    expect((await h.admin.query("SELECT doc->>'forgotten' AS f FROM llenamos.staff_time_entries WHERE uid='waiter-a' AND status='open'")).rows[0].f).toBe('true')
    expect((await h.admin.query("SELECT count(*)::int AS n FROM llenamos.jobs WHERE kind='personal.revisar_fichajes' AND status='done'")).rows[0].n).toBeGreaterThanOrEqual(1)
    // Sigue habiendo un pase futuro por local mientras haya fichajes abiertos.
    expect((await h.admin.query("SELECT count(*)::int AS n FROM llenamos.jobs WHERE kind='personal.revisar_fichajes' AND status='pending' AND scheduled_at>now() AND restaurant_id='rest-a'")).rows[0].n).toBe(1)
  })

  it('las lecturas completas fallan en vez de recortar en silencio', async () => {
    const live = MODULES.find(m => m.name === 'personal')!.liveQueries!.find(q => q.name === 'personalFichajes')!
    const input = { ...h.scope(), from: '2026-06-10', to: '2026-06-20', uid: null, max: 2 }
    const run = () => withIdentity(h.app, identity('manager-a'), 'rest-a', c => live.snapshot(c, input, { uid: 'manager-a' }))
    await expect(run()).rejects.toMatchObject({ status: 412 })
    expect(Number((await h.admin.query("SELECT count(*) AS n FROM llenamos.staff_time_entries WHERE entry_date BETWEEN '2026-06-09' AND '2026-06-20'")).rows[0].n)).toBeGreaterThan(2)
  })

  it('emite eventos de dominio sin datos personales en la misma transacción', async () => {
    const topics = (await h.admin.query('SELECT DISTINCT topic,payload FROM llenamos.events')).rows
    expect(topics.map(t => t.topic)).toEqual(expect.arrayContaining(['personal.fichaje', 'personal.turno']))
    expect(topics.length).toBeGreaterThanOrEqual(3)
    expect(topics.every(t => Object.keys(t.payload).length === 0)).toBe(true)
  })
})
