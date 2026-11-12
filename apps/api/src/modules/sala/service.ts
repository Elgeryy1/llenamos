import * as core from '@llenamos/core'
import { type Context, type Row, fail, get, newId } from './context.js'

export const destinationLines = (c: Context, sessionId: string | null, takeawayId: string | null) => [...c.rows.orderLines.values()].filter(l => sessionId ? l.sessionId === sessionId : l.takeawayId === takeawayId)
export function destination(c: Context, sessionId: string | null, takeawayId: string | null) {
  if (sessionId) {
    const s = get(c, 'tableSessions', sessionId)
    if (!core.sessionIsOpen(s.status)) fail('La mesa ya no está abierta. Vuelve a consultarla.')
    return { label: s.label, tableIds: s.tableIds }
  }
  const t = get(c, 'takeaways', takeawayId!)
  if (!['pending', 'accepted', 'ready'].includes(t.status)) fail('El pedido para llevar ya está cerrado.')
  return { label: core.takeawayLabel(t.guestName, core.horaLocal(t.pickupAt, c.reservationSettings.timezone).hora), tableIds: [] }
}
/** El cliente se identifica por teléfono; su ficha se crea al guardar la operación (solo alta, nunca pisa la existente). */
export function customer(c: Context, name: string, phone: string, email: string | null = null, language: core.Language = 'es') {
  const id = core.customerIdFor(c.rid, phone)
  c.customerDrafts.set(id, { name, phone, email, language })
  return id
}
export function lineStatus(c: Context, line: Row<core.OrderLine>, status: core.LineStatus, reason: string | null = null) {
  if (line.status !== status) c.put('orderLines', core.applyLineStatus(line, status, c.now, c.uid, reason))
}
export function sessionStatus(c: Context, s: Row<core.TableSession>, status: core.TableSessionStatus, reason: string | null = null) {
  if (s.status === status) return
  c.put('tableSessions', { ...s, status,
    billRequestedAt: status === 'bill_requested' ? c.now : null,
    closedAt: status === 'closed' || status === 'cancelled' || status === 'merged' ? c.now : null,
    closedBy: status === 'closed' || status === 'cancelled' || status === 'merged' ? c.uid : null,
    history: [...s.history, { from: s.status, to: status, at: c.now, by: c.uid, reason }],
  })
}
export function takeawayStatus(c: Context, t: Row<core.Takeaway>, status: core.TakeawayStatus, reason: string | null = null) {
  if (t.status === status) return
  c.put('takeaways', { ...t, status, readyAt: status === 'ready' ? c.now : status === 'picked_up' ? t.readyAt : null,
    pickedUpAt: status === 'picked_up' ? c.now : null, cancelReason: status === 'cancelled' ? reason : t.cancelReason,
    history: [...t.history, { from: t.status, to: status, at: c.now, by: c.uid, reason }] })
}
export function closeTask(c: Context, task: Row<core.FloorTask>, status: 'done' | 'cancelled' = 'done') {
  if (core.taskIsActive(task.status)) c.put('floorTasks', { ...task, status, doneAt: c.now, doneBy: c.uid })
}
type TaskInput = Pick<core.FloorTask, 'type' | 'sessionId' | 'takeawayId' | 'tableIds' | 'label'> & Partial<Pick<core.FloorTask, 'orderId' | 'stationId' | 'lineIds' | 'note'>> & { tableId?: string }
export function task(c: Context, input: TaskInput) {
  const dedupeKey = core.taskDedupeKey(input.type, { ...input, tableId: input.tableId })
  const key = dedupeKey ? core.sha256Hex(dedupeKey) : null
  const index = key ? c.privateRows.taskKeys.get(key) : undefined
  const old = index ? c.rows.floorTasks.get(index.taskId) : undefined
  if (old && old.dedupeKey === dedupeKey && core.taskIsActive(old.status)) {
    const next = { ...old, tableIds: input.tableIds, label: input.label, count: old.count + 1, lineIds: [...new Set([...old.lineIds, ...input.lineIds ?? []])] }
    c.put('floorTasks', next)
    return next
  }
  const id = newId()
  const value: Row<core.FloorTask> = { id, type: input.type, status: 'open', sessionId: input.sessionId, takeawayId: input.takeawayId,
    tableIds: input.tableIds, label: input.label, orderId: input.orderId ?? null, stationId: input.stationId ?? null,
    lineIds: input.lineIds ?? [], note: input.note ?? '', dedupeKey, count: 1, openedAt: c.now, dueAt: core.taskDueAt(input.type, c.now, c.settings.targets),
    createdBy: c.uid, claimedBy: null, claimedByName: null, claimedAt: null, doneAt: null, doneBy: null }
  c.put('floorTasks', value, true)
  if (key) c.secret('taskKeys', key, { ...index, taskId: id, dest: input.sessionId ?? input.takeawayId ?? input.tableId ?? '' })
  return value
}

/** Mantiene padres, totales, tareas de recogida y aportaciones dentro de la operación original. */
export function reconcile(c: Context) {
  // Los tickets antiguos reciben los datos operativos en la siguiente reconciliación.
  for (const line of c.rows.orderLines.values()) if (!line.ticket) {
    const order = c.rows.orders.get(line.orderId), takeaway = line.takeawayId ? c.rows.takeaways.get(line.takeawayId) : null
    if (order) c.put('orderLines', { ...line, ticket: { reference: order.id.slice(0, 6).toUpperCase(), source: order.source,
      note: [order.note, takeaway?.notes].filter((v, i, all) => v && all.indexOf(v) === i).join("\n"),
      pickupAt: takeaway?.pickupAt ?? null, pickupReference: takeaway?.reference ?? null, guestName: takeaway?.guestName ?? null } })
  }
  for (const parent of c.rows.orderLines.values()) if (parent.kind === 'menu') {
    const children = [...c.rows.orderLines.values()].filter(l => l.parentLineId === parent.id)
    const status = core.menuLineStatus(children)
    if (parent.status !== status) lineStatus(c, parent, status)
  }
  for (const s of c.rows.tableSessions.values()) {
    const totals = core.sessionTotals(destinationLines(c, s.id, null))
    if (s.totalCents !== totals.totalCents || s.lineCount !== totals.lineCount || s.unservedCount !== totals.unservedCount) c.put('tableSessions', { ...s, ...totals })
  }
  for (const t of c.rows.takeaways.values()) {
    const lines = destinationLines(c, null, t.id)
    const totalCents = core.sessionTotals(lines).totalCents
    if (t.totalCents !== totalCents) c.put('takeaways', { ...t, totalCents })
    let current = get(c, 'takeaways', t.id)
    if (lines.length && !lines.some(l => l.kind !== 'menu' && l.status !== 'cancelled') && ['accepted', 'ready', 'pending'].includes(current.status)) {
      takeawayStatus(c, current, 'cancelled', 'Todos los platos están anulados.')
    } else {
      const status = core.takeawayStatusFromLines(current.status, lines)
      if (status !== current.status) takeawayStatus(c, current, status)
    }
    current = get(c, 'takeaways', t.id)
    if (current.status === 'picked_up' || current.status === 'cancelled') for (const task of c.rows.floorTasks.values()) if (task.takeawayId === t.id) closeTask(c, task, 'cancelled')
  }
  reconcileHeld(c)
  reconcilePickups(c)
}
export function reconcilePickups(c: Context) {
  const stations = Object.fromEntries(c.rows.stations)
  const destinations = [
    ...[...c.rows.tableSessions.values()].filter(s => core.sessionIsOpen(s.status)).map(s => ({ sessionId: s.id, takeawayId: null, tableIds: s.tableIds, label: s.label })),
    ...[...c.rows.takeaways.values()].filter(t => ['accepted', 'ready'].includes(t.status)).map(t => ({ sessionId: null, takeawayId: t.id, tableIds: [], label: core.takeawayLabel(t.guestName, core.horaLocal(t.pickupAt, c.reservationSettings.timezone).hora) })),
  ]
  const wanted = new Set<string>()
  for (const dest of destinations) {
    const lines = destinationLines(c, dest.sessionId, dest.takeawayId)
    for (const [stationId, lineIds] of Object.entries(core.readyForPickup(lines, stations))) {
      const dedupeKey = core.taskDedupeKey('pickup', { ...dest, stationId })!
      const key = core.sha256Hex(dedupeKey), index = c.privateRows.taskKeys.get(key)
      const existing = index ? c.rows.floorTasks.get(index.taskId) : undefined
      const readyVersions = Object.fromEntries(lineIds.map(id => [id, get(c, 'orderLines', id).readyAt]))
      wanted.add(dedupeKey)
      if (existing && existing.dedupeKey === dedupeKey && core.taskIsActive(existing.status)) {
        if (JSON.stringify(existing.lineIds) !== JSON.stringify(lineIds) || existing.label !== dest.label) c.put('floorTasks', { ...existing, ...dest, lineIds, count: existing.count + (lineIds.some(id => !existing.lineIds.includes(id)) ? 1 : 0) })
      } else if (lineIds.some(id => index?.readyVersions?.[id] !== readyVersions[id])) {
        task(c, { type: 'pickup', ...dest, stationId, lineIds })
      }
      const current = c.privateRows.taskKeys.get(key)
      if (current && JSON.stringify(current.readyVersions) !== JSON.stringify(readyVersions)) c.secret('taskKeys', key, { ...current, readyVersions, dest: dest.sessionId ?? dest.takeawayId ?? '' })
    }
  }
  for (const t of c.rows.floorTasks.values()) if (t.type === 'pickup' && t.dedupeKey && !wanted.has(t.dedupeKey)) closeTask(c, t)
}

/** Retener comida exige una tarea que no se puede cerrar sin marchar o anular sus platos. */
function reconcileHeld(c: Context) {
  for (const session of c.rows.tableSessions.values()) {
    const held = destinationLines(c, session.id, null).filter(l => l.kind !== 'menu' && l.status === 'held')
    const existing = [...c.rows.floorTasks.values()].find(t => t.sessionId === session.id && t.purpose === 'fire_course' && core.taskIsActive(t.status))
    if (!held.length || !core.sessionIsOpen(session.status)) {
      if (existing) closeTask(c, existing)
      continue
    }
    const note = `Marchar los pases retenidos. ${held.reduce((n, l) => n + l.quantity, 0)} platos esperan a sala. Revisar antes de preparar la cuenta.`
    if (existing) {
      if (existing.note !== note || existing.label !== session.label || JSON.stringify(existing.lineIds) !== JSON.stringify(held.map(l => l.id)))
        c.put('floorTasks', { ...existing, label: session.label, tableIds: session.tableIds, note, lineIds: held.map(l => l.id) })
    } else {
      const created = task(c, { type: 'custom', sessionId: session.id, takeawayId: null, label: session.label, tableIds: session.tableIds, lineIds: held.map(l => l.id), note })
      c.put('floorTasks', { ...created, purpose: 'fire_course' })
    }
  }
}
