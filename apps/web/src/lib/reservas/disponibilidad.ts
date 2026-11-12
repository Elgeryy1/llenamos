/**
 * Horas libres para una reserva tomada por el personal, calculadas en el navegador con
 * el motor de core y los datos que ya se están escuchando (configuración, mesas y
 * reservas del día). `consultarDisponibilidad` es la de la web pública y exige que el
 * local acepte reservas por internet; el personal no depende de eso.
 *
 * Es una ayuda para elegir: quien decide es `crearReserva`/`moverReserva`, que vuelven
 * a comprobarlo todo dentro de una transacción.
 */
import {
  calcularDisponibilidad,
  horaLocal,
  MOTIVO_FRANJA_TEXTO,
  reservationsToOcupacion,
  tableToMesa,
  type ConfiguracionReservas,
  type Fecha,
  type ReservationWithId,
} from "@llenamos/core"
import type { TableDoc } from "@/lib/data/parse"

export interface StaffSlot {
  time: string
  startAt: number
  shift: string
  available: boolean
  /** Por qué no está libre, en castellano. */
  reason: string | null
}

export interface StaffAvailability {
  open: boolean
  message: string | null
  durationMinutes: number
  slots: StaffSlot[]
}

export function staffAvailability(input: {
  config: ConfiguracionReservas
  date: Fecha
  partySize: number
  tables: readonly TableDoc[]
  reservations: readonly ReservationWithId[]
  now: number
  /** Al mover una reserva, para que no choque consigo misma. */
  excludeReservationId?: string
  durationMinutes?: number
}): StaffAvailability {
  const d = calcularDisponibilidad({
    config: input.config,
    fecha: input.date,
    comensales: input.partySize,
    mesas: input.tables.map((t) => tableToMesa(t.id, t)),
    reservas: reservationsToOcupacion(input.reservations),
    ahora: input.now,
    ignorarLimitesPublicos: true,
    excluirReservaId: input.excludeReservationId,
    duracionMinutos: input.durationMinutes,
  })
  return {
    open: d.estado === "abierto",
    message: d.mensaje,
    durationMinutes: d.duracionMinutos,
    slots: d.franjas.map((f) => ({
      time: f.hora,
      startAt: f.inicio,
      shift: f.turno,
      available: f.disponible,
      reason: f.motivo ? MOTIVO_FRANJA_TEXTO[f.motivo] : null,
    })),
  }
}

/** Hora de ahora redondeada hacia abajo a 5 minutos («20:40»), para quien entra sin reserva. */
export function walkInTime(now: number, timezone: string): { date: Fecha; time: string } {
  const local = horaLocal(now, timezone)
  const m = Math.floor(local.minutos / 5) * 5
  return { date: local.fecha, time: `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}` }
}
