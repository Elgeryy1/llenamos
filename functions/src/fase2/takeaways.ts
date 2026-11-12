import type { Input } from './context'
import { randomBytes } from 'node:crypto'
import { HttpsError } from 'firebase-functions/v2/https'
import * as core from '@llenamos/core'
import { type Context, get, fail, newId, requireFloor, publicMenu, checkLine } from './context'
import { customer, destinationLines, takeawayStatus, lineStatus, closeTask } from './service'
import { placeOrder, decide } from './orders'
import { publicLines, tokenMatches } from './public'

function slots(c: Context, date: string, staff = false) {
  const today = core.horaLocal(c.now, c.reservationSettings.timezone).fecha
  if (!staff && (date < today || date > core.sumarDias(today, c.reservationSettings.maxAdvanceDays))) return []
  const counts: Record<number, number> = {}
  for (const t of c.rows.takeaways.values()) if (t.status !== 'cancelled') counts[t.pickupAt] = (counts[t.pickupAt] ?? 0) + 1
  return core.pickupSlots(core.settingsToConfiguracion(c.reservationSettings), c.settings.takeaway, date, c.now, counts, staff)
}
export function consultarRecogida(c: Context, d: Input<'consultarRecogida'>) {
  const enabled = core.hasModule(c.restaurant, 'floor') && c.settings.takeaway.enabled && c.settings.takeaway.publicOrdering
  return { date: d.date, timezone: c.reservationSettings.timezone, enabled, slots: enabled ? slots(c, d.date) : [] }
}
type TakeInput = Input<'crearParaLlevar'> | Input<'pedirParaLlevar'>
export function createTakeaway(c: Context, d: TakeInput, staff: boolean) {
  requireFloor(c)
  if (!c.settings.takeaway.enabled || (!staff && !c.settings.takeaway.publicOrdering)) fail('Los pedidos para llevar están desactivados.')
  const slot = core.findPickupSlot(slots(c, d.date, staff), d.time)
  if (!slot) fail('La hora de recogida ya no está disponible.')
  const catalog = staff ? { items: Object.fromEntries(c.rows.menuItems), dailyMenus: Object.fromEntries(c.rows.dailyMenus) } : core.publicMenuCatalog(publicMenu(c))
  const priced = core.priceOrder(d.lines, catalog, { channel: 'takeaway', now: slot!.startAt, timezone: c.reservationSettings.timezone, expectedTotalCents: 'expectedTotalCents' in d ? d.expectedTotalCents : null })
  if (!priced.ok) return { status: 'rejected' as const, problems: priced.problems, totalCents: priced.totalCents }
  const slotKey = core.sha256Hex(JSON.stringify(['takeaway', slot!.startAt]))
  // El bloqueo de servicio y el de reservas se actualizan junto con la capacidad.
  const oldLock = c.privateRows.serviceLocks.get(slotKey)
  c.secret('serviceLocks', slotKey, { revision: Number(oldLock?.revision ?? 0) + 1 })
  const reference = core.reservationReference(randomBytes(16)), manageToken = core.linkToken(randomBytes(32))
  if (c.takeawayReferences.has(reference)) throw new HttpsError('aborted', 'Repite la operación para obtener otra referencia.')
  const takeawayId = newId(c, 'takeaways'), status = staff || c.settings.takeaway.autoAccept ? 'accepted' : 'pending'
  const t: core.Takeaway & { id: string } = { id: takeawayId, guestName: d.guestName, phone: d.phone, email: d.email,
    language: d.language, customerId: customer(c, d.guestName, d.phone, d.email, d.language), pickupAt: slot!.startAt,
    status, reference, manageTokenHash: core.sha256Hex(manageToken), source: 'source' in d ? d.source : 'web', notes: d.notes,
    totalCents: priced.totalCents, orderIds: [], readyAt: null, pickedUpAt: null, cancelReason: null, history: [], createdBy: c.uid }
  c.secret('takeawaySecrets', takeawayId, { tokenSecret: manageToken })
  c.put('takeaways', t, true)
  c.takeawayReferences.set(reference, { locationId: c.lid, takeawayId })
  c.stage(`${c.root.path}/takeawayReferences/${reference}`, { locationId: c.lid, takeawayId }, true)
  const result = placeOrder(c, { sessionId: null, takeawayId, lines: d.lines, fire: 'fire' in d ? d.fire : 'auto', note: '',
    expectedTotalCents: priced.totalCents, source: staff ? 'staff' : 'takeaway_web', language: d.language, pending: status === 'pending' })
  if (result.status === 'rejected') fail('La carta ha cambiado. Revisa el pedido.')
  return { status, takeawayId, orderId: result.status === 'sent' ? result.orderId : '', reference, manageToken, pickupAt: slot!.startAt, totalCents: priced.totalCents }
}
export function crearParaLlevar(c: Context, d: Input<'crearParaLlevar'>) { return createTakeaway(c, d, true) }
export function pedirParaLlevar(c: Context, d: Input<'pedirParaLlevar'>) { return createTakeaway(c, d, false) }
export function verParaLlevarPublico(c: Context, d: Input<'verParaLlevarPublico'>) {
  requireFloor(c)
  const ref = c.takeawayReferences.get(d.reference)
  const t = ref?.locationId === c.lid ? c.rows.takeaways.get(ref.takeawayId) : undefined
  if (!t || !tokenMatches(t.manageTokenHash, d.token)) throw new HttpsError('permission-denied', 'El enlace de seguimiento no es válido.')
  return { notifications: [...c.messages.values()].filter(m => m.takeawayId === t.id).map(m => ({ channel: m.channel, template: m.template, status: m.status })), reference: t.reference, status: t.status, guestName: t.guestName, pickupAt: t.pickupAt,
    timezone: c.reservationSettings.timezone, locationName: c.location.name, totalCents: t.totalCents, lines: publicLines(destinationLines(c, null, t.id)) }
}
export function cambiarEstadoParaLlevar(c: Context, d: Input<'cambiarEstadoParaLlevar'>) {
  const t = get(c, 'takeaways', d.takeawayId)
  if (t.status === d.status) return { ok: true, status: t.status }
  if (!core.canTakeawayTransition(t.status, d.status)) fail('El pedido no admite ese cambio de estado.')
  const lines = destinationLines(c, null, t.id).filter(l => l.kind !== 'menu')
  if (d.status === 'accepted' && t.status === 'pending') {
    for (const id of t.orderIds) if (get(c, 'orders', id).status === 'pending_approval') decide(c, id, 'accept', null, 'auto')
  } else if (d.status === 'accepted' && t.status === 'ready') {
    fail('Deshaz el estado de los platos para volver a preparación.')
  } else if (d.status === 'ready' || d.status === 'picked_up') {
    if (!lines.length || lines.filter(l => l.status !== 'cancelled').some(l => l.status !== 'ready' && l.status !== 'served')) fail('Todavía quedan platos por preparar.')
    if (d.status === 'picked_up') for (const l of lines) if (l.status === 'ready') lineStatus(c, l, 'served')
  } else if (d.status === 'cancelled') {
    if (!d.reason?.trim()) fail('Indica el motivo de la cancelación.')
    for (const l of lines) if (l.status !== 'cancelled' && l.status !== 'pending') checkLine(c, l, 'cancelled', d.reason)
    for (const l of lines) if (l.status !== 'cancelled') lineStatus(c, l, 'cancelled', d.reason)
    for (const id of t.orderIds) {
      const o = get(c, 'orders', id)
      if (o.status === 'pending_approval') c.put('orders', { ...o, status: 'rejected', decidedAt: c.now, decidedBy: c.uid, rejectReason: d.reason ?? null })
    }
  }
  takeawayStatus(c, t, d.status, d.reason ?? null)
  if (d.status === 'picked_up' || d.status === 'cancelled') for (const task of c.rows.floorTasks.values()) if (task.takeawayId === t.id) closeTask(c, task, 'cancelled')
  return { ok: true, status: d.status }
}
