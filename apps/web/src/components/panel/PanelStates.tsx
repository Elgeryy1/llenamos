"use client"

import { LockKeyIcon } from "@phosphor-icons/react"
import type { ReactNode } from "react"
import { Wordmark } from "@/components/Wordmark"
import Link from "next/link"
import { EmptyState } from "@/components/common/empty-state"
import { Notice } from "@/components/common/notice"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { signOut } from "@/lib/auth/AuthProvider"
import { describeError } from "@/lib/firebase/errors"

/** Esqueleto del panel entero mientras llegan los datos (misma forma que sidebar-07). */
export function PanelSkeleton() {
  return (
    <div role="status" aria-live="polite" className="flex min-h-dvh">
      <span className="sr-only">Cargando el panel…</span>
      <aside className="hidden w-64 shrink-0 flex-col gap-4 border-r bg-sidebar p-2 md:flex">
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-12 w-full" />
        <div className="mt-2 flex flex-col gap-1.5">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      </aside>
      <div className="flex flex-1 flex-col">
        <div className="h-12 border-b" />
        <main className="flex flex-col gap-6 p-4 md:p-6 lg:p-8">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-80 max-w-full" />
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
        </main>
      </div>
    </div>
  )
}

/** Marco centrado para pantallas fuera del panel (crear restaurante, sin acceso, errores). */
export function StandaloneFrame({ children }: { children: ReactNode }) {
  return (
    <StandaloneFrameBare
      action={
        <Button variant="ghost" onClick={() => void signOut()}>
          Salir
        </Button>
      }
    >
      {children}
    </StandaloneFrameBare>
  )
}

/** Igual, sin botón de salir (para cuando no hay sesión). */
export function StandaloneFrameBare({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between px-6 py-5">
        <Wordmark />
        {action}
      </header>
      <main className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center px-6 pb-20">{children}</main>
    </div>
  )
}

export function FullScreenError({ title, error }: { title: string; error: unknown }) {
  const info = describeError(error)
  return (
    <StandaloneFrame>
      <Notice
        tone="error"
        title={title}
        detail={info.code}
        action={
          <Button variant="outline" onClick={() => window.location.reload()}>
            Volver a cargar
          </Button>
        }
      >
        {info.message}
      </Notice>
    </StandaloneFrame>
  )
}

/** Página del panel que el rol de esta persona no puede ver. */
export function NoAccess({ what }: { what: string }) {
  return (
    <EmptyState
      icon={<LockKeyIcon />}
      title={`Tu rol no puede ver ${what}`}
      description="Si lo necesitas para tu trabajo, pide a un propietario o encargado que cambie tu rol."
      action={
        <Button asChild variant="outline">
          <Link href="/panel">Volver al inicio</Link>
        </Button>
      }
    />
  )
}

/** Faltan variables de entorno: se dice cuáles en vez de fallar en silencio. */
export function ConfigProblems({ problems }: { problems: string[] }) {
  return (
    <Notice tone="error" title="Firebase no está configurado" detail="apps/web/.env.local">
      <ul className="mt-1 list-disc space-y-1 pl-4">
        {problems.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      <p className="mt-2">Copia apps/web/.env.example como apps/web/.env.local y vuelve a arrancar la web.</p>
    </Notice>
  )
}
