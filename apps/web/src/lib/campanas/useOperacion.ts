"use client"

import type { CallableInput, CallableOutput } from "@llenamos/core"
import { useRef, useState } from "react"
import { errorMarketing, IntencionesMarketing, type MutacionMarketing } from "./api"

export function useOperacionMarketing() {
  const intenciones = useRef<IntencionesMarketing | null>(null)
  const ocupado = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function run<N extends MutacionMarketing>(name: N, input: Omit<CallableInput<N>, "requestId">): Promise<CallableOutput<N> | null> {
    if (ocupado.current) return null
    ocupado.current = true
    setBusy(true)
    setError(null)
    intenciones.current ??= new IntencionesMarketing()
    try {
      return await intenciones.current.run(name, input)
    } catch (e) {
      setError(errorMarketing(e))
      return null
    } finally {
      ocupado.current = false
      setBusy(false)
    }
  }
  return { run, busy, error, fail: setError }
}
