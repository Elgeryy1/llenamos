import type { Input } from './context'
import * as core from '@llenamos/core'
import { type Context, get, fail } from './context'
import { task, destination, destinationLines, lineStatus, reconcile } from './service'

export function crearTarea(c: Context, d: Input<'crearTarea'>) {
  const dest = d.sessionId ? destination(c, d.sessionId, null) : { tableIds: d.tableIds, label: core.sessionLabel(d.tableIds, Object.fromEntries(c.rows.tables)) }
  for (const id of dest.tableIds) get(c, 'tables', id)
  const t = task(c, { type: 'custom', sessionId: d.sessionId, takeawayId: null, ...dest, note: d.note })
  if (d.claim) {
    const result = core.claimTask(t, c.uid!, c.actor!.displayName, c.now)
    if (result.ok) c.put('floorTasks', result.task)
  }
  return { taskId: t.id }
}
export function cambiarEstadoTarea(c: Context, d: Input<'cambiarEstadoTarea'>) {
  const t = get(c, 'floorTasks', d.taskId)
  if (t.purpose === 'fire_course' && ['done', 'cancel'].includes(d.action) && destinationLines(c, t.sessionId, null).some(l => l.kind !== 'menu' && l.status === 'held')) fail('Marcha o anula los platos retenidos antes de cerrar esta tarea.')
  if (d.action === 'done' && t.type === 'pickup' && d.expectedLineIds && JSON.stringify([...t.lineIds].sort()) !== JSON.stringify([...d.expectedLineIds].sort())) fail('Han llegado otros platos a esta tarea. Revisa la bandeja antes de confirmar la recogida.')
  if (d.action === 'done' && t.type === 'approve_order' && t.orderId && get(c, 'orders', t.orderId).status === 'pending_approval') fail('Decide el pedido antes de completar su tarea.')
  const result = d.action === 'claim' ? core.claimTask(t, c.uid!, c.actor!.displayName, c.now)
    : d.action === 'release' ? core.releaseTask(t, c.uid!, ['owner', 'manager'].includes(c.actor!.role))
    : d.action === 'done' ? core.completeTask(t, c.uid!, c.now) : core.cancelTask(t, c.uid!, c.now)
  if (!result.ok) {
    if (result.reason === 'taken') return { result: 'taken', claimedBy: result.claimedBy, claimedByName: result.claimedByName }
    fail(result.reason === 'not_owner' ? 'Solo el responsable o un encargado puede soltar esta tarea.' : 'Esta tarea ya está cerrada.')
  }
  if (result.ok) {
    c.put('floorTasks', result.task)
    if (d.action === 'done' && t.type === 'pickup') {
      destination(c, t.sessionId, t.takeawayId)
      const current = destinationLines(c, t.sessionId, t.takeawayId)
      for (const id of t.lineIds) {
        const l = current.find(l => l.id === id)
        if (l?.status === 'ready') lineStatus(c, l, 'served')
      }
      reconcile(c)
      if (t.sessionId) for (const l of core.autoFireAfterServe(destinationLines(c, t.sessionId, null), c.settings)) lineStatus(c, l, 'fired')
    }
    return { result: 'ok', status: result.task.status, claimedBy: result.task.claimedBy, claimedByName: result.task.claimedByName }
  }
  return fail('No se ha podido cambiar la tarea.')
}
