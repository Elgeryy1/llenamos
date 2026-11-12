"use client"

import { MinusCircleIcon } from "@phosphor-icons/react"
import { can, hasModule } from "@llenamos/core"
import { useState } from "react"
import { usePanel } from "@/components/panel/PanelContext"
import { Button } from "@/components/ui/button"
import { useIngredientes } from "@/lib/inventario/datos"
import { MermaDialog } from "./MermaDialog"

/**
 * Acceso directo a «Registrar merma» desde las pantallas de cocina y barra. Reutiliza el diálogo
 * del inventario (sin costes). No pinta nada si falta el permiso o el módulo de inventario, y no
 * escucha los ingredientes hasta que se abre.
 */
export function MermaRapida() {
  const { restaurant, location, role } = usePanel()
  const [abierto, setAbierto] = useState(false)
  if (!location || !hasModule(restaurant, "inventory") || !can(role, "inventario.mermar")) return null
  return (
    <>
      <Button variant="outline" size="xl" onClick={() => setAbierto(true)}>
        <MinusCircleIcon aria-hidden />
        Registrar merma
      </Button>
      {abierto ? <MermaAbierta restaurantId={restaurant.id} locationId={location.id} onClose={() => setAbierto(false)} /> : null}
    </>
  )
}

function MermaAbierta({ restaurantId, locationId, onClose }: { restaurantId: string; locationId: string; onClose: () => void }) {
  const ingredientes = useIngredientes(`restaurants/${restaurantId}/locations/${locationId}`)
  if (ingredientes.status !== "ready") return null
  return (
    <MermaDialog
      alcance={{ restaurantId, locationId }}
      ingredientes={ingredientes.data}
      elegido={null}
      onClose={onClose}
    />
  )
}
