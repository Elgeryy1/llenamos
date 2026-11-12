/**
 * Adaptadores entre los documentos guardados (en inglés) y el motor de reservas (en castellano).
 *
 * El motor no se reescribe: las funciones y la web leen los documentos con los esquemas
 * de core y los pasan por aquí antes de llamar a `calcularDisponibilidad`, `proponerMesas`
 * o `comprobarCambioEstado`. Todas las conversiones son puras y sin pérdida: ida y vuelta
 * dan lo mismo (lo comprueban las pruebas).
 */
import type { AvailabilityOutput, DiscardReason, SlotReason, TableProposals } from "./api"
import type { Table } from "./model"
import type { Reservation, ReservationStatus, StatusChange } from "./reservation-model"
import {
  defaultReservationPolicies,
  type Exception,
  type ReservationPolicies,
  type ReservationSettings,
  type Shift,
  type Week,
  type Weekday,
} from "./reservation-settings"
import type { MotivoDescarte, ResultadoAsignacion } from "./reservas/asignacion"
import type { Disponibilidad, MotivoFranja } from "./reservas/disponibilidad"
import { comprobarCambioEstado, cuentaParaCapacidad, ocupaMesa, TRANSICIONES_RESERVA, type EstadoReserva } from "./reservas/estados"
import {
  configuracionReservasInicial,
  franjasDelDia,
  type ConfiguracionReservas,
  type Excepcion,
  type HorarioSemanal,
  type Turno,
} from "./reservas/horarios"
import type { MesaMotor } from "./reservas/ocupacion"
import type { ReservaOcupacion } from "./reservas/reserva"
import { horaAMinutos, instanteDeHoraLocal, type DiaSemana, type Fecha, type Hora } from "./reservas/tiempo"

/* Días de la semana ------------------------------------------------------------ */

export const WEEKDAY_TO_DIA: Record<Weekday, DiaSemana> = {
  mon: "lun",
  tue: "mar",
  wed: "mie",
  thu: "jue",
  fri: "vie",
  sat: "sab",
  sun: "dom",
}

export const DIA_TO_WEEKDAY: Record<DiaSemana, Weekday> = {
  lun: "mon",
  mar: "tue",
  mie: "wed",
  jue: "thu",
  vie: "fri",
  sab: "sat",
  dom: "sun",
}

/* Turnos y configuración ---------------------------------------------------------- */

// Los campos opcionales solo se copian si existen: Firestore no admite `undefined`.

function shiftToTurno(s: Shift): Turno {
  return {
    nombre: s.name,
    desde: s.from,
    ultimaEntrada: s.lastEntry,
    ...(s.maxGuestsPerSlot !== undefined ? { maxComensalesPorFranja: s.maxGuestsPerSlot } : {}),
    ...(s.maxGuestsPerShift !== undefined ? { maxComensalesTurno: s.maxGuestsPerShift } : {}),
  }
}

function turnoToShift(t: Turno): Shift {
  return {
    name: t.nombre,
    from: t.desde,
    lastEntry: t.ultimaEntrada,
    ...(t.maxComensalesPorFranja !== undefined ? { maxGuestsPerSlot: t.maxComensalesPorFranja } : {}),
    ...(t.maxComensalesTurno !== undefined ? { maxGuestsPerShift: t.maxComensalesTurno } : {}),
  }
}

const conMotivo = (reason: string | undefined) => (reason !== undefined ? { motivo: reason } : {})
const conReason = (motivo: string | undefined) => (motivo !== undefined ? { reason: motivo } : {})

function exceptionToExcepcion(e: Exception): Excepcion {
  if (e.type === "closed") return { tipo: "cerrado", fecha: e.date, ...conMotivo(e.reason) }
  return { tipo: "horario", fecha: e.date, turnos: e.shifts.map(shiftToTurno), ...conMotivo(e.reason) }
}

function excepcionToException(e: Excepcion): Exception {
  if (e.tipo === "cerrado") return { type: "closed", date: e.fecha, ...conReason(e.motivo) }
  return { type: "hours", date: e.fecha, shifts: e.turnos.map(turnoToShift), ...conReason(e.motivo) }
}

/** Configuración guardada → configuración del motor. Las políticas no le importan al motor. */
export function settingsToConfiguracion(settings: ReservationSettings): ConfiguracionReservas {
  const w = settings.week
  const semana: HorarioSemanal = {
    lun: w.mon.map(shiftToTurno),
    mar: w.tue.map(shiftToTurno),
    mie: w.wed.map(shiftToTurno),
    jue: w.thu.map(shiftToTurno),
    vie: w.fri.map(shiftToTurno),
    sab: w.sat.map(shiftToTurno),
    dom: w.sun.map(shiftToTurno),
  }
  return {
    zonaHoraria: settings.timezone,
    pasoMinutos: settings.stepMinutes,
    semana,
    excepciones: settings.exceptions.map(exceptionToExcepcion),
    cierres: settings.closures.map((c) => ({ desde: c.from, hasta: c.to, ...conMotivo(c.reason) })),
    duracion: {
      porDefectoMinutos: settings.duration.defaultMinutes,
      tramos: settings.duration.tiers.map((t) => ({ hastaComensales: t.upToGuests, minutos: t.minutes })),
    },
    margenMinutos: settings.bufferMinutes,
    maxComensalesPorFranja: settings.maxGuestsPerSlot,
    comensalesMin: settings.minPartySize,
    comensalesMax: settings.maxPartySize,
    antelacionMinimaMinutos: settings.minNoticeMinutes,
    antelacionMaximaDias: settings.maxAdvanceDays,
    maxMesasUnidas: settings.maxJoinedTables,
    plazasPerdidasPorUnion: settings.seatsLostPerJoin,
  }
}

/** Configuración del motor + políticas → configuración guardada. */
export function configuracionToSettings(
  config: ConfiguracionReservas,
  policies: ReservationPolicies = defaultReservationPolicies(),
): ReservationSettings {
  const s = config.semana
  const week: Week = {
    mon: s.lun.map(turnoToShift),
    tue: s.mar.map(turnoToShift),
    wed: s.mie.map(turnoToShift),
    thu: s.jue.map(turnoToShift),
    fri: s.vie.map(turnoToShift),
    sat: s.sab.map(turnoToShift),
    sun: s.dom.map(turnoToShift),
  }
  return {
    timezone: config.zonaHoraria,
    stepMinutes: config.pasoMinutos,
    week,
    exceptions: config.excepciones.map(excepcionToException),
    closures: config.cierres.map((c) => ({ from: c.desde, to: c.hasta, ...conReason(c.motivo) })),
    duration: {
      defaultMinutes: config.duracion.porDefectoMinutos,
      tiers: config.duracion.tramos.map((t) => ({ upToGuests: t.hastaComensales, minutes: t.minutos })),
    },
    bufferMinutes: config.margenMinutos,
    maxGuestsPerSlot: config.maxComensalesPorFranja,
    minPartySize: config.comensalesMin,
    maxPartySize: config.comensalesMax,
    minNoticeMinutes: config.antelacionMinimaMinutos,
    maxAdvanceDays: config.antelacionMaximaDias,
    maxJoinedTables: config.maxMesasUnidas,
    seatsLostPerJoin: config.plazasPerdidasPorUnion,
    ...copiarPoliticas(policies),
  }
}

/** Copia de las políticas para que quien las reciba no comparta objetos con el original. */
function copiarPoliticas(p: ReservationPolicies): ReservationPolicies {
  return {
    publicBooking: p.publicBooking,
    autoConfirm: p.autoConfirm,
    deposit: { ...p.deposit },
    cancellation: { ...p.cancellation },
    reminders: { ...p.reminders },
    reviews: { ...p.reviews },
    waitlist: { ...p.waitlist },
  }
}

/**
 * Lo que vale para un local sin `settings/reservations`: los horarios de
 * `configuracionReservasInicial` (comida y cena, cerrado el lunes) y las políticas apagadas.
 */
export function defaultReservationSettings(timezone = "Europe/Madrid"): ReservationSettings {
  return configuracionToSettings(configuracionReservasInicial(timezone), defaultReservationPolicies())
}

/** Solo las políticas de una configuración guardada. */
export function settingsPolicies(settings: ReservationSettings): ReservationPolicies {
  return copiarPoliticas(settings)
}

/* Estados -------------------------------------------------------------------------- */

export const STATUS_TO_ESTADO: Record<ReservationStatus, EstadoReserva> = {
  pending: "pendiente",
  confirmed: "confirmada",
  seated: "sentada",
  finished: "terminada",
  cancelled: "cancelada",
  no_show: "no_presentada",
}

export const ESTADO_TO_STATUS: Record<EstadoReserva, ReservationStatus> = {
  pendiente: "pending",
  confirmada: "confirmed",
  sentada: "seated",
  terminada: "finished",
  cancelada: "cancelled",
  no_presentada: "no_show",
}

export function statusToEstado(status: ReservationStatus): EstadoReserva {
  return STATUS_TO_ESTADO[status]
}

export function estadoToStatus(estado: EstadoReserva): ReservationStatus {
  return ESTADO_TO_STATUS[estado]
}

/** Las transiciones del motor (`TRANSICIONES_RESERVA`) con los estados en inglés. */
const transicionesEn = (estado: EstadoReserva) => TRANSICIONES_RESERVA[estado].map(estadoToStatus)

/** Las transiciones del motor (`TRANSICIONES_RESERVA`) con los estados en inglés. */
export const RESERVATION_TRANSITIONS: Record<ReservationStatus, readonly ReservationStatus[]> = {
  pending: transicionesEn("pendiente"),
  confirmed: transicionesEn("confirmada"),
  seated: transicionesEn("sentada"),
  finished: transicionesEn("terminada"),
  cancelled: transicionesEn("cancelada"),
  no_show: transicionesEn("no_presentada"),
}

export type TransitionCheck = { ok: true } | { ok: false; reason: string }

/**
 * Si una reserva puede pasar de `from` a `to` ahora, y si no, por qué (en castellano).
 * Usa `comprobarCambioEstado` del motor: `no_show` solo desde la hora de la reserva.
 */
export function checkTransition(from: ReservationStatus, to: ReservationStatus, startAtMs: number, nowMs: number): TransitionCheck {
  const r = comprobarCambioEstado({ estado: statusToEstado(from), inicio: startAtMs }, statusToEstado(to), nowMs)
  return r.ok ? { ok: true } : { ok: false, reason: r.motivo }
}

export function canTransition(from: ReservationStatus, to: ReservationStatus, startAtMs: number, nowMs: number): boolean {
  return checkTransition(from, to, startAtMs, nowMs).ok
}

/** Estados a los que se puede pasar ahora (para pintar los botones de acción). */
export function nextStatuses(from: ReservationStatus, startAtMs: number, nowMs: number): ReservationStatus[] {
  return RESERVATION_TRANSITIONS[from].filter((to) => canTransition(from, to, startAtMs, nowMs))
}

/** Si la reserva tiene (o tendrá) una mesa ocupada: pending, confirmed y seated. */
export function occupiesTable(status: ReservationStatus): boolean {
  return ocupaMesa(statusToEstado(status))
}

/** Si cuenta para la capacidad de la franja y del turno: todas menos cancelled y no_show. */
export function countsForCapacity(status: ReservationStatus): boolean {
  return cuentaParaCapacidad(statusToEstado(status))
}

/**
 * Devuelve la reserva con el estado nuevo y el cambio apuntado en `history`, o el motivo
 * por el que no se puede. No modifica la reserva recibida.
 */
export function applyStatusChange<R extends Pick<Reservation, "status" | "startAt" | "history">>(
  reservation: R,
  to: ReservationStatus,
  options: { nowMs: number; by?: string | null; reason?: string | null },
): { ok: true; reservation: R; change: StatusChange } | { ok: false; reason: string } {
  const check = checkTransition(reservation.status, to, reservation.startAt, options.nowMs)
  if (!check.ok) return check
  const change: StatusChange = {
    from: reservation.status,
    to,
    at: options.nowMs,
    by: options.by ?? null,
    reason: options.reason ?? null,
  }
  return { ok: true, change, reservation: { ...reservation, status: to, history: [...reservation.history, change] } }
}

/* Reservas y mesas para el motor --------------------------------------------------- */

/** Reserva guardada (con `startAt` ya en ms) → lo que el motor necesita para la ocupación. */
export function reservationToOcupacion(
  id: string,
  reservation: Pick<Reservation, "startAt" | "durationMinutes" | "partySize" | "status" | "tableIds">,
): ReservaOcupacion {
  return {
    id,
    inicio: reservation.startAt,
    duracionMinutos: reservation.durationMinutes,
    comensales: reservation.partySize,
    estado: statusToEstado(reservation.status),
    mesaIds: [...reservation.tableIds],
  }
}

/** Varias reservas con su id (por ejemplo, `snapshot.docs.map(d => ({ id: d.id, ...parse(d) }))`). */
export function reservationsToOcupacion(
  reservations: ReadonlyArray<{ id: string } & Pick<Reservation, "startAt" | "durationMinutes" | "partySize" | "status" | "tableIds">>,
): ReservaOcupacion[] {
  return reservations.map((r) => reservationToOcupacion(r.id, r))
}

/** Documento de `tables/{tid}` → mesa del motor. */
export function tableToMesa(id: string, table: Pick<Table, "name" | "areaId" | "seats" | "joinableWith" | "enabled">): MesaMotor {
  return {
    id,
    name: table.name,
    areaId: table.areaId,
    seats: table.seats,
    joinableWith: [...table.joinableWith],
    enabled: table.enabled,
  }
}

/* Franjas ------------------------------------------------------------------------- */

export interface SlotStart {
  /** Instante de llegada en ms UTC. */
  startAt: number
  /** Si es una de las franjas del día (false: hora fuera de turno que solo puede poner el personal). */
  inShift: boolean
}

/**
 * Instante de una franja a partir del día de servicio y la hora de pared, tal como los
 * manda la web (`date`, `time`).
 *
 * Primero se busca entre las franjas del día (así una hora de madrugada de un turno que
 * cruza la medianoche cae en el día siguiente, y en el retraso de octubre se elige la
 * primera de las dos). Si no está, se toma esa hora en esa fecha (`inShift: false`).
 * Devuelve null si esa hora no existe (adelanto de marzo).
 */
export function slotStartAt(config: ConfiguracionReservas, date: Fecha, time: Hora): SlotStart | null {
  const franja = franjasDelDia(config, date).find((f) => f.hora === time)
  if (franja) return { startAt: franja.inicio, inShift: true }
  const startAt = instanteDeHoraLocal(date, horaAMinutos(time), config.zonaHoraria)
  return startAt === null ? null : { startAt, inShift: false }
}

/* Salidas de las callables ---------------------------------------------------------- */

export const MOTIVO_TO_SLOT_REASON: Record<MotivoFranja, SlotReason> = {
  antelacion_minima: "min_notice",
  antelacion_maxima: "max_advance",
  capacidad_franja: "slot_capacity",
  capacidad_turno: "shift_capacity",
  sin_mesa: "no_table",
}

const ESTADO_DISPONIBILIDAD = {
  abierto: "open",
  cerrado: "closed",
  grupo_no_admitido: "party_size_not_allowed",
} as const

/**
 * Resultado de `calcularDisponibilidad` → salida pública de `consultarDisponibilidad`.
 * Solo horas y motivos: ningún dato de otras reservas (ni comensales por franja).
 */
export function disponibilidadToOutput(
  disponibilidad: Disponibilidad,
  options: { timezone: string; waitlistEnabled: boolean },
): AvailabilityOutput {
  return {
    date: disponibilidad.fecha,
    partySize: disponibilidad.comensales,
    durationMinutes: disponibilidad.duracionMinutos,
    timezone: options.timezone,
    status: ESTADO_DISPONIBILIDAD[disponibilidad.estado],
    message: disponibilidad.mensaje,
    slots: disponibilidad.franjas.map((f) => ({
      time: f.hora,
      wallDate: f.fecha,
      startAt: f.inicio,
      shift: f.turno,
      available: f.disponible,
      reason: f.motivo === null ? null : MOTIVO_TO_SLOT_REASON[f.motivo],
    })),
    waitlistEnabled: options.waitlistEnabled,
  }
}

export const DESCARTE_TO_DISCARD_REASON: Record<MotivoDescarte, DiscardReason> = {
  deshabilitada: "disabled",
  ocupada: "occupied",
  pequena: "too_small",
  dejaria_sin_mesa: "would_leave_without_table",
  sin_comprobar: "not_checked",
}

/** Resultado de `proponerMesas` → salida de `proponerMesasReserva`. */
export function asignacionToOutput(resultado: ResultadoAsignacion): TableProposals {
  return {
    startAt: resultado.inicio,
    partySize: resultado.comensales,
    durationMinutes: resultado.duracionMinutos,
    proposals: resultado.propuestas.map((p) => ({
      tableIds: p.mesaIds,
      tableNames: p.nombres,
      seats: p.plazas,
      spare: p.sobran,
      joined: p.unidas,
      inPreferredArea: p.enZonaPreferida,
      explanation: p.explicacion,
    })),
    totalOptions: resultado.totalOpciones,
    discards: resultado.descartes.map((d) => ({
      tableIds: d.mesaIds,
      tableNames: d.nombres,
      reason: DESCARTE_TO_DISCARD_REASON[d.motivo],
      explanation: d.explicacion,
      reservationIds: d.reservaIds,
    })),
    summary: resultado.resumen,
  }
}
