/**
 * Marcas de tiempo de Firestore.
 *
 * En Firestore las horas se guardan como `Timestamp`; en core, en las funciones y en el
 * motor se trabaja siempre con **milisegundos UTC** (`number`). Core no depende de
 * Firebase, así que no conoce la clase `Timestamp`: la reconoce por su forma.
 *
 * Decisión: los esquemas de **lectura** usan `TimestampSchema`, que acepta de forma
 * explícita lo que puede llegar y siempre devuelve ms:
 *
 * - un número entero de ms (lo que usan core y las callables),
 * - un `Date` válido,
 * - cualquier objeto con `toMillis(): number` (el `Timestamp` del SDK web y el de
 *   firebase-admin lo tienen),
 * - `{ seconds, nanoseconds }` (lo que da `toJSON()` del SDK web) o
 *   `{ _seconds, _nanoseconds }` (lo que da `JSON.stringify` de un `Timestamp` de
 *   firebase-admin).
 *
 * Cualquier otra cosa (texto, `null`, un `serverTimestamp()` aún sin resolver) es un error.
 * Para **escribir**, quien tiene Firebase convierte los ms con `Timestamp.fromMillis`; las
 * funciones `xxxForWrite` de los documentos lo hacen recibiendo ese conversor.
 */
import { z } from "zod"

/** Lo que acepta `TimestampSchema`. */
export type TimestampInput =
  | number
  | Date
  | { toMillis(): number }
  | { seconds: number; nanoseconds: number }
  | { _seconds: number; _nanoseconds: number }

function esObjeto(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function desdeSegundos(seconds: unknown, nanoseconds: unknown): number | null {
  if (typeof seconds !== "number" || typeof nanoseconds !== "number") return null
  if (!Number.isFinite(seconds) || !Number.isFinite(nanoseconds)) return null
  return Math.floor(seconds * 1000 + nanoseconds / 1_000_000)
}

/** Convierte una marca de tiempo (de cualquiera de las formas aceptadas) a ms UTC, o null si no lo es. */
export function timestampToMillis(value: unknown): number | null {
  let ms: number | null = null
  if (typeof value === "number") ms = value
  else if (value instanceof Date) ms = value.getTime()
  else if (esObjeto(value)) {
    if (typeof value.toMillis === "function") {
      const r: unknown = value.toMillis()
      ms = typeof r === "number" ? r : null
    } else if ("seconds" in value) {
      ms = desdeSegundos(value.seconds, value.nanoseconds)
    } else if ("_seconds" in value) {
      ms = desdeSegundos(value._seconds, value._nanoseconds)
    }
  }
  return ms !== null && Number.isSafeInteger(ms) ? ms : null
}

/** Marca de tiempo leída de Firestore (o ms). Devuelve siempre ms UTC. */
export const TimestampSchema = z
  .custom<TimestampInput>((value) => timestampToMillis(value) !== null, "Marca de tiempo no válida.")
  .transform((value) => timestampToMillis(value) ?? 0)

/** Instante en ms UTC, tal como viaja en las callables. */
export const MillisSchema = z.number().int("Instante no válido.").min(0, "Instante no válido.")
