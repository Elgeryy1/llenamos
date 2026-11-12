/**
 * Punta a punta de la fase 4 sobre un solo restaurante: fichar con pausas cruzando la
 * medianoche → corrección auditada → horas para propinas de una caja de la fase 3 → compra
 * con recepción parcial y cambio de precio → venta que descuenta → anulación que devuelve →
 * merma → recuento → aviso de stock bajo → sugerencia de pedido. Más el seed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as core from '@llenamos/core'
import { db } from '../shared'
import { consumeLine } from './consumo'
import { reviewOpenEntries } from './procesos'
import { seedFase4 } from './seed'
import { HOUR, MIN, call, cleanup, createRestaurant, enabled, loadMenu, req, type Fx } from './fixture'

let fx: Fx
const doc = async (path: string) => (await db.doc(`${fx.path}/${path}`).get()).data()
const T = (h: number, m = 0, day = 10) => Date.UTC(2026, 5, day, h, m)

describe.skipIf(!enabled)('Fase 4 de punta a punta', { timeout: 120000 }, () => {
  beforeAll(async () => { fx = await createRestaurant('f4-e2e'); await loadMenu(fx) }, 60000)
  afterAll(cleanup, 120000)

  it('un servicio completo: horas, propinas, compra, venta, anulación, merma, recuento y aviso', async () => {
    // 1. Ana ficha de noche con una pausa que cruza la medianoche (reloj del servidor simulado).
    const clock = (action: core.ClockAction, now: number, uid = 'ana') => call('fichar', { ...fx.mutation(), action, note: null }, uid, now)
    await clock('in', T(19, 50)); await clock('break_start', T(21, 40)); await clock('break_end', T(22, 20))
    const out = await clock('out', T(0, 10, 11))
    expect(out.workedMinutes).toBe(220)
    // 2. Una corrección del encargado deja la foto de antes y de después.
    const fixed = await call('corregirFichaje', { ...fx.mutation(), entryId: out.entryId, expectedRevision: 4, startAt: T(19, 50), endAt: T(0, 30, 11), breaks: [{ startAt: T(21, 40), endAt: T(22, 20) }], reason: 'Salió media hora más tarde' }, 'manager', T(8, 0, 11))
    expect(fixed.workedMinutes).toBe(240)
    const audit = await db.collection(`${fx.path}/timeEntryEvents`).where('entryId', '==', out.entryId).get()
    expect(audit.docs.map((d) => d.get('kind')).sort()).toEqual(['break_end', 'break_start', 'clock_in', 'clock_out', 'correction'])
    const report = await call('informeHoras', { ...fx.scope(), from: '2026-06-10', to: '2026-06-11', uid: 'ana' }, 'manager', T(9, 0, 11))
    expect(report.rows[0]).toMatchObject({ minutes: 240, byDate: { '2026-06-10': 110, '2026-06-11': 130 } })

    // 3. Horas para propinas contra una caja real de la fase 3.
    const pos = await import('../fase3/index')
    const now = Math.floor(Date.now() / MIN) * MIN
    const cash = await pos.execute('abrirCaja', { ...fx.mutation(), registerId: 'principal', openingCents: 5000 }, req({}, 'manager'))
    await db.doc(`${fx.path}/cashSessions/${cash.cashSessionId}`).update({ openedAt: new Date(now - 3 * HOUR) })
    await call('crearFichajeManual', { ...fx.mutation(), uid: 'berta', startAt: now - 4 * HOUR, endAt: now - 30 * MIN, breaks: [], reason: 'Prueba' }, 'manager', now)
    const hours = await call('horasParaPropinas', { ...fx.scope(), cashSessionId: cash.cashSessionId }, 'manager', now)
    expect(hours.hours).toEqual([{ uid: 'berta', minutes: 150 }])

    // 4. Compra con recepción parcial y cambio de precio.
    const supplier = (await call('guardarProveedor', { ...fx.mutation(), supplierId: null, supplier: { name: 'Mercabarna', phone: null, email: null, contact: null, leadDays: 1, minOrderCents: 0, notes: '', active: true } }, 'manager')).supplierId
    const patatas = (await call('guardarIngrediente', { ...fx.mutation(), ingredientId: null, expectedRevision: null, ingredient: { name: 'Patatas', unit: 'g', category: null, minQuantity: 2000, targetQuantity: 10000, active: true }, opening: { quantity: 1000, valueCents: 120 } }, 'manager')).ingredientId
    expect(await doc(`stockAlerts/${patatas}`)).toMatchObject({ level: 'low', status: 'open' })
    const saco = (await call('guardarFormatoProveedor', { ...fx.mutation(), itemId: null, item: { supplierId: supplier, ingredientId: patatas, name: 'Saco 10 kg', sku: null, baseQuantity: 10000, priceCents: 1200, preferred: true, active: true } }, 'manager')).itemId
    const suggested = await call('sugerirPedidos', fx.scope(), 'manager')
    expect(suggested.orders[0]!.lines[0]).toMatchObject({ supplierItemId: saco, formats: 1 })
    const draft = await call('guardarPedidoProveedor', { ...fx.mutation(), orderId: null, expectedRevision: null, supplierId: supplier, lines: [{ supplierItemId: saco, formats: 2 }], expectedOn: null, notes: '' }, 'manager')
    await call('cambiarEstadoPedidoProveedor', { ...fx.mutation(), orderId: draft.orderId, expectedRevision: 1, to: 'sent' }, 'manager')
    const got = await call('recibirPedidoProveedor', { ...fx.mutation(), supplierId: supplier, purchaseOrderId: draft.orderId, expectedRevision: 2, deliveryNote: null, lines: [{ supplierItemId: saco, receivedFormats: 1, priceCents: 1320 }] }, 'manager')
    expect(got).toMatchObject({ orderStatus: 'partially_received', pending: [{ lineId: 'l1', formats: 1 }], priceChanges: [{ previousCents: 1200, newCents: 1320, changeBp: 1000 }] })
    expect(await doc(`stockAlerts/${patatas}`)).toMatchObject({ status: 'resolved' })
    // 11 000 g con 120 + 1320 céntimos de valor.
    expect(await doc(`ingredientCosts/${patatas}`)).toMatchObject({ valueCents: 1440 })

    // 5. Receta, venta que descuenta y anulación que devuelve.
    await call('guardarReceta', { ...fx.mutation(), recipeId: null, expectedVersion: null, recipe: { name: 'Bravas', itemId: 'bravas', variantId: null, lines: [{ ingredientId: patatas, quantity: 500, yieldBp: 10000 }], optionLines: {}, manualCostCents: null, active: true } }, 'manager')
    const floor = await import('../fase2')
    const table = (await floor.abrirMesa.run(req({ ...fx.scope(), tableIds: ['t1'], guests: 2, guest: null }))) as core.CallableOutput<'abrirMesa'>
    const placed = (await floor.enviarPedido.run(req({ ...fx.scope(), sessionId: table.sessionId, lines: [{ kind: 'item', itemId: 'bravas', quantity: 2 }] }))) as core.CallableOutput<'enviarPedido'>
    if (placed.status !== 'sent') throw new Error('Pedido rechazado')
    const lineId = placed.lineIds[0]!
    await floor.marcharPase.run(req({ ...fx.scope(), sessionId: table.sessionId, course: 'all' }))
    await consumeLine(fx.rid, 'centro', lineId)
    expect((await doc(`ingredients/${patatas}`))!.quantity).toBe(10000)
    await floor.cambiarEstadoLineas.run(req({ ...fx.scope(), lineIds: [lineId], status: 'cancelled', reason: 'Cambio de opinión' }))
    await consumeLine(fx.rid, 'centro', lineId)
    expect((await doc(`ingredients/${patatas}`))!.quantity).toBe(11000)
    expect(await doc(`ingredientCosts/${patatas}`)).toMatchObject({ valueCents: 1440 })

    // 6. Merma, aviso de stock bajo y recuento.
    await call('registrarMerma', { ...fx.mutation(), ingredientId: patatas, quantity: 9500, wasteReason: 'expired', reason: null }, 'kitchen')
    expect(await doc(`stockAlerts/${patatas}`)).toMatchObject({ level: 'low', status: 'open', quantity: 1500 })
    const count = await call('iniciarRecuento', { ...fx.mutation(), name: 'Noche', ingredientIds: [patatas] }, 'manager')
    await call('guardarRecuento', { ...fx.mutation(), countId: count.countId, expectedRevision: 1, lines: [{ ingredientId: patatas, countedQuantity: 1200 }] }, 'manager')
    const applied = await call('aplicarRecuento', { ...fx.mutation(), countId: count.countId, expectedRevision: 2 }, 'manager')
    expect(applied.adjusted).toEqual([expect.objectContaining({ ingredientId: patatas, quantity: -300 })])
    expect(await doc(`stockAlerts/${patatas}`)).toMatchObject({ level: 'low', quantity: 1200 })
    // 7. Queda un saco por recibir del pedido: lo que hay más lo pedido supera el mínimo y no se vuelve a sugerir.
    expect(await call('sugerirPedidos', fx.scope(), 'manager')).toEqual({ orders: [], withoutSupplier: [] })
    // Todo lo del servicio quedó en la actividad del encargado.
    const actions = new Set((await db.collection(`restaurants/${fx.rid}/activity`).get()).docs.map((d) => d.get('action')))
    for (const a of ['staff.entry_corrected', 'purchase.received', 'stock.low', 'stock.waste', 'stock.count_applied']) expect(actions.has(a)).toBe(true)
    void reviewOpenEntries
  })

  it('el seed es idempotente y deja datos de demostración coherentes', async () => {
    const uids = { propietario: 'owner', encargada: 'manager', camarero: 'waiter', camarera: 'ana', cocina: 'kitchen', barra: 'bar' }
    const clean = await createRestaurant('f4-seed')
    await loadMenu(clean)
    const target = { restaurantId: clean.rid, locationId: 'centro', uids, now: Date.UTC(2026, 5, 17, 10, 0) }
    // El seed fija la zona horaria de Madrid y ficha los últimos seis días.
    const first = await seedFase4(target)
    expect(first).toMatchObject({ ingredients: 22, recipes: 17, suppliers: 3 })
    const count = async () => Object.fromEntries(await Promise.all(['timeEntries', 'shifts', 'ingredients', 'ingredientCosts', 'stockMovements', 'recipes', 'stockAlerts', 'suppliers', 'supplierItems', 'purchaseOrders', 'goodsReceipts', 'staffPins'].map(async (c) => [c, (await db.collection(`${clean.path}/${c}`).get()).size] as const)))
    const before = await count(), activityBefore = (await db.collection(`restaurants/${clean.rid}/activity`).get()).size
    await seedFase4(target)
    expect(await count()).toEqual(before)
    expect((await db.collection(`restaurants/${clean.rid}/activity`).get()).size).toBe(activityBefore)
    expect(before).toMatchObject({ ingredients: 22, recipes: 17, staffPins: 4, purchaseOrders: 2, goodsReceipts: 1, suppliers: 3, supplierItems: 11 })
    expect(before.timeEntries).toBeGreaterThan(20)
    // Avisos de stock: la tarta agotada y la salsa brava, el aceite y el bacon por debajo del mínimo.
    const alerts = (await db.collection(`${clean.path}/stockAlerts`).get()).docs.map((d) => [d.get('level'), d.get('status')])
    expect(alerts.sort()).toEqual([['low', 'open'], ['low', 'open'], ['low', 'open'], ['out', 'open']])
    // Una persona con el fichaje olvidado, listo para cerrar.
    const report = await call('informeHoras', { ...clean.scope(), from: '2026-06-11', to: '2026-06-17', uid: null }, 'manager', Date.UTC(2026, 5, 17, 10, 0))
    expect(report.rows.find((r) => r.uid === 'ana')).toMatchObject({ forgottenEntries: 1 })
    // Cada receta de la carta demo tiene coste calculable, salvo la tarta, que está sin existencias ni coste conocido.
    const margin = await call('margenPlatos', { ...clean.scope(), from: '2026-06-01', to: '2026-06-30' }, 'manager', Date.UTC(2026, 5, 17, 10, 0))
    expect(margin.theoretical).toHaveLength(17)
    expect(margin.theoretical.filter((r) => !r.complete).map((r) => r.itemId)).toEqual(['tarta'])
    // El cuadrante de la semana en curso está publicado y el de la siguiente en borrador.
    const published = (await db.collection(`${clean.path}/shifts`).where('weekStart', '==', '2026-06-15').get()).docs.map((d) => d.get('status'))
    expect(new Set(published)).toEqual(new Set(['published']))
    expect(new Set((await db.collection(`${clean.path}/shifts`).where('weekStart', '==', '2026-06-22').get()).docs.map((d) => d.get('status')))).toEqual(new Set(['draft']))
  })
})
