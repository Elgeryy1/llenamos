"use client"

import { can, type Permission } from "@llenamos/core"
import type { ReactNode } from "react"
import { usePanel } from "./PanelContext"
import { NoAccess } from "./PanelStates"

/**
 * Enseña la página solo si el rol tiene el permiso. Es comodidad para la persona:
 * la seguridad de verdad está en las reglas y en las funciones.
 */
export function RequirePermission({
  permission,
  what,
  children,
}: {
  permission: Permission
  /** «el equipo», «la actividad»… para el mensaje de sin acceso. */
  what: string
  children: ReactNode
}) {
  const { role } = usePanel()
  if (!can(role, permission)) return <NoAccess what={what} />
  return <>{children}</>
}
