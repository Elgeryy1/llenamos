"use client"

import { invokeOperation, operationErrorCode, isDefinitiveOperationError } from "@/lib/api/operations"

/**
 * Llamadas a las callables de personal (fase 4) con los esquemas del contrato. Fichar necesita
 * el servidor y su reloj: no hay cola local ni se fabrican horas en el dispositivo. Una operación
 * cuya respuesta no llegó se repite con el MISMO `requestId`, así el servidor devuelve el
 * resultado original en lugar de fichar dos veces.
 */
import {
  CALLABLE_SCHEMAS_FASE4,
  type CALLABLES_FASE4_PERSONAL,
  type CallableInput,
  type CallableOutput,
} from "@llenamos/core"
import { useCallback, useRef, useState } from "react"
import { describeError } from "@/lib/firebase/errors"

export type NombrePersonal = keyof typeof CALLABLES_FASE4_PERSONAL
export type Alcance = { restaurantId: string; locationId: string }
/** Lo que pone quien llama: el alcance y el identificador salen del gancho. */
export type DatosPersonal<N extends NombrePersonal> = Omit<CallableInput<N>, "requestId" | "restaurantId" | "locationId">

export async function llamarPersonal<N extends NombrePersonal>(name: N, input: CallableInput<N>): Promise<CallableOutput<N>> {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    throw new Error("Necesitas conexión para esto. No se ha guardado nada.")
  }
  const schema = CALLABLE_SCHEMAS_FASE4[name]
  const data = schema.input.parse(input)
  const response = await invokeOperation(name, data)
  const parsed = schema.output.safeParse(response)
  if (!parsed.success) throw new Error("La respuesta del servidor no cumple el contrato. Mira el estado antes de repetir.")
  return parsed.data as CallableOutput<N>
}

/** ¿Puede ser que el servidor sí haya hecho la operación aunque no llegara la respuesta? */
export function esIncierto(error: unknown): boolean {
  const code = operationErrorCode(error)
  if (!code) return false
  return !isDefinitiveOperationError(error)
}

/** Mensaje en castellano para enseñar; los mensajes del servidor ya vienen pensados para eso. */
export function errorPersonal(error: unknown): string {
  const info = describeError(error)
  const code = operationErrorCode(error)
  if (["not-found", "unimplemented", "not-deployed"].includes(code)) return "Falta el servidor de esta función. No se ha cambiado nada."
  if (["internal", "unavailable", "deadline-exceeded"].includes(code)) {
    return "No se ha podido confirmar la respuesta. Vuelve a pulsar: se repite la misma operación sin duplicarla."
  }
  // Algunos errores del servidor llegan con el código HTTP al final («[403]»): no sirve a quien lee.
  return info.message.replace(/\s*\[\d{3}\]\s*$/, "")
}

/** Cuántos intentos de PIN quedan, si el servidor lo dice en los detalles del error. */
export function intentosRestantes(error: unknown): number | null {
  const d = error && typeof error === "object" && "details" in error ? (error.details as { attemptsLeft?: unknown } | null) : null
  return d && typeof d.attemptsLeft === "number" ? d.attemptsLeft : null
}

export type ResultadoAccion<N extends NombrePersonal> =
  | { ok: true; data: CallableOutput<N> }
  | { ok: false; message: string; error: unknown }

/**
 * Ejecuta mutaciones con `requestId`. Mientras una operación está en marcha no admite otra
 * (doble toque); si falla sin saber si llegó, el mismo contenido reutiliza su `requestId`.
 */
export function useAccionPersonal(scope: Alcance | null) {
  const [ocupado, setOcupado] = useState(false)
  const enCurso = useRef(false)
  const pendiente = useRef<{ clave: string; requestId: string } | null>(null)

  const ejecutar = useCallback(
    async <N extends NombrePersonal>(name: N, datos: DatosPersonal<N>): Promise<ResultadoAccion<N> | null> => {
      if (!scope || enCurso.current) return null
      enCurso.current = true
      setOcupado(true)
      const clave = `${name}:${JSON.stringify(datos)}`
      const requestId = pendiente.current?.clave === clave ? pendiente.current.requestId : crypto.randomUUID()
      try {
        const data = await llamarPersonal(name, { ...scope, ...datos, requestId } as CallableInput<N>)
        pendiente.current = null
        return { ok: true, data }
      } catch (error) {
        pendiente.current = esIncierto(error) ? { clave, requestId } : null
        return { ok: false, message: errorPersonal(error), error }
      } finally {
        enCurso.current = false
        setOcupado(false)
      }
    },
    [scope],
  )
  return { ejecutar, ocupado }
}
