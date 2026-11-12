"use client"

import { WASTE_REASONS, WASTE_REASON_LABEL, type IngredientWithId, type WasteReason } from "@llenamos/core"
import { useState } from "react"
import { toast } from "sonner"
import { SelectField, TextField } from "@/components/common/form-fields"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useAccion, type Alcance } from "@/lib/inventario/acciones"
import { ayudaCantidad, leerCantidad, textoCantidad } from "@/lib/inventario/modelo"
import { BotonAccion, ErrorAccion } from "./piezas"

/** Apuntar una merma: sin costes, lo puede hacer cocina y barra. */
export function MermaDialog({
  alcance,
  ingredientes,
  elegido,
  onClose,
}: {
  alcance: Alcance
  ingredientes: readonly IngredientWithId[]
  elegido: IngredientWithId | null
  onClose: () => void
}) {
  const { ejecutar, busy, error, limpiar } = useAccion(alcance)
  const [ingredienteId, setIngredienteId] = useState(elegido?.id ?? "")
  const [cantidad, setCantidad] = useState("")
  const [motivo, setMotivo] = useState<WasteReason>("spoiled")
  const [nota, setNota] = useState("")
  const [errorCampo, setErrorCampo] = useState<string | null>(null)
  const ingrediente = ingredientes.find((i) => i.id === ingredienteId) ?? null

  async function guardar() {
    if (!ingrediente) return setErrorCampo("Elige qué se ha tirado.")
    const q = leerCantidad(cantidad, ingrediente.unit)
    if (!q.ok) return setErrorCampo(q.error)
    setErrorCampo(null)
    const r = await ejecutar("registrarMerma", {
      ingredientId: ingrediente.id, quantity: q.valor, wasteReason: motivo, reason: nota.trim() === "" ? null : nota.trim(),
    })
    if (!r) return
    toast.success(`Merma apuntada. Quedan ${textoCantidad(r.quantityAfter, ingrediente.unit)} de ${ingrediente.name.toLocaleLowerCase("es")}.`)
    onClose()
  }

  return (
    <Dialog open onOpenChange={(abierto) => { if (!abierto && !busy) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Apuntar merma</DialogTitle>
          <DialogDescription>Lo que se tira o se pierde. Se resta del almacén y queda en el historial con tu nombre.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            void guardar()
          }}
        >
          <SelectField label="Qué se ha perdido" value={ingredienteId} onChange={(e) => { setIngredienteId(e.target.value); limpiar() }} className="pointer-coarse:h-11">
            <option value="">Elige un ingrediente</option>
            {ingredientes.filter((i) => i.active || i.id === ingredienteId).map((i) => (
              <option key={i.id} value={i.id}>{i.name}</option>
            ))}
          </SelectField>
          <TextField
            label="Cuánto"
            inputMode="decimal"
            autoComplete="off"
            value={cantidad}
            onChange={(e) => setCantidad(e.target.value)}
            error={errorCampo}
            hint={ingrediente ? `${ayudaCantidad(ingrediente.unit)} Ahora hay ${textoCantidad(ingrediente.quantity, ingrediente.unit)}.` : "Elige primero el ingrediente."}
          />
          <SelectField label="Por qué" value={motivo} onChange={(e) => setMotivo(e.target.value as WasteReason)} className="pointer-coarse:h-11">
            {WASTE_REASONS.map((r) => (
              <option key={r} value={r}>{WASTE_REASON_LABEL[r]}</option>
            ))}
          </SelectField>
          <TextField label="Nota (opcional)" value={nota} maxLength={200} onChange={(e) => setNota(e.target.value)} />
          <ErrorAccion error={error} />
          <DialogFooter>
            <Button type="button" variant="outline" size="xl" disabled={busy} onClick={onClose}>Volver</Button>
            <BotonAccion type="submit" size="xl" busy={busy} ocupado="Guardando…">Apuntar merma</BotonAccion>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
