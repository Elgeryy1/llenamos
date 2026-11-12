"use client"

import type { IngredientWithId } from "@llenamos/core"
import { useState } from "react"
import { toast } from "sonner"
import { SegmentedControl } from "@/components/common/segmented-control"
import { TextField } from "@/components/common/form-fields"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useAccion, type Alcance } from "@/lib/inventario/acciones"
import { ayudaCantidad, leerCantidad, textoCantidad } from "@/lib/inventario/modelo"
import { BotonAccion, ErrorAccion } from "./piezas"

type Tipo = "mas" | "menos" | "devolucion"

/** Ajuste manual de existencias o devolución a un proveedor. Siempre con motivo. */
export function AjusteDialog({ alcance, ingrediente, onClose }: { alcance: Alcance; ingrediente: IngredientWithId; onClose: () => void }) {
  const { ejecutar, busy, error } = useAccion(alcance)
  const [tipo, setTipo] = useState<Tipo>("mas")
  const [cantidad, setCantidad] = useState("")
  const [motivo, setMotivo] = useState("")
  const [errorCampo, setErrorCampo] = useState<{ campo: "cantidad" | "motivo"; texto: string } | null>(null)

  async function guardar() {
    const q = leerCantidad(cantidad, ingrediente.unit)
    if (!q.ok) return setErrorCampo({ campo: "cantidad", texto: q.error })
    if (motivo.trim() === "") return setErrorCampo({ campo: "motivo", texto: "Escribe el motivo." })
    setErrorCampo(null)
    const r = await ejecutar("ajustarStock", {
      ingredientId: ingrediente.id,
      kind: tipo === "devolucion" ? "supplier_return" : "adjustment",
      quantity: tipo === "menos" ? -q.valor : q.valor,
      reason: motivo.trim(),
    })
    if (!r) return
    toast.success(`Ajuste guardado. Ahora hay ${textoCantidad(r.quantityAfter, ingrediente.unit)}.`)
    onClose()
  }

  return (
    <Dialog open onOpenChange={(abierto) => { if (!abierto && !busy) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Ajustar {ingrediente.name.toLocaleLowerCase("es")}</DialogTitle>
          <DialogDescription>Ahora hay {textoCantidad(ingrediente.quantity, ingrediente.unit)}. Para corregir muchos de golpe, mejor haz un recuento.</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void guardar() }}>
          <SegmentedControl
            label="Tipo de ajuste"
            value={tipo}
            onValueChange={setTipo}
            options={[
              { value: "mas", label: "Sumar" },
              { value: "menos", label: "Restar" },
              { value: "devolucion", label: "Devolver al proveedor" },
            ]}
          />
          <TextField
            label="Cantidad"
            inputMode="decimal"
            autoComplete="off"
            value={cantidad}
            onChange={(e) => setCantidad(e.target.value)}
            error={errorCampo?.campo === "cantidad" ? errorCampo.texto : null}
            hint={ayudaCantidad(ingrediente.unit)}
          />
          <TextField
            label="Motivo"
            value={motivo}
            maxLength={200}
            onChange={(e) => setMotivo(e.target.value)}
            error={errorCampo?.campo === "motivo" ? errorCampo.texto : null}
            hint="Queda en el historial. Por ejemplo, entrada sin albarán o error al contar."
          />
          <ErrorAccion error={error} />
          <DialogFooter>
            <Button type="button" variant="outline" size="lg" disabled={busy} onClick={onClose}>Volver</Button>
            <BotonAccion type="submit" size="lg" busy={busy} ocupado="Guardando…">Guardar ajuste</BotonAccion>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
