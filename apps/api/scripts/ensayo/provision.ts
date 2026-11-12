// Alta completa de un restaurante de ensayo por la API (vía LogiQD), con equipo, plano, carta y un servicio de prueba.
import * as core from '@llenamos/core'
import { call, invitationToken, login, randomHex, requestId, sql, status, lit } from './lib.js'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

export const password = 'contraseña-de-ensayo-2026'
export async function operatorToken(): Promise<string> {
  const version = randomHex(16)
  sql(`INSERT INTO llenamos.identities(uid,session_version,tokens_valid_after,locked,platform_operator) VALUES('operador-carga',${lit(version)},now()-interval '1 hour',false,true) ON CONFLICT(uid) DO NOTHING`)
  const stored = sql(`SELECT session_version FROM llenamos.identities WHERE uid='operador-carga'`).trim()
  execFileSync('docker', ['exec', '-i', 'llenamos-ensayo-identity-1', 'node', '/ensayo/cli.mjs', 'operator', 'operador-carga', 'logiqd@ensayo.test', stored], { input: password })
  return login('logiqd@ensayo.test', password)
}
export interface Provisioned { slug: string; rid: string; loc: string; owner: string; waiter: string; cook: string; items: Record<string, string>; stations: Record<string, string>; template: { reservation: string; session: string } }
export async function provision(operator: string, slug: string, withService = true): Promise<Provisioned> {
  const domain = `${slug}.test`
  const plans = (await call('listarPlanesDisponibles', {}, null)).plans as any[]
  const plan = plans.find(p => JSON.stringify(p).includes('"pos"'))!
  const out = await call('altaRestauranteLogiqd', { requestId: requestId('alta'), ownerEmail: `propietaria@${domain}`, ownerName: 'Propietaria', name: `Restaurante ${slug}`, slug, locationName: 'Local principal', planId: plan.id, planVersion: plan.version }, operator)
  const rid = out.restaurantId as string, loc = out.locationId as string
  const R = { restaurantId: rid, locationId: loc }
  const accept = async (email: string) => {
    const id = sql(`SELECT id FROM llenamos.account_invitations WHERE restaurant_id=${lit(rid)} AND email=${lit(email)}`).trim()
    await call('aceptarInvitacion', { invitationId: id, token: invitationToken(id), password }, null)
    return login(email, password)
  }
  const owner = await accept(`propietaria@${domain}`)
  for (const [email, name, role] of [[`camarero@${domain}`, 'Camarero', 'waiter'], [`cocina@${domain}`, 'Cocinero', 'kitchen']] as const)
    await call('invitarMiembro', { restaurantId: rid, email, displayName: name, role }, owner)
  const waiter = await accept(`camarero@${domain}`), cook = await accept(`cocina@${domain}`)
  await call('guardarPlano', { ...R, createAreas: [{ id: 'sala', name: 'Sala', sortOrder: 0 }], createTables: Array.from({ length: 12 }, (_, i) => ({ id: `t${i + 1}`, name: `T${i + 1}`, areaId: 'sala', seats: 4, shape: 'rect', x: 5 + (i % 6) * 14, y: 5 + Math.floor(i / 6) * 14, w: 10, h: 10, joinableWith: [], enabled: true })) }, owner)
  await call('guardarConfiguracionReservas', { ...R, settings: { ...core.defaultReservationSettings('Europe/Madrid'), publicBooking: true, autoConfirm: true, minNoticeMinutes: 0, maxAdvanceDays: 365 } }, owner)
  const demo = core.demoMenu()
  const stations: Record<string, string> = {}, stationOf: Record<string, string> = {}, categories: Record<string, string> = {}, items: Record<string, string> = {}
  for (const [id, station] of Object.entries(demo.stations)) { stations[id] = (await call('guardarEstacion', { ...R, stationId: null, station: core.StationSchema.parse(station) }, owner)).stationId; stationOf[station.kind] ??= stations[id]! }
  for (const [id, category] of Object.entries(demo.categories)) categories[id] = (await call('guardarCategoriaCarta', { ...R, categoryId: null, category: core.MenuCategorySchema.parse(category) }, owner)).categoryId
  for (const [id, item] of Object.entries(demo.items))
    items[id] = (await call('guardarPlato', { ...R, itemId: null, item: core.MenuItemEditableSchema.parse({ ...item, categoryId: categories[item.categoryId], stationId: item.stationId ? stations[item.stationId] : item.stationId }) }, owner)).itemId
  const settings = { ...demo.settings, defaultStationId: stations[demo.settings.defaultStationId ?? ''] ?? Object.values(stations)[0] ?? null }
  settings.selfOrder = { ...settings.selfOrder, enabled: true, requireApproval: false }
  await call('guardarConfiguracionSala', { ...R, settings }, owner)
  const result: Provisioned = { slug, rid, loc, owner, waiter, cook, items, stations: stationOf, template: { reservation: '', session: '' } }
  if (!withService) return result
  // Servicio completo de plantilla: una reserva y una mesa servida y cobrada en efectivo (de aquí se clona el histórico).
  const date = core.sumarDias(core.horaLocal(Date.now(), 'Europe/Madrid').fecha, 1)
  await call('crearReservaPublica', { slug, locationId: loc, date, time: '20:00', partySize: 4, guestName: 'Cliente Plantilla', phone: '+34611000222', email: null, language: 'es', guestNotes: '', acceptPolicy: true, source: 'web', website: '' }, null)
  const opened = await call('abrirMesa', { ...R, tableIds: ['t1'], guests: 2 }, waiter)
  const order = await call('enviarPedido', { ...R, sessionId: opened.sessionId, lines: [{ kind: 'item', itemId: items.bravas, quantity: 2 }, { kind: 'item', itemId: items.agua, quantity: 1 }], requestId: randomUUID() }, waiter)
  if (order.status !== 'sent') throw new Error(`pedido de plantilla ${JSON.stringify(order)}`)
  const ids = sql(`SELECT id FROM llenamos.sala_order_lines WHERE restaurant_id=${lit(rid)} AND session_id=${lit(opened.sessionId)}`).trim().split('\n')
  await call('cambiarEstadoLineas', { ...R, lineIds: ids, status: 'served' }, waiter).catch(async () => {
    const kitchen = sql(`SELECT id FROM llenamos.sala_order_lines WHERE restaurant_id=${lit(rid)} AND session_id=${lit(opened.sessionId)} AND station_kind='kitchen'`).trim().split('\n')
    await call('cambiarEstadoLineas', { ...R, lineIds: kitchen, status: 'preparing' }, cook); await call('cambiarEstadoLineas', { ...R, lineIds: kitchen, status: 'ready' }, cook)
    await call('cambiarEstadoLineas', { ...R, lineIds: ids, status: 'served' }, waiter)
  })
  const cash = await call('abrirCaja', { ...R, requestId: requestId('caja'), registerId: 'caja-1', openingCents: 10000 }, owner)
  const bill = await call('abrirCuenta', { ...R, requestId: requestId('cta'), target: { kind: 'session', id: opened.sessionId } }, waiter)
  const prepared = await call('prepararCobro', { ...R, requestId: requestId('prep'), billId: bill.billId, expectedRevision: 1 }, waiter)
  const part = (await call('verCuenta', { ...R, billId: bill.billId }, waiter)).parts[0]
  await call('registrarCobro', { ...R, requestId: requestId('cobro'), billId: bill.billId, expectedRevision: prepared.revision, partId: part.id, cashSessionId: cash.cashSessionId, method: 'cash', amountCents: part.totalCents, tipCents: 0, tenderedCents: part.totalCents }, waiter)
  await call('cambiarEstadoMesa', { ...R, sessionId: opened.sessionId, status: 'closed' }, waiter)
  await call('cerrarCaja', { ...R, requestId: requestId('cierre'), cashSessionId: cash.cashSessionId, countedCents: 10000 + part.totalCents, reason: null }, owner)
  result.template = { reservation: '', session: opened.sessionId }
  void status
  return result
}
