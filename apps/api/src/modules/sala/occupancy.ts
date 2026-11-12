import * as core from '@llenamos/core'
import type { Context } from './context.js'
import { registerOccupancySource } from '../reservas/engine.js'

/** Una reserva absorbida sigue representada por la sesión destino; no ocupa su mesa antigua. */
export type SessionLite = Pick<core.TableSessionWithId, 'id' | 'status' | 'tableIds' | 'guests' | 'openedAt' | 'reservationId' | 'mergedInto'>
export function representedReservations(sessions: readonly SessionLite[]): Set<string> {
  const result = new Set<string>()
  for (const session of sessions) {
    let destination: SessionLite = session
    const seen = new Set<string>()
    while (destination.status === 'merged' && destination.mergedInto && !seen.has(destination.id)) {
      seen.add(destination.id)
      const next = sessions.find(s => s.id === destination.mergedInto)
      if (!next) break
      destination = next
    }
    if (session.reservationId && (core.sessionIsOpen(destination.status) || destination.status === 'closed')) result.add(session.reservationId)
  }
  return result
}
export function serviceOccupancy(reservations: readonly core.ReservationWithId[], sessions: readonly SessionLite[], settings: core.ReservationSettings, now: number): core.ReservaOcupacion[] {
  const represented = representedReservations(sessions), config = core.settingsToConfiguracion(settings)
  return [
    ...reservations.filter(r => !(r.status === 'seated' && represented.has(r.id))).map(r => core.reservationToOcupacion(r.id, r)),
    ...sessions.flatMap(s => {
      const occupied = core.sessionToOcupacion(s.id, s, core.duracionParaGrupo(config, s.guests))
      return occupied ? [occupied] : []
    }),
  ]
}
/** Ocupación de las mesas por las sesiones de sala abiertas (y sus duraciones previstas). */
export function sessionOccupancy(c: Context): core.ReservaOcupacion[] {
  return serviceOccupancy([], [...c.rows.tableSessions.values()], c.reservationSettings, c.now)
}
/**
 * Reservas que ocupan mesas ahora: pendientes, confirmadas y sentadas del local en una ventana acotada por fecha
 * (`loadContext`). Las sentadas que ya representa su sesión no se cuentan dos veces (`serviceOccupancy`).
 */
export function occupyingReservations(c: Context): core.ReservationWithId[] {
  // Sin cargarlas se ignorarían en silencio y se podría abrir una mesa reservada: la operación debe pedir `validatesTables`.
  if (!c.reservationsLoaded) throw new Error('La operación valida mesas sin haber cargado las reservas (LoadOptions.validatesTables).')
  return c.reservations.filter(r => core.occupiesTable(r.status))
}
export function floorOccupancy(c: Context) {
  return serviceOccupancy(occupyingReservations(c), [...c.rows.tableSessions.values()], c.reservationSettings, c.now)
}

/**
 * Fuente de ocupación de sala para reservas: sin ella la web o el personal podrían vender una mesa ya sentada.
 * Lee solo las sesiones abiertas (y las juntadas en ellas) por una función SQL estrecha que sirve también a las
 * peticiones públicas de reservas, y entrega las reservas ya representadas por una sesión.
 */
export function registerSalaOccupancySource(): void {
  registerOccupancySource('sala', async (client, { tenant, locationId, settings, now }) => {
    const { rows } = await client.query<{ sessions: SessionLite[] }>('SELECT llenamos.reservas_open_sessions($1,$2) AS sessions', [tenant.rid, locationId])
    const sessions = rows[0]?.sessions ?? []
    return { occupancy: serviceOccupancy([], sessions, settings, now), represented: representedReservations(sessions) }
  })
}
