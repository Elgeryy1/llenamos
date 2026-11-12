import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import * as core from '@llenamos/core'
import { withIdentity } from '../../database.js'
import type { IdentityToken } from '../../auth.js'
import { apiServer } from '../../server.js'
import { migrationSql } from '../../test-migrations.js'
import { MODULES } from '../index.js'
import { clearMenuCache } from './menu-public.js'
import { carta as cartaLive, servicio as servicioLive } from './live.js'

const source = process.env.TEST_POSTGRES_URL
const enabled = process.env.TEST_POSTGRES_API === '1' && !!source
const token = (uid: string, platformClaim = false): IdentityToken => ({ uid, sessionVersion: 'a'.repeat(32), authTime: 100, platformClaim })
const lid = 'centro'
const today = () => core.horaLocal(Date.now(), 'Europe/Madrid').fecha
const tomorrow = () => core.sumarDias(today(), 1)

describe.skipIf(!enabled)('Sala y cocina en PostgreSQL real', { timeout: 30_000 }, () => {
  process.env.SALA_SECRET_KEY = 'ab'.repeat(32)
  // El servidor confía en la cabecera del conector solo desde loopback (el cliente de pruebas).
  process.env.TRUSTED_IP_HEADER = 'x-test-ip'; process.env.TRUSTED_PROXY_ADDRESSES = '127.0.0.1,::1'
  let admin: Pool, bootstrap: Pool, app: Pool, owned = false, server: ReturnType<typeof apiServer>, base: string
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12), database = `llenamos_api_test_sala_${suffix}`, runtime = `llenamos_api_sala_${suffix}`
  let rid: string, other: string, seq = 0
  const uids = ['owner', 'manager', 'waiter', 'waiter2', 'kitchen', 'bar', 'limited', 'stranger', 'platform']

  let nextIp = 0
  /** Cada llamada sale de una IP distinta salvo que se fije: los límites por IP no se mezclan entre pruebas. */
  async function http(name: string, data: unknown, uid: string | null = 'owner', ip = `198.51.100.${(++nextIp % 250) + 1}`) {
    const response = await fetch(`${base}/v1/operations/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-ip': ip, ...(uid ? { Authorization: `Bearer ${uid}` } : {}) }, body: JSON.stringify({ data }) })
    return { status: response.status, body: await response.json() as { result?: any; error?: { code: string } } }
  }
  async function call<N extends keyof typeof core.CALLABLE_SCHEMAS_FASE2>(name: N, data: unknown, uid: string | null = 'owner'): Promise<core.CallableOutput<N>> {
    const r = await http(name, data, uid)
    if (r.status !== 200) throw Object.assign(new Error(`${name}: ${r.status} ${r.body.error?.code}`), { status: r.status, code: r.body.error?.code })
    return r.body.result
  }
  const staff = () => ({ restaurantId: rid, locationId: lid })
  const item = (itemId = 'bravas', quantity = 1) => ({ kind: 'item', itemId, quantity })
  const open = (tableIds = ['t1'], uid = 'owner') => call('abrirMesa', { ...staff(), tableIds, guests: 2 }, uid)
  const order = (sessionId: string, lines = [item()], extra: object = {}) => call('enviarPedido', { ...staff(), sessionId, lines, ...extra })
  const lines = async (sessionId?: string) => (await admin.query('SELECT id,doc FROM llenamos.sala_order_lines WHERE restaurant_id=$1', [rid])).rows.map(r => ({ id: r.id as string, ...core.OrderLineSchema.parse(r.doc) })).filter(l => !sessionId || l.sessionId === sessionId)
  const doc = async (table: string, id: string, restaurant = rid) => (await admin.query(`SELECT doc FROM llenamos.${table} WHERE restaurant_id=$1 AND id=$2`, [restaurant, id])).rows[0]?.doc
  const count = async (table: string, restaurant = rid) => Number((await admin.query(`SELECT count(*) FROM llenamos.${table} WHERE restaurant_id=$1`, [restaurant])).rows[0].count)
  async function qr(tableId = 't1') {
    const { tokens } = await call('regenerarQrMesa', { ...staff(), tableIds: [tableId] })
    return { slug: rid, locationId: lid, tableId, token: tokens[0]!.token }
  }
  async function serve(sessionId: string) {
    const live = (await lines(sessionId)).filter(l => l.kind !== 'menu' && l.status !== 'served' && l.status !== 'cancelled')
    if (live.some(l => l.status === 'held')) await call('marcharPase', { ...staff(), sessionId, course: 'all' })
    if (live.length) await call('cambiarEstadoLineas', { ...staff(), lineIds: live.map(l => l.id), status: 'served' })
  }
  async function seed(id: string, members: Record<string, [string, string[]]>) {
    await admin.query("INSERT INTO llenamos.restaurants(id,name,slug,plan,active_modules) VALUES($1,$2,$1,'sala','{reservations,floor,kitchen}')", [id, `Restaurante ${id}`])
    for (const l of [lid, 'otro']) await admin.query('INSERT INTO llenamos.locations(restaurant_id,id,name,slug,address,phone) VALUES($1,$2,$2,$2,$3,$4)', [id, l, 'Calle Mayor 1', '600000000'])
    for (const [uid, [role, locations]] of Object.entries(members)) await admin.query('INSERT INTO llenamos.memberships(restaurant_id,uid,role,active,display_name,email,location_ids) VALUES($1,$2::text,$3,true,$2::text,$4,$5)', [id, uid, role, `${uid}@${id}.test`, locations])
    await admin.query("INSERT INTO llenamos.dining_areas(restaurant_id,location_id,id,data) VALUES($1,$2,'sala',$3) ON CONFLICT DO NOTHING", [id, lid, JSON.stringify({ name: 'Sala principal', sortOrder: 0 })])
    for (let i = 1; i <= 6; i++) await admin.query('INSERT INTO llenamos.dining_tables(restaurant_id,location_id,id,area_id,data) VALUES($1,$2,$3,$4,$5)', [id, lid, `t${i}`, 'sala', JSON.stringify({ name: `S${i}`, areaId: 'sala', seats: 8, enabled: true, joinableWith: ['t1', 't2', 't3', 't4', 't5', 't6'].filter(t => t !== `t${i}`), shape: 'rect', x: 10, y: 10, w: 10, h: 10 })])
    const demo = core.demoMenu(), reservations = core.defaultReservationSettings(), shifts = [{ name: 'Servicio', from: '00:00', lastEntry: '23:45' }]
    reservations.week = { mon: shifts, tue: shifts, wed: shifts, thu: shifts, fri: shifts, sat: shifts, sun: shifts }
    demo.settings.selfOrder.enabled = true; demo.settings.selfOrder.requireApproval = false; demo.settings.takeaway.enabled = true; demo.settings.takeaway.publicOrdering = true
    await admin.query('INSERT INTO llenamos.reservation_settings(restaurant_id,location_id,data) VALUES($1,$2,$3)', [id, lid, JSON.stringify(reservations)])
    await admin.query("INSERT INTO llenamos.sala_settings(restaurant_id,location_id,kind,doc) VALUES($1,$2,'floor',$3)", [id, lid, JSON.stringify(demo.settings)])
    for (const [table, rows] of Object.entries({ sala_menu_categories: demo.categories, sala_menu_items: demo.items, sala_daily_menus: demo.dailyMenus, sala_stations: demo.stations }))
      for (const [itemId, value] of Object.entries(rows)) await admin.query(`INSERT INTO llenamos.${table}(restaurant_id,location_id,id,doc) VALUES($1,$2,$3,$4)`, [id, lid, itemId, JSON.stringify(value)])
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
    for (const uid of uids) await admin.query('INSERT INTO llenamos.identities(uid,session_version,tokens_valid_after,locked,platform_operator) VALUES($1,$2,to_timestamp(100),false,$3)', [uid, 'a'.repeat(32), uid === 'platform'])
    const identities = Object.fromEntries(uids.map(uid => [uid, token(uid, uid === 'platform')]))
    server = apiServer(app, async value => identities[value] ?? token(value), process.env.SALA_DEBUG ? e => console.error(JSON.stringify(e)) : () => undefined)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  }, 60_000)
  afterAll(async () => {
    await new Promise(resolve => server?.close(resolve))
    // DROP ... WITH (FORCE) cierra conexiones que el pool aún no ha soltado; solo ese aviso es esperable.
    for (const pool of [app, admin]) pool?.on('error', error => { if ((error as { code?: string }).code !== '57P01') throw error })
    await app?.end(); await admin?.end()
    if (owned) await bootstrap.query(`DROP DATABASE ${database} WITH (FORCE)`)
    await bootstrap?.end()
  }, 30_000)
  beforeEach(async () => {
    clearMenuCache()
    rid = `sala-${++seq}-${suffix}`; other = `otro-${seq}-${suffix}`
    await seed(rid, { owner: ['owner', []], manager: ['manager', []], waiter: ['waiter', []], waiter2: ['waiter', []], kitchen: ['kitchen', []], bar: ['bar', []], limited: ['owner', ['otro']] })
    await seed(other, { stranger: ['owner', []] })
  }, 30_000)

  /* Cola sin conexión (servicio `sync`, ejecutores de sala). */
  const device = (n: number) => `tablet-${n}-${suffix}`.slice(0, 40).padEnd(16, '0')
  const syncOp = async (name: string, data: unknown, uid: string | null = 'waiter') => http(name, data, uid)
  async function versions(entities: Array<{ kind: string; id: string }>, uid = 'waiter', deviceId = device(1)) {
    const r = await syncOp('prepararSinConexion', { actorUid: uid, restaurantId: rid, locationId: lid, deviceId, entities }, uid)
    return r
  }
  const offline = (operation: string, payload: Record<string, unknown>, preconditions: unknown[], extra: { uid?: string; deviceId?: string; sequence?: number; commandId?: string } = {}) => core.OfflineCommandSchema.parse({
    actorUid: extra.uid ?? 'waiter', restaurantId: rid, locationId: lid, deviceId: extra.deviceId ?? device(1), commandId: extra.commandId ?? randomUUID(), sequence: extra.sequence ?? 1, clientCreatedAt: Date.now(),
    operation, payload: { restaurantId: rid, locationId: lid, ...payload }, preconditions })
  async function orderCommand(sessionId: string, extra: { sequence?: number; commandId?: string; version?: string; deviceId?: string } = {}) {
    const session = core.TableSessionSchema.parse(await doc('sala_table_sessions', sessionId))
    const demo = core.demoMenu()
    const lines = core.EnviarPedidoInputSchema.shape.lines.parse([item('bravas', 2)])
    const priced = core.priceOrder(lines as never, { items: demo.items, dailyMenus: demo.dailyMenus } as never, { channel: 'staff', now: Date.now(), timezone: 'Europe/Madrid', expectedTotalCents: undefined })
    if (!priced.ok) throw new Error('precio de prueba')
    const prep = await versions([{ kind: 'session', id: sessionId }], 'waiter', extra.deviceId)
    const commandId = extra.commandId ?? randomUUID()
    return offline('enviarPedido', { sessionId, takeawayId: null, lines, fire: 'auto', note: '', requestId: commandId, expectedDestination: JSON.stringify([sessionId, [...session.tableIds].sort(), session.openedAt, session.customerId, session.guests, session.status]),
      expectedPrices: core.orderPriceSignature(priced.lines), expectedTotalCents: priced.totalCents }, [{ kind: 'session', id: sessionId, version: extra.version ?? prep.body.result.versions[0].version }], { commandId, sequence: extra.sequence, deviceId: extra.deviceId })
  }

  it('la cola sin conexión aplica un pedido una sola vez aunque se repita y devuelve el mismo recibo', async () => {
    const { sessionId } = await open()
    const command = await orderCommand(sessionId)
    const first = await syncOp('sincronizarComando', { command })
    expect(first.status).toBe(200)
    expect(first.body.result.receipt.result).toMatchObject({ status: 'applied' })
    const again = await syncOp('sincronizarComando', { command })
    expect(again.body.result.receipt).toEqual(first.body.result.receipt)
    expect((await lines(sessionId)).filter(l => l.itemId === 'bravas')).toHaveLength(1)
    const recovered = await syncOp('recuperarComando', { actorUid: 'waiter', restaurantId: rid, locationId: lid, deviceId: device(1), commandId: command.commandId })
    expect(recovered.body.result.receipt.result.status).toBe('applied')
    // El mismo identificador con otro contenido no se acepta.
    const other = { ...command, clientCreatedAt: command.clientCreatedAt + 1 }
    expect((await syncOp('sincronizarComando', { command: other })).status).toBe(409)
  })
  it('una versión caducada es un conflicto y no deja ningún efecto', async () => {
    const { sessionId } = await open()
    const command = await orderCommand(sessionId)
    await order(sessionId) // otro dispositivo cambia la mesa antes de sincronizar
    const before = (await lines(sessionId)).length
    const r = await syncOp('sincronizarComando', { command })
    expect(r.body.result.receipt.result).toMatchObject({ status: 'conflict', code: 'stale_version' })
    expect((await lines(sessionId)).length).toBe(before)
    // El conflicto bloquea lo posterior del dispositivo hasta descartarlo con motivo.
    const next = await orderCommand(sessionId, { sequence: 2 })
    expect((await syncOp('sincronizarComando', { command: next })).status).toBe(503)
    const discarded = await syncOp('descartarComando', { command, requestId: randomUUID(), reason: 'Lo repito a mano' })
    expect(discarded.body.result.receipt.result.status).toBe('discarded')
  })
  it('las versiones cambian con la mesa, y cocina no ve mesas ni pedidos de otros', async () => {
    const { sessionId } = await open()
    const a = (await versions([{ kind: 'session', id: sessionId }])).body.result
    await order(sessionId)
    const b = (await versions([{ kind: 'session', id: sessionId }])).body.result
    expect(b.versions[0].version).not.toBe(a.versions[0].version)
    expect(b.contentHashes[0].hash).toMatch(/^[a-f0-9]{64}$/)
    expect((await versions([{ kind: 'session', id: sessionId }], 'kitchen')).status).toBe(403)
    expect((await versions([{ kind: 'session', id: 'no-existe' }])).status).toBe(404)
  })
  it('la huella de contenido de cada entidad coincide con la de la lectura en vivo, o la cola local no podría usar sus versiones', async () => {
    const { sessionId } = await open()
    await order(sessionId)
    const { taskId } = await call('crearTarea', { ...staff(), sessionId, tableIds: [], note: 'Llevar pan', claim: false })
    const hash = (value: unknown) => core.sha256Hex(core.canonicalJson(JSON.parse(JSON.stringify(value))))
    const snapshot = (live: typeof servicioLive, input: object) => withIdentity(app, token('owner'), rid, client => live.snapshot(client, input, { uid: 'owner' })) as Promise<any>
    const service = await snapshot(servicioLive, staff()), menu = await snapshot(cartaLive, staff())
    const line = service.lines.find((l: any) => l.stationKind === 'kitchen')
    const entities = [{ kind: 'session', id: sessionId, observed: service.sessions.find((x: any) => x.id === sessionId) }, { kind: 'line', id: line.id, observed: line },
      { kind: 'task', id: taskId, observed: service.tasks.find((x: any) => x.id === taskId) }, { kind: 'item', id: 'bravas', observed: menu.items.find((x: any) => x.id === 'bravas') }]
    for (const e of entities) expect(e.observed, `${e.kind} presente en la lectura en vivo`).toBeTruthy()
    const prepared = (await versions(entities.map(({ kind, id }) => ({ kind, id })), 'owner')).body.result
    entities.forEach((e, i) => { expect(prepared.contentHashes[i]).toMatchObject({ kind: e.kind, id: e.id }); expect(prepared.contentHashes[i].hash, e.kind).toBe(hash(e.observed)) })
  })
  it('un documento antiguo que no cumple el esquema no tumba la preparación del lote', async () => {
    const { sessionId } = await open()
    await admin.query("UPDATE llenamos.sala_table_sessions SET doc=doc-'guests' WHERE restaurant_id=$1 AND id=$2", [rid, sessionId])
    const r = await versions([{ kind: 'session', id: sessionId }])
    expect(r.status).toBe(200)
    expect(r.body.result.versions[0].version).toMatch(/^[a-f0-9]{64}$/)
  })
  it('cambia el estado de una línea y deja una tarea cogida por una sola persona, con roles y restaurantes aislados', async () => {
    const { sessionId } = await open()
    await order(sessionId)
    const target = (await lines(sessionId)).find(l => l.stationKind === 'kitchen')!
    expect(target).toBeTruthy()
    // La barra no ve las líneas de cocina; cocina sí.
    expect((await versions([{ kind: 'line', id: target.id }], 'bar')).status).toBe(403)
    const prep = (await versions([{ kind: 'line', id: target.id }], 'kitchen')).body
    const change = offline('cambiarEstadoLineas', { lineIds: [target.id], status: 'preparing' }, [{ kind: 'line', id: target.id, version: prep.result.versions[0].version }], { uid: 'kitchen', deviceId: device(2) })
    const applied = await syncOp('sincronizarComando', { command: change }, 'kitchen')
    expect(applied.body.result.receipt.result.status).toBe('applied')
    expect((await lines(sessionId)).find(l => l.id === target.id)!.status).toBe('preparing')
    // El uid del comando debe ser el de quien llama; un extraño de otro restaurante no sincroniza en este.
    const forged = offline('cambiarEstadoLineas', { lineIds: [target.id], status: 'ready' }, [{ kind: 'line', id: target.id, version: 'x' }], { uid: 'waiter2', deviceId: device(3) })
    expect((await syncOp('sincronizarComando', { command: forged }, 'waiter')).status).toBe(403)
    expect((await syncOp('sincronizarComando', { command: forged }, 'stranger')).status).toBe(403)
    expect(Number((await admin.query('SELECT count(*) FROM llenamos.sync_receipts WHERE command_id=$1', [forged.commandId])).rows[0].count)).toBe(0)
    expect((await lines(sessionId)).find(l => l.id === target.id)!.status).toBe('preparing')
  })
  it('dos dispositivos reclaman la misma tarea: gana uno y el otro recibe «ya va otra persona»', async () => {
    const { sessionId } = await open()
    const { taskId } = await call('crearTarea', { ...staff(), sessionId, tableIds: [], note: 'Llevar pan', claim: false })
    const claim = async (uid: string, n: number) => {
      const prep = (await versions([{ kind: 'task', id: taskId }], uid, device(n))).body
      return syncOp('sincronizarComando', { command: offline('cambiarEstadoTarea', { taskId, action: 'claim' }, [{ kind: 'task', id: taskId, version: prep.result.versions[0].version }], { uid, deviceId: device(n) }) }, uid)
    }
    const [x, y] = await Promise.all([claim('waiter', 4), claim('waiter2', 5)])
    const results = [x, y].map(r => r.body.result.receipt.result)
    expect(results.filter(r => r.status === 'applied' && r.response.result === 'ok').length).toBe(1)
    expect((await doc('sala_floor_tasks', taskId)).claimedBy).toMatch(/^waiter2?$/)
  })

  it('registra las 34 operaciones del contrato más la carta pública, sin duplicados', () => {
    const names = MODULES.find(m => m.name === 'sala')!.operations.map(([name]) => name)
    expect(names.filter(n => n in core.CALLABLES_FASE2).sort()).toEqual(Object.keys(core.CALLABLES_FASE2).sort())
    expect(names).toContain('verCartaPublica')
  })

  it('guarda carta con versión de precio, ordena, agota y respeta roles y estaciones', async () => {
    const demo = core.demoMenu()
    const bravas = core.MenuItemEditableSchema.parse({ ...demo.items.bravas })
    expect(await call('guardarPlato', { ...staff(), itemId: 'bravas', item: { ...bravas, priceCents: 700 } })).toMatchObject({ ok: true, priceChanged: true, version: 2 })
    expect(await call('guardarPlato', { ...staff(), itemId: 'bravas', item: { ...bravas, priceCents: 700 } })).toMatchObject({ priceChanged: false, version: 2 })
    const created = await call('guardarCategoriaCarta', { ...staff(), categoryId: null, category: core.MenuCategorySchema.parse({ ...Object.values(demo.categories)[0], sortOrder: 9 }) })
    await call('ordenarCarta', { ...staff(), categories: [{ id: created.categoryId, sortOrder: 1 }], items: [] })
    await expect(call('guardarPlato', { ...staff(), itemId: 'bravas', item: bravas }, 'waiter')).rejects.toMatchObject({ status: 403, code: 'permission-denied' })
    await expect(call('guardarPlato', { ...staff(), itemId: null, item: { ...bravas, categoryId: 'no-existe' } })).rejects.toMatchObject({ status: 404 })
    expect(await call('marcarAgotado', { ...staff(), itemId: 'bravas', soldOut: true }, 'waiter')).toMatchObject({ soldOut: true })
    // El personal de barra solo toca platos de su estación.
    const barItem = Object.entries(demo.items).find(([, v]) => demo.stations[v.stationId ?? '']?.kind === 'bar')?.[0]
    const kitchenItem = Object.entries(demo.items).find(([, v]) => demo.stations[v.stationId ?? '']?.kind === 'kitchen')?.[0]
    if (barItem) expect(await call('marcarAgotado', { ...staff(), itemId: barItem, soldOut: true }, 'bar')).toMatchObject({ ok: true })
    if (kitchenItem) await expect(call('marcarAgotado', { ...staff(), itemId: kitchenItem, soldOut: true }, 'bar')).rejects.toMatchObject({ status: 403 })
    const events = (await admin.query("SELECT topic FROM llenamos.events WHERE restaurant_id=$1", [rid])).rows.map(r => r.topic)
    expect(events).toEqual(expect.arrayContaining(['carta.plato', 'carta.categoria']))
  })

  it('recorre mesa, comanda, cocina, servicio, recogida y cierre con totales y eventos', async () => {
    const { sessionId } = await open(['t1'], 'waiter')
    const sent = await order(sessionId, [item('bravas', 2), item('agua')])
    if (sent.status !== 'sent') throw new Error('Pedido rechazado')
    expect(sent.totalCents).toBeGreaterThan(0)
    const live = await lines(sessionId)
    expect(live.length).toBe(2)
    const cooking = live.filter(l => l.stationKind === 'kitchen')
    expect(cooking.length).toBeGreaterThan(0)
    {
      await call('cambiarEstadoLineas', { ...staff(), lineIds: cooking.map(l => l.id), status: 'preparing' }, 'kitchen')
      await call('cambiarEstadoLineas', { ...staff(), lineIds: cooking.map(l => l.id), status: 'ready' }, 'kitchen')
      const pickup = (await admin.query("SELECT id,doc FROM llenamos.sala_floor_tasks WHERE restaurant_id=$1 AND doc->>'type'='pickup'", [rid])).rows
      expect(pickup.length).toBe(1)
      expect((await call('cambiarEstadoTarea', { ...staff(), taskId: pickup[0].id, action: 'claim' }, 'waiter'))).toMatchObject({ result: 'ok', claimedBy: 'waiter' })
      await expect(call('cambiarEstadoTarea', { ...staff(), taskId: pickup[0].id, action: 'claim' }, 'waiter2')).resolves.toMatchObject({ result: 'taken', claimedBy: 'waiter' })
    }
    await expect(call('cambiarEstadoMesa', { ...staff(), sessionId, status: 'closed' })).rejects.toMatchObject({ code: 'failed-precondition' })
    await serve(sessionId)
    expect(await call('cambiarEstadoMesa', { ...staff(), sessionId, status: 'closed' })).toMatchObject({ status: 'closed', totalCents: sent.sessionTotalCents })
    expect(core.TableSessionSchema.parse(await doc('sala_table_sessions', sessionId))).toMatchObject({ status: 'closed', totalCents: sent.sessionTotalCents })
    const topics = new Set((await admin.query('SELECT topic FROM llenamos.events WHERE restaurant_id=$1', [rid])).rows.map(r => r.topic))
    for (const topic of ['sala.sesion', 'sala.pedido', 'sala.linea']) expect(topics).toContain(topic)
    expect((await admin.query('SELECT payload FROM llenamos.events WHERE restaurant_id=$1', [rid])).rows.every(r => !JSON.stringify(r.payload).match(/Ana|600/))).toBe(true)
    // Una mesa cerrada se puede volver a abrir sin leer el histórico completo.
    expect(await call('cambiarEstadoMesa', { ...staff(), sessionId, status: 'open' })).toMatchObject({ status: 'open' })
  })

  it('no abre la misma mesa dos veces ni con solapes aunque lleguen a la vez', async () => {
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => open(['t3'])))
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(await count('sala_table_sessions')).toBe(1)
    await expect(open(['t3', 't4'])).rejects.toMatchObject({ code: 'failed-precondition' })
    const joined = await open(['t4'])
    expect(await call('juntarMesas', { ...staff(), sessionId: joined.sessionId, tableIds: ['t5'] })).toMatchObject({ tableIds: ['t4', 't5'] })
    expect(await call('moverMesa', { ...staff(), sessionId: joined.sessionId, tableIds: ['t6'] })).toMatchObject({ tableIds: ['t6'] })
  })

  it('une y separa mesas moviendo las líneas elegidas a la nueva sesión', async () => {
    const a = await open(['t1']), b = await open(['t2'])
    await order(a.sessionId, [item('bravas')]); await order(b.sessionId, [item('agua')])
    const merged = await call('juntarMesas', { ...staff(), sessionId: a.sessionId, tableIds: ['t2'] })
    expect(merged.mergedSessionIds).toEqual([b.sessionId])
    expect((await lines(a.sessionId)).length).toBe(2)
    const [moved] = (await lines(a.sessionId)).filter(l => l.name.es === 'Agua' || l.itemId === 'agua')
    const split = await call('separarMesas', { ...staff(), sessionId: a.sessionId, tableIds: ['t2'], lineIds: moved ? [moved.id] : [], guests: 1 })
    expect(split.newSessionId).not.toBeNull()
    if (moved) expect((await lines(split.newSessionId!)).map(l => l.id)).toEqual([moved.id])
  })

  it('recupera el resultado de un envío concurrente sin descontar raciones de nuevo', async () => {
    await call('guardarRaciones', { ...staff(), itemId: 'bravas', remaining: 2 })
    const { sessionId } = await open()
    const input = { sessionId, lines: [item()], requestId: randomUUID() }
    const [a, b] = await Promise.all([order(input.sessionId, input.lines, { requestId: input.requestId }), order(input.sessionId, input.lines, { requestId: input.requestId })])
    expect(a).toEqual(b)
    expect(await count('sala_orders')).toBe(1)
    expect((await doc('sala_menu_items', 'bravas')).portions.remaining).toBe(1)
    await serve(sessionId)
    await call('cambiarEstadoMesa', { ...staff(), sessionId, status: 'closed' })
    expect(await order(input.sessionId, input.lines, { requestId: input.requestId })).toEqual(a)
    expect((await doc('sala_menu_items', 'bravas')).portions.remaining).toBe(1)
    await expect(order(input.sessionId, [item('agua')], { requestId: input.requestId })).rejects.toMatchObject({ code: 'failed-precondition' })
    // Sin raciones suficientes rechaza sin tocar nada.
    const second = await open()
    expect(await order(second.sessionId, [item('bravas', 3)])).toMatchObject({ status: 'rejected' })
    expect(await count('sala_orders')).toBe(1)
  })

  it('QR de mesa: token verificado antes del contexto, pedido repetible y token falso o rotado rechazado', async () => {
    const { sessionId } = await open()
    const link = await qr()
    const view = await call('verMesaPublica', link, null)
    expect(view).toMatchObject({ canOrder: true, session: { sessionId } })
    const input = { ...link, sessionId, lines: [item()], expectedTotalCents: view.session!.totalCents + 650, expectedDestination: view.destination, language: 'es', requestId: randomUUID() }
    const a = await call('pedirDesdeMesa', input, null)
    expect(a).toMatchObject({ status: 'sent' })
    await call('moverMesa', { ...staff(), sessionId, tableIds: ['t2'] })
    expect(await call('pedirDesdeMesa', input, null)).toEqual(a)
    expect(await count('sala_orders')).toBe(1)
    await expect(call('verMesaPublica', { ...link, token: link.token.slice(0, -2) + 'xx' }, null)).rejects.toMatchObject({ status: 403 })
    const recovered = await call('recuperarQrMesa', { ...staff(), tableIds: ['t1'] })
    expect(recovered.tokens[0]!.token).toBe(link.token)
    await call('regenerarQrMesa', { ...staff(), tableIds: ['t1'] })
    await expect(call('pedirDesdeMesa', input, null)).rejects.toMatchObject({ status: 403 })
    await call('revocarQrMesa', { ...staff(), tableIds: ['t1'] })
    expect((await call('recuperarQrMesa', { ...staff(), tableIds: ['t1'] })).unavailable).toEqual([{ tableId: 't1', reason: 'revoked' }])
    // Un enlace de otro restaurante no vale aquí.
    await expect(call('verMesaPublica', { ...link, slug: other }, null)).rejects.toMatchObject({ status: 403 })
  })

  it('el pedido de mesa con aprobación crea tarea y se acepta o rechaza con permiso', async () => {
    const floor = { ...core.demoMenu().settings, selfOrder: { ...core.demoMenu().settings.selfOrder, enabled: true, requireApproval: true } }
    await admin.query("UPDATE llenamos.sala_settings SET doc=$2 WHERE restaurant_id=$1 AND kind='floor'", [rid, JSON.stringify(floor)])
    const { sessionId } = await open()
    const link = await qr()
    const view = await call('verMesaPublica', link, null)
    const result = await call('pedirDesdeMesa', { ...link, sessionId, lines: [item()], expectedTotalCents: 650, expectedDestination: view.destination, language: 'es' }, null)
    expect(result).toMatchObject({ status: 'pending_approval' })
    if (result.status !== 'pending_approval') throw new Error('Debía quedar pendiente')
    expect((await lines(sessionId))[0]!.status).toBe('pending')
    await expect(call('decidirPedido', { ...staff(), orderId: result.orderId, decision: 'reject' })).rejects.toMatchObject({ code: 'failed-precondition' })
    expect(await call('decidirPedido', { ...staff(), orderId: result.orderId, decision: 'accept' }, 'waiter')).toMatchObject({ status: 'accepted' })
    await expect(call('decidirPedido', { ...staff(), orderId: result.orderId, decision: 'accept' })).rejects.toMatchObject({ code: 'failed-precondition' })
    await expect(call('decidirPedido', { ...staff(), orderId: result.orderId, decision: 'accept' }, 'kitchen')).rejects.toMatchObject({ status: 403 })
  })

  it('avisos de mesa agrupan motivos y piden la cuenta sin perder dueño ni plazo', async () => {
    const { sessionId } = await open()
    const link = { ...(await qr()), sessionId, kind: 'call_waiter' }
    const a = await call('avisarDesdeMesa', { ...link, reason: 'water', note: 'Sin hielo' }, null)
    await call('cambiarEstadoTarea', { ...staff(), taskId: a.taskId, action: 'claim' }, 'waiter')
    const before = await doc('sala_floor_tasks', a.taskId)
    const b = await call('avisarDesdeMesa', { ...link, reason: 'napkins', note: 'Dos' }, null)
    expect(b.taskId).toBe(a.taskId)
    const after = await doc('sala_floor_tasks', a.taskId)
    expect(after.claimedBy).toBe('waiter'); expect(after.dueAt).toBe(before.dueAt)
    expect(after.requests).toEqual([{ reason: 'water', note: 'Sin hielo' }, { reason: 'napkins', note: 'Dos' }])
    const bill = await call('avisarDesdeMesa', { ...link, kind: 'request_bill' }, null)
    expect(core.TableSessionSchema.parse(await doc('sala_table_sessions', sessionId)).status).toBe('bill_requested')
    expect(bill.taskId).toBeTruthy()
  })

  it('para llevar: horas, pedido web, seguimiento por token, aceptación del personal y avisos una sola vez', async () => {
    const date = tomorrow()
    const slots = await call('consultarRecogida', { slug: rid, locationId: lid, date }, null)
    expect(slots.enabled).toBe(true)
    const slot = slots.slots.find(s => s.available)!
    expect(slot).toBeTruthy()
    const input = { slug: rid, locationId: lid, date, time: slot.time, guestName: 'Ana Prueba', phone: '+34600000001', email: 'ana@example.test', language: 'es', lines: [item('bravas')], expectedTotalCents: 650, notes: '', acceptPolicy: true, website: '' }
    const placed = await call('pedirParaLlevar', input, null)
    expect(['pending', 'accepted']).toContain(placed.status)
    expect(placed.status).not.toBe('rejected')
    if (placed.status === 'rejected') return
    expect(await call('verParaLlevarPublico', { slug: rid, reference: placed.reference, token: placed.manageToken }, null)).toMatchObject({ reference: placed.reference, guestName: 'Ana Prueba' })
    await expect(call('verParaLlevarPublico', { slug: rid, reference: placed.reference, token: 'x'.repeat(43) }, null)).rejects.toMatchObject({ status: 403 })
    const takeawayId = (await admin.query('SELECT id FROM llenamos.sala_takeaways WHERE restaurant_id=$1 AND reference=$2', [rid, placed.reference])).rows[0].id
    if (placed.status === 'pending') await call('cambiarEstadoParaLlevar', { ...staff(), takeawayId, status: 'accepted' }, 'waiter')
    const ready = (await lines()).filter(l => l.takeawayId === takeawayId && l.kind !== 'menu')
    await call('cambiarEstadoLineas', { ...staff(), lineIds: ready.map(l => l.id), status: 'fired' }).catch(() => undefined)
    const notices = async () => (await admin.query("SELECT payload FROM llenamos.outbox WHERE restaurant_id=$1 AND kind='aviso.recogida'", [rid])).rows.map(r => r.payload)
    const first = await notices()
    expect(first.map((n: any) => `${n.template}:${n.channel}`).sort()).toEqual(['takeaway_accepted:email', 'takeaway_accepted:whatsapp'])
    expect(JSON.stringify(first)).not.toMatch(/ana@example|Ana Prueba|600000001/)
    // Repetir el mismo estado no genera otro aviso.
    await call('cambiarEstadoParaLlevar', { ...staff(), takeawayId, status: 'accepted' }, 'waiter')
    expect((await notices()).length).toBe(first.length)
    // Contacto ajeno al restaurante: otro local no ve la recogida.
    await expect(call('verParaLlevarPublico', { slug: other, reference: placed.reference, token: placed.manageToken }, null)).rejects.toMatchObject({ status: 403 })
  })

  it('antiabuso público: campo trampa y límite por teléfono, sin 500', async () => {
    const date = today()
    const take = { slug: rid, locationId: lid, date, time: '13:00', guestName: 'Bot', phone: '+34600000009', email: null, language: 'es', lines: [item()], expectedTotalCents: 650, notes: '', acceptPolicy: true }
    expect((await http('pedirParaLlevar', { ...take, website: 'http://spam' }, null)).status).toBe(400)
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) statuses.push((await http('pedirParaLlevar', { ...take, website: '' }, null)).status)
    expect(statuses.filter(s => s === 429).length).toBeGreaterThanOrEqual(2)
    // Según la hora del día la franja existe o no; el límite manda en cualquier caso y nunca hay errores internos.
    expect(statuses.every(s => [200, 412, 429].includes(s))).toBe(true)
    expect(statuses.slice(0, 4).every(s => s !== 429)).toBe(true)
    expect(await count('sala_takeaways')).toBeLessThanOrEqual(4)
  })

  it('antiabuso por IP: quien satura la suya no deja sin QR, recogida ni carta al resto, y un slug inventado no crea cubos', async () => {
    const link = await qr()
    const attacker = '203.0.113.7', guest = '203.0.113.99'
    const burst = await Promise.all(Array.from({ length: 140 }, (_, i) => http('verMesaPublica', { ...link, token: `${i}`.padEnd(43, 'z') }, null, attacker)))
    expect(burst.every(r => [403, 429].includes(r.status))).toBe(true)
    expect(burst.filter(r => r.status === 429).length).toBeGreaterThan(10)
    // El comensal legítimo, desde otra IP y con su token, sigue sirviéndose; la recogida y la carta también.
    expect((await http('verMesaPublica', link, null, guest)).status).toBe(200)
    expect((await http('consultarRecogida', { slug: rid, locationId: lid, date: tomorrow() }, null, guest)).status).toBe(200)
    expect((await http('verCartaPublica', { slug: rid, locationId: lid }, null, guest)).status).toBe(200)
    // Probar tokens falsos de esa mesa desde otra IP no bloquea el token verdadero.
    for (let i = 0; i < 70; i++) await http('verMesaPublica', { ...link, token: `f${i}`.padEnd(43, 'y') }, null, '203.0.113.50')
    expect((await http('verMesaPublica', link, null, guest)).status).toBe(200)
    // Carta: el sondeo de una IP se corta sin tocar a las demás.
    const cartas = await Promise.all(Array.from({ length: 130 }, () => http('verCartaPublica', { slug: rid, locationId: lid }, null, attacker)))
    expect(cartas.filter(r => r.status === 429).length).toBeGreaterThan(0)
    expect((await http('verCartaPublica', { slug: rid, locationId: lid }, null, guest)).status).toBe(200)
    // Slugs inventados: solo cuenta el cubo de la IP.
    const before = Number((await admin.query('SELECT count(*) FROM llenamos.sala_rate_limits')).rows[0].count)
    for (let i = 0; i < 20; i++) expect((await http('verMesaPublica', { ...link, slug: `no-existe-${i}` }, null, '203.0.113.60')).status).toBe(404)
    expect(Number((await admin.query('SELECT count(*) FROM llenamos.sala_rate_limits')).rows[0].count) - before).toBeLessThanOrEqual(1)
  })

  it('aislamiento: otro restaurante, local no asignado, plataforma y sesiones sin membresía no acceden', async () => {
    const { sessionId } = await open()
    await expect(call('abrirMesa', { restaurantId: rid, locationId: lid, tableIds: ['t2'], guests: 2 }, 'stranger')).rejects.toMatchObject({ status: 403 })
    await expect(call('cambiarEstadoMesa', { ...staff(), sessionId, status: 'closed' }, 'stranger')).rejects.toMatchObject({ status: 403 })
    await expect(call('abrirMesa', { ...staff(), tableIds: ['t2'], guests: 2 }, 'limited')).rejects.toMatchObject({ status: 403 })
    await expect(call('abrirMesa', { ...staff(), tableIds: ['t2'], guests: 2 }, 'platform')).rejects.toMatchObject({ status: 403 })
    // Otro restaurante con el mismo id de mesa y sesión: nada se cruza.
    await call('abrirMesa', { restaurantId: other, locationId: lid, tableIds: ['t1'], guests: 2 }, 'stranger')
    await expect(call('enviarPedido', { restaurantId: other, locationId: lid, sessionId, lines: [item()] }, 'stranger')).rejects.toMatchObject({ status: 404 })
    expect(await count('sala_table_sessions', rid)).toBe(1)
    expect(await count('sala_table_sessions', other)).toBe(1)
    await withIdentity(app, token('stranger'), other, async client => {
      for (const table of ['sala_table_sessions', 'sala_orders', 'sala_order_lines', 'sala_menu_items', 'sala_private', 'sala_settings', 'sala_floor_tasks'])
        expect((await client.query(`SELECT DISTINCT restaurant_id FROM llenamos.${table}`)).rows.every(r => r.restaurant_id === other), table).toBe(true)
      await expect(client.query("INSERT INTO llenamos.sala_stations(restaurant_id,location_id,id,doc) VALUES($1,'centro','x','{}')", [rid])).rejects.toThrow(/row-level security/)
    })
    await withIdentity(app, token('platform', true), null, async (client, platform) => {
      expect(platform).toBe(true)
      expect((await client.query('SELECT 1 FROM llenamos.sala_table_sessions')).rowCount).toBe(0)
    })
    // El alcance público de una petición no queda en la conexión del pool.
    await call('verMesaPublica', await qr(), null)
    const client = await app.connect()
    try { expect((await client.query('SELECT llenamos.sala_public_scope_id() AS s')).rows[0].s).toBeNull(); expect((await client.query('SELECT 1 FROM llenamos.sala_menu_items')).rowCount).toBe(0) } finally { client.release() }
  })

  it('lecturas en vivo: foto acotada de servicio, carta y estación con RLS y temas de eventos', async () => {
    const sala = MODULES.find(m => m.name === 'sala')!
    const query = (name: string) => sala.liveQueries!.find(q => q.name === name)!
    const { sessionId } = await open()
    await order(sessionId, [item('bravas'), item('agua')])
    const input = staff()
    const servicio = await withIdentity(app, token('waiter'), rid, client => query('salaServicio').snapshot(client, input, { uid: 'waiter' })) as any
    expect(servicio.sessions.map((s: any) => s.id)).toEqual([sessionId]); expect(servicio.lines.length).toBe(2)
    const carta = await withIdentity(app, token('kitchen'), rid, client => query('salaCarta').snapshot(client, input, { uid: 'kitchen' })) as any
    expect(carta.items.length).toBeGreaterThan(0); expect(carta.settingsSaved).toBe(true)
    const station = (await lines())[0]!
    const estacion = await withIdentity(app, token('owner'), rid, client => query('cocinaLineas').snapshot(client, { ...input, stationId: station.stationId, kind: station.stationKind }, { uid: 'owner' })) as any
    expect(estacion.lines.every((l: any) => l.stationId === station.stationId)).toBe(true)
    const ajeno = await withIdentity(app, token('stranger'), other, client => query('salaServicio').snapshot(client, { restaurantId: other, locationId: lid }, { uid: 'stranger' })) as any
    expect(ajeno.sessions).toEqual([])
    expect(query('salaServicio').topics(input)).toEqual(expect.arrayContaining(['sala.sesion', 'sala.linea']))
    // Los temas existen en los eventos emitidos por las operaciones.
    const topics = new Set((await admin.query('SELECT topic FROM llenamos.events WHERE restaurant_id=$1', [rid])).rows.map(r => r.topic))
    for (const topic of query('salaServicio').topics(input).filter(t => ['sala.sesion', 'sala.pedido', 'sala.linea'].includes(t))) expect(topics).toContain(topic)
  })

  it('carta pública: proyección del local sin credenciales y con límite de ritmo', async () => {
    const menu = await call('verCartaPublica' as never, { slug: rid, locationId: lid }, null) as any
    expect(menu.restaurantId ?? menu.restaurantName).toBeTruthy()
    expect(JSON.stringify(menu)).not.toMatch(/tokenHash|tokenSecret/)
    expect((await http('verCartaPublica', { slug: 'no-existe', locationId: lid }, null)).status).toBe(404)
  })

  it('sentar una reserva inexistente falla con su código (el recorrido completo está en cableado-reservas-sala)', async () => {
    await expect(call('abrirMesa', { ...staff(), tableIds: ['t1'], guests: 2, reservationId: 'r1' })).rejects.toMatchObject({ status: 404, code: 'not-found' })
    expect(await count('sala_table_sessions')).toBe(0)
  })

  describe('revisión del coordinador', () => {
    const live = (name: string) => MODULES.find(m => m.name === 'sala')!.liveQueries!.find(q => q.name === name)!
    const read = (uid: string, name: string, input: unknown, restaurant = rid) => withIdentity(app, token(uid), restaurant, client => live(name).snapshot(client, input, { uid })) as Promise<any>

    it('lecturas en vivo: miembro de otro local, cocina, barra y módulo apagado solo leen lo que dicen las reglas', async () => {
      const scope = staff()
      await open(); await order((await open(['t2'])).sessionId)
      // Miembro solo del local «otro»: ni servicio, ni historial, ni carta, ni estación del local «centro».
      for (const name of ['salaServicio', 'salaHistorial', 'salaCarta']) await expect(read('limited', name, scope), name).rejects.toMatchObject({ status: 403 })
      await expect(read('limited', 'cocinaLineas', { ...scope, stationId: 'x', kind: 'kitchen' })).rejects.toMatchObject({ status: 403 })
      // Cocina y barra no leen el servicio (mesas, recogidas con teléfono y correo) ni el historial.
      for (const uid of ['kitchen', 'bar']) for (const name of ['salaServicio', 'salaHistorial']) await expect(read(uid, name, scope), `${uid} ${name}`).rejects.toMatchObject({ status: 403 })
      for (const uid of ['owner', 'manager', 'waiter']) expect((await read(uid, 'salaServicio', scope)).sessions.length).toBe(2)
      // Estación: cada uno la suya; la barra no abre la de cocina.
      const stations = (await read('owner', 'salaCarta', scope)).stations as { id: string; kind: string }[]
      const kitchenStation = stations.find(x => x.kind === 'kitchen')!, barStation = stations.find(x => x.kind === 'bar')
      expect((await read('kitchen', 'cocinaLineas', { ...scope, stationId: kitchenStation.id, kind: 'kitchen' })).lines).toBeInstanceOf(Array)
      await expect(read('bar', 'cocinaLineas', { ...scope, stationId: kitchenStation.id, kind: 'kitchen' })).rejects.toMatchObject({ status: 403 })
      await expect(read('kitchen', 'cocinaLineas', { ...scope, stationId: barStation?.id ?? 'b', kind: 'bar' })).rejects.toMatchObject({ status: 403 })
      expect((await read('waiter', 'cocinaLineas', { ...scope, stationId: kitchenStation.id, kind: 'kitchen' })).lines).toBeInstanceOf(Array)
      // Carta: personal de cocina la lee, con las estaciones; sin el módulo de cocina, ni la ven ni las estaciones.
      expect((await read('kitchen', 'salaCarta', scope)).stations.length).toBeGreaterThan(0)
      await admin.query("UPDATE llenamos.restaurants SET active_modules='{reservations,floor}' WHERE id=$1", [rid])
      try {
        await expect(read('kitchen', 'salaCarta', scope)).rejects.toMatchObject({ status: 403 })
        await expect(read('kitchen', 'cocinaLineas', { ...scope, stationId: kitchenStation.id, kind: 'kitchen' })).rejects.toMatchObject({ status: 403 })
        expect((await read('waiter', 'salaCarta', scope)).stations).toEqual([])
      } finally { await admin.query("UPDATE llenamos.restaurants SET active_modules='{reservations,floor,kitchen}' WHERE id=$1", [rid]) }
      // Sin membresía activa nada se lee.
      await admin.query("UPDATE llenamos.memberships SET active=false WHERE restaurant_id=$1 AND uid='waiter'", [rid])
      await expect(read('waiter', 'salaServicio', scope)).rejects.toMatchObject({ status: 403 })
    })

    it('las lecturas avisan si recortan: ningún recorte es silencioso', async () => {
      const { sessionId } = await open()
      await order(sessionId, [item('bravas'), item('agua')])
      const snapshot = await read('owner', 'salaServicio', staff())
      expect(snapshot.truncated).toBe(false)
    })

    it('historial acotado: lo cerrado vuelve por su lectura y no ensucia el servicio vivo', async () => {
      const { sessionId } = await open()
      await order(sessionId, [item('agua')]); await serve(sessionId)
      await call('cambiarEstadoMesa', { ...staff(), sessionId, status: 'closed' })
      const vivo = await read('owner', 'salaServicio', staff()), historial = await read('manager', 'salaHistorial', staff())
      expect(vivo.sessions.find((x: any) => x.id === sessionId)).toBeUndefined()
      expect(historial.sessions.map((x: any) => x.id)).toEqual([sessionId])
      expect(historial.lines.length).toBe(1); expect(historial.orders.length).toBe(1)
      // Una mesa cerrada hace más de 18 horas ya no viaja.
      await admin.query("UPDATE llenamos.sala_table_sessions SET doc=jsonb_set(doc,'{closedAt}',to_jsonb($2::bigint)) WHERE restaurant_id=$1 AND id=$3", [rid, Date.now() - 20 * 3_600_000, sessionId])
      expect((await read('owner', 'salaHistorial', staff())).sessions).toEqual([])
      // Y las demás no ven el historial de otro restaurante.
      expect((await read('stranger', 'salaHistorial', { restaurantId: other, locationId: lid }, other)).sessions).toEqual([])
    })

    it('secretos: el enlace de mesa y el seguimiento se guardan cifrados, el alcance público es de un solo local y no ve push', async () => {
      const link = await qr()
      const row = (await admin.query("SELECT doc FROM llenamos.sala_private WHERE restaurant_id=$1 AND kind='tableTokens' AND id='t1'", [rid])).rows[0].doc
      expect(row.tokenSecret).toMatch(/^v1\./); expect(JSON.stringify(row)).not.toContain(link.token); expect(row.tokenHash).toBeTruthy()
      expect((await call('recuperarQrMesa', { ...staff(), tableIds: ['t1'] })).tokens[0]!.token).toBe(link.token)
      // Una suscripción push guardada tampoco deja sus claves en claro.
      await admin.query("INSERT INTO llenamos.sala_private(restaurant_id,location_id,kind,id,doc) VALUES($1,$2,'pushSubscriptions','p1','{\"uid\":\"waiter\"}')", [rid, lid])
      // Un local hermano con otra mesa del mismo id: sus enlaces, ajustes y carta no se ven desde el alcance de «centro».
      await admin.query("INSERT INTO llenamos.dining_areas(restaurant_id,location_id,id,data) VALUES($1,'otro','sala',$2) ON CONFLICT DO NOTHING", [rid, JSON.stringify({ name: 'Sala', sortOrder: 0 })])
      await admin.query("INSERT INTO llenamos.dining_tables(restaurant_id,location_id,id,area_id,data) SELECT restaurant_id,'otro',id,area_id,data FROM llenamos.dining_tables WHERE restaurant_id=$1 AND location_id=$2", [rid, lid])
      const client = await app.connect()
      try {
        await client.query('BEGIN')
        expect((await client.query('SELECT llenamos.sala_public_scope($1,$2) AS s', [rid, lid])).rows[0].s).toBeTruthy()
        expect((await client.query("SELECT 1 FROM llenamos.dining_tables WHERE location_id='otro'")).rowCount).toBe(0)
        expect((await client.query("SELECT 1 FROM llenamos.dining_tables WHERE location_id=$1", [lid])).rowCount).toBeGreaterThan(0)
        expect((await client.query("SELECT 1 FROM llenamos.sala_private WHERE kind='pushSubscriptions'")).rowCount).toBe(0)
        expect((await client.query("SELECT 1 FROM llenamos.sala_private WHERE kind='tableTokens' AND location_id=$1", [lid])).rowCount).toBe(1)
        expect((await client.query('SELECT 1 FROM llenamos.sala_submissions')).rowCount).toBe(0)
        await expect(client.query("INSERT INTO llenamos.sala_private(restaurant_id,location_id,kind,id,doc) VALUES($1,$2,'pushSubscriptions','p2','{}')", [rid, lid])).rejects.toThrow(/row-level security/)
        await client.query('ROLLBACK')
      } finally { client.release() }
      // La cocina no lee secretos ajenos con una consulta directa: solo ve texto cifrado.
      await withIdentity(app, token('kitchen'), rid, async c => {
        const visto = JSON.stringify((await c.query("SELECT doc FROM llenamos.sala_private WHERE kind='tableTokens'")).rows)
        expect(visto).not.toContain(link.token)
      })
    })

    it('QR: un token real de otro restaurante o de otro local con el mismo id de mesa no abre esta mesa; el reintento respeta mesa desactivada', async () => {
      const link = await qr('t1')
      await admin.query("INSERT INTO llenamos.dining_areas(restaurant_id,location_id,id,data) VALUES($1,'otro','sala',$2) ON CONFLICT DO NOTHING", [rid, JSON.stringify({ name: 'Sala', sortOrder: 0 })])
      await admin.query("INSERT INTO llenamos.dining_tables(restaurant_id,location_id,id,area_id,data) SELECT restaurant_id,'otro',id,area_id,data FROM llenamos.dining_tables WHERE restaurant_id=$1 AND location_id=$2", [rid, lid])
      const foreign = (await call('regenerarQrMesa', { restaurantId: other, locationId: lid, tableIds: ['t1'] }, 'stranger')).tokens[0]!.token
      const sibling = (await call('regenerarQrMesa', { ...staff(), locationId: 'otro', tableIds: ['t1'] }, 'limited')).tokens[0]!.token
      expect(foreign).not.toBe(link.token)
      await expect(call('verMesaPublica', { ...link, token: foreign }, null)).rejects.toMatchObject({ status: 403 })
      await expect(call('verMesaPublica', { ...link, slug: other }, null)).rejects.toMatchObject({ status: 403 })
      await expect(call('verMesaPublica', { ...link, token: sibling }, null)).rejects.toMatchObject({ status: 403 })
      await expect(call('verMesaPublica', { ...link, locationId: 'otro' }, null)).rejects.toMatchObject({ status: 403 })
      expect(await call('verMesaPublica', { ...link, locationId: 'otro', token: sibling }, null)).toMatchObject({ session: null })
      // El orden real: con un token falso no se carga el contexto (ni se toma bloqueo) ni se llega a los pedidos.
      const spy = await admin.connect()
      try {
        await spy.query('BEGIN'); await spy.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`sala:${rid}:${lid}`])
        // Con el bloqueo de escritura ajeno tomado, un token falso responde ya (no espera); el verdadero espera al bloqueo.
        const t0 = Date.now()
        expect((await http('verMesaPublica', { ...link, token: 'x'.repeat(43) }, null)).status).toBe(403)
        expect(Date.now() - t0).toBeLessThan(1500)
        const pending = http('verMesaPublica', link, null).then(r => r.status)
        const winner = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve('espera'), 800))])
        expect(winner).toBe('espera')
        await spy.query('COMMIT')
        expect(await pending).toBe(200)
      } finally { spy.release() }
      // Reintento de un pedido con la mesa desactivada: no devuelve el recibo.
      const { sessionId } = await open()
      const view = await call('verMesaPublica', link, null)
      const input = { ...link, sessionId, lines: [item()], expectedTotalCents: 650, expectedDestination: view.destination, language: 'es', requestId: randomUUID() }
      await call('pedirDesdeMesa', input, null)
      await admin.query("UPDATE llenamos.dining_tables SET data=jsonb_set(data,'{enabled}','false') WHERE restaurant_id=$1 AND location_id=$2 AND id='t1'", [rid, lid])
      await expect(call('pedirDesdeMesa', input, null)).rejects.toMatchObject({ status: 403 })
    })

    it('las lecturas no hacen cola entre sí ni con la carta pública; una escritura en curso solo retiene a quien necesita el servicio', async () => {
      const link = await qr()
      const holder = await admin.connect()
      try {
        await holder.query('BEGIN'); await holder.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [`sala:${rid}:${lid}`])
        // Con un lector compartido dentro, otro lector no espera (con el bloqueo exclusivo de antes se bloqueaba).
        const t0 = Date.now()
        expect((await http('verMesaPublica', link, null)).status).toBe(200)
        expect((await http('consultarRecogida', { slug: rid, locationId: lid, date: tomorrow() }, null)).status).toBe(200)
        expect(Date.now() - t0).toBeLessThan(2000)
        await holder.query('ROLLBACK')
        // La carta pública ni siquiera toca el bloqueo: responde con una escritura en curso.
        await holder.query('BEGIN'); await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`sala:${rid}:${lid}`])
        const carta = await Promise.race([http('verCartaPublica', { slug: rid, locationId: lid }, null).then(r => r.status), new Promise(resolve => setTimeout(() => resolve('bloqueada'), 2500))])
        expect(carta).toBe(200)
        await holder.query('ROLLBACK')
      } finally { holder.release() }
    })

    it('la carta pública se sirve de memoria unos segundos y se renueva sin sondear la base', async () => {
      const first = await call('verCartaPublica' as never, { slug: rid, locationId: lid }, null) as any
      await admin.query("UPDATE llenamos.sala_menu_items SET doc=jsonb_set(doc,'{priceCents}','999') WHERE restaurant_id=$1 AND id='bravas'", [rid])
      const cached = await call('verCartaPublica' as never, { slug: rid, locationId: lid }, null) as any
      expect(cached).toEqual(first)
      clearMenuCache()
      const fresh = await call('verCartaPublica' as never, { slug: rid, locationId: lid }, null) as any
      expect(JSON.stringify(fresh)).toContain('999')
    })

    describe('caja', () => {
      const bill = (name: string, data: object, uid = 'owner') => call(name as never, { ...staff(), requestId: randomUUID().replaceAll('-', ''), ...data }, uid) as Promise<any>
      beforeEach(async () => { await admin.query("UPDATE llenamos.restaurants SET active_modules='{reservations,floor,kitchen,pos}' WHERE id=$1", [rid]) })

      it('caja lee el consumo de sala y, con la cuenta en cobro o saldada, sala no permite mover, añadir, anular ni cerrar sin saldar', async () => {
        const { sessionId } = await open(['t1'])
        const sent = await order(sessionId, [item('bravas'), item('agua')])
        if (sent.status !== 'sent') throw new Error('rechazado')
        await serve(sessionId)
        // Cerrar con consumo y sin cuenta saldada se rechaza.
        await expect(call('cambiarEstadoMesa', { ...staff(), sessionId, status: 'closed' })).rejects.toMatchObject({ status: 412 })
        const cash = await bill('abrirCaja', { registerId: 'caja1', openingCents: 0 })
        const opened = await bill('abrirCuenta', { target: { kind: 'session', id: sessionId } })
        expect(opened.bill.totalCents).toBe(sent.sessionTotalCents)
        const locked = await bill('prepararCobro', { billId: opened.billId, expectedRevision: 1 })
        await expect(order(sessionId, [item('agua')])).rejects.toMatchObject({ status: 412 })
        await expect(call('moverMesa', { ...staff(), sessionId, tableIds: ['t2'] })).rejects.toMatchObject({ status: 412 })
        await expect(call('juntarMesas', { ...staff(), sessionId, tableIds: ['t3'] })).rejects.toMatchObject({ status: 412 })
        await expect(call('cambiarEstadoMesa', { ...staff(), sessionId, status: 'closed' })).rejects.toMatchObject({ status: 412 })
        // La mesa pública tampoco añade pedidos a una cuenta en cobro.
        const link = await qr(); const publicView = await call('verMesaPublica', link, null)
        await expect(call('pedirDesdeMesa', { ...link, sessionId, lines: [item()], expectedTotalCents: 650, expectedDestination: publicView.destination, language: 'es' }, null)).rejects.toMatchObject({ status: 412 })
        // Cobrada la cuenta, sala deja cerrar la mesa.
        const parts = (await call('verCuenta' as never, { ...staff(), billId: opened.billId }) as any).parts as { id: string; totalCents: number }[]
        for (const part of parts) await bill('registrarCobro', { billId: opened.billId, expectedRevision: locked.revision, partId: part.id, cashSessionId: cash.cashSessionId, method: 'cash', amountCents: part.totalCents, tipCents: 0, tenderedCents: part.totalCents })
        expect(await call('cambiarEstadoMesa', { ...staff(), sessionId, status: 'closed' })).toMatchObject({ status: 'closed' })
        await expect(call('cambiarEstadoMesa', { ...staff(), sessionId, status: 'open' })).rejects.toMatchObject({ status: 412 })
      })

      it('recogida: con caja activa no se marca recogida con importe sin saldar, y sin origen de pedidos no se simula la cuenta', async () => {
        const date = tomorrow()
        const slot = (await call('consultarRecogida', { slug: rid, locationId: lid, date }, null)).slots.find(x => x.available)!
        const placed = await call('crearParaLlevar', { ...staff(), date, time: slot.time, guestName: 'Ana Prueba', phone: '+34600000001', email: null, source: 'phone', lines: [item('bravas')], notes: '' }, 'waiter')
        if (placed.status === 'rejected') throw new Error('rechazado')
        const lineIds = (await lines()).filter(l => l.takeawayId === placed.takeawayId && l.kind !== 'menu').map(l => l.id)
        await call('cambiarEstadoLineas', { ...staff(), lineIds, status: 'preparing' }, 'kitchen').catch(() => undefined)
        await call('cambiarEstadoLineas', { ...staff(), lineIds, status: 'ready' }, 'kitchen').catch(() => undefined)
        await expect(call('cambiarEstadoParaLlevar', { ...staff(), takeawayId: placed.takeawayId, status: 'picked_up' }, 'waiter')).rejects.toMatchObject({ status: 412 })
        const opened = await bill('abrirCuenta', { target: { kind: 'takeaway', id: placed.takeawayId } })
        expect(opened.bill.totalCents).toBe(placed.totalCents)
      })
    })

    it('eventos de plataforma: pedido nuevo y cambios de estado de línea quedan en el outbox con ID estable y sin datos personales', async () => {
      const { sessionId } = await open()
      const sent = await order(sessionId, [item('bravas')])
      if (sent.status !== 'sent') throw new Error('rechazado')
      await call('cambiarEstadoLineas', { ...staff(), lineIds: sent.lineIds, status: 'preparing' }, 'kitchen')
      const events = (await admin.query("SELECT id,payload FROM llenamos.outbox WHERE restaurant_id=$1 AND kind='plataforma.evento'", [rid])).rows
      const types = events.map(e => e.payload.type)
      expect(types).toContain('order.placed'); expect(types).toContain('orderLine.statusChanged')
      expect(new Set(events.map(e => e.id)).size).toBe(events.length)
      expect(JSON.stringify(events)).not.toMatch(/Ana|600|@/)
    })

    it('los recibos de envío caducan a los 7 días', async () => {
      const { sessionId } = await open()
      await order(sessionId, [item('agua')], { requestId: randomUUID() })
      await admin.query("UPDATE llenamos.sala_submissions SET created_at=now()-interval '8 days' WHERE restaurant_id=$1", [rid])
      await order(sessionId, [item('agua')], { requestId: randomUUID() })
      expect(await count('sala_submissions')).toBe(1)
    })

    it('sin clave de custodia no se guardan secretos ni se simula: la operación falla con su código', async () => {
      delete process.env.SALA_SECRET_KEY
      try { await expect(call('regenerarQrMesa', { ...staff(), tableIds: ['t1'] })).rejects.toMatchObject({ status: 503, code: 'failed-precondition' }) }
      finally { process.env.SALA_SECRET_KEY = 'ab'.repeat(32) }
      expect(await count('sala_private')).toBe(0)
    })
  })
})
