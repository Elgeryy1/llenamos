"use client"

import { onAuthStateChanged, signOut as firebaseSignOut, type User } from "firebase/auth"
import { createContext, use, useEffect, useState, type ReactNode } from "react"
import { getFirebaseIdentity } from "@/lib/firebase/auth-client"
import { cancelIdentityRequests } from "@/lib/api/transport"
import { firebaseConfig } from "@/lib/firebase/config"

export type AuthState =
  | { status: "loading" }
  /** byUser: ha pulsado «Salir» (no hay que recordar dónde estaba). */
  | { status: "signedOut"; byUser: boolean }
  | { status: "signedIn"; user: User }
  /** Faltan variables de Firebase: no se puede entrar y se dice por qué. */
  | { status: "misconfigured"; problems: string[] }

const AuthContext = createContext<AuthState | null>(null)

// Se marca justo antes de cerrar la sesión a petición de la persona.
let leavingByUser = false

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(
    firebaseConfig.ok ? { status: "loading" } : { status: "misconfigured", problems: firebaseConfig.problems },
  )

  useEffect(() => {
    if (!firebaseConfig.ok) return
    const { auth } = getFirebaseIdentity()
    let previousUid: string | null | undefined
    return onAuthStateChanged(auth, (user) => {
      if (previousUid !== undefined && previousUid !== (user?.uid ?? null)) cancelIdentityRequests()
      previousUid = user?.uid ?? null
      if (user) {
        leavingByUser = false
        setState({ status: "signedIn", user })
      } else {
        setState({ status: "signedOut", byUser: leavingByUser })
      }
    })
  }, [])

  return <AuthContext value={state}>{children}</AuthContext>
}

export function useAuth(): AuthState {
  const state = use(AuthContext)
  if (!state) throw new Error("useAuth necesita estar dentro de <AuthProvider>.")
  return state
}

/** Cierra la sesión porque la persona lo ha pedido. */
export async function signOut(): Promise<void> {
  leavingByUser = true
  cancelIdentityRequests()
  try {
    await firebaseSignOut(getFirebaseIdentity().auth)
  } catch (error) {
    leavingByUser = false
    throw error
  }
}
