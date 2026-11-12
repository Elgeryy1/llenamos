"use client"

import type { CallableInput, CallableOutput } from "@llenamos/core"
import { useRef, useState } from "react"
import { errorCompras } from "./api"
import { Intenciones, type NombreMutacion } from "./operacion"

/**
 * Una operación de escritura a la vez por pantalla. Guarda el error de la última y reutiliza el
 * `requestId` si se repite exactamente la misma entrada tras un fallo incierto.
 */
export function useOperacion() {
  const intenciones = useRef<Intenciones | null>(null)
  const ocupado = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run<N extends NombreMutacion>(name: N, input: Omit<CallableInput<N>, "requestId">): Promise<CallableOutput<N> | null> {
    if (ocupado.current) return null
    ocupado.current = true
    intenciones.current ??= new Intenciones()
    setBusy(true)
    setError(null)
    try {
      return await intenciones.current.run(name, input)
    } catch (e) {
      setError(errorCompras(e))
      return null
    } finally {
      ocupado.current = false
      setBusy(false)
    }
  }
  return { run, busy, error, clear: () => setError(null), fail: (message: string) => setError(message) }
}
export type Operacion = ReturnType<typeof useOperacion>
