import type { Input } from './context'
import * as core from '@llenamos/core'
import { type Transaction } from 'firebase-admin/firestore'
import { type CallableRequest } from 'firebase-functions/v2/https'
import { type Context, context, get, newId, fail, denied, permission } from './context'
import { destinationLines, sessionStatus, closeTask, customer, reconcile } from './service'
import { floorOccupancy } from './occupancy'

const tables = (c: Context) => Object.fromEntries(c.rows.tables)
const occupancy = (c: Context) => Object.fromEntries([...c.rows.tableSessions.values()].filter(s => core.sessionIsOpen(s.status)).flatMap(s => s.tableIds.map(t => [t, s.id])))
function plan<T extends { ok: boolean }>(value: T): Extract<T, { ok: true }> {
  if (!value.ok) fail('Las mesas elegidas no están disponibles. Revisa la ocupación y la selección.')
  return value as Extract<T, { ok: true }>
}
export function validateTables(c: Context, tableIds: string[], guests: number, excludeSessions: string[] = [], excludeReservations: string[] = []) {
  if (tableIds.length < 1 || tableIds.length > 8 || new Set(tableIds).size !== tableIds.length) fail('Elige entre una y ocho mesas distintas.')
  const selected = tableIds.map(id => get(c, 'tables', id))
  if (selected.some(t => !t.enabled)) fail('Alguna mesa está desactivada.')
  const config = core.settingsToConfiguracion(c.reservationSettings)
  const seats = selected.reduce((n, t) => n + t.seats, 0) - (selected.length - 1) * config.plazasPerdidasPorUnion
  if (guests < 1 || guests > 200 || guests > seats) fail('Las mesas no admiten ese número de comensales.')
  const interval = { inicio: c.now, fin: c.now + core.duracionParaGrupo(config, guests) * 60000 }
  const reservations = floorOccupancy(c).filter(r => !excludeSessions.some(id => r.id === `session:${id}`) && !excludeReservations.includes(r.id))
  const occupied = core.construirOcupacion(reservations, c.now)
  if (tableIds.some(id => core.choquesDeMesa(occupied, id, interval, config.margenMinutos).length)) fail('Estas mesas coinciden con otra sesión o reserva.')
  // También conserva sitio para las reservas confirmadas aún sin mesa asignada.
  const motorTables = [...c.rows.tables.values()].map(t => core.tableToMesa(t.id, t))
  const combinations = core.combinacionesDeMesas(motorTables, config.maxMesasUnidas, config.plazasPerdidasPorUnion)
  const requests = core.solicitudesSinMesa(interval, occupied, config.margenMinutos, n => core.opcionesParaGrupo(combinations, motorTables, n))
  const fitting = core.encajarSolicitudes([{ id: 'opening', intervalo: interval, comensales: guests, opciones: [{ mesaIds: tableIds, plazas: seats, areaIds: [...new Set(selected.map(t => t.areaId))] }] }, ...requests], occupied, config.margenMinutos)
  if (fitting.tipo !== 'encaja') fail('No queda capacidad para las reservas previstas.')
}
function waiter(c: Context, uid: string | null | undefined) {
  const id = uid === undefined ? c.uid : uid
  if (!id) return { waiterUid: null, waiterName: null }
  const member = c.members.get(id)
  if (!member?.active || !core.can(member.role, 'sala.gestionar') || (member.locationIds.length && !member.locationIds.includes(c.lid))) fail('El responsable no puede trabajar en este local.')
  return { waiterUid: id, waiterName: member!.displayName }
}
function freshSession(c: Context, fields: Pick<core.TableSession, 'tableIds' | 'guests' | 'reservationId' | 'customerId' | 'guestName'>, responsible?: string | null, notes = '') {
  const id = newId(c, 'tableSessions')
  const session: core.TableSessionWithId = { ...fields, id, ...waiter(c, responsible), status: 'open', label: core.sessionLabel(fields.tableIds, tables(c)), notes,
    openedAt: c.now, openedBy: c.uid, closedAt: null, closedBy: null, billRequestedAt: null, mergedInto: null,
    totalCents: 0, lineCount: 0, unservedCount: 0, history: [] }
  c.put('tableSessions', session, true)
  return session
}
export function openReservation(c: Context, reservationId: string, responsible?: string | null, notes = '', writeReservation = true) {
  if (!permission(c, 'reservas.gestionar')) denied()
  if (!core.hasModule(c.restaurant, 'reservations')) fail('El módulo de reservas está desactivado.')
  const r = get(c, 'reservations', reservationId)
  const index = c.privateRows.reservationSessions.get(reservationId)
  if (index) {
    const s = get(c, 'tableSessions', index.sessionId)
    if (!core.sessionIsOpen(s.status) || r.status !== 'seated') fail('Esta reserva ya tiene una sesión cerrada o absorbida.')
    return { sessionId: s.id, label: s.label, joinable: core.tablesAreJoinable(s.tableIds, tables(c)), reservationSeated: false }
  }
  if (!r.tableIds.length) fail('Asigna mesas a la reserva antes de sentarla.')
  if (r.status !== 'seated') {
    const change = core.applyStatusChange(r, 'seated', { nowMs: c.now, by: c.uid })
    if (!change.ok) fail(change.reason)
    if (writeReservation && change.ok) c.put('reservations', change.reservation)
  }
  plan(core.planOpen(r.tableIds, tables(c), occupancy(c)))
  validateTables(c, r.tableIds, r.partySize, [], [r.id])
  customer(c, r.guestName, r.phone, r.email, r.language)
  const s = freshSession(c, core.sessionFromReservation(r, reservationId), responsible, notes)
  c.secret('reservationSessions', reservationId, { sessionId: s.id })
  return { sessionId: s.id, label: s.label, joinable: core.tablesAreJoinable(r.tableIds, tables(c)), reservationSeated: r.status !== 'seated' }
}
export function abrirMesa(c: Context, d: Input<'abrirMesa'>) {
  if (d.reservationId) {
    const r = get(c, 'reservations', d.reservationId)
    if (r.tableIds.length !== d.tableIds.length || !r.tableIds.every(id => d.tableIds.includes(id))) fail('Las mesas deben coincidir con las asignadas a la reserva.')
    return openReservation(c, r.id, d.waiterUid, d.notes)
  }
  const p = plan(core.planOpen(d.tableIds, tables(c), occupancy(c)))
  validateTables(c, d.tableIds, d.guests)
  const customerId = d.guest ? customer(c, d.guest.name, d.guest.phone) : null
  const s = freshSession(c, { tableIds: d.tableIds, guests: d.guests, reservationId: null, customerId, guestName: d.guest?.name ?? null }, d.waiterUid, d.notes)
  return { sessionId: s.id, label: s.label, joinable: p.joinable, reservationSeated: false }
}
function representedSources(c: Context, id: string): core.TableSessionWithId[] {
  return [...c.rows.tableSessions.values()].filter(s => s.mergedInto === id).flatMap(s => [s, ...representedSources(c, s.id)])
}
function finishReservations(c: Context, s: core.TableSessionWithId) {
  const sessions = [s, ...representedSources(c, s.id)]
  const seated = sessions.flatMap(s => s.reservationId ? [get(c, 'reservations', s.reservationId)] : []).filter(r => r.status === 'seated')
  if (seated.length && (!permission(c, 'reservas.gestionar') || !core.hasModule(c.restaurant, 'reservations'))) denied()
  for (const r of seated) {
    const change = core.applyStatusChange(r, 'finished', { nowMs: c.now, by: c.uid })
    if (change.ok) c.put('reservations', change.reservation)
  }
}
export function cambiarEstadoMesa(c: Context, d: Input<'cambiarEstadoMesa'>) {
  const s = get(c, 'tableSessions', d.sessionId)
  if (s.status === d.status) return { ok: true, status: s.status, totalCents: s.totalCents }
  if (!core.canSessionTransition(s.status, d.status)) fail('La mesa no admite ese cambio de estado.')
  const lines = destinationLines(c, s.id, null)
  if (d.status === 'closed') {
    if (core.checkCloseSession(lines).length) fail('Sirve o anula todos los platos y decide los pedidos pendientes antes de cerrar.')
    finishReservations(c, s)
  }
  if (d.status === 'cancelled' && core.checkCancelSession(lines).length) fail('No se puede anular una mesa con pedidos vivos.')
  if (s.status === 'closed') {
    plan(core.planOpen(s.tableIds, tables(c), occupancy(c)))
    validateTables(c, s.tableIds, s.guests, [s.id])
    c.put('tableSessions', { ...s, openedAt: c.now })
  }
  sessionStatus(c, get(c, 'tableSessions', s.id), d.status, d.reason ?? null)
  if (d.status === 'closed' || d.status === 'cancelled' || (s.status === 'bill_requested' && d.status === 'open')) {
    for (const t of c.rows.floorTasks.values()) if (t.sessionId === s.id && (d.status !== 'open' || t.type === 'bill_request')) closeTask(c, t, 'cancelled')
  }
  if (d.status === 'bill_requested') {
    // La tarea se crea por la misma ruta que la petición pública.
    billTask(c, get(c, 'tableSessions', s.id))
  }
  return { ok: true, status: d.status, totalCents: core.sessionTotals(lines).totalCents }
}
import { task } from './service'
export function billTask(c: Context, s: core.TableSessionWithId) {
  return task(c, { type: 'bill_request', sessionId: s.id, takeawayId: null, tableIds: s.tableIds, label: s.label })
}
export function editarMesa(c: Context, d: Input<'editarMesa'>) {
  const s = get(c, 'tableSessions', d.sessionId)
  if (!core.sessionIsOpen(s.status)) fail('La mesa ya está cerrada.')
  if (d.guests !== undefined) validateTables(c, s.tableIds, d.guests, [s.id], s.reservationId ? [s.reservationId] : [])
  c.put('tableSessions', { ...s, guests: d.guests ?? s.guests, notes: d.notes ?? s.notes, ...(d.waiterUid !== undefined ? waiter(c, d.waiterUid) : {}) })
  return { ok: true }
}
function relocate(c: Context, sessionId: string, targetId: string, label: string, tableIds: string[], lineIds?: string[]) {
  for (const l of c.rows.orderLines.values()) if (l.sessionId === sessionId && (!lineIds || lineIds.includes(l.id))) c.put('orderLines', { ...l, sessionId: targetId, label })
  for (const t of c.rows.floorTasks.values()) if (t.sessionId === sessionId && core.taskIsActive(t.status)) {
    if (lineIds && t.lineIds.length && !t.lineIds.some(id => lineIds.includes(id))) continue
    if (lineIds && !t.lineIds.length) { c.put('floorTasks', { ...t, tableIds: get(c, 'tableSessions', sessionId).tableIds, label: get(c, 'tableSessions', sessionId).label }); continue }
    const key = core.taskDedupeKey(t.type, { sessionId: targetId, orderId: t.orderId, stationId: t.stationId })
    const remaining = lineIds ? t.lineIds.filter(id => !lineIds.includes(id)) : []
    if (remaining.length) {
      const source = get(c, 'tableSessions', sessionId)
      c.put('floorTasks', { ...t, lineIds: remaining, tableIds: source.tableIds, label: source.label })
      const nextId = newId(c, 'floorTasks')
      c.put('floorTasks', { ...t, id: nextId, sessionId: targetId, label, tableIds, lineIds: t.lineIds.filter(id => lineIds!.includes(id)), dedupeKey: key }, true)
      if (key) c.secret('taskKeys', core.sha256Hex(key), { taskId: nextId })
      continue
    }
    if (t.dedupeKey && t.dedupeKey !== key) {
      const oldKey = core.sha256Hex(t.dedupeKey)
      if (c.privateRows.taskKeys.get(oldKey)?.taskId === t.id) c.secret('taskKeys', oldKey, { taskId: null, readyVersions: {} })
    }
    const otherIndex = key ? c.privateRows.taskKeys.get(core.sha256Hex(key)) : undefined
    const other = otherIndex ? c.rows.floorTasks.get(otherIndex.taskId) : undefined
    if (other && other.id !== t.id && core.taskIsActive(other.status)) {
      c.put('floorTasks', { ...other, lineIds: [...new Set([...other.lineIds, ...t.lineIds])], count: other.count + t.count, dueAt: Math.min(other.dueAt, t.dueAt) })
      closeTask(c, t, 'cancelled')
    } else {
      c.put('floorTasks', { ...t, sessionId: targetId, label, tableIds, dedupeKey: key })
      if (key) c.secret('taskKeys', core.sha256Hex(key), { taskId: t.id })
    }
  }
}
export function moverMesa(c: Context, d: Input<'moverMesa'>) {
  const s = get(c, 'tableSessions', d.sessionId)
  const p = plan(core.planMove(s, d.tableIds, tables(c), occupancy(c)))
  validateTables(c, p.tableIds, s.guests, [s.id], s.reservationId ? [s.reservationId] : [])
  c.put('tableSessions', { ...s, tableIds: p.tableIds, label: p.label })
  relocate(c, s.id, s.id, p.label, p.tableIds)
  return { ok: true, tableIds: p.tableIds, label: p.label }
}
export function juntarMesas(c: Context, d: Input<'juntarMesas'>) {
  const s = get(c, 'tableSessions', d.sessionId)
  const p = plan(core.planJoin(s, d.tableIds, [...c.rows.tableSessions.values()], tables(c), occupancy(c)))
  const sources = p.mergedSessionIds.map(id => get(c, 'tableSessions', id))
  validateTables(c, p.tableIds, p.guests, [s.id, ...p.mergedSessionIds], [s, ...sources].flatMap(s => s.reservationId ? [s.reservationId] : []))
  c.put('tableSessions', { ...s, tableIds: p.tableIds, label: p.label, guests: p.guests })
  relocate(c, s.id, s.id, p.label, p.tableIds)
  for (const source of sources) {
    c.put('tableSessions', { ...source, mergedInto: s.id })
    sessionStatus(c, get(c, 'tableSessions', source.id), 'merged')
    relocate(c, source.id, s.id, p.label, p.tableIds)
  }
  return p
}
export function separarMesas(c: Context, d: Input<'separarMesas'>) {
  const s = get(c, 'tableSessions', d.sessionId), lines = destinationLines(c, s.id, null)
  if (lines.some(l => l.status === 'pending')) fail('Decide los pedidos pendientes antes de separar.')
  const p = plan(core.planSplit(s, d.tableIds, d.lineIds, lines, tables(c)))
  let newSessionId: string | null = null
  if (p.createsSession) {
    const guests = d.guests
    if (!guests || guests >= s.guests) fail('Indica los comensales de cada grupo sin dejar ninguno vacío.')
    validateTables(c, p.splitTableIds, guests!, [s.id], s.reservationId ? [s.reservationId] : [])
    validateTables(c, p.keepTableIds, s.guests - guests!, [s.id], s.reservationId ? [s.reservationId] : [])
    const next = freshSession(c, { tableIds: p.splitTableIds, guests: guests!, customerId: s.customerId, guestName: s.guestName, reservationId: null }, s.waiterUid, s.notes)
    newSessionId = next.id
    c.put('tableSessions', { ...s, tableIds: p.keepTableIds, label: p.keepLabel, guests: s.guests - guests! })
    relocate(c, s.id, next.id, p.splitLabel, p.splitTableIds, p.movedLineIds)
  } else {
    validateTables(c, p.keepTableIds, s.guests, [s.id], s.reservationId ? [s.reservationId] : [])
    c.put('tableSessions', { ...s, tableIds: p.keepTableIds, label: p.keepLabel })
  }
  relocate(c, s.id, s.id, p.keepLabel, p.keepTableIds)
  return { ok: true, newSessionId, keepTableIds: p.keepTableIds, splitTableIds: p.splitTableIds }
}

/** Devuelve escrituras diferidas: reservas aún debe leer los mensajes antes de escribir. */
export async function prepareSeatReservation(tx: Transaction, rid: string, lid: string, id: string, request: CallableRequest<unknown>) {
  const c = await context(tx, rid, lid, request, 'abrirMesa')
  // Reservas escribe y anuncia el cambio de estado de esa reserva: aquí no se repite.
  c.flags.announcedElsewhere.add(id)
  openReservation(c, id, undefined, '', false)
  return () => { reconcile(c); c.flush('tableSession.opened', 'Mesa abierta al sentar una reserva.') }
}

/** Cerrar desde Reservas conserva los requisitos de servicio y de caja de la sesión. */
export async function prepareFinishReservation(tx: Transaction, rid: string, lid: string, reservationId: string, request: CallableRequest<unknown>) {
  const c = await context(tx,rid,lid,request,'cambiarEstadoMesa')
  c.flags.announcedElsewhere.add(reservationId)
  const index = c.privateRows.reservationSessions.get(reservationId)
  if (!index) return null
  let session = get(c,'tableSessions',index.sessionId)
  const seen = new Set<string>()
  while (session.mergedInto) {
    if (seen.has(session.id)) fail('Las sesiones juntadas requieren revisión.')
    seen.add(session.id); session = get(c,'tableSessions',session.mergedInto)
  }
  if (session.status !== 'closed') cambiarEstadoMesa(c,{ restaurantId:rid,locationId:lid,sessionId:session.id,status:'closed',reason:null })
  return () => { reconcile(c); c.flush('tableSession.statusChanged','Mesa cerrada al terminar la reserva.') }
}

/** Las reservas sentadas no eluden el bloqueo de caja al cambiar las mesas asignadas. */
export async function checkReservationPosLock(tx: Transaction, rid: string, lid: string, reservationId: string) {
  const c = await context(tx,rid,lid)
  const index = c.privateRows.reservationSessions.get(reservationId)
  if (!index) return
  const session = get(c,'tableSessions',index.sessionId)
  const billId = c.posTargets.get(core.sha256Hex(JSON.stringify(['session',session.mergedInto ?? session.id])))
  const bill = billId ? c.posBills.get(billId) : null
  if (bill && !['open','cancelled'].includes(bill.status)) fail('La cuenta de esta reserva está bloqueada o saldada. No se pueden cambiar sus mesas.')
}
