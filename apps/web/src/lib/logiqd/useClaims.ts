"use client"

/**
 * Claims del token de la sesión. Se pide un token nuevo al entrar en la página para
 * que un claim recién puesto (`pnpm logiqd:equipo`) se vea sin cerrar la sesión.
 */
import type { User } from "firebase/auth"
import { useEffect, useState } from "react"

export type ClaimsState =
  | { status: "loading" }
  | { status: "ready"; claims: Record<string, unknown> }
  | { status: "error"; error: unknown }

export function useClaims(user: User | null): ClaimsState {
  const [state, setState] = useState<{ uid: string | null; value: ClaimsState }>({ uid: null, value: { status: "loading" } })

  useEffect(() => {
    if (!user) return
    let alive = true
    user
      .getIdTokenResult(true)
      .then((r) => alive && setState({ uid: user.uid, value: { status: "ready", claims: r.claims } }))
      .catch((error: unknown) => alive && setState({ uid: user.uid, value: { status: "error", error } }))
    return () => {
      alive = false
    }
  }, [user])

  if (!user || state.uid !== user.uid) return { status: "loading" }
  return state.value
}
