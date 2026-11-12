import type { Input } from './context'
import * as core from '@llenamos/core'
import { type Context, get, fail, checkLine, newId, publicMenu } from './context'
import { destination, destinationLines, lineStatus, sessionStatus, closeTask, task, reconcile } from './service'

export interface OrderInput {
  sessionId: string | null; takeawayId: string | null; lines: core.OrderLineInput[];
  fire: core.FireMode; note: string; expectedTotalCents?: number | null;
  expectedPrices?: string; source: core.OrderSource; language: core.Language; pending: boolean
}
export function placeOrder(c: Context, d: OrderInput) {
  const dest = destination(c, d.sessionId, d.takeawayId)
  const takeaway = d.takeawayId ? get(c, 'takeaways', d.takeawayId) : null
  if (takeaway && d.source === 'staff' && !['accepted', 'ready'].includes(takeaway.status)) fail('Acepta primero el pedido para llevar.')
  if (takeaway && takeaway.orderIds.length >= 20) fail('Este pedido ya tiene el máximo de envíos.')
  const catalog = d.source === 'staff' ? { items: Object.fromEntries(c.rows.menuItems), dailyMenus: Object.fromEntries(c.rows.dailyMenus) } : core.publicMenuCatalog(publicMenu(c))
  const priced = core.priceOrder(d.lines, catalog, { channel: takeaway ? 'takeaway' : d.source === 'staff' ? 'staff' : 'table', now: takeaway?.pickupAt ?? c.now, timezone: c.reservationSettings.timezone, expectedTotalCents: d.expectedTotalCents })
  if (priced.ok && d.expectedPrices && d.expectedPrices !== core.orderPriceSignature(priced.lines)) return { status: 'rejected' as const, problems: [{ line: null, selection: null, code: 'price_changed' as const, ref: null }], totalCents: priced.totalCents }
  if (!priced.ok) return { status: 'rejected' as const, problems: priced.problems, totalCents: priced.totalCents }
  const kitchen = core.hasModule(c.restaurant, 'kitchen')
  const settings = kitchen ? c.settings : { ...c.settings, defaultStationId: null }
  const drafts = core.planOrderLines(priced.lines, Object.fromEntries(c.rows.menuItems), kitchen ? Object.fromEntries(c.rows.stations) : {}, settings, Object.fromEntries(c.rows.dailyMenus))
  // Se descuentan también menús y pendientes de aprobación; nunca se repone al anular.
  // Se valida el conjunto antes de modificar ningún plato.
  const consumption = new Map<string, { total: number; variants: Record<string, number> }>()
  for (const draft of drafts) if (draft.itemId) {
    const use = consumption.get(draft.itemId) ?? { total: 0, variants: Object.create(null) as Record<string, number> }
    use.total += draft.quantity
    if (draft.variant) use.variants[draft.variant.id] = (use.variants[draft.variant.id] ?? 0) + draft.quantity
    consumption.set(draft.itemId, use)
  }
  const today = core.horaLocal(c.now, c.reservationSettings.timezone).fecha
  for (const [id, use] of consumption) {
    const stock = get(c, 'menuItems', id).portions
    if (stock && (stock.date !== today || (stock.remaining !== null && use.total > stock.remaining) || Object.entries(use.variants).some(([v, n]) => Object.hasOwn(stock.variants, v) && n > stock.variants[v]!))) {
      return { status: 'rejected' as const, problems: [{ line: null, selection: null, code: 'item_sold_out' as const, ref: id }], totalCents: priced.totalCents }
    }
  }
  for (const [id, use] of consumption) {
    const item = get(c, 'menuItems', id), stock = item.portions
    if (!stock) continue
    const remaining = stock.remaining === null ? null : stock.remaining - use.total
    const variants = { ...stock.variants }
    for (const [v, n] of Object.entries(use.variants)) if (Object.hasOwn(variants, v)) variants[v]! -= n
    c.put('menuItems', { ...item, portions: { ...stock, remaining, variants }, soldOut: item.soldOut || remaining === 0 })
  }
  let orderId = newId(c, 'orders')
  while ([...c.rows.orders.keys()].some(id => id.slice(0, 6).toUpperCase() === orderId.slice(0, 6).toUpperCase())) orderId = newId(c, 'orders')
  const ids = Object.fromEntries(drafts.map(l => [l.key, newId(c, 'orderLines')]))
  const existing = destinationLines(c, d.sessionId, d.takeawayId)
  const takeFiring = takeaway ? core.takeawayFiring(drafts, takeaway.pickupAt, c.settings.takeaway.prepLeadMinutes, c.now, d.fire) : null
  const statuses = takeFiring?.statuses ?? core.firingFor(drafts, existing, d.fire, c.settings.firing.mode)
  for (const draft of drafts) {
    const { key, parentKey, ...fields } = draft
    const status = d.pending ? 'pending' : statuses[key]!
    const line: core.OrderLine & { id: string } = { ...fields, id: ids[key]!, parentLineId: parentKey ? ids[parentKey]! : null,
      ticket: { reference: orderId.slice(0, 6).toUpperCase(), source: d.source, note: [d.note, takeaway?.notes].filter((v, i, all) => v && all.indexOf(v) === i).join("\n"),
        pickupAt: takeaway?.pickupAt ?? null, pickupReference: takeaway?.reference ?? null, guestName: takeaway?.guestName ?? null },
      orderId, sessionId: d.sessionId, takeawayId: d.takeawayId, label: dest.label, status,
      placedAt: c.now, fireAt: takeFiring?.fireAt ?? null, firedAt: status === 'fired' ? c.now : null,
      startedAt: null, readyAt: null, servedAt: null, cancelReason: null, history: [], createdBy: c.uid }
    c.put('orderLines', line, true)
  }
  const lineIds = drafts.filter(l => l.parentKey === null).map(l => ids[l.key]!)
  c.put('orders', { id: orderId, sessionId: d.sessionId, takeawayId: d.takeawayId, source: d.source,
    status: d.pending ? 'pending_approval' : 'accepted', lineIds, totalCents: priced.totalCents, note: d.note, language: d.language,
    fire: d.fire, placedAt: c.now, createdBy: c.uid, decidedBy: d.pending ? null : c.uid, decidedAt: d.pending ? null : c.now, rejectReason: null }, true)
  if (d.sessionId) {
    const s = get(c, 'tableSessions', d.sessionId)
    if (s.status === 'bill_requested') sessionStatus(c, s, 'open')
    for (const t of c.rows.floorTasks.values()) if (t.sessionId === s.id && t.type === 'bill_request') closeTask(c, t, 'cancelled')
  }
  if (takeaway) c.put('takeaways', { ...takeaway, orderIds: [...takeaway.orderIds, orderId] })
  if (d.pending) task(c, { ...dest, type: 'approve_order', sessionId: d.sessionId, takeawayId: d.takeawayId, orderId })
  reconcile(c)
  return { status: 'sent' as const, orderId, lineIds, totalCents: priced.totalCents,
    sessionTotalCents: core.sessionTotals(destinationLines(c, d.sessionId, d.takeawayId)).totalCents,
    fired: drafts.filter(l => l.kind !== 'menu' && !d.pending && statuses[l.key] === 'fired').length,
    held: drafts.filter(l => l.kind !== 'menu' && !d.pending && statuses[l.key] === 'held').length }
}
export function sessionSignature(s: core.TableSession & { id: string }) {
  return JSON.stringify([s.id, [...s.tableIds].sort(), s.openedAt, s.customerId, s.guests, s.status])
}
export function orderingHours(c: Context) {
  return core.tableOrderingAllowed(c.settings, c.reservationSettings, c.now)
}
export function checkDestination(c: Context, sessionId: string | null, expected?: string) {
  if (sessionId && expected && sessionSignature(get(c, 'tableSessions', sessionId)) !== expected) fail('La mesa ha cambiado. Revisa el destino antes de enviar.')
  if (sessionId && !orderingHours(c)) fail('El local está fuera de horario y no admite nuevos pedidos en mesas abiertas.')
}
export function enviarPedido(c: Context, d: Input<'enviarPedido'>) {
  checkDestination(c, d.sessionId, d.expectedDestination)
  return placeOrder(c, { ...d, source: 'staff', language: 'es', pending: false })
}
export function decide(c: Context, orderId: string, decision: 'accept' | 'reject', reason: string | null, fire: core.FireMode) {
  const order = get(c, 'orders', orderId)
  if (order.status !== 'pending_approval') fail('Este pedido ya se ha decidido.')
  destination(c, order.sessionId, order.takeawayId)
  if (decision === 'reject' && !reason?.trim()) fail('Indica el motivo del rechazo.')
  const own = [...c.rows.orderLines.values()].filter(l => l.orderId === orderId)
  if (!own.length || own.some(l => l.status !== 'pending')) fail('El pedido pendiente ha cambiado. Vuelve a consultarlo.')
  const take = order.takeawayId ? get(c, 'takeaways', order.takeawayId) : null
  const drafts = own.map(l => ({ ...l, key: l.id, parentKey: l.parentLineId }))
  const effectiveFire = order.source === 'table' ? 'all' : fire
  const statuses = take ? core.takeawayFiring(drafts, take.pickupAt, c.settings.takeaway.prepLeadMinutes, c.now, fire).statuses
    : core.firingFor(drafts, destinationLines(c, order.sessionId, null).filter(l => l.orderId !== order.id), effectiveFire, c.settings.firing.mode)
  let fired = 0, held = 0
  for (const l of own) {
    const status = decision === 'reject' ? 'cancelled' : statuses[l.id]!
    if (l.kind !== 'menu') { if (status === 'fired') fired++; if (status === 'held') held++ }
    lineStatus(c, l, status, reason)
  }
  const status = decision === 'reject' ? 'rejected' : 'accepted'
  c.put('orders', { ...order, status, decidedAt: c.now, decidedBy: c.uid, rejectReason: decision === 'reject' ? reason : null, fire: effectiveFire })
  for (const t of c.rows.floorTasks.values()) if (t.orderId === orderId && t.type === 'approve_order') closeTask(c, t)
  return { ok: true, status, fired, held }
}
export function decidirPedido(c: Context, d: Input<'decidirPedido'>) {
  const order = get(c, 'orders', d.orderId)
  const result = decide(c, d.orderId, d.decision, d.reason ?? null, d.fire)
  if (order.takeawayId && d.decision === 'accept') {
    const take = get(c, 'takeaways', order.takeawayId)
    if (take.status === 'pending') {
      c.put('takeaways', { ...take, status: 'accepted', history: [...take.history, { from: 'pending', to: 'accepted', at: c.now, by: c.uid, reason: null }] })
    }
  }
  return result
}
export function marcharPase(c: Context, d: Input<'marcharPase'>) {
  destination(c, d.sessionId, d.takeawayId)
  if (d.takeawayId && get(c, 'takeaways', d.takeawayId).status === 'pending') fail('Acepta primero el pedido para llevar.')
  const all = destinationLines(c, d.sessionId, d.takeawayId)
  const course = d.course ?? core.nextHeldCourse(all)
  const lines = core.linesToFire(all, d.course)
  for (const line of lines) lineStatus(c, line, 'fired')
  return { ok: true, course, lineIds: lines.map(l => l.id) }
}
export function cambiarEstadoLineas(c: Context, d: Input<'cambiarEstadoLineas'>) {
  const lines = d.lineIds.map(id => get(c, 'orderLines', id))
  for (const l of lines) { destination(c, l.sessionId, l.takeawayId); checkLine(c, l, d.status, d.reason ?? null) }
  for (const l of lines) lineStatus(c, l, d.status, d.reason ?? null)
  reconcile(c)
  const firedNext: string[] = []
  if (d.status === 'served') {
    const sessions = new Set(lines.map(l => l.sessionId).filter((id): id is string => !!id))
    for (const sessionId of sessions) for (const l of core.autoFireAfterServe(destinationLines(c, sessionId, null), c.settings)) {
      lineStatus(c, l, 'fired'); firedNext.push(l.id)
    }
  }
  return { ok: true, lines: d.lineIds.map(id => ({ id, status: get(c, 'orderLines', id).status })), firedNext }
}
