import type { Transaction } from 'firebase-admin/firestore'
import * as core from '@llenamos/core'
import { db } from '../shared'
import { offeredOccupancy } from '../waitlist/occupancy'

/** Una reserva absorbida sigue representada por la sesión destino; no ocupa su mesa antigua. */
export function representedReservations(sessions: readonly core.TableSessionWithId[]): Set<string> {
  const result = new Set<string>()
  for (const session of sessions) {
    let destination = session
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
export function serviceOccupancy(reservations: readonly core.ReservationWithId[], sessions: readonly core.TableSessionWithId[], settings: core.ReservationSettings, now: number): core.ReservaOcupacion[] {
  const represented = representedReservations(sessions), config = core.settingsToConfiguracion(settings)
  return [
    ...reservations.filter(r => !(r.status === 'seated' && represented.has(r.id))).map(r => core.reservationToOcupacion(r.id, r)),
    ...sessions.flatMap(s => {
      const occupied = core.sessionToOcupacion(s.id, s, core.duracionParaGrupo(config, s.guests))
      return occupied ? [occupied] : []
    }),
  ]
}
export async function readServiceSessions(tx: Transaction, path: string) {
  const docs = await tx.get(db.collection(`${path}/tableSessions`))
  return docs.docs.map(d => ({ ...core.TableSessionSchema.parse(d.data()), id: d.id }))
}
export function floorOccupancy(c: { rows: { reservations: Map<string, core.ReservationWithId>; tableSessions: Map<string, core.TableSessionWithId>; waitlist: Map<string, core.WaitlistEntry & {id:string}> }; reservationSettings: core.ReservationSettings; now: number }) {
  return [...serviceOccupancy([...c.rows.reservations.values()], [...c.rows.tableSessions.values()], c.reservationSettings, c.now),
    ...[...c.rows.waitlist.values()].flatMap(w => offeredOccupancy(w.id, w, c.reservationSettings, c.now))]
}
