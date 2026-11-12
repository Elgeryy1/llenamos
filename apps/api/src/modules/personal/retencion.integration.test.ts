import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as core from '@llenamos/core'
import { MODULES } from '../index.js'
import { clock } from '../fase4/contexto.js'
import { withIdentity } from '../../database.js'
import { enabled, identity, startHarness, type Harness } from '../fase4/arnes.js'
import { anonymizeOldEntries, fechaLimite } from './retencion.js'
import { buildHandlers } from '../../worker/index.js'

const NOW = Date.UTC(2026, 10, 12, 9)
const T = (iso: string) => Date.parse(`${iso}T10:00:00Z`)
let h: Harness

async function seed(uid: string, date: string, id: string, extra: { rid?: string; status?: 'open'; shiftId?: string } = {}) {
  const rid = extra.rid ?? 'rest-a'
  const entry = core.TimeEntrySchema.parse({
    uid, date, startAt: T(date), endAt: extra.status ? null : T(date) + 4 * 3_600_000, breaks: [], status: extra.status ?? 'closed', startSource: 'self', endSource: extra.status ? null : 'self', shiftId: extra.shiftId ?? null,
    forgotten: !!extra.status, needsReview: false, workedMinutes: extra.status ? null : 240, breakMinutes: 0, note: 'Nota con nombre', revision: 1,
  })
  await h.admin.query('INSERT INTO llenamos.staff_time_entries(restaurant_id,location_id,id,doc) VALUES($1,$2,$3,$4)', [rid, 'centro', id, entry])
  const event = core.TimeEntryEventSchema.parse({ entryId: id, uid, kind: 'correction', at: T(date), by: 'manager-a', source: 'manager', reason: 'Motivo con nombre', before: null, after: null })
  await h.admin.query('INSERT INTO llenamos.staff_time_entry_events(restaurant_id,location_id,id,doc) VALUES($1,$2,$3,$4)', [rid, 'centro', `ev-${id}`, event])
}
async function seedShift(uid: string, date: string, id: string) {
  const shift = core.StaffShiftSchema.parse({ uid, startAt: T(date), endAt: T(date) + 6 * 3_600_000, position: 'Sala', note: 'Turno con nombre', date, weekStart: date, status: 'published', publishedAt: T(date), revision: 1 })
  await h.admin.query('INSERT INTO llenamos.staff_shifts(restaurant_id,location_id,id,doc) VALUES($1,$2,$3,$4)', ['rest-a', 'centro', id, shift])
}
const shiftDoc = async (id: string) => (await h.admin.query('SELECT doc FROM llenamos.staff_shifts WHERE id=$1', [id])).rows[0].doc
const entryDoc = async (id: string) => (await h.admin.query('SELECT doc FROM llenamos.staff_time_entries WHERE id=$1', [id])).rows[0].doc
const eventDoc = async (id: string) => (await h.admin.query('SELECT doc FROM llenamos.staff_time_entry_events WHERE id=$1', [`ev-${id}`])).rows[0].doc

describe.skipIf(!enabled)('Privacidad de los fichajes en PostgreSQL', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    h = await startHarness('retencion'); clock.now = () => NOW
    await seed('ana-a', '2021-03-01', 'viejo', { shiftId: 'turno-viejo' }); await seedShift('ana-a', '2021-03-01', 'turno-viejo'); await seedShift('ana-a', '2025-03-01', 'turno-reciente')
    await seed('berta-a', '2020-01-01', 'abierto-viejo', { status: 'open' }); await seed('berta-b', '2021-03-03', 'viejo-b', { rid: 'rest-b' })
    await seed('ana-a', '2025-03-01', 'reciente'); await seed('berta-a', '2021-03-02', 'viejo-berta')
    await h.admin.query("INSERT INTO llenamos.fase4_activity(restaurant_id,location_id,action,summary,details,actor_uid,actor_name,created_at) VALUES('rest-a','centro','staff.entry_created','Fichaje de Ana','{\"uid\":\"ana-a\"}','manager-a','Manager','2021-03-01'),('rest-a','centro','inventario.conteo','Recuento','{}','manager-a','Manager','2021-03-01')")
  }, 60_000)
  afterAll(async () => { clock.now = () => Date.now(); await h?.close() })

  it('la fecha límite deja un día de margen sobre los 4 años', () => {
    expect(fechaLimite(Date.UTC(2026, 10, 12))).toBe('2022-11-11')
  })

  it('exporta lo propio; lo de otra persona solo un encargado; otro restaurante y otro compañero, no', async () => {
    const mine = await h.ok('exportarMisFichajes', { ...h.scope(), uid: null }, 'ana-a')
    expect(mine).toMatchObject({ uid: 'ana-a', retentionYears: 4, generatedAt: NOW })
    expect(mine.entries.map((e: { id: string }) => e.id).sort()).toEqual(['reciente', 'viejo'])
    expect(mine.events).toHaveLength(2)
    expect(mine.entries.every((e: { uid: string }) => e.uid === 'ana-a')).toBe(true)
    expect((await h.call('exportarMisFichajes', { ...h.scope(), uid: 'ana-a' }, 'ana-a')).status).toBe(200)
    expect((await h.call('exportarMisFichajes', { ...h.scope(), uid: 'ana-a' }, 'berta-a')).status).toBe(403)
    expect((await h.call('exportarMisFichajes', { ...h.scope(), uid: 'ana-a' }, 'kitchen-a')).status).toBe(403)
    expect((await h.call('exportarMisFichajes', { ...h.scope(), uid: 'ana-a' }, 'owner-b')).status).toBe(403)
    const byManager = await h.call('exportarMisFichajes', { ...h.scope(), uid: 'ana-a' }, 'manager-a')
    expect(byManager.status).toBe(200)
    expect(byManager.body.result.entries).toHaveLength(2)
    // La exportación de otra persona deja rastro en la actividad; la propia no.
    expect((await h.admin.query("SELECT count(*)::int AS n FROM llenamos.fase4_activity WHERE action='staff.export_entries'")).rows[0].n).toBe(1)
    // Berta no ve lo de Ana por su propia exportación.
    const berta = await h.ok('exportarMisFichajes', { ...h.scope(), uid: null }, 'berta-a')
    expect(berta.entries.map((e: { id: string }) => e.id).sort()).toEqual(['abierto-viejo', 'viejo-berta'])
  })

  it('no se borra ni se anonimiza antes de tiempo: la base lo impide aunque falle la aplicación', async () => {
    const attempt = (sql: string, params: unknown[] = []) => withIdentity(h.app, identity('owner-a'), 'rest-a', c => c.query(sql, params)).then(() => 'ok', (e: { code?: string; message?: string }) => e.code ?? e.message)
    expect(await attempt("DELETE FROM llenamos.staff_time_entries WHERE id='viejo'")).toBe('42501')
    expect(await attempt("DELETE FROM llenamos.staff_time_entry_events WHERE id='ev-viejo'")).toBe('42501')
    expect(await attempt("UPDATE llenamos.staff_time_entries SET doc=doc||'{\"uid\":\"anonimizado\"}' WHERE id='reciente'")).toBe('42501')
    expect(await attempt("UPDATE llenamos.staff_time_entry_events SET doc=doc||'{\"uid\":\"anonimizado\",\"by\":\"anonimizado\"}' WHERE id='ev-reciente'")).toBe('42501')
    // Ni siquiera uno viejo puede cambiar otra cosa que la identidad.
    expect(await attempt("UPDATE llenamos.staff_time_entry_events SET doc=doc||'{\"kind\":\"void\",\"uid\":\"anonimizado\",\"by\":\"anonimizado\"}' WHERE id='ev-viejo'")).toBe('42501')
    expect((await entryDoc('reciente')).uid).toBe('ana-a')
    expect((await eventDoc('viejo')).kind).toBe('correction')
  })

  it('anonimiza lo que pasó el plazo, solo en su restaurante, y es idempotente', async () => {
    const run = (rid = 'rest-a', who = 'owner-a') => withIdentity(h.app, identity(who), rid, c => anonymizeOldEntries(c, { restaurantId: rid, locationId: 'centro' }, NOW))
    const first = await run()
    expect(first).toMatchObject({ entries: 3, events: 3, shifts: 1, activity: 1, remaining: 1 })
    expect(await entryDoc('viejo')).toMatchObject({ uid: 'anonimizado', note: null, shiftId: null, date: '2021-03-01', workedMinutes: 240 })
    // Un fichaje olvidado y abierto de hace años también pierde la persona.
    expect(await entryDoc('abierto-viejo')).toMatchObject({ uid: 'anonimizado', note: null, status: 'open' })
    // El turno ya no lleva a la persona ni por el fichaje ni por sí mismo; el reciente se queda.
    expect(await shiftDoc('turno-viejo')).toMatchObject({ uid: 'anonimizado', note: null, position: 'Sala' })
    expect(await shiftDoc('turno-reciente')).toMatchObject({ uid: 'ana-a', note: 'Turno con nombre' })
    // Otro restaurante: no se toca (ni con la identidad de su propietario pidiendo el local ajeno).
    expect((await entryDoc('viejo-b')).uid).toBe('berta-b')
    await expect(withIdentity(h.app, identity('owner-b'), 'rest-b', c => anonymizeOldEntries(c, { restaurantId: 'rest-a', locationId: 'centro' }, NOW))).resolves.toMatchObject({ entries: 0, events: 0, shifts: 0, activity: 0 })
    expect((await entryDoc('reciente')).uid).toBe('ana-a')
    expect(await eventDoc('viejo')).toMatchObject({ uid: 'anonimizado', by: 'anonimizado', reason: 'anonimizado', kind: 'correction' })
    expect(await entryDoc('reciente')).toMatchObject({ uid: 'ana-a', note: 'Nota con nombre' })
    expect((await eventDoc('reciente')).by).toBe('manager-a')
    // La fila de actividad de personal pierde nombres; la de inventario no es de personal y queda igual.
    const act = (await h.admin.query("SELECT action,summary,actor_uid,details FROM llenamos.fase4_activity WHERE action IN ('staff.entry_created','inventario.conteo') ORDER BY action")).rows
    expect(act).toMatchObject([{ action: 'inventario.conteo', summary: 'Recuento', actor_uid: 'manager-a' }, { action: 'staff.entry_created', summary: 'Registro anonimizado.', actor_uid: null, details: {} }])
    expect(await run()).toMatchObject({ entries: 0, events: 0, shifts: 0, activity: 0, remaining: 1 })
    // El rest-b se anonimiza solo con su propio pase.
    expect(await run('rest-b', 'owner-b')).toMatchObject({ entries: 1 })
    expect((await entryDoc('viejo-b')).uid).toBe('anonimizado')
    // La exportación de Ana ya no incluye lo anonimizado: la persona dejó de ser identificable.
    const mine = await h.ok('exportarMisFichajes', { ...h.scope(), uid: null }, 'ana-a')
    expect(mine.entries.map((e: { id: string }) => e.id)).toEqual(['reciente'])
    // Un fichaje anonimizado no se vuelve a atribuir.
    const back = await withIdentity(h.app, identity('owner-a'), 'rest-a', c => c.query("UPDATE llenamos.staff_time_entries SET doc=doc||'{\"uid\":\"ana-a\"}' WHERE id='viejo'")).then(() => 'ok', (e: { code?: string }) => e.code)
    expect(back).toBe('42501')
  })

  it('el trabajo del worker anonimiza, avisa a las pantallas y se reprograma mientras queden fichajes atribuidos', async () => {
    await seed('ana-a', '2020-05-05', 'viejo-2')
    await h.admin.query("DELETE FROM llenamos.events WHERE topic='personal.fichaje'")
    const handler = buildHandlers(MODULES).get('personal.anonimizar_fichajes')![0]!
    expect(handler).toBeTruthy()
    await handler(await h.workerContext('rest-a', 'personal.anonimizar_fichajes', { locationId: 'centro' }, NOW))
    expect((await entryDoc('viejo-2')).uid).toBe('anonimizado')
    expect((await h.admin.query("SELECT count(*)::int AS n FROM llenamos.events WHERE topic='personal.fichaje' AND restaurant_id='rest-a'")).rows[0].n).toBe(1)
    expect((await h.admin.query("SELECT count(*)::int AS n FROM llenamos.jobs WHERE kind='personal.anonimizar_fichajes' AND restaurant_id='rest-a'")).rows[0].n).toBe(1)
  })

  it('sigue anonimizando aunque el restaurante haya perdido el módulo o la suscripción', async () => {
    await seed('ana-a', '2019-02-02', 'viejo-baja')
    await h.admin.query("UPDATE llenamos.restaurants SET active_modules=ARRAY['reservations'], access_valid_until=now()-interval '1 day', entitlement_version=1 WHERE id='rest-a'")
    await h.admin.query("DELETE FROM llenamos.jobs WHERE kind='personal.anonimizar_fichajes'")
    const handler = buildHandlers(MODULES).get('personal.anonimizar_fichajes')![0]!
    await handler(await h.workerContext('rest-a', 'personal.anonimizar_fichajes', { locationId: 'centro' }, NOW))
    expect((await entryDoc('viejo-baja')).uid).toBe('anonimizado')
    // Quedan fichajes recientes atribuidos: el trabajo sigue vivo para el día siguiente.
    expect((await h.admin.query("SELECT count(*)::int AS n FROM llenamos.jobs WHERE kind='personal.anonimizar_fichajes' AND restaurant_id='rest-a'")).rows[0].n).toBe(1)
    await h.admin.query("UPDATE llenamos.restaurants SET active_modules=ARRAY['reservations','floor','kitchen','pos','staff','inventory'], access_valid_until=NULL, entitlement_version=NULL WHERE id='rest-a'")
  })

  it('fichar y crear un fichaje a mano programan, cada uno por su lado, el pase de anonimización del local', async () => {
    clock.now = () => NOW
    const jobs = async () => (await h.admin.query("SELECT count(*)::int AS n FROM llenamos.jobs WHERE kind='personal.anonimizar_fichajes' AND restaurant_id='rest-a'")).rows[0].n
    await h.admin.query("DELETE FROM llenamos.jobs WHERE kind='personal.anonimizar_fichajes'")
    expect(await jobs()).toBe(0)
    await h.ok('fichar', { ...h.mutation(), action: 'in', note: null }, 'bar-a')
    expect(await jobs()).toBe(1)
    await h.ok('fichar', { ...h.mutation(), action: 'out', note: null }, 'bar-a')
    await h.admin.query("DELETE FROM llenamos.jobs WHERE kind='personal.anonimizar_fichajes'")
    const manual = await h.call('crearFichajeManual', { ...h.mutation(), uid: 'ana-a', startAt: NOW - 30 * 3_600_000, endAt: NOW - 26 * 3_600_000, breaks: [], reason: 'Olvidó fichar' }, 'manager-a')
    expect(manual.status, JSON.stringify(manual.body)).toBe(200)
    expect(await jobs()).toBe(1)
  })

  it('la actividad es de solo añadir: solo la de personal con más de 4 años admite anonimizarse, y solo así', async () => {
    const attempt = (sql: string, params: unknown[] = []) => withIdentity(h.app, identity('owner-a'), 'rest-a', c => c.query(sql, params)).then(() => 'ok', (e: { code?: string; message?: string }) => e.code ?? e.message)
    await h.admin.query("INSERT INTO llenamos.fase4_activity(restaurant_id,location_id,action,summary,details,actor_uid,actor_name,created_at) VALUES('rest-a','centro','staff.export_entries','Exportación reciente','{}','manager-a','M',now()),('rest-a','centro','inventario.ajuste','Ajuste de stock','{}','manager-a','M','2020-01-01')")
    const anon = "SET actor_uid=NULL, actor_name=NULL, summary='Registro anonimizado.', details='{}'"
    // Reciente y de personal: no. Vieja pero de inventario: no. Reescribir el texto de una vieja de personal: tampoco.
    expect(await attempt(`UPDATE llenamos.fase4_activity ${anon} WHERE action='staff.export_entries'`)).toBe('42501')
    expect(await attempt(`UPDATE llenamos.fase4_activity ${anon} WHERE action='inventario.ajuste'`)).toBe('42501')
    expect(await attempt("UPDATE llenamos.fase4_activity SET summary='Otra cosa' WHERE action='retention.entries_anonymized'")).toBe('42501')
    await h.admin.query("INSERT INTO llenamos.fase4_activity(restaurant_id,location_id,action,summary,details,actor_uid,actor_name,created_at) VALUES('rest-a','centro','staff.shift_saved','Turno de Ana','{\"uid\":\"ana-a\"}','manager-a','M','2020-01-01')")
    expect(await attempt("UPDATE llenamos.fase4_activity SET summary='Reescrito' WHERE action='staff.shift_saved'")).toBe('42501')
    expect(await attempt(`UPDATE llenamos.fase4_activity ${anon} WHERE action='staff.shift_saved'`)).toBe('ok')
    expect(await attempt('DELETE FROM llenamos.fase4_activity')).toMatch(/permission denied|42501/)
    expect((await h.admin.query("SELECT summary FROM llenamos.fase4_activity WHERE summary IN ('Ajuste de stock','Exportación reciente','Registro anonimizado.') AND action IN ('inventario.ajuste','staff.export_entries') ORDER BY action")).rows.map(r => r.summary)).toEqual(['Ajuste de stock', 'Exportación reciente'])
  })

  it('un turno no se anonimiza antes de plazo ni se vuelve a atribuir', async () => {
    const attempt = (sql: string) => withIdentity(h.app, identity('owner-a'), 'rest-a', c => c.query(sql)).then(() => 'ok', (e: { code?: string }) => e.code)
    expect(await attempt("UPDATE llenamos.staff_shifts SET doc=doc||'{\"uid\":\"anonimizado\"}' WHERE id='turno-reciente'")).toBe('42501')
    expect(await attempt("UPDATE llenamos.staff_shifts SET doc=doc||'{\"uid\":\"ana-a\"}' WHERE id='turno-viejo'")).toBe('42501')
  })
})
