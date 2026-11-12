import type { PoolClient } from 'pg'
import * as core from '@llenamos/core'
import { reservationHooks } from '../reservas/staff.js'
import { failure } from '../reservas/scope.js'
import { reconcile } from './service.js'
import { staffContext } from './execute.js'
import { changeSessionStatus, openReservationSession } from './sessions.js'

/** Sesión de la reserva y, si se juntó, la sesión destino que la representa ahora. */
async function representingSession(client: PoolClient, rid: string, lid: string, reservationId: string) {
  let { rows } = await client.query<{ id: string; merged_into: string | null }>("SELECT id,merged_into FROM llenamos.sala_table_sessions WHERE restaurant_id=$1 AND location_id=$2 AND doc->>'reservationId'=$3 ORDER BY created_at LIMIT 1", [rid, lid, reservationId])
  const seen = new Set<string>()
  while (rows[0]?.merged_into && !seen.has(rows[0].id)) {
    seen.add(rows[0].id)
    rows = (await client.query<{ id: string; merged_into: string | null }>('SELECT id,merged_into FROM llenamos.sala_table_sessions WHERE restaurant_id=$1 AND location_id=$2 AND id=$3', [rid, lid, rows[0].merged_into])).rows
  }
  return rows[0]?.id ?? null
}

/**
 * Reservas llama a sala al sentar o terminar una reserva y antes de reasignar sus mesas. Todo en la misma transacción
 * (reservas ya tiene su bloqueo; sala toma el suyo después, como en el camino contrario).
 */
export function registerReservationHooks(): void {
  reservationHooks.onSeated = async (rc, r, uid) => {
    // Sin el módulo de sala o sin permiso de sala la reserva queda sentada y ocupa sus mesas; la sesión se abre desde sala.
    if (!core.hasModule(rc.tenant.restaurant, 'floor')) return
    const { c, actor } = await staffContext(rc.client, { restaurantId: rc.tenant.rid, locationId: rc.lid }, uid, { validatesTables: true, tableIds: r.tableIds })
    if (!core.can(actor.role, 'sala.gestionar')) return
    await openReservationSession(c, r, undefined, '', false)
    reconcile(c)
    await c.flush()
  }
  reservationHooks.onFinished = async (rc, r, uid) => {
    const id = await representingSession(rc.client, rc.tenant.rid, rc.lid, r.id)
    if (!id) return
    const { c } = await staffContext(rc.client, { restaurantId: rc.tenant.rid, locationId: rc.lid }, uid, { focus: { sessionIds: [id] }, validatesTables: true })
    const session = c.rows.tableSessions.get(id)
    if (!session || !core.sessionIsOpen(session.status)) return
    // `true`: si la mesa representa a otras reservas juntadas en ella, también se terminan (solo las que siguen sentadas).
    // Cerrar desde reservas conserva los requisitos de servicio y de caja de la mesa.
    await changeSessionStatus(c, { sessionId: id, status: 'closed', reason: null }, true)
    reconcile(c)
    await c.flush()
  }
  reservationHooks.assertAssignable = async (rc, r) => {
    const id = await representingSession(rc.client, rc.tenant.rid, rc.lid, r.id)
    if (!id) return
    const bill = (await rc.client.query<{ status: string }>("SELECT status FROM llenamos.pos_bills WHERE restaurant_id=$1 AND location_id=$2 AND target_kind='session' AND target_id=$3", [rc.tenant.rid, rc.lid, id])).rows[0]
    if (bill && !['open', 'cancelled'].includes(bill.status)) failure('La cuenta de esta reserva está bloqueada o saldada. No se pueden cambiar sus mesas.')
  }
}
