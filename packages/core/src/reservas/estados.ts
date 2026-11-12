/**
 * Estados de una reserva y cambios permitidos.
 *
 *   pendiente     → confirmada, sentada, cancelada, no_presentada
 *   confirmada    → sentada, cancelada, no_presentada
 *   sentada       → terminada
 *   no_presentada → sentada (llegó tarde)
 *   terminada y cancelada son finales.
 *
 * - pendiente: recién pedida; falta confirmar (o pagar la señal).
 * - confirmada: el restaurante la da por buena.
 * - sentada: el grupo está en la mesa.
 * - terminada: se ha ido; la mesa queda libre.
 * - cancelada: no vendrá (la anula el cliente o el restaurante). Es final.
 * - no_presentada: no vino. Si al final aparece, se puede sentar.
 */
import { z } from "zod"

export const ESTADOS_RESERVA = [
  "pendiente",
  "confirmada",
  "sentada",
  "terminada",
  "cancelada",
  "no_presentada",
] as const
export type EstadoReserva = (typeof ESTADOS_RESERVA)[number]
export const EstadoReservaSchema = z.enum(ESTADOS_RESERVA)

export const ESTADO_RESERVA_LABEL: Record<EstadoReserva, string> = {
  pendiente: "pendiente",
  confirmada: "confirmada",
  sentada: "sentada",
  terminada: "terminada",
  cancelada: "cancelada",
  no_presentada: "no presentada",
}

/** A qué estados se puede pasar desde cada uno. */
export const TRANSICIONES_RESERVA: Record<EstadoReserva, readonly EstadoReserva[]> = {
  pendiente: ["confirmada", "sentada", "cancelada", "no_presentada"],
  confirmada: ["sentada", "cancelada", "no_presentada"],
  sentada: ["terminada"],
  terminada: [],
  cancelada: [],
  no_presentada: ["sentada"],
}

export function esEstadoFinal(estado: EstadoReserva): boolean {
  return TRANSICIONES_RESERVA[estado].length === 0
}

export function puedeCambiarEstado(de: EstadoReserva, a: EstadoReserva): boolean {
  return TRANSICIONES_RESERVA[de].includes(a)
}

/** Estados en los que la reserva tiene (o tendrá) una mesa ocupada. */
export function ocupaMesa(estado: EstadoReserva): boolean {
  return estado === "pendiente" || estado === "confirmada" || estado === "sentada"
}

/**
 * Estados que cuentan para la capacidad de comensales por franja y por turno.
 * Una reserva terminada también llegó en su franja, así que cuenta.
 */
export function cuentaParaCapacidad(estado: EstadoReserva): boolean {
  return estado !== "cancelada" && estado !== "no_presentada"
}

export type ResultadoCambioEstado = { ok: true } | { ok: false; motivo: string }

/**
 * Comprueba si una reserva puede pasar a otro estado en este momento.
 * `ahora` es un instante en ms (no se lee el reloj del sistema).
 */
export function comprobarCambioEstado(
  reserva: { estado: EstadoReserva; inicio: number },
  a: EstadoReserva,
  ahora: number,
): ResultadoCambioEstado {
  const de = reserva.estado
  if (de === a) return { ok: false, motivo: `La reserva ya está ${ESTADO_RESERVA_LABEL[a]}.` }
  if (esEstadoFinal(de)) {
    return { ok: false, motivo: `Una reserva ${ESTADO_RESERVA_LABEL[de]} ya no se puede cambiar.` }
  }
  if (!puedeCambiarEstado(de, a)) {
    return {
      ok: false,
      motivo: `No se puede pasar de ${ESTADO_RESERVA_LABEL[de]} a ${ESTADO_RESERVA_LABEL[a]}.`,
    }
  }
  if (a === "no_presentada" && ahora < reserva.inicio) {
    return { ok: false, motivo: "Todavía no ha llegado la hora de la reserva." }
  }
  return { ok: true }
}

export interface CambioEstado {
  de: EstadoReserva
  a: EstadoReserva
  /** Instante en ms. */
  en: number
  /** uid de quien hizo el cambio, o null si fue el cliente o el sistema. */
  por: string | null
  motivo: string | null
}

/**
 * Devuelve la reserva con el estado nuevo y el cambio apuntado en su historial,
 * o el motivo por el que no se puede. No modifica el objeto recibido.
 */
export function cambiarEstado<R extends { estado: EstadoReserva; inicio: number; historial: readonly CambioEstado[] }>(
  reserva: R,
  a: EstadoReserva,
  opciones: { ahora: number; por?: string | null; motivo?: string | null },
): { ok: true; reserva: R } | { ok: false; motivo: string } {
  const comprobacion = comprobarCambioEstado(reserva, a, opciones.ahora)
  if (!comprobacion.ok) return comprobacion
  const cambio: CambioEstado = {
    de: reserva.estado,
    a,
    en: opciones.ahora,
    por: opciones.por ?? null,
    motivo: opciones.motivo ?? null,
  }
  return { ok: true, reserva: { ...reserva, estado: a, historial: [...reserva.historial, cambio] } }
}
