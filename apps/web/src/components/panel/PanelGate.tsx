"use client"

import { usePathname, useRouter } from "next/navigation"
import { useEffect, type ReactNode } from "react"
import type { User } from "firebase/auth"
import { useAuth } from "@/lib/auth/AuthProvider"
import { hasRestaurantAccess, useAccountAccess } from "@/lib/auth/account-access"
import { Notice } from "@/components/common/notice"
import { PanelData } from "./PanelData"
import { PanelShell } from "./PanelShell"
import { ConfigProblems, FullScreenError, PanelSkeleton, StandaloneFrame, StandaloneFrameBare } from "./PanelStates"

/**
 * Protege el panel: sin sesión se va a /entrar y se vuelve aquí después.
 * La sesión vive en el navegador (Firebase Auth), así que se comprueba aquí y
 * la API SQL comprueba permisos en cada lectura del VPS.
 */
export function PanelGate({ children }: { children: ReactNode }) {
  const auth = useAuth()
  const router = useRouter()
  const pathname = usePathname()

  const signedOutByUser = auth.status === "signedOut" && auth.byUser
  useEffect(() => {
    if (auth.status !== "signedOut") return
    // Si ha pulsado «Salir», la próxima persona empieza en el inicio del panel.
    router.replace(signedOutByUser ? "/entrar" : `/entrar?siguiente=${encodeURIComponent(pathname)}`)
  }, [auth.status, signedOutByUser, pathname, router])

  if (auth.status === "misconfigured") {
    return (
      <StandaloneFrameBare>
        <ConfigProblems problems={auth.problems} />
      </StandaloneFrameBare>
    )
  }
  if (auth.status !== "signedIn") return <PanelSkeleton />
  return <SignedInPanelGate key={auth.user.uid} user={auth.user}>{children}</SignedInPanelGate>
}

function SignedInPanelGate({ user, children }: { user: User; children: ReactNode }) {
  const access = useAccountAccess(user)
  const router = useRouter()
  const platform = access.status === "ready" && access.data.access === "platform"
  useEffect(() => { if (platform) router.replace("/logiqd") }, [platform, router])
  if (access.status === "loading" || platform) return <PanelSkeleton />
  if (access.status === "error") return <FullScreenError title="No se ha podido comprobar tu acceso" error={access.error} />
  if (!hasRestaurantAccess(access.data)) return <StandaloneFrame><Notice tone="error" title="No tienes restaurantes asignados">Pide al propietario o al equipo LogiQD que configure tu acceso.</Notice></StandaloneFrame>

  // La clave es la persona: si cambia la cuenta sin pasar por «sin sesión» (por
  // ejemplo, desde otra pestaña), no se arrastra nada de la anterior.
  return (
    <PanelData key={user.uid} user={user}>
      <PanelShell>{children}</PanelShell>
    </PanelData>
  )
}
