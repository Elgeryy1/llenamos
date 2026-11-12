"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useEffect } from "react"
import { LockKeyIcon } from "@phosphor-icons/react"
import { EmptyState } from "@/components/common/empty-state"
import { Wordmark } from "@/components/Wordmark"
import { LiveError } from "@/components/panel/LiveError"
import { ConfigProblems, PanelSkeleton } from "@/components/panel/PanelStates"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { signOut, useAuth } from "@/lib/auth/AuthProvider"
import { useAccountAccess } from "@/lib/auth/account-access"
import { PlatformRestaurants } from "@/components/logiqd/PlatformRestaurants"
import type { User } from "firebase/auth"

/** Panel interno del equipo de LogiQD: plan y módulos de cada restaurante. */
export function LogiqdView() {
  const auth = useAuth()
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    if (auth.status === "signedOut") router.replace(auth.byUser ? "/entrar" : `/entrar?siguiente=${encodeURIComponent(pathname)}`)
  }, [auth, pathname, router])

  if (auth.status === "misconfigured") {
    return (
      <Frame>
        <ConfigProblems problems={auth.problems} />
      </Frame>
    )
  }
  if (auth.status !== "signedIn") return <PanelSkeleton />
  return <Gate key={auth.user.uid} user={auth.user} />
}

function Frame({ children, user }: { children: React.ReactNode; user?: User }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between gap-3 border-b bg-sidebar px-4 py-3 sm:px-6">
        <div className="flex min-w-0 flex-wrap items-center gap-2 sm:gap-3">
          <Wordmark />
          <Badge variant="outline">Equipo LogiQD</Badge>
        </div>
        {user ? (
          <div className="flex items-center gap-3">
            <span className="hidden truncate text-sm text-muted-foreground sm:inline">{user.email}</span>
            <Button variant="ghost" size="sm" onClick={() => void signOut()}>
              Salir
            </Button>
          </div>
        ) : null}
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 md:py-10">{children}</main>
    </div>
  )
}

function Gate({ user }: { user: User }) {
  const access = useAccountAccess(user)
  if (access.status === "loading") return <PanelSkeleton />
  if (access.status === "error") {
    return (
      <Frame user={user}>
        <LiveError title="No se ha podido comprobar tu acceso" error={access.error} />
      </Frame>
    )
  }
  if (access.data.access !== "platform") {
    return (
      <Frame user={user}>
        <EmptyState
          icon={<LockKeyIcon />}
          title="Esta página es solo para el equipo de LogiQD"
          description="Desde aquí se cambia el plan y los módulos de los restaurantes. Si trabajas en un restaurante, tu sitio es el panel."
          action={
            <Button variant="outline" size="sm" asChild>
              <Link href="/panel">Ir al panel</Link>
            </Button>
          }
        />
      </Frame>
    )
  }
  return (
    <Frame user={user}>
      <PlatformRestaurants />
    </Frame>
  )
}
