"use client"

import type { CallableInput, TableProposals } from "@llenamos/core"
import { useEffect, useState } from "react"
import { llamarCore } from "@/lib/data/callables"
import { describeError, type ErrorInfo } from "@/lib/firebase/errors"

export type ProposalsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: ErrorInfo }
  | { status: "ready"; data: TableProposals }

/**
 * Pide las propuestas de mesa al servidor cuando cambia la petición (o null para no pedir).
 * `version` fuerza otra petición (por ejemplo, al volver a abrir el diálogo).
 */
export function useProposals(request: CallableInput<"proponerMesasReserva"> | null, version = 0): ProposalsState {
  const key = request ? JSON.stringify(request) : null
  const [state, setState] = useState<{ key: string | null; value: ProposalsState }>({ key: null, value: { status: "idle" } })

  useEffect(() => {
    if (key === null) return
    let alive = true
    const input = JSON.parse(key) as CallableInput<"proponerMesasReserva">
    queueMicrotask(() => alive && setState({ key, value: { status: "loading" } }))
    llamarCore("proponerMesasReserva", input).then(
      (data) => alive && setState({ key, value: { status: "ready", data } }),
      (error: unknown) => alive && setState({ key, value: { status: "error", error: describeError(error) } }),
    )
    return () => {
      alive = false
    }
  }, [key, version])

  if (key === null) return { status: "idle" }
  return state.key === key ? state.value : { status: "loading" }
}
