import { timingSafeEqual } from 'node:crypto'
import * as core from '@llenamos/core'
import { ApiError } from '../../errors.js'
import { type Context, type Input, get, fail, requireFloor } from './context.js'
import { destinationLines, task, sessionStatus } from './service.js'
import { placeOrder, sessionSignature, orderingHours, checkDestination } from './orders.js'
import { billTask } from './sessions.js'
export function tokenMatches(hash: unknown, token: string) {
  const actual = core.sha256Hex(token)
  return typeof hash === 'string' && hash.length === actual.length && timingSafeEqual(Buffer.from(hash), Buffer.from(actual))
}
export function tableLink(c: Context, d: { tableId: string; token: string }) {
  const table = get(c, 'tables', d.tableId)
  if (!table.enabled || !tokenMatches(c.privateRows.tableTokens.get(d.tableId)?.tokenHash, d.token)) throw new ApiError(403, 'permission-denied', 'El enlace de esta mesa no es válido.')
  return table
}
export function requireReplayLink(c: Context, d: { tableId: string; token: string }) { requireFloor(c); return tableLink(c, d) }
export function currentSession(c: Context, tableId: string, sessionId?: string | null) {
  const sessions = [...c.rows.tableSessions.values()].filter(s => core.sessionIsOpen(s.status) && s.tableIds.includes(tableId))
  if (sessions.length > 1) fail('Hay más de una sesión en esta mesa. Avisa al encargado.')
  const session = sessions[0] ?? null
  if (sessionId && session?.id !== sessionId) fail('La mesa ha cambiado. Vuelve a consultarla antes de pedir.')
  return session
}
export function publicLines(lines: readonly (core.OrderLine & { id: string })[]): core.PublicOrderLine[] {
  const fields = (l: core.OrderLine) => ({ name: l.name, variant: l.variant?.name ?? null, modifiers: l.modifiers.map(m => m.name), status: core.publicLineStatus(l.status) })
  return lines.filter(l => l.kind !== 'menu_component').map(l => {
    const children = lines.filter(c => c.parentLineId === l.id)
    return { id: l.id, kind: l.kind as 'item' | 'menu', ...fields(l), quantity: l.quantity,
      totalCents: l.totalCents + children.filter(c => c.status !== 'cancelled').reduce((n, c) => n + c.totalCents, 0), components: children.map(fields) }
  })
}
export function verMesaPublica(c: Context, d: Input<'verMesaPublica'>) {
  const table = tableLink(c, d), s = currentSession(c, table.id), enabled = core.hasModule(c.restaurant, 'floor')
  return { restaurantName: c.restaurant.name, locationName: c.location.name, tableName: table.name, publicMenuId: core.publicMenuId(c.rid, c.lid),
    canOrder: enabled && c.settings.selfOrder.enabled && !!s && orderingHours(c), destination: s ? sessionSignature(s) : undefined, requireApproval: c.settings.selfOrder.requireApproval,
    canViewPayment: enabled && core.hasModule(c.restaurant, 'pos') && !!s,
    callWaiter: enabled && c.settings.selfOrder.callWaiter, requestBill: enabled && c.settings.selfOrder.requestBill,
    session: s ? { sessionId: s.id, status: s.status, guests: s.guests, totalCents: s.totalCents, lines: publicLines(destinationLines(c, s.id, null)) } : null }
}
export function pedirDesdeMesa(c: Context, d: Input<'pedirDesdeMesa'>) {
  requireFloor(c); tableLink(c, d)
  checkDestination(c, d.sessionId, d.expectedDestination)
  const s = currentSession(c, d.tableId, d.sessionId)
  if (!s || !c.settings.selfOrder.enabled) fail('Esta mesa no admite pedidos desde el enlace.')
  const result = placeOrder(c, { sessionId: s!.id, takeawayId: null, lines: d.lines, fire: 'all', note: d.note, expectedTotalCents: d.expectedTotalCents, expectedPrices: d.expectedPrices, source: 'table', language: d.language, pending: c.settings.selfOrder.requireApproval })
  return result.status === 'rejected' ? result : { status: c.settings.selfOrder.requireApproval ? 'pending_approval' : 'sent', orderId: result.orderId, totalCents: result.totalCents }
}
export function avisarDesdeMesa(c: Context, d: Input<'avisarDesdeMesa'>) {
  requireFloor(c); const table = tableLink(c, d), s = currentSession(c, table.id, d.sessionId)
  if (d.kind === 'request_bill') {
    if (!s || !d.sessionId || !c.settings.selfOrder.requestBill) fail('La cuenta necesita una mesa abierta y el aviso habilitado.')
    if (s!.status !== 'bill_requested') sessionStatus(c, s!, 'bill_requested')
    return { ok: true, taskId: billTask(c, get(c, 'tableSessions', s!.id)).id }
  }
  if (!c.settings.selfOrder.callWaiter) fail('El aviso al camarero está desactivado.')
  const t = task(c, { type: 'call_waiter', sessionId: s?.id ?? null, takeawayId: null, tableId: table.id, tableIds: s?.tableIds ?? [table.id], label: s?.label ?? table.name })
  const requests = [...(t.requests ?? []), { reason: d.reason ?? 'other', note: d.note }]
  // Se conservan motivos distintos, sin perder dueño ni plazo al repetir.
  const unique = requests.filter((r, i) => requests.findIndex(x => x.reason === r.reason && x.note === r.note) === i).slice(-10)
  c.put('floorTasks', { ...t, requests: unique })
  return { ok: true, taskId: t.id }
}
