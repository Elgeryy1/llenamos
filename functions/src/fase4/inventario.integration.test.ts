import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import * as core from '@llenamos/core'
import { db } from '../shared'
import * as api from './index'
import { consumeLine, reconcileConsumption } from './consumo'
import { call, cleanup, createRestaurant, enabled, loadMenu, req, type Fx } from './fixture'

let fx: Fx
let tables = 0
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ingredient = (name: string, unit: 'g' | 'ml' | 'u', min: number, target: number | null = null) => ({ name, unit, category: null, minQuantity: min, targetQuantity: target, active: true })
const doc = async (path: string) => (await db.doc(`${fx.path}/${path}`).get()).data()
const alertDoc = async (id: string) => { const d = await doc(`stockAlerts/${id}`); return d ? core.StockAlertSchema.parse(d) : null }
const qty = async (id: string) => core.IngredientSchema.parse(await doc(`ingredients/${id}`)).quantity
const costDoc = async (id: string) => core.IngredientCostSchema.parse(await doc(`ingredientCosts/${id}`))
const movements = async (id: string) => (await db.collection(`${fx.path}/stockMovements`).where('ingredientId', '==', id).get()).docs.map((d) => ({ id: d.id, ...core.StockMovementSchema.parse(d.data()) })).sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
const lowActivity = async () => (await db.collection(`restaurants/${fx.rid}/activity`).where('action', '==', 'stock.low').get()).docs.map((d) => d.get('summary') as string)
async function newIngredient(name: string, unit: 'g' | 'ml' | 'u', min: number, opening: { quantity: number; valueCents: number } | null = null, target: number | null = null) {
  return (await call('guardarIngrediente', { ...fx.mutation(), ingredientId: null, expectedRevision: null, ingredient: ingredient(name, unit, min, target), opening })).ingredientId
}

describe.skipIf(!enabled)('Inventario: existencias, recetas, recuento y avisos', { timeout: 60000 }, () => {
  beforeEach(async () => { fx = await createRestaurant('f4-inventario'); tables = 0 }, 60000)
  afterAll(cleanup, 120000)

  it('exige sesión, rol, local y módulo; cocina y barra solo mermar y ver avisos, nunca costes', async () => {
    const d = { ...fx.mutation(), ingredientId: null, expectedRevision: null, ingredient: ingredient('Sal', 'g', 0), opening: null }
    for (const uid of [null, 'inactive', 'limited', 'foreign']) await expect(call('guardarIngrediente', d, uid)).rejects.toMatchObject({ code: uid === null ? 'unauthenticated' : 'permission-denied' })
    for (const uid of ['waiter', 'kitchen', 'bar']) await expect(call('guardarIngrediente', d, uid)).rejects.toMatchObject({ code: 'permission-denied' })
    const id = await newIngredient('Patatas', 'g', 2000, { quantity: 5000, valueCents: 750 })
    const waste = { ...fx.mutation(), ingredientId: id, quantity: 100, wasteReason: 'spoiled' as const, reason: null }
    await expect(call('registrarMerma', waste, 'waiter')).rejects.toMatchObject({ code: 'permission-denied' })
    // Cocina y barra mermar: la respuesta no trae valor ni coste.
    for (const uid of ['kitchen', 'bar']) {
      const out = await call('registrarMerma', { ...waste, requestId: `m-${uid}` }, uid)
      expect(Object.keys(out).sort()).toEqual(['movementId', 'quantityAfter'])
    }
    for (const name of ['ajustarStock', 'aplicarRecuento', 'guardarProveedor', 'sugerirPedidos', 'margenPlatos', 'guardarReceta'] as const) {
      await expect(call(name, { ...fx.mutation(), ...fx.scope() }, 'kitchen')).rejects.toMatchObject({ code: expect.stringMatching(/permission-denied|invalid-argument/) })
    }
    await expect(call('margenPlatos', { ...fx.scope(), from: '2026-01-01', to: '2026-01-02' }, 'kitchen')).rejects.toMatchObject({ code: 'permission-denied' })
    await expect(call('margenPlatos', { ...fx.scope(), from: '2026-01-01', to: '2026-01-02' }, 'bar')).rejects.toMatchObject({ code: 'permission-denied' })
    await expect(call('reconocerAvisoStock', { ...fx.mutation(), ingredientId: id }, 'kitchen')).rejects.toMatchObject({ code: 'not-found' })
    await db.doc(`restaurants/${fx.rid}`).update({ activeModules: ['floor', 'staff'] })
    await expect(call('registrarMerma', { ...waste, requestId: 'm-off' }, 'kitchen')).rejects.toMatchObject({ code: 'failed-precondition' })
  })

  it('un ingrediente nuevo fija existencias iniciales con su valor, no cambia de unidad con movimientos y respeta la revisión', async () => {
    const id = await newIngredient('Aceite', 'ml', 1000, { quantity: 2000, valueCents: 1000 })
    expect(await qty(id)).toBe(2000)
    expect(await costDoc(id)).toEqual({ valueCents: 1000, lastCost: { cents: 1000, perBase: 2000 } })
    const [open] = await movements(id)
    expect(open).toMatchObject({ kind: 'opening', quantity: 2000, valueCents: 1000, quantityAfter: 2000, by: 'owner' })
    const edit = (rev: number, change: object = {}) => ({ ...fx.mutation(), ingredientId: id, expectedRevision: rev, ingredient: { ...ingredient('Aceite', 'ml', 1000), ...change }, opening: null })
    await expect(call('guardarIngrediente', edit(5), 'manager')).rejects.toMatchObject({ code: 'failed-precondition' })
    await expect(call('guardarIngrediente', edit(1, { unit: 'g' }), 'manager')).rejects.toMatchObject({ code: 'failed-precondition', message: expect.stringContaining('unidad') })
    expect(await call('guardarIngrediente', edit(1, { minQuantity: 500 }), 'manager')).toEqual({ ingredientId: id, revision: 2 })
    // Las existencias iniciales solo se fijan al crear.
    await expect(call('guardarIngrediente', { ...edit(2), opening: { quantity: 5, valueCents: 5 } }, 'manager')).rejects.toMatchObject({ code: 'invalid-argument' })
    // La cantidad y el valor no los toca una edición.
    expect(await qty(id)).toBe(2000)
    // Sin existencias iniciales y con mínimo, nace agotado y avisa.
    const empty = await newIngredient('Sal', 'g', 100)
    expect(await alertDoc(empty)).toMatchObject({ level: 'out', status: 'open' })
    expect(await costDoc(empty)).toEqual({ valueCents: 0, lastCost: null })
  })

  it('el aviso de stock bajo se abre, empeora, se reconoce, reabre al empeorar y se resuelve; sin ajuste activado no hay avisos', async () => {
    const id = await newIngredient('Patatas', 'g', 2000, { quantity: 5000, valueCents: 750 })
    expect(await alertDoc(id)).toBeNull()
    const waste = (quantity: number, uid = 'kitchen') => call('registrarMerma', { ...fx.mutation(), ingredientId: id, quantity, wasteReason: 'broken', reason: null }, uid)
    await waste(3000)
    expect(await alertDoc(id)).toMatchObject({ level: 'low', status: 'open', quantity: 2000, minQuantity: 2000 })
    await waste(500)
    expect(await alertDoc(id)).toMatchObject({ level: 'low', quantity: 1500 })
    expect(await lowActivity()).toHaveLength(1)
    await waste(1500)
    expect(await alertDoc(id)).toMatchObject({ level: 'out', status: 'open', quantity: 0 })
    expect(await lowActivity()).toHaveLength(2)
    // Reconocer no silencia un empeoramiento.
    const ack = await call('reconocerAvisoStock', { ...fx.mutation(), ingredientId: id }, 'bar')
    expect(ack.alert).toMatchObject({ status: 'acknowledged', acknowledgedBy: 'bar' })
    await call('reconocerAvisoStock', { ...fx.mutation(), ingredientId: id }, 'kitchen')
    await waste(100)
    expect(await alertDoc(id)).toMatchObject({ level: 'negative', status: 'open', acknowledgedBy: null, quantity: -100 })
    expect(await lowActivity()).toHaveLength(3)
    // Reponer por encima del mínimo lo resuelve.
    await call('ajustarStock', { ...fx.mutation(), ingredientId: id, kind: 'adjustment', quantity: 6000, reason: 'Compra sin albarán' }, 'manager')
    expect(await alertDoc(id)).toMatchObject({ status: 'resolved', quantity: 5900 })
    await expect(call('reconocerAvisoStock', { ...fx.mutation(), ingredientId: id }, 'kitchen')).rejects.toMatchObject({ code: 'failed-precondition' })
    // Con los avisos apagados no se abre ninguno.
    await call('guardarConfiguracionInventario', { ...fx.mutation(), settings: { consumeOnSale: true, lowStockAlerts: false } }, 'manager')
    await waste(5900)
    expect(await alertDoc(id)).toMatchObject({ status: 'resolved' })
  })

  it('merma, ajuste y devolución a proveedor se valoran al coste medio y exigen motivo; el stock puede quedar en negativo', async () => {
    const id = await newIngredient('Queso', 'g', 0, { quantity: 1000, valueCents: 2000 })
    const merma = await call('registrarMerma', { ...fx.mutation(), ingredientId: id, quantity: 250, wasteReason: 'expired', reason: 'Caducó ayer' }, 'kitchen')
    expect(merma.quantityAfter).toBe(750)
    expect(await costDoc(id)).toMatchObject({ valueCents: 1500 })
    const [, w] = await movements(id)
    expect(w).toMatchObject({ kind: 'waste', quantity: -250, valueCents: -500, wasteReason: 'expired', reason: 'Caducó ayer', by: 'kitchen' })
    const bad = { ...fx.mutation(), ingredientId: id, kind: 'adjustment' as const, quantity: -50, reason: '' }
    await expect(call('ajustarStock', bad, 'manager')).rejects.toMatchObject({ code: 'invalid-argument' })
    await expect(call('ajustarStock', { ...bad, reason: 'x', quantity: 0 }, 'manager')).rejects.toMatchObject({ code: 'invalid-argument' })
    await call('ajustarStock', { ...fx.mutation(), ingredientId: id, kind: 'supplier_return', quantity: 150, reason: 'Llegó en mal estado' }, 'manager')
    expect(await qty(id)).toBe(600)
    // Un ajuste al alza se valora al coste medio (2 céntimos por gramo).
    await call('ajustarStock', { ...fx.mutation(), ingredientId: id, kind: 'adjustment', quantity: 100, reason: 'Apareció una pieza' }, 'manager')
    expect(await costDoc(id)).toMatchObject({ valueCents: 1200 + 200 })
    // Mermar más de lo que hay no se bloquea: queda negativo y lo que falta se valora al último coste.
    const out = await call('registrarMerma', { ...fx.mutation(), ingredientId: id, quantity: 800, wasteReason: 'other', reason: null }, 'kitchen')
    expect(out.quantityAfter).toBe(-100)
    expect(await costDoc(id)).toMatchObject({ valueCents: 0 })
    const last = (await movements(id)).at(-1)!
    expect(last.valueCents).toBe(-(1400 + 100 * 2))
    // Un movimiento repetido con la misma petición no se duplica.
    const again = { ...fx.mutation(), ingredientId: id, quantity: 10, wasteReason: 'other' as const, reason: null }
    const first = await call('registrarMerma', again, 'kitchen')
    expect(await call('registrarMerma', again, 'kitchen')).toEqual(first)
    expect((await movements(id)).filter((m) => m.requestId === again.requestId)).toHaveLength(1)
    await expect(call('registrarMerma', { ...again, quantity: 11 }, 'kitchen')).rejects.toMatchObject({ code: 'already-exists' })
  })

  it('la receta se versiona solo si cambia lo que consume y calcula coste teórico y margen', async () => {
    await loadMenu(fx)
    const patatas = await newIngredient('Patatas', 'g', 0, { quantity: 10000, valueCents: 1500 }) // 0,15 c/g
    const aceite = await newIngredient('Aceite', 'ml', 0, { quantity: 2000, valueCents: 1000 }) // 0,5 c/ml
    const sinCoste = await newIngredient('Sal', 'g', 0)
    const recipe = { name: 'Bravas', itemId: 'bravas', variantId: null, lines: [{ ingredientId: patatas, quantity: 200, yieldBp: 8000 }, { ingredientId: aceite, quantity: 30, yieldBp: 10000 }], optionLines: {}, manualCostCents: null, active: true }
    const saved = await call('guardarReceta', { ...fx.mutation(), recipeId: null, expectedVersion: null, recipe }, 'manager')
    // 250 g de patatas (37,5 -> 38) y 30 ml de aceite (15): 53 céntimos por ración.
    expect(saved).toMatchObject({ version: 1, cost: { costCents: 53, complete: true, missing: [] } })
    await expect(call('guardarReceta', { ...fx.mutation(), recipeId: null, expectedVersion: null, recipe }, 'manager')).rejects.toMatchObject({ code: 'failed-precondition', message: expect.stringContaining('Ya hay una receta') })
    await expect(call('guardarReceta', { ...fx.mutation(), recipeId: null, expectedVersion: null, recipe: { ...recipe, itemId: 'nada' } }, 'manager')).rejects.toMatchObject({ code: 'not-found' })
    await expect(call('guardarReceta', { ...fx.mutation(), recipeId: null, expectedVersion: null, recipe: { ...recipe, itemId: 'agua', lines: [{ ingredientId: 'fantasma', quantity: 1, yieldBp: 10000 }] } }, 'manager')).rejects.toMatchObject({ code: 'not-found' })
    await expect(call('guardarReceta', { ...fx.mutation(), recipeId: null, expectedVersion: null, recipe: { ...recipe, itemId: 'cana', variantId: 'inexistente' } }, 'manager')).rejects.toMatchObject({ code: 'failed-precondition' })
    // Renombrar no sube la versión; cambiar la cantidad, sí.
    const renamed = await call('guardarReceta', { ...fx.mutation(), recipeId: saved.recipeId, expectedVersion: 1, recipe: { ...recipe, name: 'Patatas bravas' } }, 'manager')
    expect(renamed.version).toBe(1)
    await expect(call('guardarReceta', { ...fx.mutation(), recipeId: saved.recipeId, expectedVersion: 7, recipe }, 'manager')).rejects.toMatchObject({ code: 'failed-precondition' })
    const changed = await call('guardarReceta', { ...fx.mutation(), recipeId: saved.recipeId, expectedVersion: 1, recipe: { ...recipe, lines: [...recipe.lines, { ingredientId: sinCoste, quantity: 5, yieldBp: 10000 }] } }, 'manager')
    expect(changed).toMatchObject({ version: 2, cost: { complete: false, missing: [sinCoste] } })
    const versions = await db.collection(`${fx.path}/recipes/${saved.recipeId}/versions`).get()
    expect(versions.docs.map((d) => d.id).sort()).toEqual(['1', '2'])
    expect(core.RecipeVersionSchema.parse(versions.docs.find((d) => d.id === '1')!.data()).lines).toHaveLength(2)
    // Margen teórico de hoy sobre el precio de carta (6,50 con 10 % de IVA = 5,91 sin IVA).
    const margin = await call('margenPlatos', { ...fx.scope(), from: '2026-01-01', to: '2026-01-02' }, 'manager')
    expect(margin.sold).toEqual([])
    expect(margin.theoretical[0]).toMatchObject({ itemId: 'bravas', costCents: 53, complete: false, priceCents: 650, marginBp: null })
    await call('guardarReceta', { ...fx.mutation(), recipeId: saved.recipeId, expectedVersion: 2, recipe: { ...recipe, lines: recipe.lines } }, 'manager')
    const ok = await call('margenPlatos', { ...fx.scope(), from: '2026-01-01', to: '2026-01-02' }, 'manager')
    expect(ok.theoretical[0]).toMatchObject({ costCents: 53, complete: true, marginBp: 9103, foodCostBp: 897 })
  })

  it('recuento con ventas durante el conteo: ajusta contra el libro en el momento de contar, una sola vez', async () => {
    await loadMenu(fx)
    const patatas = await newIngredient('Patatas', 'g', 0, { quantity: 5000, valueCents: 750 })
    const sal = await newIngredient('Sal', 'g', 0, { quantity: 1000, valueCents: 100 })
    const harina = await newIngredient('Harina', 'g', 0, { quantity: 2000, valueCents: 200 })
    await call('guardarReceta', { ...fx.mutation(), recipeId: null, expectedVersion: null, recipe: { name: 'Bravas', itemId: 'bravas', variantId: null, lines: [{ ingredientId: patatas, quantity: 250, yieldBp: 10000 }], optionLines: {}, manualCostCents: null, active: true } }, 'manager')
    const count = await call('iniciarRecuento', { ...fx.mutation(), name: 'Cierre de noche', ingredientIds: null }, 'manager')
    expect(count).toMatchObject({ revision: 1, ingredients: 3 })
    await expect(call('iniciarRecuento', { ...fx.mutation(), name: 'Vacío', ingredientIds: ['fantasma'] }, 'manager')).rejects.toMatchObject({ code: 'not-found' })
    await expect(call('iniciarRecuento', { ...fx.mutation(), name: 'Cocina', ingredientIds: [sal] }, 'kitchen')).rejects.toMatchObject({ code: 'permission-denied' })
    // Se cuentan las patatas (4800 donde el libro dice 5000) y la sal (1000, igual); la harina no.
    await wait(5)
    const saved = await call('guardarRecuento', { ...fx.mutation(), countId: count.countId, expectedRevision: 1, lines: [{ ingredientId: patatas, countedQuantity: 4800 }, { ingredientId: sal, countedQuantity: 1000 }] }, 'manager')
    expect(saved.revision).toBe(2)
    await expect(call('guardarRecuento', { ...fx.mutation(), countId: count.countId, expectedRevision: 1, lines: [{ ingredientId: sal, countedQuantity: 1 }] }, 'manager')).rejects.toMatchObject({ code: 'failed-precondition' })
    await expect(call('guardarRecuento', { ...fx.mutation(), countId: count.countId, expectedRevision: 2, lines: [{ ingredientId: 'otro', countedQuantity: 1 }] }, 'manager')).rejects.toMatchObject({ code: 'failed-precondition' })
    // Mientras tanto se vende: dos bravas gastan 500 g de patatas.
    await wait(15)
    const sold = await sell('bravas', 2)
    await consumeLine(fx.rid, 'centro', sold.lineIds[0]!)
    expect(await qty(patatas)).toBe(4500)
    // Volver a guardar sin cambiar lo contado no mueve el instante de la cuenta.
    const before = core.StockCountSchema.parse(await doc(`stockCounts/${count.countId}`))
    await call('guardarRecuento', { ...fx.mutation(), countId: count.countId, expectedRevision: 2, lines: [{ ingredientId: patatas, countedQuantity: 4800 }] }, 'manager')
    const after = core.StockCountSchema.parse(await doc(`stockCounts/${count.countId}`))
    expect(after.lines.find((l) => l.ingredientId === patatas)!.countedAt).toBe(before.lines.find((l) => l.ingredientId === patatas)!.countedAt)
    const apply = { ...fx.mutation(), countId: count.countId, expectedRevision: 3 }
    await expect(call('aplicarRecuento', { ...apply, expectedRevision: 1 }, 'manager')).rejects.toMatchObject({ code: 'failed-precondition' })
    const result = await call('aplicarRecuento', apply, 'manager')
    // Lo contado menos lo que el libro decía al contar: 4800 - (4500 + 500) = -200.
    expect(result).toEqual({ adjusted: [{ ingredientId: patatas, quantity: -200, valueCents: -30 }], unchanged: 1, uncounted: 1 })
    expect(await qty(patatas)).toBe(4300)
    expect(await qty(harina)).toBe(2000)
    expect((await movements(patatas)).filter((m) => m.kind === 'count_adjust')).toHaveLength(1)
    expect(await call('aplicarRecuento', apply, 'manager')).toEqual(result)
    expect(await call('aplicarRecuento', { ...fx.mutation(), countId: count.countId, expectedRevision: 4 }, 'manager')).toEqual(result)
    expect(await qty(patatas)).toBe(4300)
    expect(core.StockCountSchema.parse(await doc(`stockCounts/${count.countId}`))).toMatchObject({ status: 'applied', appliedBy: 'manager', revision: 4 })
    await expect(call('cancelarRecuento', { ...fx.mutation(), countId: count.countId, expectedRevision: 4 }, 'manager')).rejects.toMatchObject({ code: 'failed-precondition' })
    const second = await call('iniciarRecuento', { ...fx.mutation(), name: 'Otro', ingredientIds: [sal] }, 'manager')
    await call('cancelarRecuento', { ...fx.mutation(), countId: second.countId, expectedRevision: 1 }, 'manager')
    await expect(call('aplicarRecuento', { ...fx.mutation(), countId: second.countId, expectedRevision: 2 }, 'manager')).rejects.toMatchObject({ code: 'failed-precondition' })
    // Un recuento al alza entra al coste medio.
    const up = await call('iniciarRecuento', { ...fx.mutation(), name: 'Sobra', ingredientIds: [sal] }, 'manager')
    await call('guardarRecuento', { ...fx.mutation(), countId: up.countId, expectedRevision: 1, lines: [{ ingredientId: sal, countedQuantity: 1100 }] }, 'manager')
    expect(await call('aplicarRecuento', { ...fx.mutation(), countId: up.countId, expectedRevision: 2 }, 'manager')).toMatchObject({ adjusted: [{ quantity: 100, valueCents: 10 }] })
    expect(await costDoc(sal)).toMatchObject({ valueCents: 110 })
  })

  /* Venta con la sala de la fase 2 ----------------------------------------------------------- */

  async function sell(itemId: string, quantity: number, extra: object = {}) {
    const floor = await import('../fase2')
    const table = (await floor.abrirMesa.run(req({ ...fx.scope(), tableIds: [`t${++tables}`], guests: 2, guest: null }))) as core.CallableOutput<'abrirMesa'>
    const placed = (await floor.enviarPedido.run(req({ ...fx.scope(), sessionId: table.sessionId, lines: [{ kind: 'item', itemId, quantity, ...extra }] }))) as core.CallableOutput<'enviarPedido'>
    if (placed.status !== 'sent') throw new Error('Pedido rechazado')
    // Marchan todos los pases: la prueba mira el descuento, no el reparto de pases.
    await floor.marcharPase.run(req({ ...fx.scope(), sessionId: table.sessionId, course: 'all' }))
    return { sessionId: table.sessionId, lineIds: placed.lineIds }
  }
  async function setStatus(lineIds: string[], status: string, reason?: string) {
    const floor = await import('../fase2')
    await floor.cambiarEstadoLineas.run(req({ ...fx.scope(), lineIds, status, ...(reason ? { reason } : {}) }))
  }
  const lineCost = async (lineId: string) => core.LineCostSchema.parse(await doc(`lineCosts/${lineId}`))

  it('la venta descuenta al marchar, el doble disparo no duplica, desmarcar y anular antes de preparar devuelven y después de preparar es merma', async () => {
    await loadMenu(fx)
    const patatas = await newIngredient('Patatas', 'g', 2000, { quantity: 5000, valueCents: 750 })
    const aceite = await newIngredient('Aceite', 'ml', 0, { quantity: 2000, valueCents: 1000 })
    await call('guardarReceta', { ...fx.mutation(), recipeId: null, expectedVersion: null, recipe: { name: 'Bravas', itemId: 'bravas', variantId: null, lines: [{ ingredientId: patatas, quantity: 250, yieldBp: 10000 }, { ingredientId: aceite, quantity: 30, yieldBp: 10000 }], optionLines: {}, manualCostCents: null, active: true } }, 'manager')

    const order = await sell('bravas', 2)
    const lineId = order.lineIds[0]!
    // La línea ya marchó (primer pase). Dos disparos a la vez y otro después no duplican.
    await Promise.all([consumeLine(fx.rid, 'centro', lineId), consumeLine(fx.rid, 'centro', lineId)])
    await consumeLine(fx.rid, 'centro', lineId)
    expect(await qty(patatas)).toBe(4500); expect(await qty(aceite)).toBe(1940)
    expect(await costDoc(patatas)).toMatchObject({ valueCents: 675 })
    expect((await movements(patatas)).filter((m) => m.kind === 'sale')).toHaveLength(1)
    // 500 g a 0,15 c/g son 75 y 60 ml a 0,5 c/ml son 30: 105 céntimos por las dos raciones.
    expect(await lineCost(lineId)).toMatchObject({ state: 'consumed', cycle: 1, costCents: 105, complete: true, grossCents: 1300, taxRate: 10, itemId: 'bravas', quantity: 2, recipeVersion: 1, menuComponent: false })
    expect((await movements(patatas)).find((m) => m.kind === 'sale')!.id).toBe(`${lineId}.1.c.${patatas}`)

    // Desmarcar devuelve cantidad y valor exactos; volver a marchar abre un ciclo nuevo.
    await setStatus([lineId], 'held')
    await consumeLine(fx.rid, 'centro', lineId)
    expect(await lineCost(lineId)).toMatchObject({ state: 'reversed', cycle: 1 })
    expect(await qty(patatas)).toBe(5000); expect(await costDoc(patatas)).toMatchObject({ valueCents: 750 })
    expect(await costDoc(aceite)).toMatchObject({ valueCents: 1000 })
    await consumeLine(fx.rid, 'centro', lineId)
    expect(await qty(patatas)).toBe(5000)
    await setStatus([lineId], 'fired')
    await consumeLine(fx.rid, 'centro', lineId)
    expect(await lineCost(lineId)).toMatchObject({ state: 'consumed', cycle: 2, costCents: 105 })
    expect(await qty(patatas)).toBe(4500)

    // Anular antes de preparar devuelve.
    await setStatus([lineId], 'cancelled', 'El cliente se fue')
    await consumeLine(fx.rid, 'centro', lineId)
    expect(await lineCost(lineId)).toMatchObject({ state: 'reversed', cycle: 2 })
    expect(await qty(patatas)).toBe(5000); expect(await qty(aceite)).toBe(2000)
    expect((await movements(patatas)).map((m) => m.id.split('.').slice(1, 3).join('.')).filter(Boolean)).toEqual(expect.arrayContaining(['1.c', '1.r', '2.c', '2.r']))

    // Anular después de preparar no devuelve: es merma y el coste queda como pérdida.
    const second = await sell('bravas', 2)
    const l2 = second.lineIds[0]!
    await consumeLine(fx.rid, 'centro', l2)
    await setStatus([l2], 'preparing')
    await consumeLine(fx.rid, 'centro', l2)
    await setStatus([l2], 'cancelled', 'Se cayó el plato')
    await consumeLine(fx.rid, 'centro', l2)
    expect(await qty(patatas)).toBe(4500)
    expect(await lineCost(l2)).toMatchObject({ state: 'wasted', costCents: 105 })
    await consumeLine(fx.rid, 'centro', l2)
    expect(await qty(patatas)).toBe(4500)

    // Servido y vuelto a anular no cambia nada más; margen del periodo.
    const third = await sell('bravas', 2)
    await consumeLine(fx.rid, 'centro', third.lineIds[0]!)
    await setStatus([third.lineIds[0]!], 'served')
    await consumeLine(fx.rid, 'centro', third.lineIds[0]!)
    const day = core.horaLocal(Date.now(), 'Europe/Madrid').fecha
    const margin = await call('margenPlatos', { ...fx.scope(), from: day, to: day }, 'manager')
    expect(margin.sold).toEqual([expect.objectContaining({ itemId: 'bravas', units: 2, coveredUnits: 2, costCents: 105, wasteCostCents: 105, grossCents: 1300, netCents: 1182 })])
    expect(margin.sold[0]!.marginCents).toBe(1182 - 105)
    expect(await lowActivity()).toEqual([])

    // Venta hasta agotar y pasar a negativo: no se bloquea, avisa y valora lo que falta al último coste.
    const big = await sell('bravas', 40)
    await consumeLine(fx.rid, 'centro', big.lineIds[0]!)
    expect(await qty(patatas)).toBe(-6000)
    expect(await costDoc(patatas)).toMatchObject({ valueCents: 0 })
    expect(await lineCost(big.lineIds[0]!)).toMatchObject({ state: 'consumed', costCents: 2100, complete: true })
    expect(await alertDoc(patatas)).toMatchObject({ level: 'negative', status: 'open', quantity: -6000 })
    expect(await lowActivity()).toHaveLength(1)
  })

  // Solo con los emuladores de Functions en marcha (TEST_FIREBASE_TRIGGERS=1): comprueba el disparador `consumirPorLinea` de verdad.
  it.skipIf(process.env.TEST_FIREBASE_TRIGGERS !== '1')('el disparador real descuenta al marchar y devuelve al anular, sin que nadie lo llame', async () => {
    await loadMenu(fx)
    const patatas = await newIngredient('Patatas', 'g', 0, { quantity: 5000, valueCents: 750 })
    await call('guardarReceta', { ...fx.mutation(), recipeId: null, expectedVersion: null, recipe: { name: 'Bravas', itemId: 'bravas', variantId: null, lines: [{ ingredientId: patatas, quantity: 250, yieldBp: 10000 }], optionLines: {}, manualCostCents: null, active: true } }, 'manager')
    const order = await sell('bravas', 2)
    await expect.poll(async () => (await doc(`lineCosts/${order.lineIds[0]}`))?.state, { timeout: 45000 }).toBe('consumed')
    expect(await qty(patatas)).toBe(4500)
    await setStatus(order.lineIds, 'cancelled', 'Se fue la mesa')
    await expect.poll(async () => (await doc(`lineCosts/${order.lineIds[0]}`))?.state, { timeout: 45000 }).toBe('reversed')
    expect(await qty(patatas)).toBe(5000)
  }, 120000)

  it('platos sin receta no consumen, el coste manual no mueve existencias y apagar el consumo o el módulo lo desactiva', async () => {
    await loadMenu(fx)
    await newIngredient('Patatas', 'g', 0, { quantity: 5000, valueCents: 750 })
    await call('guardarReceta', { ...fx.mutation(), recipeId: null, expectedVersion: null, recipe: { name: 'Agua', itemId: 'agua', variantId: null, lines: [], optionLines: {}, manualCostCents: 40, active: true } }, 'manager')
    const none = await sell('cana', 1, { variantId: 'cana' })
    await consumeLine(fx.rid, 'centro', none.lineIds[0]!)
    expect(await lineCost(none.lineIds[0]!)).toMatchObject({ state: 'no_recipe', recipeId: null, costCents: null, complete: false })
    // No es retroactivo: una receta nueva no recalcula lo ya anotado.
    await setStatus(none.lineIds, 'cancelled', 'Error')
    await consumeLine(fx.rid, 'centro', none.lineIds[0]!)
    expect(await lineCost(none.lineIds[0]!)).toMatchObject({ state: 'no_recipe' })
    const manual = await sell('agua', 3)
    await consumeLine(fx.rid, 'centro', manual.lineIds[0]!)
    expect(await lineCost(manual.lineIds[0]!)).toMatchObject({ state: 'consumed', costCents: 120, complete: true })
    expect((await db.collection(`${fx.path}/stockMovements`).get()).docs.filter((d) => d.get('kind') === 'sale')).toHaveLength(0)
    // Con el consumo apagado o el módulo apagado no hace nada.
    const off = await sell('agua', 1)
    await call('guardarConfiguracionInventario', { ...fx.mutation(), settings: { consumeOnSale: false, lowStockAlerts: true } }, 'manager')
    expect(await consumeLine(fx.rid, 'centro', off.lineIds[0]!)).toBe('inactive')
    await call('guardarConfiguracionInventario', { ...fx.mutation(), settings: { consumeOnSale: true, lowStockAlerts: true } }, 'manager')
    await db.doc(`restaurants/${fx.rid}`).update({ activeModules: ['floor', 'kitchen'] })
    expect(await consumeLine(fx.rid, 'centro', off.lineIds[0]!)).toBe('inactive')
    expect(await consumeLine(fx.rid, 'centro', 'no-existe')).toBe('inactive')
    await db.doc(`restaurants/${fx.rid}`).update({ activeModules: ['floor', 'kitchen', 'inventory'] })
    expect(await consumeLine(fx.rid, 'centro', 'no-existe')).toBe('gone')
  })

  it('un extra de la carta suma sus ingredientes y la reconciliación arregla lo que el disparador perdió', async () => {
    await loadMenu(fx)
    const carne = await newIngredient('Carne', 'g', 0, { quantity: 10000, valueCents: 6000 })
    const queso = await newIngredient('Queso', 'g', 0, { quantity: 1000, valueCents: 500 })
    await call('guardarReceta', { ...fx.mutation(), recipeId: null, expectedVersion: null, recipe: { name: 'Hamburguesa', itemId: 'hamburguesa', variantId: null, lines: [{ ingredientId: carne, quantity: 180, yieldBp: 9000 }], optionLines: { queso: [{ ingredientId: queso, quantity: 20, yieldBp: 10000 }] }, manualCostCents: null, active: true } }, 'manager')
    await expect(call('guardarReceta', { ...fx.mutation(), recipeId: null, expectedVersion: null, recipe: { name: 'Otra', itemId: 'lubina', variantId: null, lines: [], optionLines: { fantasma: [{ ingredientId: queso, quantity: 1, yieldBp: 10000 }] }, manualCostCents: null, active: true } }, 'manager')).rejects.toMatchObject({ code: 'failed-precondition' })
    // Con el módulo apagado el disparador no hace nada: es como si se hubiera perdido.
    await db.doc(`restaurants/${fx.rid}`).update({ activeModules: ['floor', 'kitchen', 'reservations'] })
    const plain = await sell('hamburguesa', 1)
    const extra = await sell('hamburguesa', 2, { optionIds: ['queso'] })
    if (process.env.TEST_FIREBASE_TRIGGERS === '1') await wait(1500)
    await db.doc(`restaurants/${fx.rid}`).update({ activeModules: ['reservations', 'floor', 'kitchen', 'pos', 'staff', 'inventory'] })
    const out = await reconcileConsumption(fx.rid, 'centro')
    expect(out.fixed).toBe(2)
    expect(await qty(carne)).toBe(10000 - 200 - 400)
    expect(await qty(queso)).toBe(1000 - 40)
    expect(await lineCost(extra.lineIds[0]!)).toMatchObject({ costCents: 2 * 120 + 2 * 20 / 2, complete: true, quantity: 2 })
    expect(await lineCost(plain.lineIds[0]!)).toMatchObject({ costCents: 120 })
    expect(await reconcileConsumption(fx.rid, 'centro')).toMatchObject({ fixed: 0 })
    expect(Object.keys(api).includes('consumirPorLinea')).toBe(true)
  })
})
