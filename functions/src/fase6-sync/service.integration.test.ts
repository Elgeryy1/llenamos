import { randomUUID } from 'node:crypto'
import { beforeEach, afterAll, describe, it, expect } from 'vitest'
import type { CallableRequest } from 'firebase-functions/v2/https'
import * as core from '@llenamos/core'
import { db } from '../shared'
import { execute } from '../fase2'
import { sessionSignature } from '../fase2/orders'
import { entityVersion, syncContext, synchronize } from './service'

const enabled = process.env.TEST_FIREBASE_EMULATORS === '1' && process.env.GCLOUD_PROJECT === 'demo-llenamos' && !!process.env.FIRESTORE_EMULATOR_HOST
const req = (uid = 'owner') => ({ auth: { uid, token: {} }, rawRequest: { ip: '127.0.0.1' } }) as unknown as CallableRequest<unknown>
let rid: string, path: string, sessionId: string
const roots: string[] = []
const scope = (deviceId = 'tablet_00000000001', actorUid = 'owner') => ({ actorUid, restaurantId: rid, locationId: 'centro', deviceId })
async function command(deviceId?: string, uid?: string) {
  const s = scope(deviceId, uid)
  const state = await db.runTransaction(async tx => {
    const c = await syncContext(tx, s, req(s.actorUid), 'enviarPedido')
    const session = c.rows.tableSessions.get(sessionId)!
    return { preconditions: [entityVersion(c, { kind: 'session', id: sessionId })], destination: sessionSignature(session) }
  })
  const id = randomUUID(), line = core.OrderLineInputSchema.parse({ kind: 'item', itemId: 'bravas', quantity: 1 })
  const menu = core.demoMenu()
  const price = core.priceOrder([line], { items: menu.items, dailyMenus: menu.dailyMenus }, { channel: 'staff', now: Date.now(), timezone: 'Europe/Madrid' })
  return core.OfflineCommandSchema.parse({ ...s, commandId: id, sequence: 1, clientCreatedAt: Date.now(), preconditions: state.preconditions, operation: 'enviarPedido', payload: { restaurantId: rid, locationId: 'centro', sessionId, requestId: id, expectedDestination: state.destination, expectedPrices: core.orderPriceSignature(price.lines), expectedTotalCents: price.totalCents, lines: [line] } })
}
describe.skipIf(!enabled)('Sincronización transaccional real', { timeout: 30000 }, () => {
  beforeEach(async () => {
    rid = `sync-${randomUUID()}`; roots.push(rid); path = `restaurants/${rid}/locations/centro`
    await db.doc(`restaurants/${rid}`).set({ name: 'Sin conexión', slug: rid, timezone: 'Europe/Madrid', brandColor: '#f0a35e', locale: 'es', currency: 'EUR', isDemo: true, activeModules: ['floor', 'kitchen'], plan: 'sala' })
    await db.doc(path).set({ name: 'Centro' })
    for (const role of ['owner', 'waiter', 'kitchen', 'bar']) await db.doc(`restaurants/${rid}/members/${role}`).set({ uid: role, displayName: role, email: `${role}@example.test`, role, active: true, locationIds: [] })
    await db.doc(`${path}/tables/t1`).set({ name: 'Mesa 1', areaId: 'sala', seats: 4, shape: 'rect', x: 10, y: 10, w: 10, h: 10, enabled: true, joinableWith: [] })
    const menu = core.demoMenu(); menu.settings.allowOrdersOutsideHours = true
    await db.doc(`${path}/settings/floor`).set(menu.settings)
    for (const [collection, rows] of Object.entries({ menuCategories: menu.categories, menuItems: menu.items, dailyMenus: menu.dailyMenus, stations: menu.stations })) for (const [id, value] of Object.entries(rows)) await db.doc(`${path}/${collection}/${id}`).set(value)
    sessionId = (await execute('abrirMesa', { restaurantId: rid, locationId: 'centro', tableIds: ['t1'], guests: 2 }, req()) as core.CallableOutput<'abrirMesa'>).sessionId
  })
  afterAll(async () => { for (const id of roots) await db.recursiveDelete(db.doc(`restaurants/${id}`)) }, 60000)
  it('respuesta perdida y dos pestañas ejecutan una sola comanda con un solo recibo', async () => {
    const c = await command()
    const [a, b] = await Promise.all([synchronize(c, req()), synchronize(c, req())])
    expect(a).toEqual(b); expect(a.result.status).toBe('applied')
    expect((await db.collection(`${path}/orders`).get()).size).toBe(1)
    expect((await db.collection(`${path}/syncReceipts`).get()).size).toBe(1)
    expect((await synchronize({ ...c, payload: { ...c.payload, note: 'Alterado' } } as core.OfflineCommand, req()).catch(e => e)).code).toBe('already-exists')
  })
  it('dos tablets compiten, el conflicto queda y bloquea hasta el descarte con autor', async () => {
    const a = await command(), b = await command('tablet_00000000002')
    expect((await synchronize(a, req())).result.status).toBe('applied')
    const conflict = await synchronize(b, req())
    expect(conflict.result).toMatchObject({ status: 'conflict', code: 'stale_version' })
    await expect(synchronize({ ...b, commandId: randomUUID(), sequence: 2 }, req())).rejects.toMatchObject({ code: 'unavailable' })
    expect((await synchronize(b, req(), { requestId: randomUUID(), reason: 'Otra tablet ya envió la ronda. Revisado en sala.' })).result.status).toBe('discarded')
    expect((await db.collection(`${path}/syncResolutions`).get()).docs[0]?.get('updatedBy')).toBe('owner')
    expect((await db.collection(`${path}/orders`).get()).size).toBe(1)
  })
  it('recupera orderSubmissions antes de revisar destino, versiones y edad', async () => {
    const c = await command()
    const response = await execute('enviarPedido', c.payload, req())
    await execute('moverMesa', { restaurantId: rid, locationId: 'centro', sessionId, tableIds: ['t1'] }, req()).catch(() => {})
    const old = { ...c, clientCreatedAt: Date.now() - 90_000_000 }
    const replay = await synchronize(old, req())
    expect(replay.result).toMatchObject({ status: 'applied', response })
    expect((await db.collection(`${path}/orders`).get()).size).toBe(1)
  })
  it('otra cuenta, dispositivo revocado y otra estación no pueden sincronizar', async () => {
    const c = await command()
    await expect(synchronize(c, req('waiter'))).rejects.toMatchObject({ code: 'permission-denied' })
    await db.doc(`${path}/syncDevices/${c.deviceId}`).set({ uid: 'owner', active: false })
    await expect(synchronize(c, req())).rejects.toMatchObject({ code: 'permission-denied' })
    await expect(command('tablet_00000000002', 'kitchen')).rejects.toMatchObject({ code: 'permission-denied' })
  })
  it('precio, agotado, cuenta bloqueada y antigüedad se conservan como conflictos', async () => {
    const c = await command()
    await db.doc(`${path}/menuItems/bravas`).update({ soldOut: true })
    expect((await synchronize(c, req())).result.status).toBe('conflict')
    expect((await db.collection(`${path}/orders`).get()).size).toBe(0)
    const expired = await command('tablet_00000000002')
    expect((await synchronize({ ...expired, clientCreatedAt: Date.now() - 90_000_000 }, req())).result).toMatchObject({ status: 'conflict', code: 'expired' })
  })
  it('encadena empezar y listo de cocina sin cambiar las intenciones y deniega barra', async () => {
    const placed = await synchronize(await command(), req())
    if (placed.result.status !== 'applied') throw new Error('Falta el pedido')
    const lineId = core.EnviarPedidoOutputSchema.parse(placed.result.response)
    if (lineId.status !== 'sent') throw new Error('Falta la línea')
    const line = lineId.lineIds[0]!
    const s = scope('tablet_cocina_00001', 'kitchen')
    const precondition = await db.runTransaction(async tx => entityVersion(await syncContext(tx, s, req('kitchen'), 'cambiarEstadoLineas'), { kind: 'line', id: line }))
    const first = core.OfflineCommandSchema.parse({ ...s, commandId: randomUUID(), sequence: 1, clientCreatedAt: Date.now(), preconditions: [precondition], operation: 'cambiarEstadoLineas', payload: { restaurantId: rid, locationId: 'centro', lineIds: [line], status: 'preparing' } })
    const second = core.OfflineCommandSchema.parse({ ...s, commandId: randomUUID(), sequence: 2, clientCreatedAt: Date.now(), preconditions: [{ ...precondition, afterCommandId: first.commandId }], operation: 'cambiarEstadoLineas', payload: { restaurantId: rid, locationId: 'centro', lineIds: [line], status: 'ready' } })
    expect((await synchronize(first, req('kitchen'))).result.status).toBe('applied')
    expect((await synchronize(second, req('kitchen'))).result.status).toBe('applied')
    expect((await db.doc(`${path}/orderLines/${line}`).get()).get('status')).toBe('ready')
    await expect(synchronize({ ...first, ...scope('tablet_barra_000001', 'bar') }, req('bar'))).rejects.toMatchObject({ code: 'permission-denied' })
  })
  it('un precio diferente y un bloqueo de caja no crean comanda ni recibo aplicado', async () => {
    const c = await command()
    await db.doc(`${path}/menuItems/bravas`).update({ priceCents: 9999, version: 2 })
    expect((await synchronize(c, req())).result).toMatchObject({ status: 'conflict', code: 'price_changed' })
    await db.doc(`${path}/menuItems/bravas`).set(core.demoMenu().items.bravas!)
    const locked = await command('tablet_otra_0000001')
    const bill = core.BillSchema.parse({ target: { kind: 'session', id: sessionId }, status: 'locked', customerId: null, revision: 1, lines: [], adjustments: [], totalCents: 0, paidCents: 0, refundedCents: 0, openedAt: Date.now(), lockedAt: Date.now(), settledAt: null })
    await db.doc(`${path}/bills/bill`).set(core.billForWrite(bill, ms => new Date(ms)))
    await db.doc(`${path}/billTargets/${core.sha256Hex(JSON.stringify(['session', sessionId]))}`).set({ billId: 'bill' })
    expect((await synchronize(locked, req())).result.status).toBe('conflict')
    expect((await db.collection(`${path}/orders`).get()).size).toBe(0)
  })

})
