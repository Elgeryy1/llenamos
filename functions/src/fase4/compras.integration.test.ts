import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import * as core from '@llenamos/core'
import { db } from '../shared'
import { call, cleanup, createRestaurant, enabled, type Fx } from './fixture'

let fx: Fx
const doc = async (path: string) => (await db.doc(`${fx.path}/${path}`).get()).data()
const order = async (id: string) => core.PurchaseOrderSchema.parse(await doc(`purchaseOrders/${id}`))
const item = async (id: string) => core.SupplierItemSchema.parse(await doc(`supplierItems/${id}`))
const stock = async (id: string) => ({ quantity: core.IngredientSchema.parse(await doc(`ingredients/${id}`)).quantity, ...core.IngredientCostSchema.parse(await doc(`ingredientCosts/${id}`)) })
const ing = (name: string, unit: 'g' | 'ml' | 'u', min = 0, target: number | null = null) => ({ name, unit, category: null, minQuantity: min, targetQuantity: target, active: true })
const supplier = (extra: object = {}) => ({ name: 'Distribuciones Sol', phone: '600111222', email: 'pedidos@sol.test', contact: 'Marta', leadDays: 2, minOrderCents: 5000, notes: '', active: true, ...extra })
const newIng = async (name: string, unit: 'g' | 'ml' | 'u', min: number, opening: { quantity: number; valueCents: number } | null, target: number | null = null) =>
  (await call('guardarIngrediente', { ...fx.mutation(), ingredientId: null, expectedRevision: null, ingredient: ing(name, unit, min, target), opening }, 'manager')).ingredientId
const format = (supplierId: string, ingredientId: string, name: string, baseQuantity: number, priceCents: number, extra: object = {}) =>
  ({ supplierId, ingredientId, name, sku: null, baseQuantity, priceCents, preferred: false, active: true, ...extra })
const newFormat = async (f: ReturnType<typeof format>) => (await call('guardarFormatoProveedor', { ...fx.mutation(), itemId: null, item: f }, 'manager')).itemId

describe.skipIf(!enabled)('Compras: proveedores, pedidos y recepción', { timeout: 60000 }, () => {
  beforeEach(async () => { fx = await createRestaurant('f4-compras') }, 60000)
  afterAll(cleanup, 120000)

  it('solo el encargado gestiona compras; cocina y camarero no pueden ni ver sugerencias', async () => {
    for (const uid of [null, 'waiter', 'kitchen', 'bar', 'inactive', 'limited']) {
      await expect(call('guardarProveedor', { ...fx.mutation(), supplierId: null, supplier: supplier() }, uid)).rejects.toMatchObject({ code: uid === null ? 'unauthenticated' : 'permission-denied' })
    }
    for (const uid of ['waiter', 'kitchen', 'bar']) await expect(call('sugerirPedidos', fx.scope(), uid)).rejects.toMatchObject({ code: 'permission-denied' })
    const { supplierId } = await call('guardarProveedor', { ...fx.mutation(), supplierId: null, supplier: supplier() }, 'manager')
    await call('guardarProveedor', { ...fx.mutation(), supplierId, supplier: supplier({ leadDays: 3 }) }, 'owner')
    expect(core.SupplierSchema.parse(await doc(`suppliers/${supplierId}`)).leadDays).toBe(3)
    await expect(call('guardarProveedor', { ...fx.mutation(), supplierId: 'nada', supplier: supplier() }, 'manager')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('pedido en dos recepciones con cambio de precio: coste medio, último precio, pendientes y exceso', async () => {
    const { supplierId } = await call('guardarProveedor', { ...fx.mutation(), supplierId: null, supplier: supplier() }, 'manager')
    const aceite = await newIng('Aceite', 'ml', 0, { quantity: 2000, valueCents: 1000 }) // 0,5 c/ml
    const patatas = await newIng('Patatas', 'g', 0, null)
    const garrafa = await newFormat(format(supplierId, aceite, 'Garrafa 5 l', 5000, 2000, { preferred: true }))
    const saco = await newFormat(format(supplierId, patatas, 'Saco 25 kg', 25000, 1500))
    await expect(call('guardarFormatoProveedor', { ...fx.mutation(), itemId: null, item: format(supplierId, 'fantasma', 'X', 1, 1) }, 'manager')).rejects.toMatchObject({ code: 'not-found' })

    // Borrador: el precio sale del formato guardado, nunca de la entrada.
    const draft = { ...fx.mutation(), orderId: null, expectedRevision: null, supplierId, lines: [{ supplierItemId: garrafa, formats: 4 }, { supplierItemId: saco, formats: 2 }], expectedOn: '2026-12-01', notes: 'Antes de las 10' }
    const created = await call('guardarPedidoProveedor', draft, 'manager')
    expect(created).toMatchObject({ revision: 1, totalCents: 4 * 2000 + 2 * 1500 })
    expect(created.reference).toMatch(/^[A-Z0-9]{6}$/)
    expect((await doc(`purchaseReferences/${created.reference}`))).toEqual(expect.objectContaining({ orderId: created.orderId }))
    expect(await order(created.orderId)).toMatchObject({ status: 'draft', createdBy: 'manager', sentAt: null })
    // Cambiar el precio del formato después no toca el pedido ya guardado.
    await call('guardarFormatoProveedor', { ...fx.mutation(), itemId: garrafa, item: format(supplierId, aceite, 'Garrafa 5 l', 5000, 2500, { preferred: true }) }, 'manager')
    expect((await order(created.orderId)).lines[0]).toMatchObject({ lineId: 'l1', priceCents: 2000, name: 'Garrafa 5 l', baseQuantity: 5000, orderedFormats: 4, receivedFormats: 0 })
    // Al editar el borrador sí se vuelve a tomar el precio actual; el id de la línea se conserva.
    const edited = await call('guardarPedidoProveedor', { ...fx.mutation(), orderId: created.orderId, expectedRevision: 1, supplierId, lines: draft.lines, expectedOn: null, notes: '' }, 'manager')
    expect(edited).toMatchObject({ reference: created.reference, revision: 2, totalCents: 4 * 2500 + 2 * 1500 })
    await call('guardarFormatoProveedor', { ...fx.mutation(), itemId: garrafa, item: format(supplierId, aceite, 'Garrafa 5 l', 5000, 2000, { preferred: true }) }, 'manager')
    await expect(call('guardarPedidoProveedor', { ...fx.mutation(), orderId: created.orderId, expectedRevision: 1, supplierId, lines: draft.lines, expectedOn: null, notes: '' }, 'manager')).rejects.toMatchObject({ code: 'failed-precondition' })
    const again = await call('guardarPedidoProveedor', { ...fx.mutation(), orderId: created.orderId, expectedRevision: 2, supplierId, lines: draft.lines, expectedOn: null, notes: '' }, 'manager')
    expect(again.totalCents).toBe(11000)

    // Sin enviar no se recibe; enviar exige la revisión.
    const receipt = (lines: object[], orderId: string | null = created.orderId, expectedRevision: number | null = 4) => ({ ...fx.mutation(), supplierId, purchaseOrderId: orderId, expectedRevision, deliveryNote: 'A-123', lines })
    await expect(call('recibirPedidoProveedor', receipt([{ supplierItemId: garrafa, receivedFormats: 1, priceCents: 2000 }], created.orderId, 3), 'manager')).rejects.toMatchObject({ code: 'failed-precondition', message: expect.stringContaining('no admite') })
    await expect(call('cambiarEstadoPedidoProveedor', { ...fx.mutation(), orderId: created.orderId, expectedRevision: 1, to: 'sent' }, 'manager')).rejects.toMatchObject({ code: 'failed-precondition' })
    expect(await call('cambiarEstadoPedidoProveedor', { ...fx.mutation(), orderId: created.orderId, expectedRevision: 3, to: 'sent' }, 'manager')).toEqual({ revision: 4, status: 'sent' })
    expect((await order(created.orderId)).sentAt).not.toBeNull()
    await expect(call('guardarPedidoProveedor', { ...fx.mutation(), orderId: created.orderId, expectedRevision: 4, supplierId, lines: draft.lines, expectedOn: null, notes: '' }, 'manager')).rejects.toMatchObject({ message: expect.stringContaining('borrador') })

    // Primera recepción: llegan 2 de 4 garrafas a 22 euros y los dos sacos.
    const first = receipt([{ supplierItemId: garrafa, receivedFormats: 2, priceCents: 2200 }, { supplierItemId: saco, receivedFormats: 2, priceCents: 1500 }])
    const r1 = await call('recibirPedidoProveedor', first, 'manager')
    expect(r1).toMatchObject({ totalCents: 2 * 2200 + 2 * 1500, orderStatus: 'partially_received', pending: [{ lineId: 'l1', formats: 2 }], exceeded: [], priceChanges: [{ supplierItemId: garrafa, previousCents: 2000, newCents: 2200, changeBp: 1000 }] })
    // Repetir la petición no vuelve a recibir.
    expect(await call('recibirPedidoProveedor', first, 'manager')).toEqual(r1)
    expect((await db.collection(`${fx.path}/goodsReceipts`).get()).size).toBe(1)
    // Entra al precio del albarán: 2000 ml a 0,5 c/ml más 10 000 ml a 4400 céntimos.
    expect(await stock(aceite)).toEqual({ quantity: 12000, valueCents: 5400, lastCost: { cents: 4400, perBase: 10000 } })
    expect(await stock(patatas)).toMatchObject({ quantity: 50000, valueCents: 3000 })
    expect(await item(garrafa)).toMatchObject({ lastPriceCents: 2200 })
    expect(await order(created.orderId)).toMatchObject({ status: 'partially_received', revision: 5 })
    expect(core.GoodsReceiptSchema.parse(await doc(`goodsReceipts/${r1.receiptId}`))).toMatchObject({ deliveryNote: 'A-123', receivedBy: 'manager', totalCents: 7400 })
    const movs = (await db.collection(`${fx.path}/stockMovements`).where('receiptId', '==', r1.receiptId).get()).docs.map((d) => core.StockMovementSchema.parse(d.data()))
    expect(movs.map((m) => [m.kind, m.quantity, m.valueCents]).sort()).toEqual([['receipt', 10000, 4400], ['receipt', 50000, 3000]])

    // Un formato que no está en el pedido o de otro proveedor se rechaza.
    const otro = (await call('guardarProveedor', { ...fx.mutation(), supplierId: null, supplier: supplier({ name: 'Otro' }) }, 'manager')).supplierId
    const ajeno = await newFormat(format(otro, aceite, 'Lata', 1000, 400))
    await expect(call('recibirPedidoProveedor', receipt([{ supplierItemId: ajeno, receivedFormats: 1, priceCents: 400 }], created.orderId, 5), 'manager')).rejects.toMatchObject({ code: 'failed-precondition' })
    await expect(call('recibirPedidoProveedor', receipt([{ supplierItemId: saco, receivedFormats: 1, priceCents: 1500 }, { supplierItemId: saco, receivedFormats: 1, priceCents: 1500 }], created.orderId, 5), 'manager')).rejects.toMatchObject({ message: expect.stringContaining('repetidos') })
    await expect(call('recibirPedidoProveedor', { ...receipt([{ supplierItemId: garrafa, receivedFormats: 1, priceCents: 2200 }], created.orderId, 5), supplierId: otro }, 'manager')).rejects.toMatchObject({ code: 'failed-precondition' })
    await expect(call('recibirPedidoProveedor', receipt([{ supplierItemId: saco, receivedFormats: 1, priceCents: 1500 }], created.orderId, 4), 'manager')).rejects.toMatchObject({ code: 'failed-precondition' })

    // Segunda recepción: llegan 3 garrafas (una de más) al mismo precio del último albarán: sin aviso de precio.
    const r2 = await call('recibirPedidoProveedor', receipt([{ supplierItemId: garrafa, receivedFormats: 3, priceCents: 2200 }], created.orderId, 5), 'manager')
    expect(r2).toMatchObject({ orderStatus: 'received', pending: [], exceeded: [{ lineId: 'l1', extraFormats: 1 }], priceChanges: [] })
    expect(await stock(aceite)).toMatchObject({ quantity: 27000, valueCents: 5400 + 6600 })
    expect((await order(created.orderId)).status).toBe('received')
    await expect(call('recibirPedidoProveedor', receipt([{ supplierItemId: garrafa, receivedFormats: 1, priceCents: 2200 }], created.orderId, 6), 'manager')).rejects.toMatchObject({ message: expect.stringContaining('no admite') })
    await expect(call('cambiarEstadoPedidoProveedor', { ...fx.mutation(), orderId: created.orderId, expectedRevision: 6, to: 'closed', reason: 'x' }, 'manager')).rejects.toMatchObject({ code: 'failed-precondition' })
    const actions = (await db.collection(`restaurants/${fx.rid}/activity`).where('action', '==', 'purchase.received').get()).size
    expect(actions).toBe(2)
  })

  it('un pedido con recepciones no se anula: se cierra sin completar con motivo; sin recepciones se puede anular', async () => {
    const { supplierId } = await call('guardarProveedor', { ...fx.mutation(), supplierId: null, supplier: supplier() }, 'manager')
    const harina = await newIng('Harina', 'g', 0, null)
    const saco = await newFormat(format(supplierId, harina, 'Saco 10 kg', 10000, 900))
    const mk = async () => {
      const o = await call('guardarPedidoProveedor', { ...fx.mutation(), orderId: null, expectedRevision: null, supplierId, lines: [{ supplierItemId: saco, formats: 3 }], expectedOn: null, notes: '' }, 'manager')
      await call('cambiarEstadoPedidoProveedor', { ...fx.mutation(), orderId: o.orderId, expectedRevision: 1, to: 'sent' }, 'manager')
      return o.orderId
    }
    const a = await mk()
    await expect(call('cambiarEstadoPedidoProveedor', { ...fx.mutation(), orderId: a, expectedRevision: 2, to: 'cancelled', reason: null }, 'manager')).rejects.toMatchObject({ message: expect.stringContaining('motivo') })
    expect(await call('cambiarEstadoPedidoProveedor', { ...fx.mutation(), orderId: a, expectedRevision: 2, to: 'cancelled', reason: 'Cambio de proveedor' }, 'manager')).toEqual({ revision: 3, status: 'cancelled' })
    expect(await order(a)).toMatchObject({ status: 'cancelled', closedReason: 'Cambio de proveedor' })
    const b = await mk()
    await call('recibirPedidoProveedor', { ...fx.mutation(), supplierId, purchaseOrderId: b, expectedRevision: 2, deliveryNote: null, lines: [{ supplierItemId: saco, receivedFormats: 1, priceCents: 900 }] }, 'manager')
    await expect(call('cambiarEstadoPedidoProveedor', { ...fx.mutation(), orderId: b, expectedRevision: 3, to: 'cancelled', reason: 'Ya no' }, 'manager')).rejects.toMatchObject({ code: 'failed-precondition' })
    await expect(call('cambiarEstadoPedidoProveedor', { ...fx.mutation(), orderId: b, expectedRevision: 3, to: 'closed', reason: '  ' }, 'manager')).rejects.toMatchObject({ code: 'failed-precondition' })
    expect(await call('cambiarEstadoPedidoProveedor', { ...fx.mutation(), orderId: b, expectedRevision: 3, to: 'closed', reason: 'No traen más' }, 'manager')).toEqual({ revision: 4, status: 'closed' })
    await expect(call('cambiarEstadoPedidoProveedor', { ...fx.mutation(), orderId: b, expectedRevision: 4, to: 'sent' }, 'manager')).rejects.toMatchObject({ code: 'failed-precondition' })
    // No se pide a un proveedor desactivado ni con formatos desactivados.
    await call('guardarProveedor', { ...fx.mutation(), supplierId, supplier: supplier({ active: false }) }, 'manager')
    await expect(call('guardarPedidoProveedor', { ...fx.mutation(), orderId: null, expectedRevision: null, supplierId, lines: [{ supplierItemId: saco, formats: 1 }], expectedOn: null, notes: '' }, 'manager')).rejects.toMatchObject({ message: expect.stringContaining('desactivado') })
  })

  it('una compra directa sin pedido entra al almacén; un formato preferido deja de serlo al marcar otro', async () => {
    const { supplierId } = await call('guardarProveedor', { ...fx.mutation(), supplierId: null, supplier: supplier() }, 'manager')
    const leche = await newIng('Leche', 'ml', 0, null)
    const brik = await newFormat(format(supplierId, leche, 'Brik 1 l', 1000, 90, { preferred: true }))
    const caja = await newFormat(format(supplierId, leche, 'Caja 6 l', 6000, 480))
    await call('guardarFormatoProveedor', { ...fx.mutation(), itemId: caja, item: format(supplierId, leche, 'Caja 6 l', 6000, 480, { preferred: true }) }, 'manager')
    expect((await item(brik)).preferred).toBe(false); expect((await item(caja)).preferred).toBe(true)
    await expect(call('guardarFormatoProveedor', { ...fx.mutation(), itemId: caja, item: format(supplierId, 'otro', 'Caja 6 l', 6000, 480) }, 'manager')).rejects.toMatchObject({ code: 'not-found' })
    const direct = await call('recibirPedidoProveedor', { ...fx.mutation(), supplierId, purchaseOrderId: null, expectedRevision: null, deliveryNote: null, lines: [{ supplierItemId: caja, receivedFormats: 2, priceCents: 480 }] }, 'manager')
    expect(direct).toMatchObject({ orderStatus: null, totalCents: 960, pending: [], exceeded: [], priceChanges: [] })
    expect(await stock(leche)).toMatchObject({ quantity: 12000, valueCents: 960 })
    await call('guardarFormatoProveedor', { ...fx.mutation(), itemId: brik, item: format(supplierId, leche, 'Brik 1 l', 1000, 90, { active: false }) }, 'manager')
    await expect(call('recibirPedidoProveedor', { ...fx.mutation(), supplierId, purchaseOrderId: null, expectedRevision: null, deliveryNote: null, lines: [{ supplierItemId: brik, receivedFormats: 1, priceCents: 90 }] }, 'manager')).rejects.toMatchObject({ message: expect.stringContaining('desactivado') })
  })

  it('sugerir pedidos tiene en cuenta lo ya pedido, el formato preferido, el mínimo del proveedor y los ingredientes sin formato', async () => {
    const { supplierId } = await call('guardarProveedor', { ...fx.mutation(), supplierId: null, supplier: supplier({ minOrderCents: 5000 }) }, 'manager')
    const aceite = await newIng('Aceite', 'ml', 2000, { quantity: 1500, valueCents: 750 }, 10000)
    const patatas = await newIng('Patatas', 'g', 5000, { quantity: 1000, valueCents: 150 }) // sin objetivo: el doble del mínimo
    const sal = await newIng('Sal', 'g', 500, { quantity: 200, valueCents: 20 })
    await newIng('Pimienta', 'g', 100, { quantity: 5000, valueCents: 500 })
    const garrafa = await newFormat(format(supplierId, aceite, 'Garrafa 5 l', 5000, 2000))
    const saco = await newFormat(format(supplierId, patatas, 'Saco 25 kg', 25000, 1500))
    await newFormat(format(supplierId, patatas, 'Saco 10 kg', 10000, 900, { preferred: true }))
    const suggestion = await call('sugerirPedidos', fx.scope(), 'manager')
    expect(suggestion.withoutSupplier).toEqual([sal])
    expect(suggestion.orders).toHaveLength(1)
    // Aceite: faltan 8500 hasta 10 000 -> 2 garrafas; patatas: faltan 9000 -> 1 saco de 10 kg (preferido).
    const lines = suggestion.orders[0]!.lines
    expect(lines.find((l) => l.ingredientId === aceite)).toMatchObject({ formats: 2, totalCents: 4000 })
    expect(lines.find((l) => l.ingredientId === patatas)).toMatchObject({ formats: 1, totalCents: 900 })
    expect(suggestion.orders[0]).toMatchObject({ supplierId, totalCents: 4900, belowMinimum: true })
    // Lo ya pedido cuenta: se envía el pedido de 2 garrafas y deja de sugerirse el aceite.
    const o = await call('guardarPedidoProveedor', { ...fx.mutation(), orderId: null, expectedRevision: null, supplierId, lines: [{ supplierItemId: garrafa, formats: 2 }], expectedOn: null, notes: '' }, 'manager')
    // Un borrador todavía no cuenta; enviado, sí.
    expect((await call('sugerirPedidos', fx.scope(), 'manager')).orders[0]!.lines.some((l) => l.ingredientId === aceite)).toBe(true)
    await call('cambiarEstadoPedidoProveedor', { ...fx.mutation(), orderId: o.orderId, expectedRevision: 1, to: 'sent' }, 'manager')
    expect((await call('sugerirPedidos', fx.scope(), 'manager')).orders[0]!.lines.some((l) => l.ingredientId === aceite)).toBe(false)
    expect(saco).toBeTruthy(); expect(o.orderId).toBeTruthy()
  })
})
