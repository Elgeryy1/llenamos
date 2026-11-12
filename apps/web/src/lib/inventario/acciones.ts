"use client"

/**
 * Llamadas a las callables de inventario con `requestId` estable: si un envío no se sabe si
 * llegó (sin red, tiempo agotado), repetir la misma intención manda el mismo identificador y
 * el servidor devuelve el resultado original sin repetir efectos. Un error definitivo
 * (permiso, datos, estado obsoleto) cierra la intención y la siguiente usa otro identificador.
 */
import type { CALLABLES_FASE4_INVENTARIO, CallableInput, CallableOutput } from "@llenamos/core"
import { useCallback, useRef, useState } from "react"
import { llamarCore } from "@/lib/data/callables"
import { isDefinitiveOperationError } from "@/lib/api/operations"
import { describeError, type ErrorInfo } from "@/lib/firebase/errors"

export type NombreInventario = keyof typeof CALLABLES_FASE4_INVENTARIO
export type Alcance = { restaurantId: string; locationId: string }
/** Entrada sin lo que pone la capa de llamadas (local y requestId). */
export type DatosAccion<N extends NombreInventario> = Omit<CallableInput<N>, "requestId" | "restaurantId" | "locationId">

/** Guarda el identificador de la última intención mientras no se sepa cómo acabó. */
export class IntencionEstable {
  private actual: { huella: string; requestId: string } | null = null
  constructor(private nuevoId: () => string = () => crypto.randomUUID()) {}

  idPara(nombre: string, datos: unknown): string {
    const huella = JSON.stringify([nombre, datos])
    if (this.actual?.huella !== huella) this.actual = { huella, requestId: this.nuevoId() }
    return this.actual.requestId
  }

  cerrar(): void {
    this.actual = null
  }
}

export function esDefinitivo(error: unknown): boolean {
  return isDefinitiveOperationError(error) || error instanceof SyntaxError || (error instanceof Error && error.name === "ZodError")
}

export function useAccion(alcance: Alcance) {
  const intencion = useRef(new IntencionEstable())
  const ocupado = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ErrorInfo | null>(null)
  const { restaurantId, locationId } = alcance

  const ejecutar = useCallback(
    async <N extends NombreInventario>(nombre: N, datos: DatosAccion<N>): Promise<CallableOutput<N> | null> => {
      if (ocupado.current) return null
      ocupado.current = true
      setBusy(true)
      setError(null)
      try {
        const base = { restaurantId, locationId, ...datos } as Omit<CallableInput<N>, "requestId">
        const requestId = nombre === "sugerirPedidos" || nombre === "margenPlatos" ? undefined : intencion.current.idPara(nombre, base)
        const resultado = await llamarCore(nombre, (requestId ? { ...base, requestId } : base) as CallableInput<N>)
        intencion.current.cerrar()
        return resultado
      } catch (e) {
        if (esDefinitivo(e)) intencion.current.cerrar()
        setError(describeError(e))
        return null
      } finally {
        ocupado.current = false
        setBusy(false)
      }
    },
    [restaurantId, locationId],
  )

  const limpiar = useCallback(() => {
    intencion.current.cerrar()
    setError(null)
  }, [])

  return { ejecutar, busy, error, limpiar }
}
export type Accion = ReturnType<typeof useAccion>
