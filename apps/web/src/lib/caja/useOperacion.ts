"use client"

import { useEffect, useRef, useState } from "react"
import type { CallableInput, CallableOutput } from "@llenamos/core"
import { errorCaja, type NombreCaja } from "./api"
import { IntencionesCaja, type Resultado } from "./intenciones"
import type { Scope } from "./datos"

export type DatosOperacion<N extends NombreCaja> = Omit<
  CallableInput<N>,
  "requestId" | "restaurantId" | "locationId"
>
export function useOperacionCaja(scope: Scope, uid: string) {
  const controller = useRef<IntencionesCaja | null>(null)
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const [pending, setPending] = useState(false)
  const [pendingName, setPendingName] = useState<NombreCaja | undefined>(
    undefined,
  )
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<Resultado | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  useEffect(() => {
    try {
      controller.current = new IntencionesCaja(
        sessionStorage,
        `llenamos:caja:${uid}:${scope.restaurantId}:${scope.locationId}`,
      )
      setPending(Boolean(controller.current.pending))
      setPendingName(controller.current.pending?.name)
      setReady(true)
    } catch {
      setError(
        "No se puede recuperar o guardar la operación local. Revisa el almacenamiento de esta pestaña antes de cobrar.",
      )
    }
  }, [scope.restaurantId, scope.locationId, uid])
  function syncPending() {
    const intent = controller.current?.pending
    setPending(Boolean(intent))
    setPendingName(intent?.name)
  }
  async function run<N extends NombreCaja>(
    name: N,
    input: DatosOperacion<N>,
    confirmation: (data: CallableOutput<N>) => string,
  ): Promise<CallableOutput<N> | null> {
    if (
      !controller.current ||
      controller.current.busy ||
      controller.current.pending
    )
      return null
    setBusy(true)
    setError(null)
    setMessage(null)
    setResult(null)
    try {
      const data = await controller.current.run(name, {
        ...scope,
        ...input,
      } as Omit<CallableInput<N>, "requestId">)
      setResult({ name, data })
      setMessage(confirmation(data))
      return data
    } catch (e) {
      setError(errorCaja(e))
      return null
    } finally {
      setBusy(false)
      syncPending()
    }
  }
  async function retry() {
    if (!controller.current || controller.current.busy) return
    setBusy(true)
    setError(null)
    try {
      const response = await controller.current.retry()
      setResult(response)
      setMessage(
        "El servidor ha respondido a la misma operación. Revisa el resultado y los datos actualizados.",
      )
    } catch (e) {
      setError(errorCaja(e))
    } finally {
      setBusy(false)
      syncPending()
    }
  }
  return {
    run,
    retry,
    busy,
    blocked: !ready || busy || pending,
    pending,
    error,
    message,
    result,
    pendingName,
  }
}
export type OperacionCaja = ReturnType<typeof useOperacionCaja>
