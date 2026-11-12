import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import * as core from '@llenamos/core'
import type { IdentityToken } from '../../auth.js'
import { apiServer } from '../../server.js'
import { migrationSql } from '../../test-migrations.js'
import { applyDepositPayment, recordCheckoutSession } from '../reservas/deposit.js'
import { withIdentity } from '../../database.js'
import { withPublicScope } from '../reservas/scope.js'
import { READ_WINDOW_SQL, readWindow, readWindowParams } from '../reservas/store.js'
import { clearMenuCache } from './menu-public.js'

const source = process.env.TEST_POSTGRES_URL
const enabled = process.env.TEST_POSTGRES_API === '1' && !!source
const token = (uid: string): IdentityToken => ({ uid, sessionVersion: 'a'.repeat(32), authTime: 100, platformClaim: false })
const lid = 'la'
const phone = (n: number) => `+346000${String(n).padStart(5, '0')}`
const EVENTS = ['reservation.created', 'reservation.statusChanged', 'payment.succeeded']
/** Siguiente cuarto de hora a `minutes` minutos: la franja de la reserva, en la hora de pared del local. */
function slotAt(minutes: number) {
  const startAt = Math.ceil((Date.now() + minutes * 60_000) / 900_000) * 900_000, wall = core.horaLocal(startAt, 'Europe/Madrid')
  return { startAt, date: wall.fecha, time: wall.hora }
}

/**
 * Recorrido de punta a punta de reservas, sala y caja sobre PostgreSQL: la ocupación en los dos sentidos, sentar y terminar
 * reservas desde sala o desde reservas, el plano con mesas vivas, la cuenta de caja, la señal, los orígenes y los eventos.
 */
describe.skipIf(!enabled)('Cableado B: reservas, sala y caja en PostgreSQL real', { timeout: 40_000 }, () => {
  process.env.SALA_SECRET_KEY = 'ab'.repeat(32)
  process.env.PUBLIC_APP_URL = 'https://app.example.test'
  process.env.TRUSTED_IP_HEADER = 'x-test-ip'; process.env.TRUSTED_PROXY_ADDRESSES = '127.0.0.1,::1'
  let admin: Pool, bootstrap: Pool, app: Pool, owned = false, server: ReturnType<typeof apiServer>, base: string
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12), database = `llenamos_api_test_cableado_${suffix}`, runtime = `llenamos_api_cableado_${suffix}`
  let rid = '', seq = 0, ipCounter = 0
  const uids = ['owner', 'cook', 'waiter']

  async function post(name: string, data: unknown, uid: string | null = 'owner') {
    const response = await fetch(`${base}/v1/operations/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-ip': `198.51.100.${(++ipCounter % 250) + 1}`, ...(uid ? { Authorization: `Bearer ${uid}` } : {}) }, body: JSON.stringify({ data }) })
    const body = await response.json() as { result?: any; error?: { code: string } }
    return { status: response.status, result: body.result, code: body.error?.code, body }
  }
  async function ok(name: string, data: unknown, uid: string | null = 'owner') {
    const r = await post(name, data, uid)
    expect(r.status, `${name}: ${JSON.stringify(r.body)}`).toBe(200)
    return r.result
  }
  const scope = () => ({ restaurantId: rid, locationId: lid })
  const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0]
  const count = async (table: string, where = 'true', restaurant = rid) => Number((await one(`SELECT count(*) FROM llenamos.${table} WHERE restaurant_id=$1 AND ${where}`, [restaurant])).count)
  const reservation = async (id: string) => one('SELECT status,data FROM llenamos.reservations WHERE restaurant_id=$1 AND id=$2', [rid, id])
  const session = async (id: string) => (await one('SELECT status,doc FROM llenamos.sala_table_sessions WHERE restaurant_id=$1 AND id=$2', [rid, id]))
  const platform = async (type: string) => count('webhook_deliveries', `event->>'type'='${type}'`)

  async function book(minutes: number, tableId: string, n: number, partySize = 2) {
    const slot = slotAt(minutes)
    const out = await ok('crearReserva', { ...scope(), date: slot.date, time: slot.time, partySize, guestName: `Cliente ${n}`, phone: phone(n), source: 'phone', tableIds: [tableId] })
    return out.reservationId as string
  }
  const publicBooking = (minutes: number, n: number, over: Record<string, unknown> = {}) => {
    const slot = slotAt(minutes)
    return post('crearReservaPublica', { slug: rid, locationId: lid, date: slot.date, time: slot.time, partySize: 4, guestName: 'Ana Pruebas', phone: phone(n), email: null, language: 'es', guestNotes: '', acceptPolicy: true, source: 'web', website: '', ...over }, null)
  }
  const item = (itemId = 'bravas', quantity = 1) => ({ kind: 'item', itemId, quantity })
  const lines = async (sessionId: string) => (await q('SELECT id,doc FROM llenamos.sala_order_lines WHERE restaurant_id=$1', [rid])).map(r => ({ id: r.id as string, ...core.OrderLineSchema.parse(r.doc) })).filter(l => l.sessionId === sessionId)
  async function consume(sessionId: string, quantity = 1) {
    await ok('enviarPedido', { ...scope(), sessionId, lines: [item('bravas', quantity)] })
  }
  async function serve(sessionId: string) {
    const live = (await lines(sessionId)).filter(l => l.kind !== 'menu' && l.status !== 'served' && l.status !== 'cancelled')
    if (live.some(l => l.status === 'held')) await ok('marcharPase', { ...scope(), sessionId, course: 'all' })
    if (live.length) await ok('cambiarEstadoLineas', { ...scope(), lineIds: live.map(l => l.id), status: 'served' })
  }

  /** Siembra otro restaurante sin perder el actual: devuelve su id. */
  async function seedOther(options: { pos?: boolean } = {}) {
    const mine = rid
    await fresh(options)
    const other = rid
    rid = mine
    return other
  }
  async function inRestaurant<T>(id: string, work: () => Promise<T>) {
    const mine = rid
    rid = id
    try { return await work() } finally { rid = mine }
  }

  /** Restaurante nuevo con plano (t1 a t3 de 4 plazas), horarios de todo el día, carta y un webhook que escucha todo. */
  async function fresh(options: { pos?: boolean } = {}) {
    rid = `cab-${++seq}-${suffix}`
    clearMenuCache()
    const modules = ['reservations', 'floor', 'kitchen', ...(options.pos ? ['pos'] : [])]
    await admin.query("INSERT INTO llenamos.restaurants(id,name,slug,plan,active_modules) VALUES($1,$2,$1,'completo',$3)", [rid, `Restaurante ${rid}`, modules])
    await admin.query('INSERT INTO llenamos.locations(restaurant_id,id,name,slug,address,phone) VALUES($1,$2,$2,$2,$3,$4)', [rid, lid, 'Calle Mayor 1', '600000000'])
    for (const [uid, role] of [['owner', 'owner'], ['cook', 'kitchen'], ['waiter', 'waiter']]) await admin.query('INSERT INTO llenamos.memberships(restaurant_id,uid,role,active,display_name,email,location_ids) VALUES($1,$2::text,$3,true,$2::text,$4,$5)', [rid, uid, role, `${uid}@${rid}.test`, []])
    await admin.query("INSERT INTO llenamos.dining_areas(restaurant_id,location_id,id,data) VALUES($1,$2,'sala',$3)", [rid, lid, JSON.stringify({ name: 'Sala', sortOrder: 0 })])
    for (let i = 1; i <= 3; i++) await admin.query('INSERT INTO llenamos.dining_tables(restaurant_id,location_id,id,area_id,data) VALUES($1,$2,$3,$4,$5)', [rid, lid, `t${i}`, 'sala', JSON.stringify({ name: `S${i}`, areaId: 'sala', seats: 4, enabled: true, joinableWith: ['t1', 't2', 't3'].filter(t => t !== `t${i}`), shape: 'rect', x: 10 * i, y: 10, w: 10, h: 10 })])
    const shifts = [{ name: 'Servicio', from: '00:00', lastEntry: '23:45' }], settings = core.defaultReservationSettings('Europe/Madrid')
    settings.week = { mon: shifts, tue: shifts, wed: shifts, thu: shifts, fri: shifts, sat: shifts, sun: shifts }
    Object.assign(settings, { publicBooking: true, autoConfirm: true, minNoticeMinutes: 0, maxAdvanceDays: 700 })
    await admin.query('INSERT INTO llenamos.reservation_settings(restaurant_id,location_id,data) VALUES($1,$2,$3)', [rid, lid, JSON.stringify(settings)])
    const demo = core.demoMenu()
    demo.settings.selfOrder.enabled = true; demo.settings.selfOrder.requireApproval = false; demo.settings.takeaway.enabled = true; demo.settings.takeaway.publicOrdering = true
    await admin.query("INSERT INTO llenamos.sala_settings(restaurant_id,location_id,kind,doc) VALUES($1,$2,'floor',$3)", [rid, lid, JSON.stringify(demo.settings)])
    for (const [table, rows] of Object.entries({ sala_menu_categories: demo.categories, sala_menu_items: demo.items, sala_daily_menus: demo.dailyMenus, sala_stations: demo.stations }))
      for (const [id, value] of Object.entries(rows)) await admin.query(`INSERT INTO llenamos.${table}(restaurant_id,location_id,id,doc) VALUES($1,$2,$3,$4)`, [rid, lid, id, JSON.stringify(value)])
    await admin.query("INSERT INTO llenamos.webhook_endpoints(restaurant_id,id,url,events,location_ids,status,secret_version) VALUES($1,'e1','https://hooks.example.test/x',$2,$3,'active',1)", [rid, EVENTS, [lid]])
  }

  beforeAll(async () => {
    const url = new URL(source!)
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.startsWith('/llenamos_api_test_')) throw new Error('Solo PostgreSQL temporal loopback de pruebas.')
    bootstrap = new Pool({ connectionString: source, max: 1 })
    await bootstrap.query(`CREATE DATABASE ${database}`); owned = true
    url.pathname = `/${database}`
    admin = new Pool({ connectionString: url.toString(), max: 2 })
    for (const sql of migrationSql()) await admin.query(sql)
    await admin.query(`CREATE ROLE ${runtime} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD 'fixture-only' IN ROLE llenamos_app`)
    url.username = runtime; url.password = 'fixture-only'
    app = new Pool({ connectionString: url.toString(), max: 12, statement_timeout: 8000 })
    for (const uid of uids) await admin.query('INSERT INTO llenamos.identities(uid,session_version,tokens_valid_after,locked,platform_operator) VALUES($1,$2,to_timestamp(100),false,false)', [uid, 'a'.repeat(32)])
    server = apiServer(app, async value => { if (!uids.includes(value)) throw new Error('sin identidad'); return token(value) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }, 60_000)
  afterAll(async () => {
    server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server.close(() => resolve()))
    for (const pool of [app, admin]) pool?.on('error', error => { if ((error as { code?: string }).code !== '57P01') throw error })
    await app?.end(); await admin?.end()
    if (owned) await bootstrap.query(`DROP DATABASE ${database} WITH (FORCE)`)
    await bootstrap?.end()
  }, 30_000)
  beforeEach(() => fresh({ pos: false }), 30_000)

  it('ocupación en los dos sentidos: sala no vende una mesa reservada ni reservas una mesa sentada', async () => {
    const reserved = await book(60, 't1', 1)
    // Sala: la mesa t1 está reservada para dentro de una hora, no se puede abrir ahora.
    const refused = await post('abrirMesa', { ...scope(), tableIds: ['t1'], guests: 2 })
    expect(refused).toMatchObject({ status: 412, code: 'failed-precondition' })
    expect(await count('sala_table_sessions')).toBe(0)
    // Una mesa libre sí se abre.
    const opened = await ok('abrirMesa', { ...scope(), tableIds: ['t2'], guests: 2 })
    // Reservas: con t1 reservada y t2 sentada solo queda t3 para un grupo de cuatro.
    expect((await publicBooking(60, 11)).status).toBe(200)
    const full = await publicBooking(60, 12)
    expect(full).toMatchObject({ status: 412, code: 'failed-precondition' })
    // Al cerrar la mesa de sala, su hueco vuelve a estar libre para la web.
    await ok('cambiarEstadoMesa', { ...scope(), sessionId: opened.sessionId, status: 'closed' })
    expect((await publicBooking(60, 13)).status).toBe(200)
    expect((await reservation(reserved)).status).toBe('confirmed')
  })

  it('sentar una reserva desde sala la une a la mesa, es idempotente y al cerrar la mesa la termina con el gasto del cliente', async () => {
    const id = await book(120, 't1', 2)
    const mismatch = await post('abrirMesa', { ...scope(), tableIds: ['t2'], guests: 2, reservationId: id })
    expect(mismatch).toMatchObject({ status: 412, code: 'failed-precondition' })
    expect((await reservation(id)).status).toBe('confirmed')
    const opened = await ok('abrirMesa', { ...scope(), tableIds: ['t1'], guests: 2, reservationId: id })
    expect(opened).toMatchObject({ reservationSeated: true })
    expect((await reservation(id)).status).toBe('seated')
    expect((await session(opened.sessionId)).doc).toMatchObject({ reservationId: id, status: 'open' })
    expect(await platform('reservation.statusChanged')).toBe(1)
    // Repetir devuelve la misma sesión sin sentar otra vez ni duplicar eventos.
    const again = await ok('abrirMesa', { ...scope(), tableIds: ['t1'], guests: 2, reservationId: id })
    expect(again).toMatchObject({ sessionId: opened.sessionId, reservationSeated: false })
    expect(await count('sala_table_sessions')).toBe(1)
    expect(await platform('reservation.statusChanged')).toBe(1)
    // Ficha del cliente creada por la reserva y origen en "sentada".
    const customerId = core.customerIdFor(rid, phone(2))
    expect((await one('SELECT data FROM llenamos.customers WHERE restaurant_id=$1 AND id=$2', [rid, customerId])).data).toMatchObject({ name: 'Cliente 2' })
    expect((await one('SELECT final_status FROM llenamos.reservation_origins WHERE restaurant_id=$1 AND reservation_id=$2', [rid, id])).final_status).toBe('seated')
    // Consumo, servicio y cierre: la reserva se termina y el gasto se suma una sola vez.
    await consume(opened.sessionId, 2); await serve(opened.sessionId)
    const total = (await session(opened.sessionId)).doc.totalCents as number
    expect(total).toBeGreaterThan(0)
    await ok('cambiarEstadoMesa', { ...scope(), sessionId: opened.sessionId, status: 'closed' })
    expect((await reservation(id)).status).toBe('finished')
    expect((await one('SELECT final_status FROM llenamos.reservation_origins WHERE restaurant_id=$1 AND reservation_id=$2', [rid, id])).final_status).toBe('finished')
    const spent = async () => Number((await one('SELECT data->>\'spentCents\' AS s FROM llenamos.customers WHERE restaurant_id=$1 AND id=$2', [rid, customerId])).s)
    expect(await spent()).toBe(total)
    await ok('cambiarEstadoMesa', { ...scope(), sessionId: opened.sessionId, status: 'closed' })
    expect(await spent()).toBe(total)
    expect(await platform('reservation.statusChanged')).toBe(2)
    // Una reserva terminada no se puede volver a sentar.
    expect(await post('abrirMesa', { ...scope(), tableIds: ['t1'], guests: 2, reservationId: id })).toMatchObject({ status: 412 })
  })

  it('reabrir una mesa cerrada resta su gasto y el gasto del mismo teléfono en otro restaurante no se toca', async () => {
    const other = await seedOther()
    const spentIn = async (restaurant: string) => Number((await one('SELECT data->>\'spentCents\' AS s FROM llenamos.customers WHERE restaurant_id=$1 AND id=$2', [restaurant, core.customerIdFor(restaurant, phone(30))])).s)
    await inRestaurant(other, async () => {
      const theirs = await ok('abrirMesa', { ...scope(), tableIds: ['t1'], guests: 2, guest: { name: 'Luis Gómez', phone: phone(30) } })
      await consume(theirs.sessionId, 3); await serve(theirs.sessionId)
      await ok('cambiarEstadoMesa', { ...scope(), sessionId: theirs.sessionId, status: 'closed' })
    })
    const theirSpent = await spentIn(other)
    expect(theirSpent).toBe(1950)
    const opened = await ok('abrirMesa', { ...scope(), tableIds: ['t1'], guests: 2, guest: { name: 'Luis Gómez', phone: phone(30) } })
    await consume(opened.sessionId); await serve(opened.sessionId)
    await ok('cambiarEstadoMesa', { ...scope(), sessionId: opened.sessionId, status: 'closed' })
    expect(await spentIn(rid)).toBe(650)
    await ok('cambiarEstadoMesa', { ...scope(), sessionId: opened.sessionId, status: 'open' })
    expect(await spentIn(rid)).toBe(0)
    await ok('cambiarEstadoMesa', { ...scope(), sessionId: opened.sessionId, status: 'closed' })
    expect(await spentIn(rid)).toBe(650)
    expect(await count('sala_spend')).toBe(1)
    expect(await spentIn(other)).toBe(theirSpent)
    expect(await count('sala_spend', 'true', other)).toBe(1)
  })

  it('sentar desde reservas abre la sesión de sala y abrir la mesa desde sala la reutiliza', async () => {
    const id = await book(120, 't1', 3)
    await ok('cambiarEstadoReserva', { ...scope(), reservationId: id, status: 'seated' })
    const row = await one("SELECT id,status FROM llenamos.sala_table_sessions WHERE restaurant_id=$1 AND doc->>'reservationId'=$2", [rid, id])
    expect(row.status).toBe('open')
    expect(await ok('abrirMesa', { ...scope(), tableIds: ['t1'], guests: 2, reservationId: id })).toMatchObject({ sessionId: row.id, reservationSeated: false })
    await consume(row.id)
    // Con un plato sin servir la mesa no se cierra y por tanto la reserva tampoco se termina.
    expect((await post('cambiarEstadoReserva', { ...scope(), reservationId: id, status: 'finished' })).status).toBe(412)
    expect((await reservation(id)).status).toBe('seated')
    await serve(row.id)
    await ok('cambiarEstadoReserva', { ...scope(), reservationId: id, status: 'finished' })
    expect((await reservation(id)).status).toBe('finished')
    expect((await session(row.id)).status).toBe('closed')
  })

  it('mesas juntadas: terminar la reserva destino desde reservas cierra la mesa y también termina la reserva absorbida', async () => {
    const r1 = await book(120, 't1', 7), r2 = await book(120, 't2', 8)
    await ok('cambiarEstadoReserva', { ...scope(), reservationId: r1, status: 'seated' })
    await ok('cambiarEstadoReserva', { ...scope(), reservationId: r2, status: 'seated' })
    const s1 = (await one("SELECT id FROM llenamos.sala_table_sessions WHERE restaurant_id=$1 AND doc->>'reservationId'=$2", [rid, r1])).id as string
    const s2 = (await one("SELECT id FROM llenamos.sala_table_sessions WHERE restaurant_id=$1 AND doc->>'reservationId'=$2", [rid, r2])).id as string
    // Se junta S1 en S2: S2 representa ahora a las dos reservas.
    await ok('juntarMesas', { ...scope(), sessionId: s2, tableIds: ['t2', 't1'] })
    expect((await session(s1)).status).toBe('merged')
    // La reserva absorbida se termina desde reservas: se cierra la mesa que la representa (S2) y R2 no queda sentada.
    await ok('cambiarEstadoReserva', { ...scope(), reservationId: r1, status: 'finished' })
    expect((await session(s2)).status).toBe('closed')
    expect((await reservation(r1)).status).toBe('finished')
    expect((await reservation(r2)).status).toBe('finished')
    // Las mesas quedan libres para la web: nadie las sigue ocupando.
    expect((await publicBooking(60, 80)).status).toBe(200)
    expect((await publicBooking(60, 81)).status).toBe(200)
    expect((await publicBooking(60, 82)).status).toBe(200)
  })

  it('el plano no deja borrar una mesa con sesión abierta o cuenta pedida', async () => {
    const opened = await ok('abrirMesa', { ...scope(), tableIds: ['t1'], guests: 2 })
    const plan = (deleteTables: string[]) => post('guardarPlano', { ...scope(), createAreas: [], updateAreas: [], createTables: [], updateTables: [], deleteTables, deleteAreas: [] })
    expect(await plan(['t1'])).toMatchObject({ status: 412, code: 'failed-precondition' })
    await ok('cambiarEstadoMesa', { ...scope(), sessionId: opened.sessionId, status: 'bill_requested' })
    expect((await plan(['t1'])).status).toBe(412)
    expect(await count('dining_tables', "id='t1'")).toBe(1)
    // Otra mesa libre sí se borra, y la ocupada también cuando se cierra.
    expect((await plan(['t3'])).status).toBe(200)
    await ok('cambiarEstadoMesa', { ...scope(), sessionId: opened.sessionId, status: 'closed' })
    expect((await plan(['t1'])).status).toBe(200)
    expect(await count('dining_tables')).toBe(1)
  })

  it('los horarios de sala salen de reservation_settings y no de una copia propia', async () => {
    const date = core.sumarDias(core.horaLocal(Date.now(), 'Europe/Madrid').fecha, 1)
    const slots = async () => (await ok('consultarRecogida', { slug: rid, locationId: lid, date }, null)).slots.filter((s: { available: boolean }) => s.available).length
    expect(await slots()).toBeGreaterThan(0)
    // Cerrar el local en reservas cierra también la recogida; una fila antigua en sala_settings no la reabre.
    const closed = core.defaultReservationSettings('Europe/Madrid')
    closed.week = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] }
    await admin.query("UPDATE llenamos.reservation_settings SET data=$3 WHERE restaurant_id=$1 AND location_id=$2", [rid, lid, JSON.stringify(closed)])
    expect(await slots()).toBe(0)
    // La copia antigua ya no puede existir: la migración limpia las filas y una restricción impide volver a escribirla.
    await expect(admin.query("INSERT INTO llenamos.sala_settings(restaurant_id,location_id,kind,doc) VALUES($1,$2,'reservations',$3)", [rid, lid, JSON.stringify(core.defaultReservationSettings('Europe/Madrid'))])).rejects.toThrow(/sala_settings_sin_reservas/)
    expect(await count('sala_settings', "kind='reservations'")).toBe(0)
  })

  it('concurrencia: dos aperturas simultáneas de la misma reserva dejan una sola sesión', async () => {
    const id = await book(120, 't1', 5)
    const results = await Promise.all([1, 2, 3, 4].map(() => post('abrirMesa', { ...scope(), tableIds: ['t1'], guests: 2, reservationId: id })))
    const ok200 = results.filter(r => r.status === 200)
    expect(ok200.length).toBeGreaterThanOrEqual(1)
    expect(new Set(ok200.map(r => r.result.sessionId)).size).toBe(1)
    expect(results.filter(r => r.status !== 200).every(r => [409, 412].includes(r.status))).toBe(true)
    expect(await count('sala_table_sessions')).toBe(1)
    expect(await platform('reservation.statusChanged')).toBe(1)
  })

  it('permisos y aislamiento: cocina no abre mesas, una reserva ajena no se sienta y una sesión ajena no ocupa mis mesas', async () => {
    const id = await book(120, 't1', 6)
    expect(await post('abrirMesa', { ...scope(), tableIds: ['t1'], guests: 2, reservationId: id }, 'cook')).toMatchObject({ status: 403 })
    expect((await reservation(id)).status).toBe('confirmed')
    const mine = rid, other = await seedOther()
    // El mismo id en otro restaurante no existe: no se sienta ni se crea sesión; mi reserva no cambia.
    expect(await post('abrirMesa', { restaurantId: other, locationId: lid, tableIds: ['t1'], guests: 2, reservationId: id })).toMatchObject({ status: 404, code: 'not-found' })
    expect(await count('sala_table_sessions', 'true', other)).toBe(0)
    expect((await reservation(id)).status).toBe('confirmed')
    // Una mesa sentada en el otro restaurante (sus t1) no ocupa las mías: caben tres grupos de cuatro y el cuarto no.
    const theirs = await inRestaurant(other, () => ok('abrirMesa', { ...scope(), tableIds: ['t1'], guests: 2 }))
    await admin.query('DELETE FROM llenamos.reservations WHERE restaurant_id=$1 AND id=$2', [mine, id])
    for (const n of [71, 72, 73]) expect((await publicBooking(60, n)).status).toBe(200)
    expect((await publicBooking(60, 74)).status).toBe(412)
    // Las funciones estrechas actúan solo en el restaurante de la transacción, aunque se les pase otro.
    await withPublicScope(app, mine, async client => {
      expect((await client.query('SELECT llenamos.reservas_open_sessions($1,$2) AS s', [other, lid])).rows[0].s).toEqual([])
      await client.query("SELECT llenamos.reservas_origin_outcome($1,'cualquiera','cancelled')", [other])
    })
    await withPublicScope(app, other, async client => {
      expect((await client.query('SELECT llenamos.reservas_open_sessions($1,$2) AS s', [other, lid])).rows[0].s).toHaveLength(1)
      expect((await client.query('SELECT llenamos.reservas_open_sessions($1,$2) AS s', [mine, lid])).rows[0].s).toEqual([])
    })
    const blocked = await inRestaurant(other, () => one('SELECT status FROM llenamos.sala_table_sessions WHERE restaurant_id=$1 AND id=$2', [other, theirs.sessionId]))
    expect(blocked.status).toBe('open')
  })

  it('reservas por el personal: crear o asignar una mesa con alguien sentado sin reserva se rechaza', async () => {
    const opened = await ok('abrirMesa', { ...scope(), tableIds: ['t1'], guests: 2 })
    const slot = slotAt(30)
    const create = (table: string, n: number) => post('crearReserva', { ...scope(), date: slot.date, time: slot.time, partySize: 2, guestName: `Cliente ${n}`, phone: phone(n), source: 'phone', tableIds: [table] })
    expect(await create('t1', 90)).toMatchObject({ status: 412, code: 'failed-precondition' })
    const free = await create('t2', 91)
    expect(free.status).toBe(200)
    expect(await post('asignarMesas', { ...scope(), reservationId: free.result.reservationId, tableIds: ['t1'] })).toMatchObject({ status: 412, code: 'failed-precondition' })
    await ok('cambiarEstadoMesa', { ...scope(), sessionId: opened.sessionId, status: 'closed' })
    expect((await create('t1', 92)).status).toBe(200)
  })

  it('para llevar: la ficha se da de alta desde el ámbito público y la recogida entregada suma al gasto una sola vez', async () => {
    const date = core.sumarDias(core.horaLocal(Date.now(), 'Europe/Madrid').fecha, 1)
    const slot = (await ok('consultarRecogida', { slug: rid, locationId: lid, date }, null)).slots.find((x: { available: boolean }) => x.available)
    const placed = await ok('pedirParaLlevar', { slug: rid, locationId: lid, date, time: slot.time, guestName: 'Ana Prueba', phone: phone(95), email: null, language: 'es', lines: [item('bravas', 2)], expectedTotalCents: 1300, notes: '', acceptPolicy: true, website: '' }, null)
    const customerId = core.customerIdFor(rid, phone(95))
    expect((await one('SELECT data FROM llenamos.customers WHERE restaurant_id=$1 AND id=$2', [rid, customerId])).data).toMatchObject({ name: 'Ana Prueba', phone: phone(95) })
    expect(await count('sala_spend')).toBe(0)
    const takeawayId = (await one('SELECT id FROM llenamos.sala_takeaways WHERE restaurant_id=$1 AND reference=$2', [rid, placed.reference])).id as string
    if (placed.status === 'pending') await ok('cambiarEstadoParaLlevar', { ...scope(), takeawayId, status: 'accepted' })
    const takeawayLines = (await q('SELECT id,doc FROM llenamos.sala_order_lines WHERE restaurant_id=$1', [rid])).filter(r => r.doc.takeawayId === takeawayId && r.doc.kind !== 'menu')
    for (const status of ['fired', 'preparing', 'ready', 'served']) await post('cambiarEstadoLineas', { ...scope(), lineIds: takeawayLines.map(r => r.id), status })
    expect((await q('SELECT doc FROM llenamos.sala_order_lines WHERE restaurant_id=$1', [rid])).filter(r => r.doc.takeawayId === takeawayId && r.doc.kind !== 'menu').map(r => r.doc.status)).toEqual(['served', 'served'].slice(0, takeawayLines.length))
    await ok('cambiarEstadoParaLlevar', { ...scope(), takeawayId, status: 'picked_up' })
    const spent = async () => Number((await one('SELECT data->>\'spentCents\' AS s FROM llenamos.customers WHERE restaurant_id=$1 AND id=$2', [rid, customerId])).s)
    expect(await spent()).toBe(1300)
    // Un segundo pedido del mismo cliente suma el suyo; repetir el estado no suma otra vez.
    await ok('cambiarEstadoParaLlevar', { ...scope(), takeawayId, status: 'picked_up' })
    expect(await spent()).toBe(1300)
    expect(await count('sala_spend')).toBe(1)
  })

  it('gasto con la ficha borrada: no se aplica nada, el servicio sigue y queda registrado', async () => {
    const opened = await ok('abrirMesa', { ...scope(), tableIds: ['t1'], guests: 2, guest: { name: 'Borrada', phone: phone(96) } })
    await consume(opened.sessionId); await serve(opened.sessionId)
    await admin.query('DELETE FROM llenamos.customers WHERE restaurant_id=$1', [rid])
    await ok('cambiarEstadoMesa', { ...scope(), sessionId: opened.sessionId, status: 'closed' })
    expect((await session(opened.sessionId)).status).toBe('closed')
    expect(await count('sala_spend')).toBe(0)
  })

  it('cocina y barra no toman el cerrojo de reservas ni cargan reservas; abrir mesa sí, y 501 reservas en la ventana no la tumban', async () => {
    const opened = await ok('abrirMesa', { ...scope(), tableIds: ['t1'], guests: 2 })
    await consume(opened.sessionId)
    const line = (await lines(opened.sessionId)).find(l => l.kind !== 'menu')!
    // Con el cerrojo de reservas retenido por otra sesión, una operación de cocina termina y abrir una mesa espera.
    const holder = await admin.connect()
    try {
      await holder.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [`reservas:${rid}:${lid}`])
      const kitchen = await Promise.race([post('cambiarEstadoLineas', { ...scope(), lineIds: [line.id], status: 'served' }, 'owner').then(r => r.status), new Promise<string>(resolve => setTimeout(() => resolve('espera'), 3000))])
      expect(kitchen).toBe(200)
      const waiting = await Promise.race([post('abrirMesa', { ...scope(), tableIds: ['t2'], guests: 2 }).then(r => r.status), new Promise<string>(resolve => setTimeout(() => resolve('espera'), 1500))])
      expect(waiting).toBe('espera')
    } finally {
      await holder.query('SELECT pg_advisory_unlock_all()'); holder.release()
    }
    await new Promise(resolve => setTimeout(resolve, 500))
    // 501 reservas en la ventana, todas en OTRA mesa (t9): el volumen de la agenda no puede tumbar la apertura de t3.
    const near = Date.now() + 3_600_000, hash = 'a'.repeat(64)
    await admin.query(`INSERT INTO llenamos.reservations(restaurant_id,location_id,id,customer_id,reference,start_at,status,table_ids,manage_token_hash,data)
      SELECT $1,$2,'m'||g,repeat('c',20),'M'||lpad(g::text,5,'0'),$3::timestamptz,'confirmed','{t9}',$4,$5::jsonb FROM generate_series(1,501) g`,
    [rid, lid, new Date(near), hash, JSON.stringify({ guestName: 'X', phone: phone(1), email: null, language: 'es', partySize: 2, startAt: near, durationMinutes: 90, status: 'confirmed', tableIds: [], suggestedTableIds: [], suggestionReason: null, source: 'phone', notes: '', guestNotes: '', customerId: 'c'.repeat(20), manageTokenHash: hash, reference: 'AAAAAA', deposit: { status: 'none', amountCents: 0, checkoutSessionId: null }, history: [], createdBy: null })])
    // Una reserva mal formada sobre la misma mesa se salta y se registra, sin romper la escritura.
    await admin.query(`INSERT INTO llenamos.reservations(restaurant_id,location_id,id,customer_id,reference,start_at,status,table_ids,manage_token_hash,data)
      VALUES($1,$2,'rota',repeat('c',20),'ROTA01',$3,'confirmed','{t3}',$4,'{"basura":true}')`, [rid, lid, new Date(near), hash])
    expect((await post('abrirMesa', { ...scope(), tableIds: ['t3'], guests: 2 })).status).toBe(200)
    expect(await count('sala_table_sessions')).toBe(3)
  })

  it('con 501 reservas en la ventana sobre otras mesas, abrir, mover, juntar y separar siguen funcionando y un solape real se rechaza', async () => {
    const reserved = await book(60, 't1', 1)
    const near = Date.now() + 3_600_000
    await admin.query(`INSERT INTO llenamos.reservations(restaurant_id,location_id,id,customer_id,reference,start_at,status,table_ids,manage_token_hash,data)
      SELECT $1,$2,'v'||g,repeat('c',20),'V'||lpad(g::text,5,'0'),$3::timestamptz,'confirmed','{t9}',$4,'{"basura":true}'::jsonb FROM generate_series(1,501) g`, [rid, lid, new Date(near), 'a'.repeat(64)])
    expect(await count('reservations', "table_ids='{t9}'")).toBe(501)
    // El solape real sigue rechazado aunque haya cientos de reservas ajenas.
    expect(await post('abrirMesa', { ...scope(), tableIds: ['t1'], guests: 2 })).toMatchObject({ status: 412, code: 'failed-precondition' })
    const opened = await ok('abrirMesa', { ...scope(), tableIds: ['t2'], guests: 2 })
    await ok('moverMesa', { ...scope(), sessionId: opened.sessionId, tableIds: ['t3'] })
    await ok('juntarMesas', { ...scope(), sessionId: opened.sessionId, tableIds: ['t3', 't2'] })
    await ok('separarMesas', { ...scope(), sessionId: opened.sessionId, tableIds: ['t2'] })
    expect(reserved).toBeTruthy()
  })

  it('mesas juntadas: terminar la reserva destino (r2) desde reservas cierra la mesa y también termina la reserva absorbida (r1)', async () => {
    const r1 = await book(300, 't1', 17), r2 = await book(300, 't2', 18)
    await ok('cambiarEstadoReserva', { ...scope(), reservationId: r1, status: 'seated' })
    await ok('cambiarEstadoReserva', { ...scope(), reservationId: r2, status: 'seated' })
    const s1 = (await one("SELECT id FROM llenamos.sala_table_sessions WHERE restaurant_id=$1 AND doc->>'reservationId'=$2", [rid, r1])).id as string
    const s2 = (await one("SELECT id FROM llenamos.sala_table_sessions WHERE restaurant_id=$1 AND doc->>'reservationId'=$2", [rid, r2])).id as string
    await ok('juntarMesas', { ...scope(), sessionId: s2, tableIds: ['t2', 't1'] })
    expect((await session(s1)).status).toBe('merged')
    // Ahora se termina la reserva DESTINO (la de la sesión que sobrevive).
    await ok('cambiarEstadoReserva', { ...scope(), reservationId: r2, status: 'finished' })
    expect((await session(s2)).status).toBe('closed')
    expect((await reservation(r2)).status).toBe('finished')
    expect((await reservation(r1)).status).toBe('finished')
  })

  describe('caja con sala', () => {
    beforeEach(() => fresh({ pos: true }), 30_000)
    const cash = async () => (await ok('abrirCaja', { ...scope(), requestId: randomUUID().replaceAll('-', ''), registerId: 'caja1', openingCents: 0 })).cashSessionId as string
    const lockedBill = async (sessionId: string) => {
      const opened = await ok('abrirCuenta', { ...scope(), requestId: randomUUID().replaceAll('-', ''), target: { kind: 'session', id: sessionId } })
      const prepared = await ok('prepararCobro', { ...scope(), requestId: randomUUID().replaceAll('-', ''), billId: opened.billId, expectedRevision: 1 })
      const view = await ok('verCuenta', { ...scope(), billId: opened.billId })
      return { billId: opened.billId as string, revision: prepared.revision as number, part: view.parts[0] as { id: string; totalCents: number }, total: view.bill.totalCents as number }
    }
    const pay = (b: Awaited<ReturnType<typeof lockedBill>>, cashSessionId: string, extra: Record<string, unknown> = {}) => post('registrarCobro', {
      ...scope(), requestId: randomUUID().replaceAll('-', ''), billId: b.billId, expectedRevision: b.revision, partId: b.part.id, cashSessionId, method: 'cash', amountCents: b.total, tipCents: 0, tenderedCents: b.total, ...extra })

    it('no se cierra, mueve, junta ni anula una mesa con cuenta sin saldar; saldada se cierra y avisa a la plataforma', async () => {
      const opened = await ok('abrirMesa', { ...scope(), tableIds: ['t1'], guests: 2 })
      await consume(opened.sessionId); await serve(opened.sessionId)
      const close = () => post('cambiarEstadoMesa', { ...scope(), sessionId: opened.sessionId, status: 'closed' })
      expect(await close()).toMatchObject({ status: 412, code: 'failed-precondition' })
      const cashSessionId = await cash(), bill = await lockedBill(opened.sessionId)
      for (const attempt of [close(), post('cambiarEstadoMesa', { ...scope(), sessionId: opened.sessionId, status: 'cancelled' }),
        post('moverMesa', { ...scope(), sessionId: opened.sessionId, tableIds: ['t2'] }), post('juntarMesas', { ...scope(), sessionId: opened.sessionId, tableIds: ['t1', 't2'] }),
        post('enviarPedido', { ...scope(), sessionId: opened.sessionId, lines: [item()] })]) expect(await attempt).toMatchObject({ status: 412, code: 'failed-precondition' })
      expect((await session(opened.sessionId)).doc).toMatchObject({ status: 'open', tableIds: ['t1'] })
      expect(await platform('payment.succeeded')).toBe(0)
      expect((await pay(bill, cashSessionId)).status).toBe(200)
      expect(await platform('payment.succeeded')).toBe(1)
      expect((await close()).status).toBe(200)
      expect((await session(opened.sessionId)).status).toBe('closed')
    })

    it('terminar la reserva desde reservas respeta la caja de la mesa: con la cuenta sin saldar no se termina', async () => {
      const id = await book(120, 't1', 3)
      await ok('cambiarEstadoReserva', { ...scope(), reservationId: id, status: 'seated' })
      const row = await one("SELECT id FROM llenamos.sala_table_sessions WHERE restaurant_id=$1 AND doc->>'reservationId'=$2", [rid, id])
      await consume(row.id); await serve(row.id)
      expect((await post('cambiarEstadoReserva', { ...scope(), reservationId: id, status: 'finished' })).status).toBe(412)
      expect((await reservation(id)).status).toBe('seated')
      const cashSessionId = await cash(), bill = await lockedBill(row.id)
      expect((await post('cambiarEstadoReserva', { ...scope(), reservationId: id, status: 'finished' })).status).toBe(412)
      expect((await pay(bill, cashSessionId)).status).toBe(200)
      await ok('cambiarEstadoReserva', { ...scope(), reservationId: id, status: 'finished' })
      expect((await reservation(id)).status).toBe('finished')
      expect((await session(row.id)).status).toBe('closed')
    })

    it('concurrencia: un pedido y el bloqueo de la cuenta nunca dejan consumo fuera del cobro', async () => {
      for (const table of ['t1', 't2', 't3']) {
        const opened = await ok('abrirMesa', { ...scope(), tableIds: [table], guests: 2 })
        await consume(opened.sessionId); await serve(opened.sessionId)
        const billId = (await ok('abrirCuenta', { ...scope(), requestId: randomUUID().replaceAll('-', ''), target: { kind: 'session', id: opened.sessionId } })).billId as string
        // Se fuerza el solape: otra conexión retiene el cerrojo (sala o caja, según la vuelta) y las dos operaciones esperan
        // juntas; al soltarlo compiten de verdad por él, en vez de depender de que el reparto de tareas las cruce.
        const holder = await admin.connect(), name = table === 't2' ? 'pos' : 'sala'
        await holder.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [`${name}:${rid}:${lid}`])
        const racing = Promise.all([
          post('enviarPedido', { ...scope(), sessionId: opened.sessionId, lines: [item('bravas', 1)] }),
          post('prepararCobro', { ...scope(), requestId: randomUUID().replaceAll('-', ''), billId, expectedRevision: 1 })])
        await new Promise(resolve => setTimeout(resolve, 700))
        await holder.query('SELECT pg_advisory_unlock_all()'); holder.release()
        const [order, lock] = await racing
        expect([200, 412]).toContain(order.status)
        expect([200, 412]).toContain(lock.status)
        const bill = (await one('SELECT status,data FROM llenamos.pos_bills WHERE restaurant_id=$1 AND id=$2', [rid, billId]))
        const total = (await q('SELECT doc FROM llenamos.sala_order_lines WHERE restaurant_id=$1', [rid])).filter(r => r.doc.sessionId === opened.sessionId && r.doc.status !== 'cancelled' && r.doc.kind !== 'menu').reduce((n, r) => n + r.doc.totalCents, 0)
        // Si la cuenta quedó bloqueada, incluye todo el consumo que entró; si el pedido entró después, no se bloqueó con otro total.
        if (bill.status === 'locked') expect(bill.data.totalCents).toBe(total)
        if (order.status === 200 && bill.status === 'locked') expect(total).toBe(1300)
        if (order.status === 412) expect(total).toBe(650)
      }
    })

    it('la suma de la señal tiene su índice parcial', async () => {
      const index = await one("SELECT indexdef FROM pg_indexes WHERE schemaname='llenamos' AND indexname='pos_payments_deposit'")
      expect(index.indexdef).toMatch(/\(restaurant_id, location_id, external_id\) WHERE \(\(?method = 'deposit'/)
      const unique = await one("SELECT indexdef FROM pg_indexes WHERE schemaname='llenamos' AND indexname='pos_payments_external_once'")
      expect(unique.indexdef).toContain("method <> 'deposit'")
    })

    it('una reserva sentada con la cuenta en cobro no puede cambiar de mesas', async () => {
      const id = await book(120, 't1', 4)
      const opened = await ok('abrirMesa', { ...scope(), tableIds: ['t1'], guests: 2, reservationId: id })
      await consume(opened.sessionId); await serve(opened.sessionId)
      await lockedBill(opened.sessionId)
      const moved = await post('asignarMesas', { ...scope(), reservationId: id, tableIds: ['t2'] })
      expect(moved).toMatchObject({ status: 412, code: 'failed-precondition' })
      expect((await reservation(id)).data.tableIds).toEqual(['t1'])
    })

    it('cobro con la señal de la reserva: saldo, repetición, devolución y ventas del origen', async () => {
      await admin.query("INSERT INTO llenamos.platform_restaurants(restaurant_id,name,slug,plan_id,owner_email,integration_status) VALUES($1,'R',$1,'sala','o@example.test','{\"stripe\":{\"configured\":true,\"status\":\"configured\"}}')", [rid])
      const settings = (await one('SELECT data FROM llenamos.reservation_settings WHERE restaurant_id=$1', [rid])).data
      await admin.query('UPDATE llenamos.reservation_settings SET data=$3 WHERE restaurant_id=$1 AND location_id=$2', [rid, lid, JSON.stringify({ ...settings, deposit: { mode: 'perPerson', amountCents: 200, fromPartySize: 2 } })])
      const booked = await publicBooking(120, 40, { partySize: 2 })
      expect(booked.result.deposit).toMatchObject({ status: 'required', amountCents: 400 })
      const id = (await one('SELECT id FROM llenamos.reservations WHERE restaurant_id=$1 AND reference=$2', [rid, booked.result.reference])).id as string
      // Sin señal pagada no hay nada que descontar: se asigna mesa, se sienta y la caja lo rechaza.
      await ok('asignarMesas', { ...scope(), reservationId: id, tableIds: ['t1'] })
      expect(await recordCheckoutSession(app, rid, lid, id, 'cs_test_1')).toBe(true)
      expect(await applyDepositPayment(app, { restaurantId: rid, locationId: lid, reservationId: id, checkoutSessionId: 'cs_test_1', amountCents: 400, currency: 'eur' })).toBe('paid')
      expect((await reservation(id)).data.deposit.status).toBe('paid')
      const opened = await ok('abrirMesa', { ...scope(), tableIds: ['t1'], guests: 2, reservationId: id })
      await consume(opened.sessionId, 2); await serve(opened.sessionId)
      const cashSessionId = await cash(), bill = await lockedBill(opened.sessionId)
      expect(bill.total).toBeGreaterThan(900)
      const deposit = (amountCents: number, extra: Record<string, unknown> = {}) => pay(bill, cashSessionId, { method: 'deposit', amountCents, tenderedCents: 0, ...extra })
      expect((await deposit(100, { tipCents: 50 })).status).toBeGreaterThanOrEqual(400)
      expect((await deposit(300)).status).toBe(200)
      expect(await deposit(101)).toMatchObject({ status: 412, code: 'failed-precondition' })
      const second = await deposit(100)
      expect(second.status, JSON.stringify(second.body)).toBe(200)
      expect(await deposit(1)).toMatchObject({ status: 412, code: 'failed-precondition' })
      // Lo aplicado es exactamente lo cobrado, con el id de la sesión de pago como referencia.
      expect(await q("SELECT external_id,(data->>'amountCents')::int AS cents FROM llenamos.pos_payments WHERE restaurant_id=$1 AND method='deposit' ORDER BY (data->>'amountCents')::int", [rid])).toEqual([{ external_id: 'cs_test_1', cents: 100 }, { external_id: 'cs_test_1', cents: 300 }])
      // El resto se paga en efectivo, la cuenta queda saldada y las ventas del origen son el total.
      expect((await pay(bill, cashSessionId, { amountCents: bill.total - 400, tenderedCents: bill.total - 400 })).status).toBe(200)
      expect(Number((await one('SELECT sales_cents FROM llenamos.reservation_origins WHERE restaurant_id=$1 AND reservation_id=$2', [rid, id])).sales_cents)).toBe(bill.total)
      expect(await platform('payment.succeeded')).toBe(3)
      // La señal es dinero de Stripe: sin adaptador bancario la devolución no se da por hecha.
      const payment = await one("SELECT id FROM llenamos.pos_payments WHERE restaurant_id=$1 AND method='deposit' AND (data->>'amountCents')::int=300", [rid])
      expect(await ok('devolverCobro', { ...scope(), requestId: randomUUID().replaceAll('-', ''), paymentId: payment.id, amountCents: 300, tipCents: 0, reason: 'Prueba' })).toMatchObject({ status: 'not_configured' })
      await ok('cambiarEstadoMesa', { ...scope(), sessionId: opened.sessionId, status: 'closed' })
      expect((await reservation(id)).status).toBe('finished')
    })

    it('dos cobros simultáneos con la señal no pasan de lo cobrado', async () => {
      await admin.query("INSERT INTO llenamos.platform_restaurants(restaurant_id,name,slug,plan_id,owner_email,integration_status) VALUES($1,'R',$1,'sala','o@example.test','{\"stripe\":{\"configured\":true,\"status\":\"configured\"}}')", [rid])
      const settings = (await one('SELECT data FROM llenamos.reservation_settings WHERE restaurant_id=$1', [rid])).data
      await admin.query('UPDATE llenamos.reservation_settings SET data=$3 WHERE restaurant_id=$1 AND location_id=$2', [rid, lid, JSON.stringify({ ...settings, deposit: { mode: 'perPerson', amountCents: 200, fromPartySize: 2 } })])
      const booked = await publicBooking(120, 42, { partySize: 2 })
      const id = (await one('SELECT id FROM llenamos.reservations WHERE restaurant_id=$1 AND reference=$2', [rid, booked.result.reference])).id as string
      await ok('asignarMesas', { ...scope(), reservationId: id, tableIds: ['t1'] })
      await recordCheckoutSession(app, rid, lid, id, 'cs_test_2')
      await applyDepositPayment(app, { restaurantId: rid, locationId: lid, reservationId: id, checkoutSessionId: 'cs_test_2', amountCents: 400, currency: 'eur' })
      const opened = await ok('abrirMesa', { ...scope(), tableIds: ['t1'], guests: 2, reservationId: id })
      await consume(opened.sessionId, 2); await serve(opened.sessionId)
      const cashSessionId = await cash(), bill = await lockedBill(opened.sessionId)
      const results = await Promise.all([1, 2, 3].map(() => pay(bill, cashSessionId, { method: 'deposit', amountCents: 300, tenderedCents: 0 })))
      expect(results.filter(r => r.status === 200)).toHaveLength(1)
      expect(Number((await one("SELECT coalesce(sum((data->>'amountCents')::int),0) AS s FROM llenamos.pos_payments WHERE restaurant_id=$1 AND method='deposit'", [rid])).s)).toBe(300)
    })

    it('concurrencia entre la señal (webhook) y el cobro con la señal: o se cobra tras pagarse o se rechaza, nunca a medias', async () => {
      await admin.query("INSERT INTO llenamos.platform_restaurants(restaurant_id,name,slug,plan_id,owner_email,integration_status) VALUES($1,'R',$1,'sala','o@example.test','{\"stripe\":{\"configured\":true,\"status\":\"configured\"}}')", [rid])
      const settings = (await one('SELECT data FROM llenamos.reservation_settings WHERE restaurant_id=$1', [rid])).data
      await admin.query('UPDATE llenamos.reservation_settings SET data=$3 WHERE restaurant_id=$1 AND location_id=$2', [rid, lid, JSON.stringify({ ...settings, deposit: { mode: 'perPerson', amountCents: 200, fromPartySize: 2 } })])
      const booked = await publicBooking(120, 44, { partySize: 2 })
      const id = (await one('SELECT id FROM llenamos.reservations WHERE restaurant_id=$1 AND reference=$2', [rid, booked.result.reference])).id as string
      await ok('asignarMesas', { ...scope(), reservationId: id, tableIds: ['t1'] })
      await recordCheckoutSession(app, rid, lid, id, 'cs_race')
      const opened = await ok('abrirMesa', { ...scope(), tableIds: ['t1'], guests: 2, reservationId: id })
      await consume(opened.sessionId, 2); await serve(opened.sessionId)
      const cashSessionId = await cash(), bill = await lockedBill(opened.sessionId)
      // La señal llega justo cuando se intenta cobrar con ella: las dos esperan al cerrojo de reservas y compiten al soltarlo.
      const holder = await admin.connect()
      await holder.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [`reservas:${rid}:${lid}`])
      const racing = Promise.all([
        applyDepositPayment(app, { restaurantId: rid, locationId: lid, reservationId: id, checkoutSessionId: 'cs_race', amountCents: 400, currency: 'eur' }),
        pay(bill, cashSessionId, { method: 'deposit', amountCents: 300, tenderedCents: 0 })])
      await new Promise(resolve => setTimeout(resolve, 700))
      await holder.query('SELECT pg_advisory_unlock_all()'); holder.release()
      const [webhook, charge] = await racing
      expect(webhook).toBe('paid')
      expect((await reservation(id)).data.deposit.status).toBe('paid')
      const deposited = Number((await one("SELECT coalesce(sum((data->>'amountCents')::int),0) AS s FROM llenamos.pos_payments WHERE restaurant_id=$1 AND method='deposit' AND status='succeeded'", [rid])).s)
      // Si el cobro entró, fue con la señal ya pagada y por un importe que no pasa de lo cobrado; si no, no queda nada a medias.
      if (charge.status === 200) expect(deposited).toBe(300)
      else { expect(charge).toMatchObject({ status: 412, code: 'failed-precondition' }); expect(deposited).toBe(0) }
      expect(deposited).toBeLessThanOrEqual(400)
      // Y un segundo intento, con la señal ya pagada, siempre queda dentro del tope.
      if (charge.status !== 200) expect((await pay(bill, cashSessionId, { method: 'deposit', amountCents: 300, tenderedCents: 0 })).status).toBe(200)
    })

    it('la señal solo se aplica a la sesión de una reserva con señal pagada', async () => {
      const opened = await ok('abrirMesa', { ...scope(), tableIds: ['t1'], guests: 2 })
      await consume(opened.sessionId); await serve(opened.sessionId)
      const cashSessionId = await cash(), bill = await lockedBill(opened.sessionId)
      expect(await pay(bill, cashSessionId, { method: 'deposit', amountCents: 100, tenderedCents: 0 })).toMatchObject({ status: 412, code: 'failed-precondition' })
      const id = await book(120, 't2', 41)
      const withReservation = await ok('abrirMesa', { ...scope(), tableIds: ['t2'], guests: 2, reservationId: id })
      await consume(withReservation.sessionId); await serve(withReservation.sessionId)
      const second = await lockedBill(withReservation.sessionId)
      expect(await pay(second, cashSessionId, { method: 'deposit', amountCents: 100, tenderedCents: 0 })).toMatchObject({ status: 412, code: 'failed-precondition' })
      expect(await count('pos_payments')).toBe(0)
    })
  })

  describe('reservas', () => {
    it('el origen guarda canal, campaña, día y comensales con los datos de campañas y sigue el estado de la reserva', async () => {
      const slot = slotAt(180)
      const out = await publicBooking(180, 50, { partySize: 3, attribution: { utmSource: 'google', utmMedium: 'cpc', utmCampaign: 'otono', campaignId: 'camp-1' } })
      expect(out.status, JSON.stringify(out.body)).toBe(200)
      const id = (await one('SELECT id FROM llenamos.reservations WHERE restaurant_id=$1 AND reference=$2', [rid, out.result.reference])).id as string
      const origin = await one('SELECT * FROM llenamos.reservation_origins WHERE restaurant_id=$1 AND reservation_id=$2', [rid, id])
      expect(origin).toMatchObject({ channel: 'campaign', campaign_id: 'camp-1', party_size: 3, reservation_source: 'web', final_status: 'confirmed', location_id: lid })
      expect(await one('SELECT service_date::text AS day FROM llenamos.reservation_origins WHERE restaurant_id=$1 AND reservation_id=$2', [rid, id])).toEqual({ day: slot.date })
      // El cliente cancela por su enlace (ámbito público): el estado final también llega al origen.
      const link = { slug: rid, reference: out.result.reference, token: out.result.manageToken }
      expect((await post('gestionarReservaPublica', { ...link, action: 'cancel', website: '' }, null)).status).toBe(200)
      expect((await one('SELECT final_status FROM llenamos.reservation_origins WHERE reservation_id=$1', [id])).final_status).toBe('cancelled')
      expect(await platform('reservation.created')).toBe(1)
      expect(await platform('reservation.statusChanged')).toBe(1)
    })

    it('la reserva de la lista de espera también guarda su origen completo', async () => {
      const settings = (await one('SELECT data FROM llenamos.reservation_settings WHERE restaurant_id=$1', [rid])).data
      await admin.query('UPDATE llenamos.reservation_settings SET data=$3 WHERE restaurant_id=$1 AND location_id=$2', [rid, lid, JSON.stringify({ ...settings, waitlist: { enabled: true, offerMinutes: 30 } })])
      const slot = slotAt(240)
      const filled = await Promise.all(['t1', 't2', 't3'].map((t, i) => ok('crearReserva', { ...scope(), date: slot.date, time: slot.time, partySize: 4, guestName: `Lleno ${i}`, phone: phone(60 + i), source: 'phone', tableIds: [t], durationMinutes: 240 })))
      const join = await ok('apuntarseListaEspera', { slug: rid, locationId: lid, date: slot.date, from: slot.time, to: slot.time, partySize: 4, guestName: 'Espera Uno', phone: phone(70), email: null, language: 'es', source: 'web', website: '' }, null)
      await ok('cambiarEstadoReserva', { ...scope(), reservationId: filled[0]!.reservationId, status: 'cancelled' })
      const notice = await one("SELECT payload FROM llenamos.outbox WHERE restaurant_id=$1 AND payload->>'waitlistId'=$2 AND payload->>'template'='waitlist_offer' LIMIT 1", [rid, join.waitlistId])
      const offerToken = new URL(notice.payload.data.offerUrl).searchParams.get('t')!
      const accepted = await ok('aceptarOfertaListaEspera', { slug: rid, waitlistId: join.waitlistId, token: offerToken, website: '' }, null)
      const id = (await one('SELECT id FROM llenamos.reservations WHERE restaurant_id=$1 AND reference=$2', [rid, accepted.reference])).id as string
      expect(await one('SELECT channel,reservation_source,party_size,final_status,service_date::text AS day FROM llenamos.reservation_origins WHERE restaurant_id=$1 AND reservation_id=$2', [rid, id]))
        .toMatchObject({ reservation_source: 'waitlist', party_size: 4, day: slot.date })
      expect(await platform('reservation.created')).toBe(4)
    })

    it('readWindow con el rol de ejecución y RLS: límite exacto de ±48 h, sin forzar el plan', async () => {
      const focus = Date.parse('2031-03-10T12:00:00Z'), HOUR = 3_600_000, hash = 'a'.repeat(64)
      let n = 0
      const insert = (at: number, status = 'confirmed') => admin.query(
        `INSERT INTO llenamos.reservations(restaurant_id,location_id,id,customer_id,reference,start_at,status,table_ids,manage_token_hash,data)
         SELECT $1,$2,$3,repeat('c',20),$4,$5,$6,'{}',$8,$7::jsonb`, [rid, lid, `w${++n}`, `W${String(n).padStart(5, '0')}`, new Date(at), status, JSON.stringify({ guestName: 'X', phone: phone(1), email: null, language: 'es', partySize: 2, startAt: at, durationMinutes: 90, status, tableIds: [], suggestedTableIds: [], suggestionReason: null, source: 'phone', notes: '', guestNotes: '', customerId: 'c'.repeat(20), manageTokenHash: hash, reference: 'AAAAAA', deposit: { status: 'none', amountCents: 0, checkoutSessionId: null }, history: [], createdBy: null }), hash])
      const ids = {
        menos48: (await insert(focus - 48 * HOUR), n), menos48Fuera: (await insert(focus - 48 * HOUR - 1), n), dentro: (await insert(focus + 48 * HOUR - 1), n),
        mas48: (await insert(focus + 48 * HOUR), n), cancelada: (await insert(focus, 'cancelled'), n),
      }
      const read = (instants: number[]) => withIdentity(app, token('owner'), rid, async client => (await readWindow(client, rid, lid, instants)).map(r => r.id))
      // El límite inferior entra, el superior no; las canceladas no cuentan.
      expect((await read([focus])).sort()).toEqual([`w${ids.menos48}`, `w${ids.dentro}`].sort())
      // Varios instantes lejanos: no se lee el hueco que queda entre ellos.
      await insert(focus + 30 * 24 * HOUR)
      expect(await read([focus, focus + 60 * 24 * HOUR])).not.toContain(`w${n}`)
      // Otro restaurante con el mismo local no ve estas filas.
      const other = await seedOther()
      expect(await withIdentity(app, token('owner'), other, async client => (await readWindow(client, other, lid, [focus])).length)).toBe(0)
      // Histórico alrededor de la fecha: el plan natural usa un índice por local y día y no recorre la tabla.
      await admin.query(`INSERT INTO llenamos.reservations(restaurant_id,location_id,id,customer_id,reference,start_at,status,table_ids,manage_token_hash,data)
        SELECT $1,$2,'h'||g,repeat('c',20),'H'||lpad(g::text,5,'0'),timestamptz '2031-01-01' + (g||' hours')::interval,'finished','{}',repeat('a',64),'{}'::jsonb FROM generate_series(1,6000) g`, [rid, lid])
      await admin.query('ANALYZE llenamos.reservations')
      const plan = await withIdentity(app, token('owner'), rid, async client => JSON.stringify((await client.query(`EXPLAIN (FORMAT JSON) ${READ_WINDOW_SQL}`, readWindowParams(rid, lid, [focus]))).rows[0]['QUERY PLAN']))
      expect(plan).toMatch(/reservations_(status_)?day/)
      expect(plan).not.toContain('Seq Scan')
    })
  })
})
