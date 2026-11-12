import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as core from '@llenamos/core'
import { MODULES } from '../index.js'
import { clock } from '../fase4/contexto.js'
import { withIdentity } from '../../database.js'
import { ZodError } from 'zod'
import { enabled, identity, startHarness, type Harness } from '../fase4/arnes.js'
import { lineSource } from '../fase4/puertos.js'
import { consumeLine, reconcileConsumption } from './consumo.js'

const T = (h: number, m = 0, day = 10) => Date.UTC(2026, 5, day, h, m)
let h: Harness
/** Líneas de pedido reales de sala (tabla de 008): se escribe como sala y se lee con la fuente por defecto. */
const putLine = async (id: string, raw: unknown, rid = 'rest-a') => {
  const doc = core.OrderLineSchema.parse(raw)
  await h.admin.query(`INSERT INTO llenamos.sala_order_lines(restaurant_id,location_id,id,doc) VALUES($1,'centro',$2,$3)
    ON CONFLICT(restaurant_id,location_id,id) DO UPDATE SET doc=EXCLUDED.doc,revision=sala_order_lines.revision+1`, [rid, id, doc])
}
const run = (id: string) => withIdentity(h.app, identity('waiter-a'), 'rest-a', c => consumeLine(c, scope(), id, now))
let now = T(9)
const at = (value: number) => { now = value; clock.now = () => now }
const scope = () => ({ restaurantId: 'rest-a', locationId: 'centro' })
const row = async (sql: string, params: unknown[] = []) => (await h.admin.query(sql, params)).rows[0]
/** Carta y mesas reales de sala (008) para un restaurante, como en las pruebas de sala. */
async function seedSala(rid: string) {
  const demo = core.demoMenu(), reservations = core.defaultReservationSettings(), shifts = [{ name: 'Servicio', from: '00:00', lastEntry: '23:45' }]
  const settings = { ...demo.settings, selfOrder: { ...demo.settings.selfOrder, enabled: true, requireApproval: false } }
  reservations.week = { mon: shifts, tue: shifts, wed: shifts, thu: shifts, fri: shifts, sat: shifts, sun: shifts }
  await h.admin.query("INSERT INTO llenamos.dining_areas(restaurant_id,location_id,id,data) VALUES($1,'centro','sala',$2) ON CONFLICT DO NOTHING", [rid, JSON.stringify({ name: 'Sala principal', sortOrder: 0 })])
  for (let i = 1; i <= 3; i++) await h.admin.query('INSERT INTO llenamos.dining_tables(restaurant_id,location_id,id,area_id,data) VALUES($1,$2,$3,$4,$5)', [rid, 'centro', `t${i}`, 'sala', JSON.stringify({ name: `S${i}`, areaId: 'sala', seats: 8, enabled: true, joinableWith: [], shape: 'rect', x: 10, y: 10, w: 10, h: 10 })])
  await h.admin.query("INSERT INTO llenamos.reservation_settings(restaurant_id,location_id,data) VALUES($1,'centro',$2) ON CONFLICT DO NOTHING", [rid, JSON.stringify(reservations)])
  await h.admin.query("INSERT INTO llenamos.sala_settings(restaurant_id,location_id,kind,doc) VALUES($1,'centro','floor',$2)", [rid, JSON.stringify(settings)])
  for (const [table, rows] of Object.entries({ sala_menu_categories: demo.categories, sala_menu_items: demo.items, sala_daily_menus: demo.dailyMenus, sala_stations: demo.stations }))
    for (const [id, value] of Object.entries(rows)) await h.admin.query(`INSERT INTO llenamos.${table}(restaurant_id,location_id,id,doc) VALUES($1,'centro',$2,$3)`, [rid, id, JSON.stringify(value)])
}
const demo = core.demoMenu()
const menuOf = (): Record<string, core.MenuItem> => demo.items as Record<string, core.MenuItem>
const ingredient = (name: string, extra: object = {}) => ({ name, unit: 'g', category: null, minQuantity: 0, targetQuantity: null, active: true, ...extra })
const stock = async (id: string) => Number((await row("SELECT doc->>'quantity' AS q FROM llenamos.inv_ingredients WHERE id=$1", [id])).q)

function orderLine(over: Record<string, unknown> = {}): unknown {
  return {
    orderId: 'o1', sessionId: 's1', takeawayId: null, label: 'S1', kind: 'item', parentLineId: null, position: 0, itemId: 'bravas', dailyMenuId: null, sectionId: null,
    version: 1, name: { es: 'Bravas', ca: 'Braves', en: 'Bravas' }, variant: null, modifiers: [], quantity: 2, unitPriceCents: 600, totalCents: 1200, taxRate: 10,
    notes: '', guest: null, course: null, stationId: null, stationKind: null, targetMinutes: null, status: 'fired', fireAt: null, placedAt: T(12), firedAt: T(12, 1),
    startedAt: null, readyAt: null, servedAt: null, cancelReason: null, history: [], createdBy: 'waiter-a', ...over,
  }
}

process.env.SALA_SECRET_KEY = 'ab'.repeat(32)
process.env.TRUSTED_IP_HEADER = 'x-test-ip'; process.env.TRUSTED_PROXY_ADDRESSES = '127.0.0.1,::1'
describe.skipIf(!enabled)('Inventario, costes y compras en PostgreSQL', { timeout: 60_000 }, () => {
  let patatas = '', aceite = '', supplier = '', saco = ''
  beforeAll(async () => { h = await startHarness('inventario'); at(T(9)); await seedSala('rest-a') }, 60_000)
  afterAll(async () => { clock.now = () => Date.now(); await h?.close() })

  it('registra las 17 operaciones de inventario y compras y sus lecturas en vivo, sin duplicados', () => {
    const module = MODULES.find(m => m.name === 'inventario')!
    expect(module.operations.map(([name]) => name).sort()).toEqual(Object.keys(core.CALLABLES_FASE4_INVENTARIO).sort())
    const names = MODULES.flatMap(m => m.liveQueries?.map(q => q.name) ?? [])
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual(expect.arrayContaining(['inventarioStock', 'comprasPedidos', 'personalFichajes']))
  })

  it('ingredientes: existencias iniciales, aviso de stock bajo y revisión optimista', async () => {
    const made = await h.ok('guardarIngrediente', { ...h.mutation(), ingredientId: null, expectedRevision: null, ingredient: ingredient('Patatas', { minQuantity: 2000, targetQuantity: 10000 }), opening: { quantity: 1000, valueCents: 120 } }, 'manager-a')
    patatas = made.ingredientId
    expect(await stock(patatas)).toBe(1000)
    expect((await row('SELECT doc FROM llenamos.inv_stock_alerts WHERE id=$1', [patatas])).doc).toMatchObject({ level: 'low', status: 'open' })
    expect((await row('SELECT doc FROM llenamos.inv_ingredient_costs WHERE id=$1', [patatas])).doc).toMatchObject({ valueCents: 120 })
    aceite = (await h.ok('guardarIngrediente', { ...h.mutation(), ingredientId: null, expectedRevision: null, ingredient: ingredient('Aceite', { unit: 'ml' }), opening: null }, 'manager-a')).ingredientId
    const stale = await h.call('guardarIngrediente', { ...h.mutation(), ingredientId: patatas, expectedRevision: 7, ingredient: ingredient('Patatas'), opening: null }, 'manager-a')
    expect(stale.status).toBe(412)
    const unit = await h.call('guardarIngrediente', { ...h.mutation(), ingredientId: patatas, expectedRevision: 1, ingredient: ingredient('Patatas', { unit: 'ml', minQuantity: 2000, targetQuantity: 10000 }), opening: null }, 'manager-a')
    expect(unit.status).toBe(412)
    expect(unit.body.error.message).toMatch(/unidad/)
    const edit = await h.ok('guardarIngrediente', { ...h.mutation(), ingredientId: patatas, expectedRevision: 1, ingredient: ingredient('Patatas nuevas', { minQuantity: 2000, targetQuantity: 10000 }), opening: null }, 'manager-a')
    expect(edit.revision).toBe(2)
    expect(await stock(patatas)).toBe(1000)
  })

  it('permisos por rol: cocina mide merma pero no gestiona ni ve costes; sala no toca nada', async () => {
    const waste = { ...h.mutation(), ingredientId: patatas, quantity: 100, wasteReason: 'expired', reason: null }
    expect((await h.call('registrarMerma', waste, 'waiter-a')).status).toBe(403)
    expect((await h.call('registrarMerma', waste, 'owner-b')).status).toBe(403)
    expect((await h.call('registrarMerma', waste, 'kitchen-a')).status).toBe(200)
    expect((await h.call('ajustarStock', { ...h.mutation(), ingredientId: patatas, kind: 'adjustment', quantity: 5, reason: 'x' }, 'kitchen-a')).status).toBe(403)
    expect((await h.call('guardarProveedor', { ...h.mutation(), supplierId: null, supplier: { name: 'X', phone: null, email: null, contact: null, leadDays: 1, minOrderCents: 0, notes: '', active: true } }, 'bar-a')).status).toBe(403)
    expect((await h.call('margenPlatos', { ...h.scope(), from: '2026-06-01', to: '2026-06-30' }, 'kitchen-a')).status).toBe(403)
    expect((await h.call('registrarMerma', waste, 'inactive-a')).status).toBe(403)
    expect(await stock(patatas)).toBe(900)
  })

  it('merma y ajustes: repetir la misma petición no vuelve a mover existencias y reutilizar el id con otros datos falla', async () => {
    const m = { ...h.mutation(), ingredientId: patatas, quantity: 50, wasteReason: 'spoiled', reason: 'Se cayó' }
    const first = await h.ok('registrarMerma', m, 'kitchen-a')
    const second = await h.ok('registrarMerma', m, 'kitchen-a')
    expect(second).toEqual(first)
    expect(await stock(patatas)).toBe(850)
    expect((await h.call('registrarMerma', { ...m, quantity: 60 }, 'kitchen-a')).status).toBe(409)
    expect(await stock(patatas)).toBe(850)
    const adj = await h.ok('ajustarStock', { ...h.mutation(), ingredientId: patatas, kind: 'adjustment', quantity: 150, reason: 'Hallazgo' }, 'manager-a')
    expect(adj.quantityAfter).toBe(1000)
    const ret = await h.ok('ajustarStock', { ...h.mutation(), ingredientId: patatas, kind: 'supplier_return', quantity: 100, reason: 'Defectuoso' }, 'manager-a')
    expect(ret.quantityAfter).toBe(900)
    const ack = await h.ok('reconocerAvisoStock', { ...h.mutation(), ingredientId: patatas }, 'kitchen-a')
    expect(ack.alert.status).toBe('acknowledged')
    expect(await h.call('reconocerAvisoStock', { ...h.mutation(), ingredientId: aceite }, 'kitchen-a').then(r => r.status)).toBe(404)
  })

  it('sin pérdidas con concurrencia: veinte mermas a la vez dejan el libro y las existencias cuadrados', async () => {
    const before = await stock(patatas)
    const results = await Promise.all(Array.from({ length: 20 }, () => h.call('registrarMerma', { ...h.mutation(), ingredientId: patatas, quantity: 10, wasteReason: 'expired', reason: null }, 'kitchen-a')))
    expect(results.map(r => r.status)).toEqual(Array(20).fill(200))
    expect(await stock(patatas)).toBe(before - 200)
    const sum = await row("SELECT sum((doc->>'quantity')::bigint)::int AS total FROM llenamos.inv_stock_movements WHERE ingredient_id=$1", [patatas])
    expect(sum.total).toBe(await stock(patatas))
    // El último movimiento recuerda la cantidad resultante y es la que hay.
    const last = await row("SELECT (doc->>'quantityAfter')::int AS q FROM llenamos.inv_stock_movements WHERE ingredient_id=$1 ORDER BY at DESC, created_at DESC LIMIT 1", [patatas])
    expect(last.q).toBe(await stock(patatas))
  })

  it('el libro de movimientos es inmutable para el rol de ejecución', async () => {
    const id = identity('owner-a')
    await expect(withIdentity(h.app, id, 'rest-a', c => c.query('UPDATE llenamos.inv_stock_movements SET doc=doc'))).rejects.toThrow(/permission denied/)
    await expect(withIdentity(h.app, id, 'rest-a', c => c.query('DELETE FROM llenamos.inv_stock_movements'))).rejects.toThrow(/permission denied/)
    await expect(withIdentity(h.app, id, 'rest-a', c => c.query('DELETE FROM llenamos.inv_goods_receipts'))).rejects.toThrow(/permission denied/)
  })

  it('recuento: iniciar, guardar, aplicar descontando lo movido durante el conteo y reaplicar sin repetir', async () => {
    at(T(22))
    const count = await h.ok('iniciarRecuento', { ...h.mutation(), name: 'Noche', ingredientIds: [patatas] }, 'manager-a')
    expect(count.ingredients).toBe(1)
    expect((await h.call('iniciarRecuento', { ...h.mutation(), name: 'Fantasma', ingredientIds: ['no-existe'] }, 'manager-a')).status).toBe(404)
    const before = await stock(patatas)
    at(T(22, 5))
    await h.ok('guardarRecuento', { ...h.mutation(), countId: count.countId, expectedRevision: 1, lines: [{ ingredientId: patatas, countedQuantity: before - 100 }] }, 'manager-a')
    // Mientras se contaba se tiró algo más: lo contado vale para el instante de la cuenta, así que el ajuste
    // suma esa merma posterior (130 en total) y no la cuenta dos veces.
    at(T(22, 10))
    await h.ok('registrarMerma', { ...h.mutation(), ingredientId: patatas, quantity: 30, wasteReason: 'expired', reason: null }, 'kitchen-a')
    const apply = { ...h.mutation(), countId: count.countId, expectedRevision: 2 }
    const applied = await h.ok('aplicarRecuento', apply, 'manager-a')
    expect(applied.adjusted).toEqual([expect.objectContaining({ ingredientId: patatas, quantity: -100 })])
    expect(await stock(patatas)).toBe(before - 130)
    expect(await h.ok('aplicarRecuento', { ...h.mutation(), countId: count.countId, expectedRevision: 3 }, 'manager-a')).toEqual(applied)
    expect(await stock(patatas)).toBe(before - 130)
    expect((await h.call('guardarRecuento', { ...h.mutation(), countId: count.countId, expectedRevision: 3, lines: [{ ingredientId: patatas, countedQuantity: 1 }] }, 'manager-a')).status).toBe(412)
    const second = await h.ok('iniciarRecuento', { ...h.mutation(), name: 'Otro', ingredientIds: null }, 'manager-a')
    expect(second.ingredients).toBe(2)
    expect((await h.ok('cancelarRecuento', { ...h.mutation(), countId: second.countId, expectedRevision: 1 }, 'manager-a')).ok).toBe(true)
    expect((await h.call('aplicarRecuento', { ...h.mutation(), countId: second.countId, expectedRevision: 2 }, 'manager-a')).status).toBe(412)
  })

  it('compras: formato preferido único, pedido con referencia, recepción parcial con cambio de precio y sin doble stock', async () => {
    at(T(9, 0, 11))
    supplier = (await h.ok('guardarProveedor', { ...h.mutation(), supplierId: null, supplier: { name: 'Mercabarna', phone: null, email: null, contact: null, leadDays: 1, minOrderCents: 0, notes: '', active: true } }, 'manager-a')).supplierId
    saco = (await h.ok('guardarFormatoProveedor', { ...h.mutation(), itemId: null, item: { supplierId: supplier, ingredientId: patatas, name: 'Saco 10 kg', sku: null, baseQuantity: 10000, priceCents: 1200, preferred: true, active: true } }, 'manager-a')).itemId
    const second = (await h.ok('guardarFormatoProveedor', { ...h.mutation(), itemId: null, item: { supplierId: supplier, ingredientId: patatas, name: 'Saco 5 kg', sku: null, baseQuantity: 5000, priceCents: 700, preferred: true, active: true } }, 'manager-a')).itemId
    expect((await row("SELECT count(*)::int AS n FROM llenamos.inv_supplier_items WHERE preferred AND ingredient_id=$1", [patatas])).n).toBe(1)
    expect((await row('SELECT preferred FROM llenamos.inv_supplier_items WHERE id=$1', [saco])).preferred).toBe(false)
    await h.ok('guardarFormatoProveedor', { ...h.mutation(), itemId: second, item: { supplierId: supplier, ingredientId: patatas, name: 'Saco 5 kg', sku: null, baseQuantity: 5000, priceCents: 700, preferred: false, active: false } }, 'manager-a')
    expect((await h.call('guardarFormatoProveedor', { ...h.mutation(), itemId: saco, item: { supplierId: supplier, ingredientId: aceite, name: 'Cambio', sku: null, baseQuantity: 1, priceCents: 1, preferred: false, active: true } }, 'manager-a')).status).toBe(412)
    // Un formato de otro restaurante no existe para este.
    const suggested = await h.ok('sugerirPedidos', h.scope(), 'manager-a')
    expect(suggested.orders[0].lines[0]).toMatchObject({ supplierItemId: saco, ingredientId: patatas })
    const draft = await h.ok('guardarPedidoProveedor', { ...h.mutation(), orderId: null, expectedRevision: null, supplierId: supplier, lines: [{ supplierItemId: saco, formats: 2 }], expectedOn: null, notes: '' }, 'manager-a')
    expect(draft.reference).toMatch(/^[A-Z0-9]{6}$/)
    expect((await h.call('guardarPedidoProveedor', { ...h.mutation(), orderId: null, expectedRevision: null, supplierId: supplier, lines: [{ supplierItemId: second, formats: 1 }], expectedOn: null, notes: '' }, 'manager-a')).status).toBe(412)
    const sent = await h.ok('cambiarEstadoPedidoProveedor', { ...h.mutation(), orderId: draft.orderId, expectedRevision: 1, to: 'sent' }, 'manager-a')
    expect(sent.status).toBe('sent')
    expect((await h.call('guardarPedidoProveedor', { ...h.mutation(), orderId: draft.orderId, expectedRevision: 2, supplierId: supplier, lines: [{ supplierItemId: saco, formats: 3 }], expectedOn: null, notes: '' }, 'manager-a')).status).toBe(412)
    const before = await stock(patatas)
    const receive = { ...h.mutation(), supplierId: supplier, purchaseOrderId: draft.orderId, expectedRevision: 2, deliveryNote: 'A-1', lines: [{ supplierItemId: saco, receivedFormats: 1, priceCents: 1320 }] }
    const got = await h.ok('recibirPedidoProveedor', receive, 'manager-a')
    expect(got).toMatchObject({ orderStatus: 'partially_received', pending: [{ lineId: 'l1', formats: 1 }], priceChanges: [{ previousCents: 1200, newCents: 1320, changeBp: 1000 }] })
    expect(await stock(patatas)).toBe(before + 10000)
    // Dos entregas idénticas a la vez o una repetida: solo una mueve existencias.
    const again = await Promise.all([h.call('recibirPedidoProveedor', receive, 'manager-a'), h.call('recibirPedidoProveedor', receive, 'manager-a')])
    expect(again.map(r => r.status)).toEqual([200, 200])
    expect(again[0]!.body.result.receiptId).toBe(got.receiptId)
    expect(await stock(patatas)).toBe(before + 10000)
    expect((await row('SELECT count(*)::int AS n FROM llenamos.inv_goods_receipts')).n).toBe(1)
    expect((await row('SELECT doc->>\'lastPriceCents\' AS p FROM llenamos.inv_supplier_items WHERE id=$1', [saco])).p).toBe('1320')
    // El resto del pedido, con una unidad de más.
    const rest = await h.ok('recibirPedidoProveedor', { ...h.mutation(), supplierId: supplier, purchaseOrderId: draft.orderId, expectedRevision: 3, deliveryNote: null, lines: [{ supplierItemId: saco, receivedFormats: 2, priceCents: 1320 }] }, 'manager-a')
    expect(rest).toMatchObject({ orderStatus: 'received', exceeded: [{ lineId: 'l1', extraFormats: 1 }] })
    expect((await h.call('cambiarEstadoPedidoProveedor', { ...h.mutation(), orderId: draft.orderId, expectedRevision: 4, to: 'sent' }, 'manager-a')).status).toBe(412)
    expect((await h.call('recibirPedidoProveedor', { ...h.mutation('b'), supplierId: supplier, purchaseOrderId: null, expectedRevision: null, deliveryNote: null, lines: [{ supplierItemId: saco, receivedFormats: 1, priceCents: 1 }] }, 'owner-b')).status).toBe(404)
    expect((await h.call('sugerirPedidos', h.scope('b'), 'manager-a')).status).toBe(403)
  })

  it('recetas: valida plato, variante y extras contra la carta; una sola por plato y variante; versiones inmutables', async () => {
    const recipe = (over: object = {}) => ({ name: 'Bravas', itemId: 'bravas', variantId: null, lines: [{ ingredientId: patatas, quantity: 500, yieldBp: 10000 }], optionLines: {}, manualCostCents: null, active: true, ...over })
    const bad = await h.call('guardarReceta', { ...h.mutation(), recipeId: null, expectedVersion: null, recipe: recipe({ itemId: 'no-existe' }) }, 'manager-a')
    expect(bad.status).toBe(404)
    expect((await h.call('guardarReceta', { ...h.mutation(), recipeId: null, expectedVersion: null, recipe: recipe({ variantId: 'fantasma' }) }, 'manager-a')).status).toBe(412)
    expect((await h.call('guardarReceta', { ...h.mutation(), recipeId: null, expectedVersion: null, recipe: recipe() }, 'waiter-a')).status).toBe(403)
    const made = await h.ok('guardarReceta', { ...h.mutation(), recipeId: null, expectedVersion: null, recipe: recipe() }, 'manager-a')
    expect(made.version).toBe(1)
    expect(made.cost.complete).toBe(true)
    expect((await h.call('guardarReceta', { ...h.mutation(), recipeId: null, expectedVersion: null, recipe: recipe({ name: 'Otra' }) }, 'manager-a')).status).toBe(412)
    const edited = await h.ok('guardarReceta', { ...h.mutation(), recipeId: made.recipeId, expectedVersion: 1, recipe: recipe({ lines: [{ ingredientId: patatas, quantity: 400, yieldBp: 10000 }] }) }, 'manager-a')
    expect(edited.version).toBe(2)
    expect((await row('SELECT count(*)::int AS n FROM llenamos.inv_recipe_versions WHERE recipe_id=$1', [made.recipeId])).n).toBe(2)
    const same = await h.ok('guardarReceta', { ...h.mutation(), recipeId: made.recipeId, expectedVersion: 2, recipe: recipe({ lines: [{ ingredientId: patatas, quantity: 400, yieldBp: 10000 }] }) }, 'manager-a')
    expect(same.version).toBe(2)
    expect((await h.call('guardarReceta', { ...h.mutation(), recipeId: made.recipeId, expectedVersion: 1, recipe: recipe() }, 'manager-a')).status).toBe(412)
  })

  it('la carta sale de la tabla real de sala: un restaurante sin carta no puede montar recetas ni se inventa nada', async () => {
    // rest-b no tiene platos en sala: el plato «no existe» para él, aunque el mismo id exista en rest-a.
    const r = await h.call('guardarReceta', { ...h.mutation('b'), recipeId: null, expectedVersion: null, recipe: { name: 'Sin carta', itemId: 'bravas', variantId: null, lines: [], optionLines: {}, manualCostCents: 100, active: true } }, 'owner-b')
    expect(r.status).toBe(404)
    const live = MODULES.find(m => m.name === 'inventario')!.liveQueries!.find(q => q.name === 'inventarioPlatos')!
    expect((await withIdentity(h.app, identity('owner-b'), 'rest-b', c => live.snapshot(c, h.scope('b'), { uid: 'owner-b' })) as { items: unknown[] }).items).toEqual([])
  })

  it('descuento por venta: consumir, repetir sin duplicar, anular antes de preparar devuelve, y anular después es pérdida', async () => {
    at(T(13))
    await h.ok('guardarConfiguracionInventario', { ...h.mutation(), settings: { ...core.defaultInventorySettings(), consumeOnSale: true } }, 'manager-a')
    const start = await stock(patatas)
    // La receta vigente usa 400 g por ración y la línea pide 2. Primer consumo con cuatro llamadas a la vez: un solo movimiento.
    await putLine('line1', orderLine())
    const first = await Promise.all(Array.from({ length: 4 }, () => run('line1')))
    expect(first.sort()).toEqual(['consumed', 'noop', 'noop', 'noop'])
    expect(await stock(patatas)).toBe(start - 800)
    expect((await row("SELECT count(*)::int AS n FROM llenamos.inv_stock_movements WHERE line_id='line1'")).n).toBe(1)
    expect(await run('line1')).toBe('noop')
    // Anulada antes de prepararse: devuelve. La relectura usa el estado vigente, así que un aviso atrasado no vuelve a descontar.
    await putLine('line1', orderLine({ status: 'cancelled', history: [{ from: 'pending', to: 'fired', at: T(12, 1), by: 'waiter-a', reason: 'x' }] }))
    expect(await run('line1')).toBe('reversed')
    expect(await stock(patatas)).toBe(start)
    expect(await run('line1')).toBe('noop')
    await Promise.all([run('line1'), run('line1')])
    expect(await stock(patatas)).toBe(start)
    expect((await row("SELECT count(*)::int AS n FROM llenamos.inv_stock_movements WHERE line_id='line1'")).n).toBe(2)
    // Una línea que ya se preparó y se anula: el stock no vuelve, queda como pérdida.
    await putLine('line2', orderLine())
    expect(await run('line2')).toBe('consumed')
    await putLine('line2', orderLine({ status: 'cancelled', history: [{ from: 'fired', to: 'preparing', at: T(12, 10), by: 'kitchen-a', reason: 'x' }] }))
    expect(await run('line2')).toBe('wasted')
    expect(await stock(patatas)).toBe(start - 800)
    // Sin receta: se anota y no se vuelve a evaluar. Menú del día y línea desaparecida no hacen nada.
    await putLine('line3', orderLine({ itemId: 'tarta' }))
    expect(await run('line3')).toBe('no_recipe')
    await putLine('line4', orderLine({ kind: 'menu' }))
    expect(await run('line4')).toBe('skipped')
    expect(await run('line5')).toBe('gone')
    // Desactivado el descuento por venta no se toca nada.
    await h.ok('guardarConfiguracionInventario', { ...h.mutation(), settings: { ...core.defaultInventorySettings(), consumeOnSale: false } }, 'manager-a')
    await putLine('line6', orderLine())
    expect(await run('line6')).toBe('inactive')
    await h.ok('guardarConfiguracionInventario', { ...h.mutation(), settings: { ...core.defaultInventorySettings(), consumeOnSale: true } }, 'manager-a')
    // Otro restaurante no puede descontar el stock de este.
    await putLine('line9', orderLine())
    await expect(withIdentity(h.app, identity('owner-b'), 'rest-b', c => consumeLine(c, scope(), 'line9', now))).rejects.toMatchObject({ status: 404 })
    expect((await row("SELECT count(*)::int AS n FROM llenamos.inv_line_costs WHERE id='line9'")).n).toBe(0)
    // Cada consumo siembra el trabajo periódico de reconciliación del local, una vez por ranura.
    const jobs = (await h.admin.query("SELECT payload,scheduled_at FROM llenamos.jobs WHERE kind='inventario.reconciliar' AND restaurant_id='rest-a'")).rows
    expect(jobs).toHaveLength(1)
    expect(jobs[0].payload).toEqual({ locationId: 'centro' })
    expect(jobs[0].scheduled_at.getTime()).toBeGreaterThan(now)
  })

  it('una línea sin IVA propio toma el del plato de la carta real', async () => {
    at(T(13, 30))
    await putLine('line7', orderLine({ taxRate: null }))
    expect(await run('line7')).toBe('consumed')
    expect((await row("SELECT doc->>'taxRate' AS t FROM llenamos.inv_line_costs WHERE id='line7'")).t).toBe(String(menuOf().bravas!.taxRate))
  })

  it('reconciliación: arregla las líneas recientes que no cuadran con su estado y deja el segundo pase sin nada que arreglar', async () => {
    at(T(14))
    await h.admin.query("DELETE FROM llenamos.sala_order_lines WHERE restaurant_id='rest-a'")
    await putLine('rec1', orderLine({ placedAt: now - 1000 }))
    await putLine('line1', orderLine({ status: 'cancelled', history: [{ from: 'pending', to: 'fired', at: T(12, 1), by: 'waiter-a', reason: 'x' }] }))
    const out = await withIdentity(h.app, identity('owner-a'), 'rest-a', c => reconcileConsumption(c, scope(), now))
    expect(out).toEqual({ checked: 2, fixed: 1 })
    expect((await row("SELECT doc->>'state' AS s FROM llenamos.inv_line_costs WHERE id='rec1'")).s).toBe('consumed')
    // Segundo pase: nada que arreglar.
    expect((await withIdentity(h.app, identity('owner-a'), 'rest-a', c => reconcileConsumption(c, scope(), now))).fixed).toBe(0)
  })

  it('el worker, sin identidad de miembro, reconcilia el consumo y reprograma mientras haya ventas', async () => {
    at(T(15))
    const handler = new Map(MODULES.find(m => m.name === 'inventario')!.workerHandlers).get('inventario.reconciliar')!
    expect(handler).toBeTypeOf('function')
    await putLine('rec3', orderLine({ placedAt: now - 500 }))
    const before = await stock(patatas)
    await handler(await h.workerContext('rest-a', 'inventario.reconciliar', { locationId: 'centro' }, now))
    expect((await row("SELECT doc->>'state' AS s FROM llenamos.inv_line_costs WHERE id='rec3'")).s).toBe('consumed')
    expect(await stock(patatas)).toBe(before - 800)
    expect((await row("SELECT count(*)::int AS n FROM llenamos.jobs WHERE kind='inventario.reconciliar' AND scheduled_at>$1", [new Date(now)])).n).toBeGreaterThanOrEqual(1)
    // Sin ventas recientes no se reprograma y no cambia nada; un local de otro restaurante no existe para el worker de A.
    await expect(handler(await h.workerContext('rest-b', 'inventario.reconciliar', { locationId: 'centro' }, now))).resolves.toBeUndefined()
    expect(await stock(patatas)).toBe(before - 800)
  })

  it('márgenes: histórico acotado por fecha y teórico con los costes medios de hoy', async () => {
    const report = await h.ok('margenPlatos', { ...h.scope(), from: '2026-06-01', to: '2026-06-30' }, 'manager-a')
    const bravas = report.sold.find((r: { itemId: string }) => r.itemId === 'bravas')
    // Cuenta lo vendido (line7, rec1 y rec3); lo devuelto no suma y lo anulado tras prepararlo es pérdida (line2).
    expect(bravas).toMatchObject({ units: 6, coveredUnits: 6, wasteCostCents: 105 })
    expect(report.theoretical).toEqual([expect.objectContaining({ itemId: 'bravas', complete: true })])
    const empty = await h.ok('margenPlatos', { ...h.scope(), from: '2026-07-01', to: '2026-07-02' }, 'manager-a')
    expect(empty.sold).toEqual([])
    expect((await h.call('margenPlatos', { ...h.scope(), from: '2020-01-01', to: '2026-07-02' }, 'manager-a')).status).toBe(412)
  })

  it('lecturas en vivo: costes solo para quien los ve, cocina ve existencias, aislamiento y consultas acotadas', async () => {
    const live = (name: string) => MODULES.find(m => m.name === 'inventario')!.liveQueries!.find(q => q.name === name)!
    const snap = (name: string, input: unknown, uid: string) => withIdentity(h.app, identity(uid), (input as { restaurantId: string }).restaurantId, c => live(name).snapshot(c, input, { uid }) as Promise<any>)
    const stockView = await snap('inventarioStock', h.scope(), 'kitchen-a')
    expect(stockView.ingredients.map((i: { name: string }) => i.name).sort()).toEqual(['Aceite', 'Patatas nuevas'])
    expect(stockView.alerts.length).toBeGreaterThanOrEqual(1)
    await expect(snap('inventarioCostes', h.scope(), 'kitchen-a')).rejects.toMatchObject({ status: 403 })
    await expect(snap('inventarioMovimientos', h.scope(), 'kitchen-a')).rejects.toMatchObject({ status: 403 })
    await expect(snap('comprasPedidos', h.scope(), 'kitchen-a')).rejects.toMatchObject({ status: 403 })
    await expect(snap('inventarioStock', h.scope(), 'owner-b')).rejects.toMatchObject({ status: 403 })
    await expect(snap('inventarioStock', h.scope('b'), 'owner-a')).rejects.toMatchObject({ status: 403 })
    const costs = await snap('inventarioCostes', h.scope(), 'manager-a')
    expect(costs.costs.length).toBe(2)
    const movements = await snap('inventarioMovimientos', { ...h.scope(), max: 5, ingredientId: patatas, since: null }, 'manager-a')
    expect(movements.movements).toHaveLength(5)
    expect(movements.movements[0].at).toBeGreaterThanOrEqual(movements.movements[4].at)
    await expect(snap('inventarioMovimientos', { ...h.scope(), max: 99999 }, 'manager-a')).rejects.toBeInstanceOf(ZodError)
    expect((await snap('inventarioRecuentos', h.scope(), 'manager-a')).counts.length).toBe(2)
    expect((await snap('comprasPedidos', h.scope(), 'manager-a')).orders).toHaveLength(1)
    expect((await snap('comprasAlbaranes', { ...h.scope(), orderId: null }, 'manager-a')).receipts.length).toBeGreaterThanOrEqual(1)
    expect((await snap('inventarioPlatos', h.scope(), 'manager-a')).items.length).toBeGreaterThan(5)
    const recipes = await snap('inventarioRecetas', h.scope(), 'manager-a')
    expect((await snap('inventarioVersiones', { ...h.scope(), recipeId: recipes.recipes[0].id }, 'manager-a')).versions.map((v: { version: number }) => v.version)).toEqual([2, 1])
    await expect(snap('inventarioAjustes', h.scope(), 'kitchen-a')).rejects.toMatchObject({ status: 403 })
    await expect(snap('inventarioAjustes', h.scope(), 'bar-a')).rejects.toMatchObject({ status: 403 })
    expect((await snap('inventarioAjustes', h.scope(), 'manager-a')).settings.consumeOnSale).toBe(true)
    expect((await h.admin.query("SELECT DISTINCT topic FROM llenamos.events WHERE topic LIKE 'inventario.%' OR topic LIKE 'compras.%'")).rows.map(r => r.topic).sort()).toEqual(expect.arrayContaining(['compras.pedido', 'inventario.receta', 'inventario.recuento', 'inventario.stock']))
  })

  it('la lectura de la línea toma FOR SHARE: bloquea una escritura concurrente hasta que acaba la transacción', async () => {
    await putLine('share1', orderLine())
    const share = await h.app.connect()
    try {
      await share.query('BEGIN'); await share.query("SELECT set_config('app.restaurant_id','rest-a',true),set_config('app.actor_uid','owner-a',true)")
      expect((await lineSource().line(share, scope(), 'share1'))?.itemId).toBe('bravas')
      const writer = await h.app.connect()
      try {
        await writer.query('BEGIN'); await writer.query("SELECT set_config('app.restaurant_id','rest-a',true),set_config('app.actor_uid','owner-a',true)"); await writer.query("SET LOCAL lock_timeout='300ms'")
        await expect(writer.query("UPDATE llenamos.sala_order_lines SET doc=doc WHERE id='share1'")).rejects.toThrow(/lock timeout/)
      } finally { await writer.query('ROLLBACK').catch(() => {}); writer.release() }
    } finally { await share.query('ROLLBACK'); share.release() }
    // Y lo que no existe en este local no se inventa: el otro restaurante no ve esa línea.
    await withIdentity(h.app, identity('owner-b'), 'rest-b', async c => { expect(await lineSource().line(c, scope(), 'share1')).toBeNull() })
  })

  it('de punta a punta con sala: el pedido descuenta el stock, la anulación lo devuelve y un fallo de inventario no bloquea el pedido', async () => {
    const sala = { restaurantId: 'rest-a', locationId: 'centro' }
    at(Date.now())
    await h.ok('guardarConfiguracionInventario', { ...h.mutation(), settings: { ...core.defaultInventorySettings(), consumeOnSale: true } }, 'manager-a')
    const start = await stock(patatas)
    const table = await h.ok('abrirMesa', { ...sala, tableIds: ['t1'], guests: 2 }, 'waiter-a')
    const placed = await h.ok('enviarPedido', { ...sala, sessionId: table.sessionId, lines: [{ kind: 'item', itemId: 'bravas', quantity: 2 }] }, 'waiter-a')
    expect(placed.status).toBe('sent')
    const lineId = placed.lineIds[0] as string
    const status = async () => (await row("SELECT doc->>'status' AS s FROM llenamos.sala_order_lines WHERE id=$1", [lineId])).s as string
    if ((await status()) === 'held') await h.ok('marcharPase', { ...sala, sessionId: table.sessionId, course: 'all' }, 'waiter-a')
    expect(['fired', 'preparing']).toContain(await status())
    // Marchó: el stock bajó en la misma transacción de sala (2 raciones × 400 g) y la línea tiene su coste.
    expect(await stock(patatas)).toBe(start - 800)
    expect((await row("SELECT doc->>'state' AS s FROM llenamos.inv_line_costs WHERE id=$1", [lineId])).s).toBe('consumed')
    // Repetir el mismo estado no vuelve a descontar.
    await h.ok('cambiarEstadoLineas', { ...sala, lineIds: [lineId], status: 'preparing' }, 'kitchen-a').catch(() => null)
    expect(await stock(patatas)).toBe(start - 800)
    // Segunda línea que se anula antes de preparar: vuelve el stock.
    const second = await h.ok('enviarPedido', { ...sala, sessionId: table.sessionId, lines: [{ kind: 'item', itemId: 'bravas', quantity: 1 }] }, 'waiter-a')
    const secondId = second.lineIds[0] as string
    if ((await row("SELECT doc->>'status' AS s FROM llenamos.sala_order_lines WHERE id=$1", [secondId])).s === 'held') await h.ok('marcharPase', { ...sala, sessionId: table.sessionId, course: 'all' }, 'waiter-a')
    expect(await stock(patatas)).toBe(start - 1200)
    await h.ok('cambiarEstadoLineas', { ...sala, lineIds: [secondId], status: 'cancelled', reason: 'Cambio de opinión' }, 'manager-a')
    expect(await stock(patatas)).toBe(start - 800)
    expect((await row("SELECT doc->>'state' AS s FROM llenamos.inv_line_costs WHERE id=$1", [secondId])).s).toBe('reversed')
    // Averiado inventario (documento de un ingrediente ilegible): el pedido se acepta igualmente y queda para la reconciliación.
    const good = (await row('SELECT doc FROM llenamos.inv_ingredients WHERE id=$1', [patatas])).doc
    await h.admin.query("UPDATE llenamos.inv_ingredients SET doc='{}'::jsonb WHERE id=$1", [patatas])
    const third = await h.call('enviarPedido', { ...sala, sessionId: table.sessionId, lines: [{ kind: 'item', itemId: 'bravas', quantity: 1 }] }, 'waiter-a')
    await h.admin.query('UPDATE llenamos.inv_ingredients SET doc=$2 WHERE id=$1', [patatas, good])
    expect(third.status).toBe(200)
    const thirdId = third.body.result.lineIds[0] as string
    if ((await row("SELECT doc->>'status' AS s FROM llenamos.sala_order_lines WHERE id=$1", [thirdId])).s === 'held') await h.ok('marcharPase', { ...sala, sessionId: table.sessionId, course: 'all' }, 'waiter-a').catch(() => null)
    expect((await row("SELECT count(*)::int AS n FROM llenamos.inv_line_costs WHERE id=$1", [thirdId])).n).toBe(0)
    const fixed = await withIdentity(h.app, identity('owner-a'), 'rest-a', c => reconcileConsumption(c, scope(), Date.now()))
    expect(fixed.fixed).toBeGreaterThanOrEqual(1)
    expect((await row("SELECT doc->>'state' AS s FROM llenamos.inv_line_costs WHERE id=$1", [thirdId])).s).toBe('consumed')
    expect(await stock(patatas)).toBe(start - 1200)
  })

  it('un pedido público por QR también descuenta el stock en su transacción, sin sesión de miembro', async () => {
    const sala = { restaurantId: 'rest-a', locationId: 'centro' }
    const start = await stock(patatas)
    const { tokens } = await h.ok('regenerarQrMesa', { ...sala, tableIds: ['t2'] }, 'manager-a')
    const open = await h.ok('abrirMesa', { ...sala, tableIds: ['t2'], guests: 2 }, 'waiter-a')
    const link = { slug: 'rest-a', locationId: 'centro', tableId: 't2', token: tokens[0].token }
    const view = await h.callPublic('verMesaPublica', link)
    expect(view.status, JSON.stringify(view.body)).toBe(200)
    const input = { ...link, sessionId: open.sessionId, lines: [{ kind: 'item', itemId: 'bravas', quantity: 1 }], expectedTotalCents: view.body.result.session.totalCents + menuOf().bravas!.priceCents, expectedDestination: view.body.result.destination, language: 'es', requestId: 'qr-pedido-0000001' }
    const order = await h.callPublic('pedirDesdeMesa', input)
    expect(order.status, JSON.stringify(order.body)).toBe(200)
    const ids = (await h.admin.query("SELECT id FROM llenamos.sala_order_lines WHERE restaurant_id='rest-a' AND session_id=$1", [open.sessionId])).rows.map(r => r.id)
    expect(ids).toHaveLength(1)
    const state = (await row("SELECT doc->>'status' AS s FROM llenamos.sala_order_lines WHERE id=$1", [ids[0]])).s
    // Con el pedido de mesa ya en marcha (sin aprobación) el consumo se anota; si el local lo deja retenido hasta marchar, aún no.
    if (['fired', 'preparing', 'ready', 'served'].includes(state)) {
      expect(await stock(patatas)).toBe(start - 400)
      expect((await row("SELECT doc->>'state' AS s FROM llenamos.inv_line_costs WHERE id=$1", [ids[0]])).s).toBe('consumed')
    } else expect(await stock(patatas)).toBe(start)
    // Repetir el mismo pedido (reintento del cliente) no descuenta otra vez.
    const again = await h.callPublic('pedirDesdeMesa', input)
    expect(again.status).toBe(200)
    expect(await stock(patatas)).toBe(state === 'held' ? start : start - 400)
  })

  it('las lecturas completas fallan en vez de recortar: 2001 ingredientes no se sirven a medias', async () => {
    await h.admin.query(`INSERT INTO llenamos.inv_ingredients(restaurant_id,location_id,id,doc)
      SELECT 'rest-b','centro','ing'||g,jsonb_build_object('name','Ingrediente '||g,'unit','g','category',null,'minQuantity',0,'targetQuantity',null,'active',true,'quantity',0,'revision',1) FROM generate_series(1,2001) g`)
    const live = MODULES.find(m => m.name === 'inventario')!.liveQueries!.find(q => q.name === 'inventarioStock')!
    await expect(withIdentity(h.app, identity('owner-b'), 'rest-b', c => live.snapshot(c, h.scope('b'), { uid: 'owner-b' }))).rejects.toMatchObject({ status: 412 })
    const sug = await h.call('sugerirPedidos', h.scope('b'), 'owner-b')
    expect(sug.status).toBe(200)
    await h.admin.query("DELETE FROM llenamos.inv_ingredients WHERE id='ing2001' AND restaurant_id='rest-b'")
    const ok = await withIdentity(h.app, identity('owner-b'), 'rest-b', c => live.snapshot(c, h.scope('b'), { uid: 'owner-b' })) as { ingredients: unknown[] }
    expect(ok.ingredients).toHaveLength(2000)
  })
})
