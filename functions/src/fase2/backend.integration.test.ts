import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'
import { type CallableRequest } from 'firebase-functions/v2/https'
import * as core from '@llenamos/core'
import * as api from './index'
import * as r1 from '../reservations'
import { db } from '../shared'
import { offerWaitlist } from '../waitlist/service'
import { mensajesReservaActualizada } from '../messages/lifecycle'
import { processMessage } from '../messages/process'
import { processTakeaways } from './process'
import { reconcileLocation, syncPublicMenu } from './triggers'

type Name = keyof typeof core.CALLABLE_SCHEMAS_FASE2
const enabled = process.env.TEST_FIREBASE_EMULATORS === '1' && process.env.GCLOUD_PROJECT === 'demo-llenamos' && !!process.env.FIRESTORE_EMULATOR_HOST
let rid: string, path: string
const lid = 'centro', roots: string[] = []
const req = (data: unknown, uid: string | null = 'owner') => ({ data, rawRequest: { ip: '127.0.0.1' }, ...(uid ? { auth: { uid, token: {} } } : {}) }) as unknown as CallableRequest<unknown>
async function call<N extends Name>(name: N, data: unknown, uid: string | null = 'owner'): Promise<core.CallableOutput<N>> {
  return await api[name].run(req(data, uid)) as core.CallableOutput<N>
}
const staff = () => ({ restaurantId: rid, locationId: lid })
const item = (itemId = 'bravas', quantity = 1) => ({ kind: 'item', itemId, quantity })
const open = (tableIds = ['t1'], guest = false) => call('abrirMesa', { ...staff(), tableIds, guests: 2, ...(guest ? { guest: { name: 'Ana Prueba', phone: '600000000' } } : {}) })
const order = (sessionId: string, lines = [item()]) => call('enviarPedido', { ...staff(), sessionId, lines })
const today = () => core.horaLocal(Date.now(), 'Europe/Madrid').fecha
const tomorrow = () => core.sumarDias(today(), 1)
const currentLines = async (sessionId?: string) => (await db.collection(`${path}/orderLines`).get()).docs.map(d => ({ id: d.id, ...core.OrderLineSchema.parse(d.data()) })).filter(l => !sessionId || l.sessionId === sessionId)
async function serve(sessionId: string) {
  const lines = (await currentLines(sessionId)).filter(l => l.kind !== 'menu' && l.status !== 'served' && l.status !== 'cancelled')
  const held = lines.filter(l => l.status === 'held')
  if (held.length) await call('marcharPase', { ...staff(), sessionId, course: 'all' })
  if (lines.length) await call('cambiarEstadoLineas', { ...staff(), lineIds: lines.map(l => l.id), status: 'served' })
}

describe.skipIf(!enabled)('Backend de sala contra Firestore real', { timeout: 30000 }, () => {
  beforeEach(async () => {
    rid = `fase2-${randomUUID()}`; roots.push(rid); path = `restaurants/${rid}/locations/${lid}`
    await db.doc(`restaurants/${rid}`).set({ name: 'Prueba de sala', slug: rid, brandColor: '#f0a35e', timezone: 'Europe/Madrid', locale: 'es', currency: 'EUR', isDemo: true, plan: 'sala', activeModules: ['reservations','floor','kitchen'] })
    await db.doc(path).set({ name: 'Centro', slug: 'centro', address: '', city: '', phone: '' })
    await db.doc(`restaurants/${rid}/locations/otro`).set({ name: 'Otro' })
    for (const role of ['owner','manager','waiter','waiter2','kitchen','bar','inactive','limited']) {
      await db.doc(`restaurants/${rid}/members/${role}`).set({ uid: role, displayName: role, email: `${role}@test.es`, role: role === 'waiter2' ? 'waiter' : ['limited','inactive'].includes(role) ? 'owner' : role, active: role !== 'inactive', locationIds: role === 'limited' ? ['otro'] : [] })
    }
    for (let i = 1; i <= 6; i++) await db.doc(`${path}/tables/t${i}`).set({ name: `S${i}`, areaId: 'sala', seats: 8, enabled: true, joinableWith: ['t1','t2','t3','t4','t5','t6'].filter(t => t !== `t${i}`), shape: 'rect', x: 10, y: 10, w: 10, h: 10 })
    const demo = core.demoMenu(), settings = core.defaultReservationSettings()
    const shifts = [{ name: 'Servicio', from: '00:00', lastEntry: '23:45' }]
    settings.week = { mon: shifts, tue: shifts, wed: shifts, thu: shifts, fri: shifts, sat: shifts, sun: shifts }; settings.publicBooking = true; settings.autoConfirm = true
    await db.doc(`${path}/settings/reservations`).set(settings)
    demo.settings.selfOrder.enabled = true; demo.settings.takeaway.enabled = true; demo.settings.takeaway.publicOrdering = true
    await db.doc(`${path}/settings/floor`).set(demo.settings)
    for (const [collection, rows] of Object.entries({ menuCategories: demo.categories, menuItems: demo.items, dailyMenus: demo.dailyMenus, stations: demo.stations })) {
      const batch = db.batch(); for (const [id, value] of Object.entries(rows)) batch.set(db.doc(`${path}/${collection}/${id}`), value); await batch.commit()
    }
  }, 30000)
  afterAll(async () => {
    for (const id of roots) { await db.recursiveDelete(db.doc(`restaurants/${id}`)); await db.doc(`publicMenus/${core.publicMenuId(id,lid)}`).delete(); await db.doc(`publicRestaurants/${id}`).delete() }
  }, 60000)
  it('recupera el resultado de un envío concurrente sin descontar raciones de nuevo y rechaza reutilizar la clave', async () => {
    await call('guardarRaciones', { ...staff(), itemId: 'bravas', remaining: 2 })
    const { sessionId } = await open()
    const input = { ...staff(), sessionId, lines: [item()], requestId: randomUUID() }
    const [a, b] = await Promise.all([call('enviarPedido', input), call('enviarPedido', input)])
    expect(a).toEqual(b)
    expect((await db.collection(`${path}/orders`).get()).size).toBe(1)
    expect((await db.doc(`${path}/menuItems/bravas`).get()).get('portions.remaining')).toBe(1)
    await serve(sessionId)
    await call('cambiarEstadoMesa', { ...staff(), sessionId, status: 'closed' })
    expect(await call('enviarPedido', input)).toEqual(a)
    expect((await db.doc(`${path}/menuItems/bravas`).get()).get('portions.remaining')).toBe(1)
    await expect(call('enviarPedido', { ...input, lines: [item('agua')] })).rejects.toMatchObject({ code: 'failed-precondition' })
    expect((await db.collection(`restaurants/${rid}/activity`).where('action', '==', 'order.placed').get()).size).toBe(1)
  })
  it('el QR recupera el mismo pedido tras perder la respuesta y valida el token antes de recuperarlo', async () => {
    const { sessionId } = await open()
    const { tokens } = await call('regenerarQrMesa', { ...staff(), tableIds: ['t1'] })
    const link = { slug: rid, locationId: lid, tableId: 't1', token: tokens[0]!.token }
    const view = await call('verMesaPublica', link, null)
    const input = { ...link, sessionId, lines: [item()], expectedTotalCents: 650, expectedDestination: view.destination, language: 'es', requestId: randomUUID() }
    const a = await call('pedirDesdeMesa', input, null)
    await call('moverMesa', { ...staff(), sessionId, tableIds: ['t2'] })
    expect(await call('pedirDesdeMesa', input, null)).toEqual(a)
    expect((await db.collection(`${path}/orders`).get()).size).toBe(1)
    await call('regenerarQrMesa', { ...staff(), tableIds: ['t1'] })
    await expect(call('pedirDesdeMesa', input, null)).rejects.toMatchObject({ code: 'permission-denied' })
  })
  it('revalida el destino y los precios aunque dos cambios compensen el total', async () => {
    const { sessionId } = await open()
    const { tokens } = await call('regenerarQrMesa', { ...staff(), tableIds: ['t1'] })
    const view = await call('verMesaPublica', { slug: rid, locationId: lid, tableId: 't1', token: tokens[0]!.token }, null)
    const lines = core.OrderLinesInputSchema.parse([item('bravas'), item('agua')])
    const demo = core.demoMenu()
    const price = core.priceOrder(lines, { items: demo.items, dailyMenus: demo.dailyMenus }, { channel: 'staff', now: Date.now(), timezone: 'Europe/Madrid' })
    await db.doc(`${path}/menuItems/bravas`).update({ priceCents: 750, version: 2 })
    await db.doc(`${path}/menuItems/agua`).update({ priceCents: 100, version: 2 })
    expect(await call('enviarPedido', { ...staff(), sessionId, lines, expectedTotalCents: 850, expectedPrices: core.orderPriceSignature(price.lines), requestId: randomUUID() })).toMatchObject({ status: 'rejected', problems: [{ code: 'price_changed' }] })
    await call('moverMesa', { ...staff(), sessionId, tableIds: ['t2'] })
    await expect(call('enviarPedido', { ...staff(), sessionId, lines, expectedDestination: view.destination })).rejects.toMatchObject({ code: 'failed-precondition' })
    expect((await db.collection(`${path}/orders`).get()).empty).toBe(true)
  })
  it('aplica la política horaria en el servidor al personal y al QR', async () => {
    const { sessionId } = await open()
    const floor = core.demoMenu().settings
    await db.doc(`${path}/settings/floor`).set({ ...floor, allowOrdersOutsideHours: false })
    await db.doc(`${path}/settings/reservations`).update({ week: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] } })
    const { tokens } = await call('regenerarQrMesa', { ...staff(), tableIds: ['t1'] })
    const link = { slug: rid, locationId: lid, tableId: 't1', token: tokens[0]!.token }
    expect((await call('verMesaPublica', link, null)).canOrder).toBe(false)
    await expect(order(sessionId)).rejects.toMatchObject({ code: 'failed-precondition' })
    await expect(call('pedirDesdeMesa', { ...link, sessionId, lines: [item()], expectedTotalCents: 650, language: 'es' }, null)).rejects.toMatchObject({ code: 'failed-precondition' })
    await db.doc(`${path}/settings/floor`).update({ allowOrdersOutsideHours: true })
    expect((await call('verMesaPublica', link, null)).canOrder).toBe(true)
    expect(await order(sessionId)).toMatchObject({ status: 'sent' })
  })
  it('agrupa motivos y notas de llamada sin perder el dueño ni el plazo', async () => {
    const { sessionId } = await open()
    const { tokens } = await call('regenerarQrMesa', { ...staff(), tableIds: ['t1'] })
    const link = { slug: rid, locationId: lid, tableId: 't1', token: tokens[0]!.token, sessionId, kind: 'call_waiter' }
    const a = await call('avisarDesdeMesa', { ...link, reason: 'water', note: 'Sin hielo' }, null)
    await call('cambiarEstadoTarea', { ...staff(), taskId: a.taskId, action: 'claim' }, 'waiter')
    const before = (await db.doc(`${path}/floorTasks/${a.taskId}`).get()).data()!
    const b = await call('avisarDesdeMesa', { ...link, reason: 'napkins', note: 'Dos' }, null)
    expect(b.taskId).toBe(a.taskId)
    const after = (await db.doc(`${path}/floorTasks/${a.taskId}`).get()).data()!
    expect(after.claimedBy).toBe('waiter')
    expect(after.dueAt).toEqual(before.dueAt)
    expect(after.requests).toEqual([{ reason: 'water', note: 'Sin hielo' }, { reason: 'napkins', note: 'Dos' }])
  })
  it('añade una bandeja a la recogida cogida y rechaza confirmar una versión anterior', async () => {
    const { sessionId } = await open()
    const first = await order(sessionId)
    if (first.status !== 'sent') throw new Error('Pedido rechazado')
    await call('cambiarEstadoLineas', { ...staff(), lineIds: first.lineIds, status: 'ready' })
    const task = (await db.collection(`${path}/floorTasks`).where('type', '==', 'pickup').get()).docs[0]!
    await call('cambiarEstadoTarea', { ...staff(), taskId: task.id, action: 'claim' }, 'waiter')
    const second = await order(sessionId)
    if (second.status !== 'sent') throw new Error('Pedido rechazado')
    await call('cambiarEstadoLineas', { ...staff(), lineIds: second.lineIds, status: 'ready' })
    const current = core.FloorTaskSchema.parse((await task.ref.get()).data())
    expect(current.claimedBy).toBe('waiter')
    expect(current.lineIds).toHaveLength(2)
    expect(current.count).toBe(2)
    await expect(call('cambiarEstadoTarea', { ...staff(), taskId: task.id, action: 'done', expectedLineIds: first.lineIds }, 'waiter')).rejects.toMatchObject({ code: 'failed-precondition' })
    await call('cambiarEstadoTarea', { ...staff(), taskId: task.id, action: 'done', expectedLineIds: current.lineIds }, 'waiter')
    expect((await currentLines(sessionId)).every(l => l.status === 'served')).toBe(true)
  })
  it('exporta las callables de sala y exige sesión, rol, local y módulo', async () => {
    expect(Object.keys(core.CALLABLE_SCHEMAS_FASE2)).toEqual(expect.arrayContaining(['recuperarQrMesa', 'importarQrMesa', 'revocarQrMesa']))
    expect(Object.keys(core.CALLABLE_SCHEMAS_FASE2)).toHaveLength(34)
    expect(Object.keys(core.CALLABLE_SCHEMAS_FASE2)).toEqual(expect.arrayContaining(['guardarRaciones', 'configuracionPush', 'guardarSuscripcionPush']))
    for (const name of Object.keys(core.CALLABLE_SCHEMAS_FASE2) as Name[]) expect(api[name].run).toBeTypeOf('function')
    for (const uid of [null,'kitchen','bar','inactive','limited','foreign']) await expect(call('abrirMesa', { ...staff(), tableIds: ['t1'], guests: 2 }, uid)).rejects.toMatchObject({ code: uid === null ? 'unauthenticated' : 'permission-denied' })
    await db.doc(`restaurants/${rid}`).update({ activeModules: ['reservations'] })
    await expect(open()).rejects.toMatchObject({ code: 'failed-precondition' })
    await db.doc(`restaurants/${rid}`).update({ activeModules: ['kitchen'] })
    await call('guardarEstacion', { ...staff(), stationId: 'cocina', station: core.demoMenu().stations.cocina }, 'manager')
    await expect(open()).rejects.toMatchObject({ code: 'failed-precondition' })
  })
  it('recupera QR sin rotar, importa uno antiguo y revoca sin emitir sustituto', async () => {
    const generated = await call('regenerarQrMesa', { ...staff(), tableIds: ['t1'] })
    const first = generated.tokens[0]!
    const row = db.doc(`${path}/tableTokens/t1`)
    const before = (await row.get()).get('rotatedAt')
    expect((await call('recuperarQrMesa', { ...staff(), tableIds: ['t1'] })).tokens).toEqual(generated.tokens)
    expect((await row.get()).get('rotatedAt')).toEqual(before)
    for (const uid of ['waiter', 'kitchen', 'limited']) await expect(call('recuperarQrMesa', { ...staff(), tableIds: ['t1'] }, uid)).rejects.toMatchObject({ code: 'permission-denied' })
    await row.set({ tokenHash: core.sha256Hex(first.token), rotatedAt: before })
    expect((await call('recuperarQrMesa', { ...staff(), tableIds: ['t1'] })).unavailable).toEqual([{ tableId: 't1', reason: 'legacy' }])
    await expect(call('importarQrMesa', { ...staff(), tableId: 't1', token: 'x'.repeat(43) })).rejects.toMatchObject({ code: 'failed-precondition' })
    await call('importarQrMesa', { ...staff(), tableId: 't1', token: first.token })
    expect((await call('recuperarQrMesa', { ...staff(), tableIds: ['t1'] })).tokens).toEqual(generated.tokens)
    await call('revocarQrMesa', { ...staff(), tableIds: ['t1'] })
    const link = { slug: rid, locationId: lid, tableId: 't1', token: first.token }
    await expect(call('verMesaPublica', link, null)).rejects.toMatchObject({ code: 'permission-denied' })
    expect((await call('recuperarQrMesa', { ...staff(), tableIds: ['t1'] }))).toEqual({ tokens: [], unavailable: [{ tableId: 't1', reason: 'revoked' }] })
    expect((await row.get()).get('tokenSecret')).toBeNull()
  })
  it('agota botella manteniendo copa y publica sugerencia y revisión de alérgenos', async () => {
    const editable = core.MenuItemEditableSchema.parse({ ...core.demoMenu().items.vino, selfOrder: true, featured: true, allergensReviewed: true })
    await call('guardarPlato', { ...staff(), itemId: 'vino', item: editable })
    await call('marcarAgotado', { ...staff(), itemId: 'vino', variantId: 'botella', soldOut: true }, 'bar')
    await expect(call('marcarAgotado', { ...staff(), itemId: 'vino', variantId: 'copa', soldOut: true }, 'kitchen')).rejects.toMatchObject({ code: 'permission-denied' })
    const session = await open()
    expect((await order(session.sessionId, [{ ...item('vino'), variantId: 'copa' }] as never)).status).toBe('sent')
    expect((await order(session.sessionId, [{ ...item('vino'), variantId: 'botella' }] as never)).status).toBe('rejected')
    await syncPublicMenu(rid, lid)
    const pub = core.PublicMenuSchema.parse((await db.doc(`publicMenus/${core.publicMenuId(rid, lid)}`).get()).data())
    expect(pub.items.find(i => i.id === 'vino')).toMatchObject({ soldOut: false, featured: true, allergensReviewed: true, version: 1, variants: [expect.objectContaining({ id: 'copa' }), expect.objectContaining({ id: 'botella', soldOut: true })] })
  })
  it('encola aceptación y listo una sola vez con enlace privado y resiste fallo del proveedor', async () => {
    const result = await call('crearParaLlevar', { ...staff(), date: tomorrow(), time: '13:00', guestName: 'Ana Prueba', phone: '600000000', email: 'ana@test.es', language: 'ca', source: 'phone', lines: [item()], fire: 'all' })
    if (result.status !== 'accepted') throw new Error('Falta recogida')
    const collection = db.collection(`restaurants/${rid}/messages`)
    let messages = (await collection.get()).docs
    expect(messages).toHaveLength(1)
    expect(messages[0]!.get('template')).toBe('takeaway_accepted')
    const manageUrl = String(messages[0]!.get('data.manageUrl'))
    expect(manageUrl).toContain(result.manageToken)
    expect((await call('verParaLlevarPublico', { slug: rid, reference: result.reference, token: result.manageToken }, null)).status).toBe('accepted')
    await expect(call('verParaLlevarPublico', { slug: rid, reference: result.reference, token: 'x'.repeat(43) }, null)).rejects.toMatchObject({ code: 'permission-denied' })
    const lines = await currentLines()
    await call('cambiarEstadoLineas', { ...staff(), lineIds: lines.map(l => l.id), status: 'ready' }, 'kitchen')
    await call('cambiarEstadoLineas', { ...staff(), lineIds: lines.map(l => l.id), status: 'preparing' }, 'kitchen')
    await call('cambiarEstadoLineas', { ...staff(), lineIds: lines.map(l => l.id), status: 'ready' }, 'kitchen')
    messages = (await collection.get()).docs
    expect(messages.map(m => m.get('template')).sort()).toEqual(['takeaway_accepted', 'takeaway_ready'])
    const ref = collection.doc('failure-test')
    await ref.set({ ...messages[0]!.data(), status: 'captured' })
    await ref.update({ status: 'queued', leaseUntil: Timestamp.fromMillis(0) })
    vi.stubEnv('RESEND_API_KEY', 'solo-prueba-local'); vi.stubEnv('EMAIL_FROM', 'demo@test.es')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))
    try {
      expect(await processMessage(ref)).toBe('failed')
      expect((await ref.get()).data()).toMatchObject({ status: 'failed', attempts: expect.any(Number), lastError: expect.stringContaining('503') })
      expect((await db.doc(`${path}/takeaways/${result.takeawayId}`).get()).get('status')).toBe('ready')
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await ref.delete() }
    const tracking = await call('verParaLlevarPublico', { slug: rid, reference: result.reference, token: result.manageToken }, null)
    expect(tracking.notifications).toHaveLength(2)
    expect(tracking.notifications?.[0]).not.toHaveProperty('to')
  })
  it('solo encola WhatsApp si el evento tiene credenciales y plantilla configuradas', async () => {
    vi.stubEnv('WHATSAPP_TOKEN', 'solo-prueba'); vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', 'solo-prueba')
    vi.stubEnv('WHATSAPP_TEMPLATE_TAKEAWAY_ACCEPTED', 'aceptado_prueba')
    try {
      const result = await call('crearParaLlevar', { ...staff(), date: tomorrow(), time: '13:00', guestName: 'Ana Prueba', phone: '600000000', email: 'ana@test.es', source: 'phone', lines: [item()], fire: 'all' })
      if (result.status !== 'accepted') throw new Error('Falta recogida')
      const messages = (await db.collection(`restaurants/${rid}/messages`).get()).docs
      expect(messages.map(m => m.get('channel')).sort()).toEqual(['email', 'whatsapp'])
    } finally { vi.unstubAllEnvs() }
  })
  it('no avisa de aceptación hasta confirmar un pedido público pendiente', async () => {
    const result = await call('pedirParaLlevar', { slug: rid, locationId: lid, date: tomorrow(), time: '13:00', guestName: 'Ana Prueba', phone: '600000000', email: 'ana@test.es', language: 'en', lines: [item()], expectedTotalCents: 650, acceptPolicy: true }, null)
    if (result.status !== 'pending') throw new Error('Se esperaba recogida pendiente')
    expect((await db.collection(`restaurants/${rid}/messages`).get()).size).toBe(0)
    const takeaway = (await db.collection(`${path}/takeaways`).get()).docs[0]!
    const take = core.TakeawaySchema.parse(takeaway.data())
    await call('decidirPedido', { ...staff(), orderId: take.orderIds[0], decision: 'accept' })
    const messages = (await db.collection(`restaurants/${rid}/messages`).get()).docs
    expect(messages).toHaveLength(1)
    expect(messages[0]!.get('template')).toBe('takeaway_accepted')
  })
  it('solo abre una vez una mesa cuando llegan dos transacciones juntas', async () => {
    const results = await Promise.allSettled([open(), open()])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect((await db.collection(`${path}/tableSessions`).get()).size).toBe(1)
    expect((await db.doc(`${path}/reservationLocks/current`).get()).get('revision')).toBeGreaterThan(0)
  }, 30000)
  it('guarda una foto sin bloquearse con la publicación de la carta anterior', async () => {
    // El seed y las operaciones automáticas no tienen autor humano.
    await db.doc(`${path}/menuItems/bravas`).update({ updatedBy: null })
    await db.doc(`${path}/dailyMenus/mediodia`).update({ updatedBy: null })
    const editable = core.MenuItemEditableSchema.parse(core.demoMenu().items.bravas)
    await syncPublicMenu(rid, lid)
    await call('guardarPlato', { ...staff(), itemId: 'bravas', item: { ...editable, priceCents: 700 } })
    const photoPath = `${path}/menu/bravas/foto.png`
    await Promise.all([
      syncPublicMenu(rid, lid),
      call('guardarPlato', { ...staff(), itemId: 'bravas', item: { ...editable, priceCents: 700, photoPath } }),
    ])
    await syncPublicMenu(rid, lid)
    const saved = core.MenuItemSchema.parse((await db.doc(`${path}/menuItems/bravas`).get()).data())
    expect(saved).toMatchObject({ photoPath, priceCents: 700, version: 2, updatedBy: 'owner' })
    const published = core.PublicMenuSchema.parse((await db.doc(`publicMenus/${core.publicMenuId(rid, lid)}`).get()).data())
    expect(published.items.find(i => i.id === 'bravas')).toMatchObject({ photoPath, priceCents: 700 })
  })
  it('ignora eventos atrasados de una reserva ya borrada', async () => {
    const result = core.CrearReservaOutputSchema.parse(await r1.crearReserva.run(req({ ...staff(), guestName: 'Evento atrasado', phone: '600000004', partySize: 2, date: tomorrow(), time: '13:00', source: 'phone', tableIds: ['t1'] })))
    const ref = db.doc(`${path}/reservations/${result.reservationId}`)
    const before = await ref.get()
    await ref.update({ status: 'finished' })
    const after = await ref.get()
    await ref.delete()
    const event = { params: { rid, lid, reservationId: ref.id }, data: { before, after } } as Parameters<typeof mensajesReservaActualizada.run>[0]
    await expect(mensajesReservaActualizada.run(event)).resolves.toBeUndefined()
    expect((await db.collection(`restaurants/${rid}/messages`).where('template', '==', 'review_request').get()).empty).toBe(true)
  })
  it('sentar una reserva abre la sesión en la misma operación y exige mesas', async () => {
    const reservation = core.CrearReservaOutputSchema.parse(await r1.crearReserva.run(req({ ...staff(), guestName: 'Ana Prueba', phone: '600000000', partySize: 2, date: tomorrow(), time: '13:00', source: 'phone', tableIds: ['t1'] })))
    await r1.cambiarEstadoReserva.run(req({ ...staff(), reservationId: reservation.reservationId, status: 'seated' }))
    await r1.cambiarEstadoReserva.run(req({ ...staff(), reservationId: reservation.reservationId, status: 'seated' }))
    const sessions = await db.collection(`${path}/tableSessions`).get()
    expect(sessions.size).toBe(1)
    expect(sessions.docs[0]!.get('reservationId')).toBe(reservation.reservationId)
    expect((await db.doc(`${path}/reservations/${reservation.reservationId}`).get()).get('status')).toBe('seated')
    const reservation2 = core.CrearReservaOutputSchema.parse(await r1.crearReserva.run(req({ ...staff(), guestName: 'Sin mesa', phone: '600000001', partySize: 2, date: tomorrow(), time: '15:00', source: 'phone' })))
    await expect(r1.cambiarEstadoReserva.run(req({ ...staff(), reservationId: reservation2.reservationId, status: 'seated' }))).rejects.toMatchObject({ code: 'failed-precondition' })
    expect((await db.doc(`${path}/reservations/${reservation2.reservationId}`).get()).get('status')).toBe('confirmed')
  })
  it('rechaza precios de cliente y calcula variantes, extras y cantidades con la carta', async () => {
    const s = await open()
    await expect(order(s.sessionId, [{ ...item(), priceCents: 1 } as ReturnType<typeof item>])).rejects.toMatchObject({ code: 'invalid-argument' })
    expect(await call('enviarPedido', { ...staff(), sessionId: s.sessionId, lines: [item()], expectedTotalCents: 1 })).toMatchObject({ status: 'rejected', totalCents: 650, problems: [{ code: 'price_changed' }] })
    expect((await db.collection(`${path}/orders`).get()).size).toBe(0)
    const sent = await call('enviarPedido', { ...staff(), sessionId: s.sessionId, lines: [{ ...item('hamburguesa', 2), optionIds: ['queso','bacon'] }] })
    expect(sent).toMatchObject({ status: 'sent', totalCents: 3500, sessionTotalCents: 3500 })
    expect((await currentLines())[0]!.unitPriceCents).toBe(1750)
  })
  it('vincula cada QR a mesa, local, sesión y token vigente', async () => {
    const s = await open()
    const qr = await call('regenerarQrMesa', { ...staff(), tableIds: ['t1','t2'] })
    const d = { slug: rid, locationId: lid, tableId: 't1', token: qr.tokens[0]!.token }
    expect(await call('verMesaPublica', d, null)).toMatchObject({ canOrder: true, session: { sessionId: s.sessionId } })
    await expect(call('verMesaPublica', { ...d, tableId: 't2' }, null)).rejects.toMatchObject({ code: 'permission-denied' })
    await db.doc(`restaurants/${rid}/locations/otro/tables/t1`).set((await db.doc(`${path}/tables/t1`).get()).data()!)
    await call('regenerarQrMesa', { ...staff(), locationId: 'otro', tableIds: ['t1'] })
    await expect(call('verMesaPublica', { ...d, locationId: 'otro' }, null)).rejects.toMatchObject({ code: 'permission-denied' })
    const other = await open(['t2'])
    await expect(call('pedirDesdeMesa', { ...d, sessionId: other.sessionId, lines: [item()], expectedTotalCents: 650, language: 'es' }, null)).rejects.toMatchObject({ code: 'failed-precondition' })
    await call('moverMesa', { ...staff(), sessionId: s.sessionId, tableIds: ['t3'] })
    await expect(call('pedirDesdeMesa', { ...d, sessionId: s.sessionId, lines: [item()], expectedTotalCents: 650, language: 'es' }, null)).rejects.toMatchObject({ code: 'failed-precondition' })
    await call('regenerarQrMesa', { ...staff(), tableIds: ['t1'] })
    await expect(call('verMesaPublica', d, null)).rejects.toMatchObject({ code: 'permission-denied' })
  })
  it('el público no pide categorías ocultas ni cambia el pase y la aprobación conserva el precio', async () => {
    const s = await open(), qr = await call('regenerarQrMesa', { ...staff(), tableIds: ['t1'] })
    const d = { slug: rid, locationId: lid, tableId: 't1', token: qr.tokens[0]!.token, sessionId: s.sessionId, language: 'es', expectedTotalCents: 650, lines: [item()] }
    await expect(call('pedirDesdeMesa', { ...d, lines: [{ ...item(), course: 'dessert' }] }, null)).rejects.toMatchObject({ code: 'invalid-argument' })
    await db.doc(`${path}/menuCategories/compartir`).update({ active: false })
    expect(await call('pedirDesdeMesa', d, null)).toMatchObject({ status: 'rejected' })
    await db.doc(`${path}/menuCategories/compartir`).update({ active: true })
    const pending = await call('pedirDesdeMesa', d, null)
    expect(pending.status).toBe('pending_approval')
    if (pending.status === 'rejected') throw new Error('Pedido rechazado')
    await db.doc(`${path}/menuItems/bravas`).update({ priceCents: 9999, version: 2 })
    expect((await currentLines())[0]!.status).toBe('pending')
    await call('decidirPedido', { ...staff(), orderId: pending.orderId, decision: 'accept' })
    expect((await currentLines())[0]!).toMatchObject({ status: 'fired', totalCents: 650, version: 1 })
    const view = await call('verMesaPublica', d as unknown as object, null).catch(() => null)
    expect(view).toBeNull() // La consulta estricta rechaza los campos propios del envío.
  })
  it('solo una persona se queda una tarea y un camarero no suelta la de otra persona', async () => {
    const s = await open(), t = await call('crearTarea', { ...staff(), sessionId: s.sessionId, note: 'Traer agua' })
    const results = await Promise.all(['waiter','waiter2'].map(uid => call('cambiarEstadoTarea', { ...staff(), taskId: t.taskId, action: 'claim' }, uid)))
    expect(results.filter(r => r.result === 'ok')).toHaveLength(1)
    expect(results.filter(r => r.result === 'taken')).toHaveLength(1)
    const owner = (await db.doc(`${path}/floorTasks/${t.taskId}`).get()).get('claimedBy') as string
    const notOwner = owner === 'waiter' ? 'waiter2' : 'waiter'
    await expect(call('cambiarEstadoTarea', { ...staff(), taskId: t.taskId, action: 'release' }, notOwner)).rejects.toMatchObject({ code: 'failed-precondition' })
    await call('cambiarEstadoTarea', { ...staff(), taskId: t.taskId, action: 'release' }, 'manager')
    expect((await db.doc(`${path}/floorTasks/${t.taskId}`).get()).get('status')).toBe('open')
  })
  it('estación propia, marcha, anulaciones con motivo, recogida con dueño y cierre', async () => {
    const s = await open(), sent = await order(s.sessionId, [item(), item('agua')])
    if (sent.status !== 'sent') throw new Error('Pedido rechazado')
    const lines = await currentLines(), kitchen = lines.find(l => l.stationKind === 'kitchen')!, bar = lines.find(l => l.stationKind === 'bar')!
    await expect(call('cambiarEstadoLineas', { ...staff(), lineIds: [kitchen.id, bar.id], status: 'ready' }, 'kitchen')).rejects.toMatchObject({ code: 'permission-denied' })
    expect((await db.doc(`${path}/orderLines/${kitchen.id}`).get()).get('status')).toBe('fired')
    await call('cambiarEstadoLineas', { ...staff(), lineIds: [kitchen.id], status: 'ready' }, 'kitchen')
    await expect(call('cambiarEstadoLineas', { ...staff(), lineIds: [kitchen.id], status: 'cancelled', reason: 'Error' }, 'waiter')).rejects.toMatchObject({ code: 'permission-denied' })
    await expect(call('cambiarEstadoLineas', { ...staff(), lineIds: [bar.id], status: 'cancelled' })).rejects.toMatchObject({ code: 'failed-precondition' })
    await expect(call('cambiarEstadoMesa', { ...staff(), sessionId: s.sessionId, status: 'closed' })).rejects.toMatchObject({ code: 'failed-precondition' })
    const pickup = (await db.collection(`${path}/floorTasks`).get()).docs.find(d => d.get('type') === 'pickup')!
    await call('cambiarEstadoTarea', { ...staff(), taskId: pickup.id, action: 'done' }, 'waiter')
    expect((await db.doc(`${path}/orderLines/${kitchen.id}`).get()).get('status')).toBe('served')
    await call('cambiarEstadoLineas', { ...staff(), lineIds: [bar.id], status: 'cancelled', reason: 'Error' })
    await call('cambiarEstadoMesa', { ...staff(), sessionId: s.sessionId, status: 'closed' })
    await expect(order(s.sessionId)).rejects.toMatchObject({ code: 'failed-precondition' })
  })
  it('no duplica el gasto al cerrar, reconciliar y reabrir', async () => {
    const s = await open(['t1'], true); await order(s.sessionId); await serve(s.sessionId)
    const d = { ...staff(), sessionId: s.sessionId, status: 'closed' }
    await Promise.all([call('cambiarEstadoMesa', d), call('cambiarEstadoMesa', d)])
    await reconcileLocation(rid, lid); await reconcileLocation(rid, lid)
    const customer = db.doc(`restaurants/${rid}/customers/${core.customerIdFor(rid,'+34600000000')}`)
    expect((await customer.get()).get('spentCents')).toBe(650)
    await call('cambiarEstadoMesa', { ...d, status: 'open' })
    expect((await customer.get()).get('spentCents')).toBe(0)
    await call('cambiarEstadoMesa', d)
    expect((await customer.get()).get('spentCents')).toBe(650)
    expect((await customer.get()).get('visits')).toBe(0)
  })
  it('mueve, junta y separa el destino actual de platos y sus totales', async () => {
    const a = await open(['t1'], true), b = await open(['t2'])
    await order(a.sessionId); await order(b.sessionId, [item('agua')])
    await call('moverMesa', { ...staff(), sessionId: a.sessionId, tableIds: ['t3'] })
    expect((await currentLines(a.sessionId))[0]!.label).toBe('S3')
    await call('juntarMesas', { ...staff(), sessionId: a.sessionId, tableIds: ['t2'] })
    expect((await db.doc(`${path}/tableSessions/${b.sessionId}`).get()).get('mergedInto')).toBe(a.sessionId)
    expect((await db.doc(`${path}/tableSessions/${a.sessionId}`).get()).get('totalCents')).toBe(850)
    const line = (await currentLines(a.sessionId)).find(l => l.itemId === 'agua')!
    const split = await call('separarMesas', { ...staff(), sessionId: a.sessionId, tableIds: ['t2'], lineIds: [line.id], guests: 2 })
    expect(split.newSessionId).toBeTruthy()
    expect((await db.doc(`${path}/orderLines/${line.id}`).get()).get('sessionId')).toBe(split.newSessionId)
    expect((await db.doc(`${path}/tableSessions/${a.sessionId}`).get()).get('totalCents')).toBe(650)
    expect((await db.doc(`${path}/tableSessions/${split.newSessionId}`).get()).get('totalCents')).toBe(200)
    expect((await db.doc(`${path}/tableSessions/${split.newSessionId}`).get()).get('reservationId')).toBeNull()
  })
  it('sin kitchen la sala sirve directamente y no asigna estaciones nuevas', async () => {
    await db.doc(`restaurants/${rid}`).update({ activeModules: ['floor'] })
    const s = await open(); await order(s.sessionId)
    const line = (await currentLines())[0]!
    expect(line.stationKind).toBeNull()
    await call('cambiarEstadoLineas', { ...staff(), lineIds: [line.id], status: 'served' }, 'waiter')
    await call('cambiarEstadoMesa', { ...staff(), sessionId: s.sessionId, status: 'closed' })
  })
  it('revalida capacidad pública de recogida, acepta y marcha una sola vez', async () => {
    await db.doc(`${path}/settings/floor`).update({ 'takeaway.maxOrdersPerSlot': 1, 'takeaway.autoAccept': false })
    const d = { slug: rid, locationId: lid, date: tomorrow(), time: '13:00', guestName: 'Ana Prueba', phone: '600000000', language: 'es', lines: [item()], expectedTotalCents: 650, acceptPolicy: true }
    const results = await Promise.allSettled([call('pedirParaLlevar', d, null), call('pedirParaLlevar', d, null)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const created = results.find(r => r.status === 'fulfilled')!
    if (created.status !== 'fulfilled' || created.value.status === 'rejected') throw new Error('Falta recogida')
    expect(created.value.status).toBe('pending')
    const take = (await db.collection(`${path}/takeaways`).get()).docs[0]!
    await expect(call('verParaLlevarPublico', { slug: rid, reference: created.value.reference, token: 'x'.repeat(43) }, null)).rejects.toMatchObject({ code: 'permission-denied' })
    expect(await call('verParaLlevarPublico', { slug: rid, reference: created.value.reference, token: created.value.manageToken }, null)).toMatchObject({ status: 'pending', totalCents: 650 })
    expect(await processTakeaways(rid, lid)).toEqual({ fired: 0 })
    await call('cambiarEstadoParaLlevar', { ...staff(), takeawayId: take.id, status: 'accepted' })
    const line = (await currentLines())[0]!
    await db.doc(`${path}/orderLines/${line.id}`).update({ fireAt: Timestamp.fromMillis(Date.now() - 1) })
    const fired = await Promise.all([processTakeaways(rid, lid), processTakeaways(rid, lid)])
    expect(fired.reduce((n, r) => n + r.fired, 0)).toBe(1)
    await call('cambiarEstadoLineas', { ...staff(), lineIds: [line.id], status: 'ready' }, 'kitchen')
    await call('cambiarEstadoParaLlevar', { ...staff(), takeawayId: take.id, status: 'picked_up' })
    await call('cambiarEstadoParaLlevar', { ...staff(), takeawayId: take.id, status: 'picked_up' })
    expect((await db.doc(`restaurants/${rid}/customers/${core.customerIdFor(rid,'+34600000000')}`).get()).get('spentCents')).toBe(650)
  }, 30000)
  it('proyecta la carta vigente sin datos privados y con los módulos actuales', async () => {
    await syncPublicMenu(rid, lid)
    const ref = db.doc(`publicMenus/${core.publicMenuId(rid,lid)}`), first = core.PublicMenuSchema.parse((await ref.get()).data())
    expect(first.items.some(i => i.id === 'bravas')).toBe(true)
    expect(first.items.find(i => i.id === 'bravas')).not.toHaveProperty('stationId')
    await db.doc(`${path}/menuCategories/compartir`).update({ active: false })
    await db.doc(`restaurants/${rid}`).update({ activeModules: ['reservations'] })
    await Promise.all([syncPublicMenu(rid, lid), syncPublicMenu(rid, lid)])
    const next = core.PublicMenuSchema.parse((await ref.get()).data())
    expect(next.items.find(i => i.id === 'bravas')).toBeUndefined()
    expect(next.selfOrder.enabled).toBe(false)
    await db.doc(path).delete(); await syncPublicMenu(rid, lid)
    expect((await ref.get()).exists).toBe(false)
  })
  it('valida la propiedad de fotos y estaciones al guardar catálogo', async () => {
    const demo = core.demoMenu(), item = demo.items.bravas!
    const { version: _version, soldOut: _soldOut, ...editable } = item
    await expect(call('guardarPlato', { ...staff(), itemId: 'bravas', item: { ...editable, photoPath: `${path}/menu/agua/foto.png` } })).rejects.toMatchObject({ code: 'failed-precondition' })
    await expect(call('marcarAgotado', { ...staff(), itemId: 'agua', soldOut: true }, 'kitchen')).rejects.toMatchObject({ code: 'permission-denied' })
    await call('marcarAgotado', { ...staff(), itemId: 'bravas', soldOut: true }, 'kitchen')
    expect((await db.doc(`${path}/menuItems/bravas`).get()).get('version')).toBe(1)
    expect(await call('guardarPlato', { ...staff(), itemId: 'bravas', item: { ...editable, priceCents: 750 } })).toMatchObject({ version: 2, priceChanged: true })
    expect((await db.doc(`${path}/menuItems/bravas`).get()).get('soldOut')).toBe(true)
  })
  it('conserva el precio fijo del menú y descuenta cada suplemento una sola vez', async () => {
    await db.doc(`${path}/dailyMenus/mediodia`).update({ days: ['mon','tue','wed','thu','fri','sat','sun'], from: '00:00', to: '23:59' })
    const s = await open()
    const result = await call('enviarPedido', { ...staff(), sessionId: s.sessionId, lines: [{ kind: 'menu', dailyMenuId: 'mediodia', quantity: 2,
      selections: [{ sectionId: 'primeros', itemId: 'sopa' }, { sectionId: 'segundos', itemId: 'entrecot', optionIds: ['punto','roquefort'] }, { sectionId: 'postres', itemId: 'crema' }] }] })
    expect(result).toMatchObject({ status: 'sent', totalCents: 4300 })
    const lines = await currentLines(s.sessionId)
    expect(lines).toHaveLength(4)
    expect(lines.reduce((n, l) => n + l.totalCents, 0)).toBe(4300)
    const parent = lines.find(l => l.kind === 'menu')!, meat = lines.find(l => l.itemId === 'entrecot')!
    expect(parent.totalCents).toBe(3100)
    await expect(call('cambiarEstadoLineas', { ...staff(), lineIds: [parent.id], status: 'fired' })).rejects.toMatchObject({ code: 'failed-precondition' })
    await call('cambiarEstadoLineas', { ...staff(), lineIds: [meat.id], status: 'cancelled' }, 'waiter')
    expect((await db.doc(`${path}/tableSessions/${s.sessionId}`).get()).get('totalCents')).toBe(3100)
    await call('cambiarEstadoLineas', { ...staff(), lineIds: lines.filter(l => l.kind !== 'menu' && l.id !== meat.id).map(l => l.id), status: 'cancelled', reason: 'No lo quieren' })
    expect((await db.doc(`${path}/tableSessions/${s.sessionId}`).get()).get('totalCents')).toBe(0)
  })
  it('agrupa avisos sin reiniciar plazo y no acepta un pedido al completar su tarea', async () => {
    const s = await open(), qr = await call('regenerarQrMesa', { ...staff(), tableIds: ['t1'] })
    const link = { slug: rid, locationId: lid, tableId: 't1', token: qr.tokens[0]!.token }
    const d = { ...link, sessionId: s.sessionId, kind: 'call_waiter' }
    const a = await call('avisarDesdeMesa', d, null)
    await call('cambiarEstadoTarea', { ...staff(), taskId: a.taskId, action: 'claim' }, 'waiter')
    const before = core.FloorTaskSchema.parse((await db.doc(`${path}/floorTasks/${a.taskId}`).get()).data())
    const b = await call('avisarDesdeMesa', d, null)
    const after = core.FloorTaskSchema.parse((await db.doc(`${path}/floorTasks/${a.taskId}`).get()).data())
    expect(b.taskId).toBe(a.taskId); expect(after.count).toBe(2); expect(after.dueAt).toBe(before.dueAt); expect(after.claimedBy).toBe('waiter')
    const pending = await call('pedirDesdeMesa', { ...link, sessionId: s.sessionId, lines: [item()], expectedTotalCents: 650, language: 'es' }, null)
    if (pending.status === 'rejected') throw new Error('Falta pedido pendiente')
    const approval = (await db.collection(`${path}/floorTasks`).get()).docs.find(d => d.get('type') === 'approve_order')!
    await expect(call('cambiarEstadoTarea', { ...staff(), taskId: approval.id, action: 'done' }, 'waiter')).rejects.toMatchObject({ code: 'failed-precondition' })
    await expect(call('decidirPedido', { ...staff(), orderId: pending.orderId, decision: 'reject' })).rejects.toMatchObject({ code: 'failed-precondition' })
    await call('decidirPedido', { ...staff(), orderId: pending.orderId, decision: 'reject', reason: 'Sin existencias' })
    expect((await db.doc(`${path}/floorTasks/${approval.id}`).get()).get('status')).toBe('done')
    const view = await call('verMesaPublica', link, null)
    expect(view.session!.lines[0]!.status).toBe('cancelled')
    expect(view.session).not.toHaveProperty('customerId'); expect(view.session).not.toHaveProperty('notes')
  })
  it('no reabre ni mueve hacia mesas ocupadas o reservadas y mantiene la actividad atómica', async () => {
    const a = await open(), b = await open(['t2'])
    await expect(call('moverMesa', { ...staff(), sessionId: a.sessionId, tableIds: ['t2'] })).rejects.toMatchObject({ code: 'failed-precondition' })
    const r = core.CrearReservaOutputSchema.parse(await r1.crearReserva.run(req({ ...staff(), guestName: 'Grupo futuro', phone: '600000003', partySize: 2, date: tomorrow(), time: '13:00', source: 'phone', tableIds: ['t3'] })))
    await db.doc(`${path}/reservations/${r.reservationId}`).update({ startAt: Timestamp.fromMillis(Date.now() + 600000) })
    await expect(call('moverMesa', { ...staff(), sessionId: a.sessionId, tableIds: ['t3'] })).rejects.toMatchObject({ code: 'failed-precondition' })
    await call('cambiarEstadoMesa', { ...staff(), sessionId: a.sessionId, status: 'closed' })
    await call('moverMesa', { ...staff(), sessionId: b.sessionId, tableIds: ['t1'] })
    await expect(call('cambiarEstadoMesa', { ...staff(), sessionId: a.sessionId, status: 'open' })).rejects.toMatchObject({ code: 'failed-precondition' })
  })
  it('rota el estado de una recogida al deshacer cocina y cancela sin duplicar consumo', async () => {
    const result = await call('crearParaLlevar', { ...staff(), date: tomorrow(), time: '13:00', guestName: 'Ana Prueba', phone: '600000000', source: 'phone', lines: [item()], fire: 'all' })
    if (result.status !== 'accepted') throw new Error('Falta recogida')
    const line = (await currentLines())[0]!
    await call('cambiarEstadoLineas', { ...staff(), lineIds: [line.id], status: 'ready' }, 'kitchen')
    expect((await db.doc(`${path}/takeaways/${result.takeawayId}`).get()).get('status')).toBe('ready')
    await call('cambiarEstadoLineas', { ...staff(), lineIds: [line.id], status: 'preparing' }, 'kitchen')
    expect((await db.doc(`${path}/takeaways/${result.takeawayId}`).get()).get('status')).toBe('accepted')
    await expect(call('cambiarEstadoParaLlevar', { ...staff(), takeawayId: result.takeawayId, status: 'cancelled', reason: 'Error' }, 'waiter')).rejects.toMatchObject({ code: 'permission-denied' })
    await call('cambiarEstadoParaLlevar', { ...staff(), takeawayId: result.takeawayId, status: 'cancelled', reason: 'Error' })
    expect((await db.doc(`${path}/takeaways/${result.takeawayId}`).get()).get('totalCents')).toBe(0)
    expect((await db.doc(`restaurants/${rid}/customers/${core.customerIdFor(rid,'+34600000000')}`).get()).get('spentCents')).toBe(0)
  })
  it('limita también intentos con token inválido sin escribir pedidos', async () => {
    const qr = await call('regenerarQrMesa', { ...staff(), tableIds: ['t1'] })
    const counter = db.doc(`restaurants/${rid}/floorRateLimits/${core.sha256Hex('ip:127.0.0.1')}`)
    await counter.set({ count: 59, since: Timestamp.now() })
    await expect(call('verMesaPublica', { slug: rid, locationId: lid, tableId: 't1', token: 'x'.repeat(43) }, null)).rejects.toMatchObject({ code: 'permission-denied' })
    expect((await counter.get()).get('count')).toBe(60)
    await expect(call('verMesaPublica', { slug: rid, locationId: lid, tableId: 't1', token: qr.tokens[0]!.token }, null)).rejects.toMatchObject({ code: 'resource-exhausted' })
    expect((await db.collection(`${path}/orders`).get()).size).toBe(0)
  })
  it('administra categorías, estaciones, menús, orden y responsables con las callables reales', async () => {
    const category = await call('guardarCategoriaCarta', { ...staff(), categoryId: null, category: { name: { es: 'Nueva categoría' }, sortOrder: 100, active: true } })
    const station = await call('guardarEstacion', { ...staff(), stationId: null, station: { name: 'Nueva cocina', kind: 'kitchen', sortOrder: 100, targetMinutes: 10, pickup: true, active: true } })
    const created = await call('guardarPlato', { ...staff(), itemId: null, item: { categoryId: category.categoryId, name: { es: 'Plato nuevo' }, sortOrder: 0, priceCents: 1234, course: 'first', stationId: station.stationId } })
    const menu = await call('guardarMenuDia', { ...staff(), dailyMenuId: null, menu: { name: { es: 'Menú nuevo' }, priceCents: 1800, days: ['mon'], from: '13:00', to: '16:00', sections: [{ id: 'principal', name: { es: 'Principal' }, course: 'second', min: 1, max: 1, choices: [{ itemId: created.itemId }] }] } })
    expect(menu.version).toBe(1)
    await call('ordenarCarta', { ...staff(), categories: [{ id: category.categoryId, sortOrder: -1 }], items: [{ id: created.itemId, categoryId: 'compartir', sortOrder: -1 }] })
    expect((await db.doc(`${path}/menuItems/${created.itemId}`).get()).get('categoryId')).toBe('compartir')
    const settings = core.defaultFloorSettings(); settings.defaultStationId = station.stationId
    await call('guardarConfiguracionSala', { ...staff(), settings })
    const s = await open()
    await expect(call('editarMesa', { ...staff(), sessionId: s.sessionId, waiterUid: 'kitchen' })).rejects.toMatchObject({ code: 'failed-precondition' })
    await call('editarMesa', { ...staff(), sessionId: s.sessionId, guests: 3, waiterUid: 'waiter', notes: 'Nota privada' })
    expect((await db.doc(`${path}/tableSessions/${s.sessionId}`).get()).get('waiterName')).toBe('waiter')
    await expect(call('guardarEstacion', { ...staff(), stationId: null, station: core.demoMenu().stations.cocina }, 'waiter')).rejects.toMatchObject({ code: 'permission-denied' })
    expect(await call('consultarRecogida', { slug: rid, locationId: lid, date: tomorrow() }, null)).toMatchObject({ enabled: false, slots: [] })
  })
  it('pedir después de la cuenta vuelve a abrir la mesa y cancela su aviso', async () => {
    const s = await open(), qr = await call('regenerarQrMesa', { ...staff(), tableIds: ['t1'] })
    const link = { slug: rid, locationId: lid, tableId: 't1', token: qr.tokens[0]!.token }
    await expect(call('avisarDesdeMesa', { ...link, kind: 'request_bill' }, null)).rejects.toMatchObject({ code: 'failed-precondition' })
    const bill = await call('avisarDesdeMesa', { ...link, sessionId: s.sessionId, kind: 'request_bill' }, null)
    expect((await db.doc(`${path}/tableSessions/${s.sessionId}`).get()).get('status')).toBe('bill_requested')
    await order(s.sessionId)
    expect((await db.doc(`${path}/tableSessions/${s.sessionId}`).get()).get('status')).toBe('open')
    expect((await db.doc(`${path}/floorTasks/${bill.taskId}`).get()).get('status')).toBe('cancelled')
  })
  it('al separar platos listos conserva plazo y dueño de ambas recogidas', async () => {
    const s = await open(['t1','t2']); await order(s.sessionId, [item(), item()])
    const lines = await currentLines(s.sessionId)
    await call('cambiarEstadoLineas', { ...staff(), lineIds: lines.map(l => l.id), status: 'ready' }, 'kitchen')
    const pickup = (await db.collection(`${path}/floorTasks`).get()).docs.find(d => d.get('type') === 'pickup')!
    await call('cambiarEstadoTarea', { ...staff(), taskId: pickup.id, action: 'claim' }, 'waiter')
    const original = core.FloorTaskSchema.parse((await pickup.ref.get()).data())
    const split = await call('separarMesas', { ...staff(), sessionId: s.sessionId, tableIds: ['t2'], lineIds: [lines[0]!.id], guests: 1 })
    expect(split.newSessionId).toBeTruthy()
    const tasks = (await db.collection(`${path}/floorTasks`).get()).docs.map(d => core.FloorTaskSchema.parse(d.data())).filter(t => t.type === 'pickup' && core.taskIsActive(t.status))
    expect(tasks).toHaveLength(2)
    for (const t of tasks) { expect(t.claimedBy).toBe('waiter'); expect(t.dueAt).toBe(original.dueAt); expect(t.lineIds).toHaveLength(1) }
    await reconcileLocation(rid, lid)
    expect((await db.collection(`${path}/floorTasks`).get()).docs.filter(d => ['open','claimed'].includes(d.get('status')))).toHaveLength(2)
  })
  it('la lista de espera respeta las sesiones abiertas antes de ofrecer una franja', async () => {
    for (let i = 2; i <= 6; i++) await db.doc(`${path}/tables/t${i}`).update({ enabled: false })
    await db.doc(`${path}/settings/reservations`).update({ 'waitlist.enabled': true, minNoticeMinutes: 0 })
    const s = await open()
    const at = Math.ceil((Date.now() + 30 * 60000) / (15 * 60000)) * 15 * 60000, wall = core.horaLocal(at, 'Europe/Madrid')
    const waiting = db.doc(`${path}/waitlist/w`)
    await waiting.set({ guestName: 'Grupo en espera', phone: '+34600000004', email: null, language: 'es', partySize: 2, date: wall.fecha, from: wall.hora, to: wall.hora, status: 'waiting', offer: null, customerId: core.customerIdFor(rid,'+34600000004'), source: 'staff', createdAt: Timestamp.now() })
    await offerWaitlist(rid,lid)
    expect((await waiting.get()).get('status')).toBe('waiting')
    await call('cambiarEstadoMesa', { ...staff(), sessionId: s.sessionId, status: 'closed' })
    await offerWaitlist(rid,lid)
    expect((await waiting.get()).get('status')).toBe('offered')
  })
  it('captura actividad con autor y changeId sin tokens ni datos de contacto', async () => {
    const s = await open(), qr = await call('regenerarQrMesa', { ...staff(), tableIds: ['t1'] })
    const rows = await db.collection(`restaurants/${rid}/activity`).get()
    expect(rows.docs.some(d => d.get('action') === 'tableSession.opened' && d.get('actorUid') === 'owner')).toBe(true)
    expect(JSON.stringify(rows.docs.map(d => d.data()))).not.toContain(qr.tokens[0]!.token)
    const changeId = (await db.doc(`${path}/tableSessions/${s.sessionId}`).get()).get('changeId') as string
    expect((await db.doc(`restaurants/${rid}/activity/${changeId}`).get()).exists).toBe(true)
  })
})
