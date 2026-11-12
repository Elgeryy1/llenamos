/**
 * Sala en directo: qué pasa en cada mesa ahora mismo según las reservas del día.
 *
 * - sentados: hay una reserva sentada en la mesa (si pasa de su duración, «larga»).
 * - pronto: la siguiente reserva llega en menos de `soonMinutes`.
 * - tarde: ya ha pasado la hora de la siguiente reserva y no ha llegado.
 * - reservada: tiene una reserva más tarde en el día.
 * - libre: nada más hoy.
 * - deshabilitada: la mesa no se usa.
 */
import { horaLocal, type ReservationWithId } from "@llenamos/core"
import { formatMinutes, lateMinutes, seatedMinutes } from "./estados"

export type TableLiveState = "free" | "reserved" | "soon" | "late" | "seated" | "overtime" | "disabled"

export const TABLE_STATE_LABEL: Record<TableLiveState, string> = {
  free: "libre",
  reserved: "reservada",
  soon: "llega pronto",
  late: "va tarde",
  seated: "sentados",
  overtime: "sentados, pasan de su hora",
  disabled: "deshabilitada",
}

export interface TableLive {
  tableId: string
  state: TableLiveState
  /** La reserva que manda en la mesa ahora: la sentada o la siguiente. */
  current: ReservationWithId | null
  /** La siguiente reserva que llega (si la actual está sentada, la de después). */
  next: ReservationWithId | null
  /** Todas las reservas activas del día en esa mesa, por hora. */
  reservations: ReservationWithId[]
  /** Minutos sentados (si está ocupada) o de retraso de la siguiente. */
  minutes: number
  /** 0 a 1: cuánto de su duración llevan sentados. */
  progress: number
  /** Otras mesas de la misma reserva («unida con S4»). */
  joinedWith: string[]
}

const ACTIVE = new Set(["pending", "confirmed", "seated"])

export function liveTables(
  tables: ReadonlyArray<{ id: string; enabled: boolean }>,
  reservations: readonly ReservationWithId[],
  now: number,
  options: { soonMinutes?: number } = {},
): Map<string, TableLive> {
  const soon = (options.soonMinutes ?? 30) * 60_000
  const out = new Map<string, TableLive>()
  for (const t of tables) {
    const own = reservations
      .filter((r) => ACTIVE.has(r.status) && r.tableIds.includes(t.id))
      .sort((a, b) => a.startAt - b.startAt)
    const seated = own.find((r) => r.status === "seated") ?? null
    const upcoming = own.filter((r) => r.status !== "seated" && r !== seated)
    const next = upcoming[0] ?? null
    const current = seated ?? next
    let state: TableLiveState
    let minutes = 0
    let progress = 0
    if (!t.enabled && !seated) state = "disabled"
    else if (seated) {
      minutes = seatedMinutes(seated, now)
      progress = Math.min(1, minutes / Math.max(1, seated.durationMinutes))
      state = minutes > seated.durationMinutes ? "overtime" : "seated"
    } else if (next) {
      minutes = lateMinutes(next, now)
      state = minutes > 0 ? "late" : next.startAt - now <= soon ? "soon" : "reserved"
    } else state = "free"
    out.set(t.id, {
      tableId: t.id,
      state,
      current,
      next: seated ? next : (upcoming[1] ?? null),
      reservations: own,
      minutes,
      progress,
      joinedWith: current ? current.tableIds.filter((id) => id !== t.id) : [],
    })
  }
  return out
}

/** Próximas llegadas (pendientes y confirmadas), las que van tarde primero en su orden. */
export function arrivals(reservations: readonly ReservationWithId[], now: number, max = 8): ReservationWithId[] {
  return reservations
    .filter((r) => (r.status === "pending" || r.status === "confirmed") && r.startAt <= now + 3 * 3_600_000)
    .sort((a, b) => a.startAt - b.startAt)
    .slice(0, max)
}

export function countStates(live: ReadonlyMap<string, TableLive>): Record<TableLiveState, number> {
  const out: Record<TableLiveState, number> = { free: 0, reserved: 0, soon: 0, late: 0, seated: 0, overtime: 0, disabled: 0 }
  for (const t of live.values()) out[t.state] += 1
  return out
}

/** Texto corto de la mesa en el plano: «Familia Roca · 27 min», «21:30 Pau Ferrer, retraso 5 min», «Reservada 22:30». */
export function liveLine(t: TableLive, timezone: string): string {
  const r = t.current
  switch (t.state) {
    case "free":
      return "Libre"
    case "disabled":
      return "Deshabilitada"
    case "seated":
    case "overtime":
      return r ? `${r.guestName} · ${formatMinutes(t.minutes)}` : "Sentados"
    case "soon":
    case "late": {
      if (!r) return t.state === "late" ? "Va tarde" : "Llega pronto"
      const base = `${horaLocal(r.startAt, timezone).hora} ${r.guestName}`
      return t.minutes > 0 ? `${base}, retraso ${formatMinutes(t.minutes)}` : base
    }
    case "reserved":
      return r ? `Reservada ${horaLocal(r.startAt, timezone).hora}` : "Reservada"
  }
}
