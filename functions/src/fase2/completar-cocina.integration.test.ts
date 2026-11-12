import { createECDH, randomBytes, randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'
import type { CallableRequest } from 'firebase-functions/v2/https'
import * as core from '@llenamos/core'
import { db } from '../shared'
import { execute } from './index'
import { processPush } from './push-process'
import { syncPublicMenu } from './triggers'

const enabled = process.env.TEST_FIREBASE_EMULATORS === '1' && process.env.GCLOUD_PROJECT === 'demo-llenamos' && !!process.env.FIRESTORE_EMULATOR_HOST
let rid: string, path: string
const roots: string[] = [], lid = 'centro'
function call<N extends keyof typeof core.CALLABLE_SCHEMAS_FASE2>(name: N, data: unknown, uid: string | null = 'owner'): Promise<core.CallableOutput<N>> {
  return execute(name, data, { data, rawRequest: { ip: '127.0.0.1' }, ...(uid ? { auth: { uid, token: {} } } : {}) } as unknown as CallableRequest<unknown>) as Promise<core.CallableOutput<N>>
}
const staff = () => ({ restaurantId: rid, locationId: lid })
const item = (itemId: string, quantity = 1) => ({ kind: 'item', itemId, quantity })
const open = () => call('abrirMesa', { ...staff(), tableIds: ['t1'], guests: 2 })
const lines = async () => (await db.collection(`${path}/orderLines`).get()).docs.map(d => ({ id: d.id, ...core.OrderLineSchema.parse(d.data()) }))
const stock = (itemId = 'bravas') => db.doc(`${path}/menuItems/${itemId}`)
function vapid() {
  const key = createECDH('prime256v1'); key.generateKeys()
  vi.stubEnv('VAPID_PUBLIC_KEY', key.getPublicKey().toString('base64url')); vi.stubEnv('VAPID_PRIVATE_KEY', key.getPrivateKey().toString('base64url')); vi.stubEnv('VAPID_SUBJECT', 'mailto:local@example.test')
}
async function subscription() {
  const key = createECDH('prime256v1'); key.generateKeys()
  const value = { endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`, keys: { p256dh: key.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }
  await call('guardarSuscripcionPush', { ...staff(), subscription: value, enabled: true }, 'waiter')
  return value
}
async function overdue() {
  const task = await call('crearTarea', { ...staff(), note: 'Recoger el pase' })
  await db.doc(`${path}/floorTasks/${task.taskId}`).update({ dueAt: Timestamp.fromMillis(Date.now() - 60_000) })
  return task.taskId
}

describe.skipIf(!enabled)('Cierre de cocina contra los emuladores', { timeout: 30000 }, () => {
  beforeEach(async () => {
    rid = `cocina-${randomUUID()}`; roots.push(rid); path = `restaurants/${rid}/locations/${lid}`
    await db.doc(`restaurants/${rid}`).set({ name: 'Cocina local', slug: rid, brandColor: '#f0a35e', timezone: 'Europe/Madrid', locale: 'es', currency: 'EUR', plan: 'sala', activeModules: ['floor', 'kitchen', 'reservations'] })
    await db.doc(path).set({ name: 'Centro' })
    for (const role of ['owner', 'waiter', 'kitchen', 'bar']) await db.doc(`restaurants/${rid}/members/${role}`).set({ uid: role, displayName: role, email: `${role}@example.test`, role, active: true, locationIds: [] })
    await db.doc(`${path}/tables/t1`).set({ name: 'S1', areaId: 'sala', seats: 4, enabled: true, joinableWith: [], shape: 'rect', x: 10, y: 10, w: 10, h: 10 })
    const demo = core.demoMenu(), reservations = core.defaultReservationSettings()
    const shifts = [{ name: 'Servicio', from: '00:00', lastEntry: '23:45' }]
    reservations.week = { mon: shifts, tue: shifts, wed: shifts, thu: shifts, fri: shifts, sat: shifts, sun: shifts }
    await db.doc(`${path}/settings/reservations`).set(reservations)
    demo.settings.selfOrder.enabled = true; demo.settings.takeaway.enabled = true
    await db.doc(`${path}/settings/floor`).set(demo.settings)
    for (const [collection, rows] of Object.entries({ menuCategories: demo.categories, menuItems: demo.items, dailyMenus: demo.dailyMenus, stations: demo.stations })) {
      const batch = db.batch(); for (const [id, value] of Object.entries(rows)) batch.set(db.doc(`${path}/${collection}/${id}`), value); await batch.commit()
    }
  })
  afterEach(() => vi.unstubAllEnvs())
  afterAll(async () => { for (const id of roots) { await db.recursiveDelete(db.doc(`restaurants/${id}`)); await db.doc(`publicMenus/${core.publicMenuId(id, lid)}`).delete() } }, 60000)

  it('entrega nota general, origen y referencia común a cocina y barra, sin copiar contacto', async () => {
    const s = await open()
    const order = await call('enviarPedido', { ...staff(), sessionId: s.sessionId, note: 'Mesa con alergia declarada', lines: [item('bravas'), item('agua')] })
    expect(order.status).toBe('sent')
    const ls = await lines()
    expect(new Set(ls.map(l => l.stationKind))).toEqual(new Set(['kitchen', 'bar']))
    for (const l of ls) expect(l.ticket).toMatchObject({ note: 'Mesa con alergia declarada', source: 'staff', pickupAt: null })
    expect(new Set(ls.map(l => l.ticket?.reference)).size).toBe(1)
    expect(ls[0]!.ticket).not.toHaveProperty('phone')
  })
  it('QR con primeros y segundos sale completo al aprobar, aunque se solicite auto o hold', async () => {
    const s = await open(), qr = await call('regenerarQrMesa', { ...staff(), tableIds: ['t1'] })
    const sent = await call('pedirDesdeMesa', { slug: rid, locationId: lid, tableId: 't1', token: qr.tokens[0]!.token, sessionId: s.sessionId, lines: [item('bravas'), item('hamburguesa')], expectedTotalCents: 2050, language: 'es' }, null)
    if (sent.status === 'rejected') throw new Error('No debe rechazar')
    expect((await lines()).every(l => l.status === 'pending')).toBe(true)
    expect(await call('decidirPedido', { ...staff(), orderId: sent.orderId, decision: 'accept', fire: 'hold' }, 'waiter')).toMatchObject({ fired: 2, held: 0 })
    expect((await lines()).every(l => l.status === 'fired')).toBe(true)
  })
  it('mantiene tarea de marcha al pedir cuenta y no permite cerrarla con platos retenidos', async () => {
    const s = await open()
    await call('enviarPedido', { ...staff(), sessionId: s.sessionId, lines: [item('bravas'), item('hamburguesa')] })
    await call('cambiarEstadoMesa', { ...staff(), sessionId: s.sessionId, status: 'bill_requested' })
    const tasks = await db.collection(`${path}/floorTasks`).where('purpose', '==', 'fire_course').get()
    expect(tasks.size).toBe(1); expect(tasks.docs[0]!.get('status')).toBe('open')
    await expect(call('cambiarEstadoTarea', { ...staff(), taskId: tasks.docs[0]!.id, action: 'done' })).rejects.toMatchObject({ code: 'failed-precondition' })
    await call('marcharPase', { ...staff(), sessionId: s.sessionId, course: 'all' })
    expect((await tasks.docs[0]!.ref.get()).get('status')).toBe('done')
  })
  it('valida todo el lote antes de empezar ninguna línea de otra estación', async () => {
    const s = await open()
    await call('enviarPedido', { ...staff(), sessionId: s.sessionId, lines: [item('bravas'), item('agua')], fire: 'all' })
    const ls = await lines()
    await expect(call('cambiarEstadoLineas', { ...staff(), lineIds: ls.map(l => l.id), status: 'preparing' }, 'kitchen')).rejects.toMatchObject({ code: 'permission-denied' })
    expect((await lines()).every(l => l.status === 'fired')).toBe(true)
    const own = ls.filter(l => l.stationKind === 'kitchen')
    await call('cambiarEstadoLineas', { ...staff(), lineIds: own.map(l => l.id), status: 'ready' }, 'kitchen')
    expect((await lines()).find(l => l.stationKind === 'bar')!.status).toBe('fired')
  })
  it('aprobar otro QR y pedir cuenta conserva responsable y vencimiento de los pases de sala', async () => {
    const s = await open()
    await call('enviarPedido', { ...staff(), sessionId: s.sessionId, lines: [item('bravas'), item('hamburguesa')] })
    const held = (await db.collection(`${path}/floorTasks`).where('purpose', '==', 'fire_course').get()).docs[0]!
    const dueAt = held.get('dueAt')
    await call('cambiarEstadoTarea', { ...staff(), taskId: held.id, action: 'claim' }, 'waiter')
    const qr = await call('regenerarQrMesa', { ...staff(), tableIds: ['t1'] })
    const sent = await call('pedirDesdeMesa', { slug: rid, locationId: lid, tableId: 't1', token: qr.tokens[0]!.token, sessionId: s.sessionId, lines: [item('agua')], expectedTotalCents: 200, language: 'es' }, null)
    if (sent.status === 'rejected') throw new Error('Debe enviar')
    await call('decidirPedido', { ...staff(), orderId: sent.orderId, decision: 'accept' })
    await call('cambiarEstadoMesa', { ...staff(), sessionId: s.sessionId, status: 'bill_requested' })
    const current = await held.ref.get()
    expect(current.get('claimedBy')).toBe('waiter'); expect(current.get('status')).toBe('claimed')
    expect(current.get('dueAt')).toEqual(dueAt)
    await expect(call('cambiarEstadoTarea', { ...staff(), taskId: held.id, action: 'cancel' })).rejects.toMatchObject({ code: 'failed-precondition' })
  })
  it('descuenta la última ración una sola vez entre dos pedidos simultáneos y publica agotado', async () => {
    const s = await open()
    await call('guardarRaciones', { ...staff(), itemId: 'bravas', remaining: 1 }, 'kitchen')
    const results = await Promise.all([1, 2].map(() => call('enviarPedido', { ...staff(), sessionId: s.sessionId, lines: [item('bravas')] })))
    expect(results.map(r => r.status).sort()).toEqual(['rejected', 'sent'])
    expect((await stock().get()).data()).toMatchObject({ soldOut: true, portions: { remaining: 0 } })
    await syncPublicMenu(rid, lid)
    expect((await db.doc(`publicMenus/${core.publicMenuId(rid, lid)}`).get()).get('items').find((i: { id: string }) => i.id === 'bravas').soldOut).toBe(true)
  })
  it('suma repetidos, controla cada variante y no devuelve cupo al anular ni al rechazar', async () => {
    const s = await open()
    await call('guardarRaciones', { ...staff(), itemId: 'croquetas', variantId: 'media', remaining: 1 })
    const line = { ...item('croquetas'), variantId: 'media' }
    expect(await call('enviarPedido', { ...staff(), sessionId: s.sessionId, lines: [line, line] })).toMatchObject({ status: 'rejected' })
    const sent = await call('enviarPedido', { ...staff(), sessionId: s.sessionId, lines: [line] })
    if (sent.status !== 'sent') throw new Error('Debe enviar')
    await call('cambiarEstadoLineas', { ...staff(), lineIds: sent.lineIds, status: 'cancelled', reason: 'Error al pedir' })
    expect((await stock('croquetas').get()).get('portions.variants.media')).toBe(0)
    expect(await call('enviarPedido', { ...staff(), sessionId: s.sessionId, lines: [line] })).toMatchObject({ status: 'rejected' })
    expect(await call('enviarPedido', { ...staff(), sessionId: s.sessionId, lines: [{ ...line, variantId: 'racion' }] })).toMatchObject({ status: 'sent' })
  })
  it('bloquea recuentos antiguos hasta contar hoy y respeta permisos por estación', async () => {
    const s = await open()
    await stock().update({ portions: { date: '2020-01-01', remaining: 8, variants: {} } })
    expect(await call('enviarPedido', { ...staff(), sessionId: s.sessionId, lines: [item('bravas')] })).toMatchObject({ status: 'rejected' })
    await expect(call('guardarRaciones', { ...staff(), itemId: 'bravas', remaining: 3 }, 'bar')).rejects.toMatchObject({ code: 'permission-denied' })
    await call('guardarRaciones', { ...staff(), itemId: 'bravas', remaining: 3 }, 'waiter')
    expect(await call('enviarPedido', { ...staff(), sessionId: s.sessionId, lines: [item('bravas', 3)] })).toMatchObject({ status: 'sent' })
  })
  it('quitar un límite de variante lo elimina de Firestore sin borrar los demás límites', async () => {
    const s = await open()
    await call('guardarRaciones', { ...staff(), itemId: 'croquetas', remaining: 10 })
    await call('guardarRaciones', { ...staff(), itemId: 'croquetas', variantId: 'media', remaining: 0 })
    await call('guardarRaciones', { ...staff(), itemId: 'croquetas', variantId: 'racion', remaining: 3 })
    await call('guardarRaciones', { ...staff(), itemId: 'croquetas', variantId: 'media', remaining: null })
    expect((await stock('croquetas').get()).get('portions')).toMatchObject({ remaining: 10, variants: { racion: 3 } })
    expect((await stock('croquetas').get()).get('portions.variants.media')).toBeUndefined()
    expect(await call('enviarPedido', { ...staff(), sessionId: s.sessionId, lines: [{ ...item('croquetas'), variantId: 'media' }] })).toMatchObject({ status: 'sent' })
    expect((await stock('croquetas').get()).get('portions.remaining')).toBe(9)
  })
  it('reserva raciones también en pendientes y no repone al rechazar', async () => {
    const s = await open()
    await call('guardarRaciones', { ...staff(), itemId: 'bravas', remaining: 1 })
    const qr = await call('regenerarQrMesa', { ...staff(), tableIds: ['t1'] })
    const sent = await call('pedirDesdeMesa', { slug: rid, locationId: lid, tableId: 't1', token: qr.tokens[0]!.token, sessionId: s.sessionId, lines: [item('bravas')], expectedTotalCents: 650, language: 'es' }, null)
    if (sent.status === 'rejected') throw new Error('Debe enviar')
    expect((await stock().get()).get('portions.remaining')).toBe(0)
    await call('decidirPedido', { ...staff(), orderId: sent.orderId, decision: 'reject', reason: 'Cambio del cliente' })
    expect((await stock().get()).get('portions.remaining')).toBe(0)
  })
  it('el primer recuento del día pone a cero los otros límites hasta recontarlos explícitamente', async () => {
    await stock('croquetas').update({ portions: { date: '2020-01-01', remaining: 20, variants: { media: 8, racion: 6 } } })
    await call('guardarRaciones', { ...staff(), itemId: 'croquetas', variantId: 'media', remaining: 4 })
    expect((await stock('croquetas').get()).get('portions')).toMatchObject({ remaining: 0, variants: { media: 4, racion: 0 } })
    expect((await stock('croquetas').get()).get('soldOut')).toBe(true)
    await call('guardarRaciones', { ...staff(), itemId: 'croquetas', remaining: 5 })
    expect((await stock('croquetas').get()).get('portions')).toMatchObject({ remaining: 5, variants: { media: 4, racion: 0 } })
    expect((await stock('croquetas').get()).get('soldOut')).toBe(false)
  })
  it('los componentes del menú consumen raciones y una falta revierte todos los contadores', async () => {
    const s = await open(), menu = core.demoMenu().dailyMenus.mediodia!
    await db.doc(`${path}/dailyMenus/mediodia`).update({ from: '00:00', to: '23:59', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] })
    const selections = menu.sections.map(section => ({ sectionId: section.id, itemId: section.choices[0]!.itemId, variantId: section.choices[0]!.variantId }))
    const first = selections[0]!.itemId, second = selections[1]!.itemId
    await call('guardarRaciones', { ...staff(), itemId: first, remaining: 2 })
    await call('guardarRaciones', { ...staff(), itemId: second, remaining: 1 })
    const input = { ...staff(), sessionId: s.sessionId, lines: [{ kind: 'menu', dailyMenuId: 'mediodia', quantity: 2, selections }] }
    expect(await call('enviarPedido', input)).toMatchObject({ status: 'rejected' })
    expect((await stock(first).get()).get('portions.remaining')).toBe(2)
    expect((await stock(second).get()).get('portions.remaining')).toBe(1)
    await call('guardarRaciones', { ...staff(), itemId: second, remaining: 2 })
    expect(await call('enviarPedido', input)).toMatchObject({ status: 'sent' })
    expect((await stock(first).get()).get('portions.remaining')).toBe(0)
    expect((await stock(second).get()).get('portions.remaining')).toBe(0)
  })
  it('congela nombre, hora prometida y referencia de recogida en todas las líneas de estación', async () => {
    const date = core.sumarDias(core.horaLocal(Date.now(), 'Europe/Madrid').fecha, 1)
    const sent = await call('crearParaLlevar', { ...staff(), date, time: '13:00', guestName: 'Ana Recogida', phone: '600000000', source: 'phone', lines: [item('bravas'), item('agua')], notes: 'Llamar por el nombre al salir' })
    if (sent.status !== 'accepted') throw new Error('Debe aceptar')
    const ls = await lines()
    for (const l of ls) expect(l.ticket).toMatchObject({ guestName: 'Ana Recogida', pickupAt: sent.pickupAt, pickupReference: sent.reference, note: 'Llamar por el nombre al salir' })
    expect(ls).toHaveLength(2)
  })
  it('sin VAPID no envía ni admite suscripciones y la interfaz recibe ese estado', async () => {
    vi.stubEnv('VAPID_PRIVATE_KEY', '')
    expect(await call('configuracionPush', staff(), 'waiter')).toMatchObject({ configured: false, publicKey: null, localCapture: true })
    await overdue()
    const transport = vi.fn<typeof fetch>()
    expect(await processPush(rid, lid, { transport, capture: false })).toMatchObject({ configured: false, sent: 0 })
    expect(transport).not.toHaveBeenCalled()
  })
  it('captura solo vencidas sin dueño, deduplica dos trabajadores y reclamar silencia', async () => {
    vapid(); await subscription()
    const id = await overdue()
    const results = await Promise.all([processPush(rid, lid), processPush(rid, lid)])
    expect(results.reduce((n, r) => n + r.captured, 0)).toBe(1)
    expect((await db.collection(`${path}/pushDeliveries`).get()).size).toBe(1)
    const other = await overdue()
    await call('cambiarEstadoTarea', { ...staff(), taskId: other, action: 'claim' }, 'waiter')
    expect(await processPush(rid, lid)).toMatchObject({ captured: 0 })
    const delivery = (await db.collection(`${path}/pushDeliveries`).get()).docs[0]!
    expect(delivery.get('payload.url')).toContain(`/panel/avisos?task=${id}`)
    expect(delivery.get('status')).toBe('captured')
  })
  it('elimina endpoints caducados y comprueba bajas de personal sin enviar de verdad', async () => {
    vapid(); await subscription(); await overdue()
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 410 }))
    await processPush(rid, lid, { transport, capture: false })
    expect(transport).toHaveBeenCalledOnce()
    expect((await db.collection(`${path}/pushSubscriptions`).get()).docs[0]!.get('enabled')).toBe(false)
    await subscription(); await db.doc(`restaurants/${rid}/members/waiter`).update({ active: false })
    await processPush(rid, lid, { transport, capture: false })
    expect(transport).toHaveBeenCalledOnce()
  })
  it('no avisa antes del plazo, reintenta un fallo pasado un minuto y coger la tarea detiene el reintento', async () => {
    vapid(); await subscription()
    const task = await call('crearTarea', { ...staff(), note: 'Prueba del plazo' })
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }))
    const now = Date.now()
    await processPush(rid, lid, { transport, capture: false, now })
    expect(transport).not.toHaveBeenCalled()
    await db.doc(`${path}/floorTasks/${task.taskId}`).update({ dueAt: Timestamp.fromMillis(now - 1) })
    await processPush(rid, lid, { transport, capture: false, now })
    await processPush(rid, lid, { transport, capture: false, now: now + 59000 })
    expect(transport).toHaveBeenCalledOnce()
    await processPush(rid, lid, { transport, capture: false, now: now + 60001 })
    expect(transport).toHaveBeenCalledTimes(2)
    await call('cambiarEstadoTarea', { ...staff(), taskId: task.taskId, action: 'claim' }, 'waiter')
    await processPush(rid, lid, { transport, capture: false, now: now + 120002 })
    expect(transport).toHaveBeenCalledTimes(2)
  })
})
