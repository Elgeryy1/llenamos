"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Notice } from "@/components/common/notice"
import { RequirePermission } from "@/components/panel/RequirePermission"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
import { useAccion, type Alcance } from "@/lib/inventario/acciones"
import { useAjustesInventario } from "@/lib/inventario/datos"
import type { InventorySettings } from "@llenamos/core"
import { Cargado, ErrorAccion, useLocalInventario } from "./piezas"

export function AjustesInventario() {
  return (
    <RequirePermission permission="inventario.gestionar" what="los ajustes del inventario">
      <Ajustes />
    </RequirePermission>
  )
}

function Ajustes() {
  const { base, alcance } = useLocalInventario()
  const ajustes = useAjustesInventario(base)
  if (!alcance) return null
  return (
    <Cargado live={ajustes} label="los ajustes">
      {({ ajustes: a }) => <Formulario alcance={alcance} ajustes={a} />}
    </Cargado>
  )
}

function Formulario({ alcance, ajustes }: { alcance: Alcance; ajustes: InventorySettings }) {
  const { ejecutar, busy, error } = useAccion(alcance)
  const [guardando, setGuardando] = useState<keyof InventorySettings | null>(null)

  async function cambiar(clave: keyof InventorySettings, valor: boolean) {
    setGuardando(clave)
    const r = await ejecutar("guardarConfiguracionInventario", { settings: { ...ajustes, [clave]: valor } })
    setGuardando(null)
    if (r) toast.success("Ajuste guardado.")
  }

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <section className="superficie divide-y" aria-label="Ajustes del inventario">
        <Field orientation="horizontal" className="p-5">
          <FieldLabel htmlFor="descontar" className="flex-1">
            <span>
              Descontar al vender
              <FieldDescription>Cuando un plato con receta marcha a cocina, se resta del almacén lo que lleva. Si lo apagas, el stock solo cambia a mano.</FieldDescription>
            </span>
          </FieldLabel>
          <Switch id="descontar" checked={ajustes.consumeOnSale} disabled={busy} aria-busy={guardando === "consumeOnSale"} onCheckedChange={(v) => void cambiar("consumeOnSale", v)} />
        </Field>
        <Field orientation="horizontal" className="p-5">
          <FieldLabel htmlFor="avisos" className="flex-1">
            <span>
              Avisos de stock bajo
              <FieldDescription>Se crea un aviso cuando un ingrediente con mínimo llega a ese nivel, se agota o queda en negativo.</FieldDescription>
            </span>
          </FieldLabel>
          <Switch id="avisos" checked={ajustes.lowStockAlerts} disabled={busy} aria-busy={guardando === "lowStockAlerts"} onCheckedChange={(v) => void cambiar("lowStockAlerts", v)} />
        </Field>
      </section>
      <ErrorAccion error={error} />
      <Notice>
        El almacén no bloquea ventas ni marca platos como agotados. El contador de raciones del día sigue siendo manual y es lo único que limita lo que se puede pedir.
      </Notice>
    </div>
  )
}
