"use client"

import { TruckIcon } from "@phosphor-icons/react"
import type { ReactNode } from "react"
import { EmptyState } from "@/components/common/empty-state"
import { usePanel } from "@/components/panel/PanelContext"
import { RequireModule } from "@/components/panel/RequireModule"
import { RequirePermission } from "@/components/panel/RequirePermission"
import type { Scope } from "@/lib/compras/datos"

/** Permiso `compras.gestionar`, módulo `inventory` y un local elegido; entrega el ámbito a la vista. */
export function ComprasGate({ children }: { children: (scope: Scope, localName: string) => ReactNode }) {
  const { restaurant, location } = usePanel()
  return (
    <RequirePermission permission="compras.gestionar" what="las compras">
      <RequireModule module="inventory">
        {location ? (
          <div key={`${restaurant.id}:${location.id}`}>{children({ restaurantId: restaurant.id, locationId: location.id }, location.name)}</div>
        ) : (
          <EmptyState title="Elige un local" description="Cada local tiene sus propios proveedores y pedidos." icon={<TruckIcon />} />
        )}
      </RequireModule>
    </RequirePermission>
  )
}
