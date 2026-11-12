"use client"

import { FASE5_ACCESS } from "@llenamos/core"
import Link from "next/link"
import { usePathname } from "next/navigation"
import type { ReactNode } from "react"
import { Notice } from "@/components/common/notice"
import { RequireModule } from "@/components/panel/RequireModule"
import { RequirePermission } from "@/components/panel/RequirePermission"
import { usePanel } from "@/components/panel/PanelContext"
import { cn } from "@/lib/cn"
import { errorMarketing } from "@/lib/campanas/api"

export function MarcoCampanas({ children, origen = false }: { children: ReactNode; origen?: boolean }) {
  const access = FASE5_ACCESS[origen ? "informeOrigen" : "guardarCampana"]
  const { restaurant } = usePanel()
  if (access.permission === "public" || access.permission === "logiqd")
    throw new Error("El contrato no define un permiso de personal para esta pantalla.")
  return (
    <RequirePermission permission={access.permission} what={origen ? "el informe de origen" : "las campañas"}>
      <RequireModule module={access.modules[0]}>
        <div key={restaurant.id} className="space-y-5">
          {children}
        </div>
      </RequireModule>
    </RequirePermission>
  )
}

export function NavCampanas() {
  const pathname = usePathname()
  return (
    <nav aria-label="Campañas y origen" className="flex flex-wrap gap-1 border-b pb-3">
      {[
        ["/panel/campanas", "Campañas"],
        ["/panel/campanas/segmentos", "Segmentos"],
        ["/panel/campanas/origen", "Origen"],
        ["/panel/campanas/ajustes", "Ajustes"],
      ].map(([href, label]) => (
        <Link
          key={href}
          href={href}
          aria-current={pathname === href ? "page" : undefined}
          className={cn(
            "inline-flex min-h-11 items-center rounded-lg px-4 text-sm text-muted-foreground hover:bg-surface-raised",
            pathname === href && "bg-surface-raised text-foreground shadow-soft",
          )}
        >
          {label}
        </Link>
      ))}
    </nav>
  )
}

export function ErrorLectura({ error }: { error: unknown }) {
  return (
    <Notice tone="warning" title="Los datos de campañas no están disponibles">
      <p>{errorMarketing(error)}</p>
    </Notice>
  )
}
export function AvisoFixture() {
  return (
    <Notice tone="warning" title="Fixture de diseño · datos inventados">
      Estos ejemplos no son datos del restaurante. Guardar, lanzar y cancelar están desactivados. No se llama al backend ni se envía ningún
      mensaje.
    </Notice>
  )
}
