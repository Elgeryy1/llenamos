"use client"

import { CLOCK_STATE_LABEL, can, type ClockState, type Permission } from "@llenamos/core"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useMemo, type ReactNode } from "react"
import { GuestAvatar } from "@/components/reservas/Huesped"
import { LiveError } from "@/components/panel/LiveError"
import { usePanel } from "@/components/panel/PanelContext"
import { RequireModule } from "@/components/panel/RequireModule"
import { RequirePermission } from "@/components/panel/RequirePermission"
import { Notice } from "@/components/common/notice"
import { LoadingBlock } from "@/components/common/loading"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/cn"
import { useMembers } from "@/lib/data/hooks"
import type { MemberDoc } from "@/lib/data/parse"
import type { Alcance } from "@/lib/personal/api"

/** Puerta de cada pantalla: módulo de personal activo, permiso y un local elegido. */
export function PuertaPersonal({ permission, what, children }: { permission: Permission; what: string; children: (scope: Alcance) => ReactNode }) {
  const { restaurant, location } = usePanel()
  return (
    <RequirePermission permission={permission} what={what}>
      <RequireModule module="staff">
        {location ? (
          <div key={`${restaurant.id}:${location.id}`}>{children({ restaurantId: restaurant.id, locationId: location.id })}</div>
        ) : (
          <Notice>Elige un local para ver {what}.</Notice>
        )}
      </RequireModule>
    </RequirePermission>
  )
}

export interface Equipo {
  personas: MemberDoc[]
  /** Quienes ya no trabajan aquí: siguen teniendo registro de jornada que conservar y exportar. */
  antiguas: MemberDoc[]
  nombre: (uid: string) => string
}

/** Las personas activas con acceso a este local, con su nombre para ponerlo en filas y turnos. */
export function useEquipoLocal(restaurantId: string, locationId: string): { status: "loading" } | { status: "error"; error: unknown } | ({ status: "ready" } & Equipo) {
  const live = useMembers(restaurantId)
  return useMemo(() => {
    if (live.status !== "ready") return live.status === "error" ? { status: "error" as const, error: live.error } : { status: "loading" as const }
    const todas = live.data
    const personas = todas
      .filter((m) => m.active && (m.locationIds.length === 0 || m.locationIds.includes(locationId)))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, "es"))
    const antiguas = todas
      .filter((m) => !m.active)
      .sort((a, b) => a.displayName.localeCompare(b.displayName, "es"))
    const nombres = new Map(todas.map((m) => [m.uid, m.displayName]))
    return { status: "ready" as const, personas, antiguas, nombre: (uid: string) => nombres.get(uid) ?? "Persona que ya no está" }
  }, [live, locationId])
}

/** Carga el equipo y lo pasa a quien lo necesita; si falla, lo dice. */
export function ConEquipo({ scope, children }: { scope: Alcance; children: (equipo: Equipo) => ReactNode }) {
  const equipo = useEquipoLocal(scope.restaurantId, scope.locationId)
  if (equipo.status === "loading") return <LoadingBlock label="Cargando al equipo…" />
  if (equipo.status === "error") return <LiveError title="No se puede leer al equipo" error={equipo.error} />
  return <>{children(equipo)}</>
}

const ESTADO_CLASE: Record<ClockState | "forgotten", string> = {
  out: "bg-ash",
  working: "bg-success",
  on_break: "bg-warning",
  forgotten: "bg-destructive",
}

/** Estado de fichaje con punto y palabra (el color nunca va solo). */
export function EstadoFichaje({ state, forgotten = false, className }: { state: ClockState; forgotten?: boolean; className?: string }) {
  const clave = forgotten ? "forgotten" : state
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm", forgotten ? "text-destructive" : state === "on_break" ? "text-warning" : state === "working" ? "text-success" : "text-muted-foreground", className)}>
      <span aria-hidden className={cn("size-2 rounded-full", ESTADO_CLASE[clave], state === "out" && !forgotten && "bg-transparent ring-2 ring-ash ring-inset")} />
      {forgotten ? "Olvidado" : CLOCK_STATE_LABEL[state]}
    </span>
  )
}

export function Persona({ nombre, detalle, size = "md" }: { nombre: string; detalle?: ReactNode; size?: "sm" | "md" | "lg" }) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      <GuestAvatar name={nombre} size={size} />
      <span className="min-w-0">
        <span className="block truncate text-[15px] font-medium">{nombre}</span>
        {detalle ? <span className="block truncate text-xs text-muted-foreground">{detalle}</span> : null}
      </span>
    </span>
  )
}

const SECCIONES = [
  { href: "/panel/personal", label: "Hoy" },
  { href: "/panel/personal/horas", label: "Horas" },
  { href: "/panel/personal/cuadrante", label: "Cuadrante" },
  { href: "/panel/personal/ajustes", label: "Ajustes" },
] as const

/** Pestañas de la zona de personal para el encargado, más el acceso al puesto de fichaje. */
export function NavegacionPersonal() {
  const ruta = usePathname()
  const { role } = usePanel()
  return (
    <nav className="mb-5 flex flex-wrap items-center gap-2" aria-label="Personal">
      {SECCIONES.map((s) => {
        const activa = ruta === s.href
        return (
          <Button key={s.href} asChild variant={activa ? "secondary" : "ghost"} className="min-h-11 px-3">
            <Link href={s.href} aria-current={activa ? "page" : undefined}>{s.label}</Link>
          </Button>
        )
      })}
      {can(role, "personal.gestionar") ? (
        <Button asChild variant="outline" className="ml-auto min-h-11 px-3 shadow-soft">
          <Link href="/panel/fichaje/puesto">Abrir el puesto de fichaje</Link>
        </Button>
      ) : null}
    </nav>
  )
}
