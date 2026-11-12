"use client"

import { MODULE_LABEL, hasModule, type Module } from "@llenamos/core"
import { PuzzlePieceIcon } from "@phosphor-icons/react"
import Link from "next/link"
import type { ReactNode } from "react"
import { EmptyState } from "@/components/common/empty-state"
import { Button } from "@/components/ui/button"
import { accesoVencido, TEXTO_ACCESO_VENCIDO } from "@/lib/panel/acceso"
import { usePanel } from "./PanelContext"

/**
 * Enseña la página solo si el restaurante tiene el módulo activo. Como con los
 * permisos, es comodidad: las reglas y las funciones lo vuelven a comprobar.
 */
export function RequireModule({ module, children }: { module: Module; children: ReactNode }) {
  const { restaurant } = usePanel()
  if (hasModule(restaurant, module)) return <>{children}</>
  const vencido = accesoVencido(restaurant)
  return (
    <EmptyState
      icon={<PuzzlePieceIcon />}
      title={vencido ? "El servicio está en pausa" : `El módulo ${MODULE_LABEL[module]} no está activo`}
      description={vencido ? TEXTO_ACCESO_VENCIDO : `${restaurant.name} no tiene ${MODULE_LABEL[module].toLowerCase()} en su plan. Para activarlo, habla con LogiQD. En Ajustes ves qué incluye tu plan.`}
      action={
        <Button variant="outline" size="sm" asChild>
          {vencido ? <Link href="/panel/planes">Plan y facturación</Link> : <Link href="/panel/ajustes">Ver mi plan</Link>}
        </Button>
      }
    />
  )
}
