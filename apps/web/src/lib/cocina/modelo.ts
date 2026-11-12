import { can, lineWindow, lateAlerts, resolveStation, stationTickets, type MenuItem, type Role, type Station, type StationKind, type TicketLine } from "@llenamos/core"

export type StationDoc = Station & { id: string }
export type ItemDoc = MenuItem & { id: string }
export const ESTADOS_VISIBLES = ["held", "fired", "preparing", "ready"] as const

export function puedeVer(role: Role, kind: StationKind): boolean {
  return can(role, kind === "kitchen" ? "cocina.ver" : "barra.ver")
}

/** Segunda barrera en memoria: nunca se mezclan tipos ni estaciones. */
export function ticketsDeEstacion(lines: readonly TicketLine[], station: StationDoc, now: number, pickupMinutes: number) {
  return stationTickets(lines.filter((l) => l.stationKind === station.kind && l.kind !== "menu"), station.id, now, pickupMinutes)
}

export function claveTicket(ticket: { orderId: string; sessionId: string | null; takeawayId: string | null }): string {
  return JSON.stringify([ticket.orderId, ticket.sessionId, ticket.takeawayId])
}

export function platosDeEstacion(items: readonly ItemDoc[], stations: readonly StationDoc[], station: StationDoc, defaultStationId: string | null): ItemDoc[] {
  const byId = Object.fromEntries(stations.map((s) => [s.id, s]))
  return items.filter((item) => item.active && resolveStation(item.stationId, byId, defaultStationId)?.id === station.id)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.es.localeCompare(b.name.es))
}

/** Recogida avisa por la tarea de sala. Aquí solo avisa la preparación. */
export function nuevosRetrasos(lines: readonly TicketLine[], lastCheckAt: number, now: number): string[] {
  const windows = lines.flatMap((l) => {
    if (l.status !== "fired" && l.status !== "preparing") return []
    const window = lineWindow(l, 0)
    return window ? [{ id: l.id, ...window }] : []
  })
  return lateAlerts(windows, lastCheckAt, now).map((w) => w.id)
}
