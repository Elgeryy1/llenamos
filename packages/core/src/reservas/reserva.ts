/**
 * Forma de una reserva.
 *
 * En Firestore vivirá en `restaurants/{rid}/locations/{lid}/reservations/{id}` (fase 1).
 * Allí `inicio` y los instantes del historial serán marcas de tiempo; el motor trabaja
 * siempre con milisegundos UTC, y la conversión la hace quien lee o escribe en Firestore.
 */
import { z } from "zod"
import { EstadoReservaSchema, type EstadoReserva } from "./estados"

export const ORIGENES_RESERVA = ["web", "widget", "telefono", "presencial", "importada"] as const
export const OrigenReservaSchema = z.enum(ORIGENES_RESERVA)
export type OrigenReserva = z.infer<typeof OrigenReservaSchema>

export const CambioEstadoSchema = z.object({
  de: EstadoReservaSchema,
  a: EstadoReservaSchema,
  en: z.number().int(),
  por: z.string().nullable(),
  motivo: z.string().max(200).nullable(),
})

export const ReservaSchema = z.object({
  nombre: z.string().trim().min(1).max(80),
  telefono: z.string().trim().max(30),
  email: z.string().email().nullable(),
  comensales: z.number().int().min(1).max(200),
  /** Instante de llegada, en ms UTC. */
  inicio: z.number().int(),
  /** Duración prevista. La calcula `duracionParaGrupo` al crearla, y el personal la puede cambiar. */
  duracionMinutos: z.number().int().min(15).max(24 * 60),
  estado: EstadoReservaSchema,
  /** Mesas asignadas. Vacío = todavía sin mesa (la propone el motor, la decide el encargado). */
  mesaIds: z.array(z.string().min(1)),
  origen: OrigenReservaSchema,
  notas: z.string().max(500),
  historial: z.array(CambioEstadoSchema),
})
export type Reserva = z.infer<typeof ReservaSchema>

/** Lo mínimo que el motor necesita saber de una reserva existente. */
export interface ReservaOcupacion {
  id: string
  inicio: number
  duracionMinutos: number
  comensales: number
  estado: EstadoReserva
  mesaIds: readonly string[]
}
