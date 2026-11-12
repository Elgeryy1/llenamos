/**
 * El día de reservas: qué reservas pertenecen a un día de servicio, en qué turno caen,
 * cómo se agrupan por media hora y el resumen de cubiertos.
 *
 * Todo es puro: el instante actual (`now`, ms UTC) y la configuración del local entran
 * como datos, igual que en el motor de core.
 */
import {
  horaLocal,
  instanteDeHoraLocal,
  minutosAHora,
  rangoTurno,
  sumarDias,
  turnosDelDia,
  type ConfiguracionReservas,
  type Fecha,
  type ReservationStatus,
  type ReservationWithId,
} from "@llenamos/core"

/** Fecha del local en un instante («2026-11-09»). */
export function localDate(now: number, timezone: string): Fecha {
  return horaLocal(now, timezone).fecha
}

/**
 * Instantes entre los que se piden las reservas de un día de servicio: desde las 00:00
 * del día hasta las 00:00 de dos días después, para no perder los turnos que cruzan la
 * medianoche. Luego `belongsToDay` se queda solo con las del día.
 */
export function dayQueryWindow(date: Fecha, timezone: string): { from: number; to: number } {
  const from = instanteDeHoraLocal(date, 0, timezone) ?? Date.parse(`${date}T00:00:00Z`)
  const end = sumarDias(date, 2)
  const to = instanteDeHoraLocal(end, 0, timezone) ?? Date.parse(`${end}T00:00:00Z`)
  return { from, to }
}

export interface ShiftRef {
  /** Posición en los turnos del día; -1 = fuera de turno. */
  index: number
  name: string
  /** «13:00» */
  from: string
  /** «15:30» (última entrada). */
  lastEntry: string
}

export const OFF_SHIFT: ShiftRef = { index: -1, name: "Fuera de turno", from: "", lastEntry: "" }

/** Minutos de la llegada contados desde la medianoche del día de servicio (o null si es de otro día). */
function minutesFromDay(startAt: number, date: Fecha, timezone: string): number | null {
  const local = horaLocal(startAt, timezone)
  if (local.fecha === date) return local.minutos
  if (local.fecha === sumarDias(date, 1)) return local.minutos + 1440
  return null
}

function shiftsOf(config: ConfiguracionReservas, date: Fecha): ShiftRef[] {
  return turnosDelDia(config, date).turnos.map((t, index) => ({ index, name: t.nombre, from: t.desde, lastEntry: t.ultimaEntrada }))
}

function inShift(minutes: number, shift: ShiftRef): boolean {
  const r = rangoTurno({ desde: shift.from, ultimaEntrada: shift.lastEntry })
  return minutes >= r.desde && minutes <= r.ultimaEntrada
}

/**
 * A qué turno del día `date` pertenece una llegada, o null si es de otro día de servicio.
 *
 * - Dentro de un turno del día (también la parte de madrugada de un turno que cruza la
 *   medianoche): ese turno.
 * - En la fecha del día pero fuera de turno (reserva a mano del personal): `OFF_SHIFT`,
 *   salvo que caiga en la madrugada de un turno del día anterior.
 * - En la fecha siguiente y fuera de los turnos del día: es del día siguiente.
 */
export function shiftForStart(startAt: number, config: ConfiguracionReservas, date: Fecha): ShiftRef | null {
  const minutes = minutesFromDay(startAt, date, config.zonaHoraria)
  if (minutes === null) return null
  const shift = shiftsOf(config, date).find((s) => inShift(minutes, s))
  if (shift) return shift
  if (minutes >= 1440) return null
  const previous = shiftsOf(config, sumarDias(date, -1))
  if (previous.some((s) => inShift(minutes + 1440, s))) return null
  return OFF_SHIFT
}

export function belongsToDay(startAt: number, config: ConfiguracionReservas, date: Fecha): boolean {
  return shiftForStart(startAt, config, date) !== null
}

/** Reservas que no ocupan sitio ni cuentan como cubiertos. */
export function isDropped(status: ReservationStatus): boolean {
  return status === "cancelled" || status === "no_show"
}

/** «20:30»: la media hora en la que llega. */
export function halfHourOf(startAt: number, timezone: string): string {
  const m = horaLocal(startAt, timezone).minutos
  return minutosAHora(Math.floor(m / 30) * 30)
}

export interface SlotGroup {
  /** «20:30» */
  label: string
  covers: number
  reservations: ReservationWithId[]
}

export interface ShiftGroup {
  shift: ShiftRef
  covers: number
  reservations: ReservationWithId[]
  slots: SlotGroup[]
}

function byStart(a: ReservationWithId, b: ReservationWithId) {
  return a.startAt - b.startAt || a.guestName.localeCompare(b.guestName, "es")
}

export function covers(reservations: readonly Pick<ReservationWithId, "status" | "partySize">[]): number {
  return reservations.reduce((n, r) => (isDropped(r.status) ? n : n + r.partySize), 0)
}

/**
 * Agrupa las reservas de un día por turno y, dentro de cada turno, por media hora.
 * Los turnos van en su orden y «fuera de turno» al final. Solo salen los turnos con
 * reservas, salvo que `includeEmpty` pida también los vacíos.
 */
export function groupByShift(
  reservations: readonly ReservationWithId[],
  config: ConfiguracionReservas,
  date: Fecha,
  options: { includeEmpty?: boolean } = {},
): ShiftGroup[] {
  const shifts = shiftsOf(config, date)
  const buckets = new Map<number, ReservationWithId[]>()
  for (const s of shifts) buckets.set(s.index, [])
  for (const r of reservations) {
    const shift = shiftForStart(r.startAt, config, date)
    if (!shift) continue
    const list = buckets.get(shift.index) ?? []
    list.push(r)
    buckets.set(shift.index, list)
  }
  const ordered = [...shifts, OFF_SHIFT]
  return ordered.flatMap((shift) => {
    const list = (buckets.get(shift.index) ?? []).sort(byStart)
    if (list.length === 0 && (!options.includeEmpty || shift.index === -1)) return []
    const slots: SlotGroup[] = []
    for (const r of list) {
      const label = halfHourOf(r.startAt, config.zonaHoraria)
      let slot = slots.at(-1)
      if (!slot || slot.label !== label) {
        slot = { label, covers: 0, reservations: [] }
        slots.push(slot)
      }
      slot.reservations.push(r)
      if (!isDropped(r.status)) slot.covers += r.partySize
    }
    return [{ shift, covers: covers(list), reservations: list, slots }]
  })
}

/** El turno que toca ahora: el que está en marcha, o el siguiente, o el último del día. */
export function currentShiftIndex(config: ConfiguracionReservas, date: Fecha, now: number): number | null {
  const shifts = shiftsOf(config, date)
  if (shifts.length === 0) return null
  const minutes = minutesFromDay(now, date, config.zonaHoraria)
  if (minutes === null) return localDate(now, config.zonaHoraria) < date ? (shifts[0]?.index ?? null) : (shifts.at(-1)?.index ?? null)
  // Un turno sigue «en marcha» hasta dos horas después de su última entrada.
  const live = shifts.find((s) => {
    const r = rangoTurno({ desde: s.from, ultimaEntrada: s.lastEntry })
    return minutes >= r.desde - 60 && minutes <= r.ultimaEntrada + 120
  })
  if (live) return live.index
  const next = shifts.find((s) => rangoTurno({ desde: s.from, ultimaEntrada: s.lastEntry }).desde > minutes)
  return (next ?? shifts.at(-1))?.index ?? null
}

export interface DaySummary {
  /** Cubiertos que cuentan (sin canceladas ni no presentadas). */
  covers: number
  seated: number
  /** Comensales que aún tienen que llegar (pendientes y confirmadas). */
  toArrive: number
  finished: number
  /** Reservas activas sin mesa asignada. */
  withoutTable: number
  /** Reservas que siguen sin confirmar. */
  pending: number
  /** Señales pagadas, en céntimos. */
  depositsPaidCents: number
  reservations: number
}

export function summarize(reservations: readonly ReservationWithId[]): DaySummary {
  const s: DaySummary = { covers: 0, seated: 0, toArrive: 0, finished: 0, withoutTable: 0, pending: 0, depositsPaidCents: 0, reservations: 0 }
  for (const r of reservations) {
    if (r.deposit.status === "paid") s.depositsPaidCents += r.deposit.amountCents
    if (isDropped(r.status)) continue
    s.reservations += 1
    s.covers += r.partySize
    if (r.status === "seated") s.seated += r.partySize
    if (r.status === "finished") s.finished += r.partySize
    if (r.status === "pending" || r.status === "confirmed") s.toArrive += r.partySize
    if (r.status === "pending") s.pending += 1
    if (r.tableIds.length === 0 && (r.status === "pending" || r.status === "confirmed" || r.status === "seated")) s.withoutTable += 1
  }
  return s
}

/** Comensales que llegan en cada franja de media hora de un turno, para la barra de ocupación. */
export function coversBySlot(group: ShiftGroup, config: ConfiguracionReservas, date: Fecha): Array<{ label: string; covers: number; startAt: number }> {
  if (group.shift.index < 0) return group.slots.map((s) => ({ label: s.label, covers: s.covers, startAt: s.reservations[0]?.startAt ?? 0 }))
  const r = rangoTurno({ desde: group.shift.from, ultimaEntrada: group.shift.lastEntry })
  const out: Array<{ label: string; covers: number; startAt: number }> = []
  for (let m = Math.floor(r.desde / 30) * 30; m <= r.ultimaEntrada; m += 30) {
    const label = minutosAHora(m % 1440)
    const day = m >= 1440 ? sumarDias(date, 1) : date
    const startAt = instanteDeHoraLocal(day, m % 1440, config.zonaHoraria) ?? 0
    out.push({ label, covers: group.slots.find((s) => s.label === label)?.covers ?? 0, startAt })
  }
  return out
}
