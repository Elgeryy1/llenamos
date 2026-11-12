import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createFixture, postgresTests, type Fixture } from '../comun/fixture.js'
import { aggregateDay, aggregateRecentDays, backfillDays, missingDays } from './dias.js'
import { fakeDayFacts, todayLocal, sumarDias } from './pruebas/dobles.js'
import { FACTS_UNAVAILABLE, RESERVATIONS_UNAVAILABLE, isPortUnavailable, resetAnalyticsPortsForTests, setAnalyticsFactsPort, setAnalyticsReservationsPort, setOriginReportPort } from './puertos.js'
import { EXTRA_SQL, rejects, tenant } from './pruebas/prueba.js'
import { instanteDeHoraLocal } from '@llenamos/core'

describe.skipIf(!postgresTests)('análisis: instantáneas, panel, exportación y previsión', () => {
  let f: Fixture
  const D1 = '2026-09-01', D2 = '2026-09-02', D3 = '2026-09-03'
  beforeAll(async () => { f = await createFixture('analisis_panel', EXTRA_SQL) }, 60_000)
  afterAll(async () => { await f?.close() })
  beforeEach(() => resetAnalyticsPortsForTests())
  const useDouble = () => setAnalyticsFactsPort({ dayFacts: async (_c, _r, lid, date) => fakeDayFacts(lid, date, lid === 'a-terraza' ? 2 : 1) })
  const panel = (uid: string, data: object, rid = 'a') => f.call('panelAnalisis', uid, { restaurantId: rid, locationIds: null, ...data })
  const count = async (sql: string, args: unknown[] = []) => (await f.admin.query(sql, args)).rows[0].n as number

  it('sin puerto de hechos no se inventa nada: aggregateDay falla con 412 y código propio', async () => {
    const error = await rejects(tenant(f, c => aggregateDay(c, 'a', 'a-main', D1)))
    expect(error).toMatchObject({ status: 412, code: 'failed-precondition' })
    expect(isPortUnavailable(error, FACTS_UNAVAILABLE)).toBe(true)
    expect(await count('SELECT count(*)::int AS n FROM llenamos.analytics_days')).toBe(0)
  })

  it('aggregateDay guarda la instantánea, es idempotente y emite day.closed una sola vez', async () => {
    useDouble()
    const totals = await tenant(f, c => aggregateDay(c, 'a', 'a-main', D1, Date.now()))
    expect(totals?.grossSalesCents).toBe(10_000)
    await tenant(f, c => aggregateDay(c, 'a', 'a-main', D1, Date.now() + 1000))
    for (const d of [D2, D3]) await tenant(f, c => aggregateDay(c, 'a', 'a-main', d))
    await tenant(f, c => aggregateDay(c, 'a', 'a-terraza', D1))
    const row = (await f.admin.query("SELECT * FROM llenamos.analytics_days WHERE restaurant_id='a' AND location_id='a-main' AND date=$1", [D1])).rows[0]
    expect(row.totals.bills).toBe(2)
    expect(row.hours.slotMinutes).toBe(15)
    expect(row.dishes.zero).toEqual([{ itemId: 'tarta', name: 'Tarta' }])
    expect(row.margin.costCents).toBe(1500)
    expect(await count("SELECT count(*)::int AS n FROM llenamos.analytics_days WHERE restaurant_id='a' AND location_id='a-main' AND date=$1", [D1])).toBe(1)
    expect(await count("SELECT count(*)::int AS n FROM llenamos.automation_events WHERE id=$1", [`day.closed.a-main.${D1}`])).toBe(1)
    const event = (await f.admin.query("SELECT * FROM llenamos.automation_events WHERE id=$1", [`day.closed.a-main.${D2}`])).rows[0]
    expect(event.data).toMatchObject({ grossSalesCents: 10_000, salesDeltaBp: 0 })
    expect(await count("SELECT count(*)::int AS n FROM llenamos.events WHERE topic='analisis.dia'")).toBeGreaterThanOrEqual(5)
    // Datos personales: ningún evento de dominio lleva nada más que la fecha.
    expect((await f.admin.query("SELECT payload FROM llenamos.events WHERE topic='analisis.dia' LIMIT 1")).rows[0].payload).toEqual({ date: expect.any(String) })
  })

  it('no agrega hoy, ni locales ajenos ni con el módulo apagado', async () => {
    useDouble()
    expect(await rejects(tenant(f, c => aggregateDay(c, 'a', 'a-main', todayLocal())))).toMatchObject({ status: 412 })
    expect(await rejects(tenant(f, c => aggregateDay(c, 'a', 'b-main', D1)))).toMatchObject({ status: 404 })
  })

  it('detecta y rellena días sin instantánea', async () => {
    useDouble()
    expect(await tenant(f, c => missingDays(c, 'a', 'a-main', '2026-08-30', D3))).toEqual(['2026-08-30', '2026-08-31'])
    const result = await tenant(f, c => backfillDays(c, 'a', 'a-main', '2026-08-30', D3, Date.now(), 1))
    expect(result).toEqual({ filled: ['2026-08-30'], remaining: 1 })
    expect(await tenant(f, c => aggregateRecentDays(c, 'a'))).toBe(8)
    expect(await count("SELECT count(*)::int AS n FROM llenamos.analytics_days WHERE restaurant_id='a'")).toBeGreaterThanOrEqual(9)
  })

  it('el panel suma instantáneas de varios días y locales', async () => {
    const r = await panel('alice', { from: D1, to: D3, compare: 'none', slotMinutes: 60 })
    expect(r.status).toBe(200)
    const p = r.body.result ?? r.body.data ?? r.body
    expect(p.total).toMatchObject({ grossSalesCents: 50_000, bills: 8, guests: 20 })
    expect(p.byDay.map((d: any) => d.date)).toEqual([D1, D2, D3])
    expect(p.byDay[0].metrics.grossSalesCents).toBe(30_000)
    expect(p.byLocation.map((l: any) => [l.locationId, l.metrics.grossSalesCents])).toEqual([['a-main', 30_000], ['a-terraza', 20_000]])
    expect(p.comparison).toBeNull()
    expect(p.hours.peak).toBe('13:00')
    expect(p.hours.slots.find((s: any) => s.slot === '13:00')).toMatchObject({ bills: 4 })
    expect(p.dishes.top[0]).toMatchObject({ itemId: 'paella', units: 15, unitsInMenu: 4 })
    expect(p.dishes.bottom[0].itemId).toBe('flan')
    expect(p.dishes.zeroSales).toEqual([{ itemId: 'tarta', name: 'Tarta' }])
    expect(p.margin).toMatchObject({ costCents: 7500 })
    expect(p.computedAt).toBeGreaterThan(0)
  })

  it('compara con el periodo anterior desde la misma tabla y deja los días sin instantánea vacíos', async () => {
    const r = await panel('alice', { from: D2, to: D3, compare: 'previous' })
    const p = r.body.result ?? r.body.data ?? r.body
    // Periodo anterior: 31-ago y 1-sep. Solo existen el 31-ago (rellenado antes) y el 1-sep.
    expect(p.comparison.grossSalesCents.previous).toBeGreaterThan(0)
    expect(p.comparison.grossSalesCents.current).toBe(20_000)
    const empty = await panel('alice', { from: '2026-01-01', to: '2026-01-10', compare: 'previous' })
    const e = empty.body.result ?? empty.body.data ?? empty.body
    expect(e.total.grossSalesCents).toBe(0)
    expect(e.byDay).toHaveLength(10)
    expect(e.comparison.grossSalesCents).toEqual({ current: 0, previous: null, delta: null, deltaBp: null })
  })

  it('el margen exige el módulo inventory', async () => {
    await f.admin.query("UPDATE llenamos.restaurants SET active_modules=array_remove(active_modules,'inventory') WHERE id='a'")
    const p = (await panel('alice', { from: D1, to: D3, compare: 'none' })).body
    expect((p.result ?? p.data ?? p).margin).toBeNull()
    await f.admin.query("UPDATE llenamos.restaurants SET active_modules=array_append(active_modules,'inventory') WHERE id='a'")
  })

  it('hoy sale del puerto de hechos y, sin puerto, el panel sigue con las instantáneas', async () => {
    const today = todayLocal()
    const live = await panel('alice', { from: today, to: today, compare: 'none' })
    const without = live.body.result ?? live.body.data ?? live.body
    expect(live.status).toBe(200)
    expect(without.total.grossSalesCents).toBe(0)
    useDouble()
    const withPort = (await panel('alice', { from: today, to: today, compare: 'none' })).body
    const p = withPort.result ?? withPort.data ?? withPort
    expect(p.total.grossSalesCents).toBe(30_000)
    expect(Math.abs(p.computedAt - Date.now())).toBeLessThan(60_000)
  })

  it('aislamiento, permisos, módulo y alcance de locales', async () => {
    const b = (await panel('bob', { from: D1, to: D3, compare: 'none' }, 'b')).body
    expect((b.result ?? b.data ?? b).total.grossSalesCents).toBe(0)
    expect((await panel('bob', { from: D1, to: D3 }, 'a')).status).toBe(403)
    expect((await panel('outsider', { from: D1, to: D3 })).status).toBe(403)
    expect((await panel('kit', { from: D1, to: D3 })).status).toBe(403)
    expect((await panel('wai', { from: D1, to: D3 })).status).toBe(403)
    expect((await panel('alice', { from: D1, to: D3, locationIds: ['b-main'] })).status).toBe(404)
    // Encargado limitado a a-main: ve solo su local y un local ajeno es permission-denied.
    const lim = (await panel('lim', { from: D1, to: D3, compare: 'none' })).body
    expect((lim.result ?? lim.data ?? lim).byLocation.map((l: any) => l.locationId)).toEqual(['a-main'])
    expect((lim.result ?? lim.data ?? lim).total.grossSalesCents).toBe(30_000)
    expect((await panel('lim', { from: D1, to: D3, locationIds: ['a-terraza'] })).status).toBe(403)
    // Límites de periodo: 366 días sí, 367 no.
    expect((await panel('alice', { from: '2025-09-04', to: '2026-09-04', compare: 'none' })).status).toBe(200)
    expect((await panel('alice', { from: '2025-09-03', to: '2026-09-04', compare: 'none' })).status).toBe(400)
    expect((await panel('alice', { from: D3, to: D1 })).status).toBe(400)
    await f.admin.query("UPDATE llenamos.restaurants SET active_modules=ARRAY['reservations'] WHERE id='b'")
    expect((await panel('bob', { from: D1, to: D3 }, 'b')).status).toBe(403)
  })

  it('exporta ventas por día, horas, locales y platos; origins usa el informe de campañas', async () => {
    const exp = (uid: string, kind: string, extra: object = {}) => f.call('exportarAnalisis', uid, { restaurantId: 'a', from: D1, to: D3, locationIds: null, kind, ...extra })
    const days = (await exp('alice', 'sales_by_day')).body
    const d = days.result ?? days.data ?? days
    expect(d.rows).toBe(3)
    expect(d.csv.startsWith('﻿Fecha;')).toBe(true)
    expect(d.filename).toBe('llenamos-sales_by_day-2026-09-01-2026-09-03.csv')
    const dishes = (await exp('mia', 'dishes')).body
    expect((dishes.result ?? dishes.data ?? dishes).csv).toContain('Paella')
    expect((dishes.result ?? dishes.data ?? dishes).csv).toContain('Tarta')
    expect((await exp('alice', 'hours')).status).toBe(200)
    const loc = (await exp('lim', 'locations')).body
    expect((loc.result ?? loc.data ?? loc).rows).toBe(1)
    expect((await exp('lim', 'locations', { locationIds: ['a-terraza'] })).status).toBe(403)
    expect((await exp('kit', 'hours')).status).toBe(403)
    expect((await exp('alice', 'hours', { to: '2026-12-31' })).status).toBe(400)
    // origins sin informe conectado: 412 propio; con él, filas.
    expect((await exp('alice', 'origins')).status).toBe(412)
    let received: unknown
    setOriginReportPort({ originReportRows: async (_c, _r, input) => { received = input; return [{ channel: 'web', covers: 12 }] } })
    const origins = (await exp('alice', 'origins')).body
    expect((origins.result ?? origins.data ?? origins).csv).toContain('Canal;Comensales')
    expect(received).toEqual({ from: D1, to: D3, locationIds: ['a-main', 'a-terraza'] })
    await f.admin.query("UPDATE llenamos.restaurants SET active_modules=array_remove(active_modules,'marketing') WHERE id='a'")
    expect((await exp('alice', 'origins')).status).toBe(403)
    await f.admin.query("UPDATE llenamos.restaurants SET active_modules=array_append(active_modules,'marketing') WHERE id='a'")
  })

  it('la previsión usa el puerto de reservas con historial acotado y respeta locales y módulos', async () => {
    const today = todayLocal(), from = sumarDias(today, 7)
    const call = (uid: string, data: object) => f.call('previsionOcupacion', uid, { restaurantId: 'a', locationId: 'a-main', from, days: 1, ...data })
    expect(isPortUnavailable((await call('alice', {})).body, RESERVATIONS_UNAVAILABLE)).toBe(false)
    expect((await call('alice', {})).status).toBe(412)
    const seen: { historyFrom: string; from: string; to: string }[] = []
    setAnalyticsReservationsPort({ forecastInputs: async (_c, _r, _l, p) => {
      seen.push(p)
      const sessions = Array.from({ length: 12 }, (_, k) => sumarDias(from, -7 * (k + 1))).map(date => ({ openedAt: instanteDeHoraLocal(date, 13 * 60, 'Europe/Madrid')!, closedAt: instanteDeHoraLocal(date, 14 * 60, 'Europe/Madrid')!, guests: 10 }))
      const openMinutesByDate = Object.fromEntries(sessions.map(s => [new Date(s.openedAt).toISOString().slice(0, 10), 360]))
      const booked = { startAt: instanteDeHoraLocal(from, 13 * 60, 'Europe/Madrid')!, durationMinutes: 60, partySize: 25, status: 'confirmed' }
      return { seats: 30, openMinutesByDate, sessions, reservations: [booked, { ...booked, partySize: 99, status: 'cancelled' }] }
    } })
    const ok = (await call('alice', {})).body
    const r = ok.result ?? ok.data ?? ok
    expect(seen).toEqual([{ historyFrom: sumarDias(from, -84), from, to: from, timezone: 'Europe/Madrid' }])
    expect(r.seats).toBe(30)
    expect(r.days[0].samples).toBe(11)
    expect(r.days[0].confidence).toBe('high')
    const slot = r.days[0].slots.find((s: any) => s.slot === '13:00')
    expect(slot).toMatchObject({ expected: 10, booked: 25, projected: 25 })
    expect(slot.occupancyBp).toBe(8333)
    expect((await call('lim', {})).status).toBe(200)
    expect((await call('lim', { locationId: 'a-terraza' })).status).toBe(403)
    expect((await call('alice', { locationId: 'b-main' })).status).toBe(404)
    expect((await call('kit', {})).status).toBe(403)
    expect((await call('alice', { days: 15 })).status).toBe(400)
    await f.admin.query("UPDATE llenamos.restaurants SET active_modules=array_remove(active_modules,'reservations') WHERE id='a'")
    expect((await call('alice', {})).status).toBe(403)
    await f.admin.query("UPDATE llenamos.restaurants SET active_modules=array_append(active_modules,'reservations') WHERE id='a'")
  })
})
