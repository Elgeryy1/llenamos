import * as core from '@llenamos/core'
import { type Context, denied, fail, missing, permission } from './context.js'
import { changeStatus, lockedReservation } from '../reservas/bookings.js'
import { loadContext as loadReservations } from '../reservas/engine.js'
import { staffTenant } from '../reservas/staff.js'
import { readReservation } from '../reservas/store.js'

/**
 * Puente de sala hacia reservas, dentro de la misma transacción y con el orden de bloqueos único (reservas y luego sala:
 * `loadContext` de sala ya tomó los dos). Sentar o terminar una reserva la cambia por la ruta de reservas, que además
 * deja el origen, la ficha del cliente, los avisos y el evento de plataforma.
 */
async function reservationsContext(c: Context, startAt: number) {
  if (!c.uid) return denied()
  const tenant = await staffTenant(c.client, c.uid, c.rid, c.lid, 'reservas.gestionar')
  return loadReservations(c.client, tenant, c.lid, [startAt], { now: c.now })
}
function requireReservations(c: Context) {
  if (!permission(c, 'reservas.gestionar')) denied()
  if (!core.hasModule(c.restaurant, 'reservations')) fail('El módulo de reservas está desactivado.')
}
/** La reserva (sin bloquearla) para validar las mesas antes de sentarla. */
export async function reservationFor(c: Context, id: string): Promise<core.ReservationWithId> {
  requireReservations(c)
  return (await readReservation(c.client, c.rid, c.lid, id)) ?? missing()
}
/** Pasa la reserva a sentada (si no lo estaba) por la ruta de reservas; valida transición y capacidad. */
export async function seatReservation(c: Context, id: string): Promise<{ reservation: core.ReservationWithId; changed: boolean }> {
  const current = await reservationFor(c, id)
  const rc = await reservationsContext(c, current.startAt)
  const locked = await lockedReservation(rc, id)
  if (locked.status === 'seated') return { reservation: locked, changed: false }
  const next = await changeStatus(rc, locked, 'seated', c.uid, null)
  return { reservation: { ...next, id }, changed: true }
}
/** Termina las reservas sentadas que representan estas sesiones (al cerrar la mesa). */
export async function finishReservations(c: Context, reservationIds: readonly string[]): Promise<void> {
  const seated: core.ReservationWithId[] = []
  for (const id of new Set(reservationIds)) {
    const r = await readReservation(c.client, c.rid, c.lid, id)
    if (r?.status === 'seated') seated.push(r)
  }
  if (seated.length && (!permission(c, 'reservas.gestionar') || !core.hasModule(c.restaurant, 'reservations'))) denied()
  for (const r of seated) {
    const rc = await reservationsContext(c, r.startAt)
    await changeStatus(rc, await lockedReservation(rc, r.id), 'finished', c.uid, null)
  }
}
