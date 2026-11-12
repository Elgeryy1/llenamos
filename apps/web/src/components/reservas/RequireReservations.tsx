"use client"

import { hasModule, PLAN_LABEL } from "@llenamos/core"
import { CalendarXIcon, StorefrontIcon } from "@phosphor-icons/react"
import type { ReactNode } from "react"
import { EmptyState } from "@/components/common/empty-state"
import { usePanel } from "@/components/panel/PanelContext"
import { accesoVencido, TEXTO_ACCESO_VENCIDO } from "@/lib/panel/acceso"

/**
 * Enseña la página solo si el restaurante tiene el módulo de reservas activo y un local.
 * Si no, explica por qué. Las reglas y las funciones lo vuelven a comprobar.
 */
export function RequireReservations({ children }: { children: ReactNode }) {
  const { restaurant, location } = usePanel()
  if (!hasModule(restaurant, "reservations")) {
    return (
      <EmptyState
        icon={<CalendarXIcon size={22} />}
        title={accesoVencido(restaurant) ? "El servicio está en pausa" : "El módulo de reservas no está activo"}
        description={
          accesoVencido(restaurant)
            ? TEXTO_ACCESO_VENCIDO
            : restaurant.plan
            ? `Tu plan (${PLAN_LABEL[restaurant.plan]}) no incluye reservas o LogiQD lo ha desactivado. Si lo necesitas, habla con LogiQD.`
            : "Este restaurante no tiene las reservas activadas. Si lo necesitas, habla con LogiQD."
        }
      />
    )
  }
  if (!location) {
    return (
      <EmptyState
        icon={<StorefrontIcon size={22} />}
        title="Este restaurante aún no tiene locales"
        description="Las reservas van por local. Cuando haya uno con sus mesas, aparecerán aquí."
      />
    )
  }
  return <>{children}</>
}
