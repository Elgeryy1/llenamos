"use client"

import type { BaseUnit, IngredientWithId } from "@llenamos/core"
import { useState } from "react"
import { toast } from "sonner"
import { SelectField, TextField } from "@/components/common/form-fields"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
import { useAccion, type Alcance } from "@/lib/inventario/acciones"
import { ayudaCantidad, leerCantidad, leerEuros, textoCantidad } from "@/lib/inventario/modelo"
import { BotonAccion, ErrorAccion } from "./piezas"

const UNIDADES: { value: BaseUnit; label: string }[] = [
  { value: "g", label: "Gramos (se pueden escribir en kg)" },
  { value: "ml", label: "Mililitros (se pueden escribir en cl o l)" },
  { value: "u", label: "Unidades" },
]

type Errores = Partial<Record<"name" | "min" | "target" | "opening" | "value", string>>

/** Crear o editar un ingrediente. Las existencias iniciales solo se fijan al crear. */
export function IngredienteDialog({
  alcance, ingrediente, categorias, onClose,
}: { alcance: Alcance; ingrediente: IngredientWithId | null; categorias: readonly string[]; onClose: () => void }) {
  const { ejecutar, busy, error } = useAccion(alcance)
  const nuevo = ingrediente === null
  const [name, setName] = useState(ingrediente?.name ?? "")
  const [unit, setUnit] = useState<BaseUnit>(ingrediente?.unit ?? "g")
  const [category, setCategory] = useState(ingrediente?.category ?? "")
  const [min, setMin] = useState(ingrediente ? String(ingrediente.minQuantity) : "0")
  const [target, setTarget] = useState(ingrediente?.targetQuantity != null ? String(ingrediente.targetQuantity) : "")
  const [active, setActive] = useState(ingrediente?.active ?? true)
  const [opening, setOpening] = useState("")
  const [value, setValue] = useState("")
  const [errores, setErrores] = useState<Errores>({})

  async function guardar() {
    const e: Errores = {}
    if (name.trim() === "") e.name = "Escribe un nombre."
    const m = leerCantidad(min, unit, { permitirCero: true })
    if (!m.ok) e.min = m.error
    const t = target.trim() === "" ? null : leerCantidad(target, unit, { permitirCero: true })
    if (t && !t.ok) e.target = t.error
    if (m.ok && t?.ok && t.valor < m.valor) e.target = "El objetivo no puede ser menor que el mínimo."
    let apertura: { quantity: number; valueCents: number } | null = null
    if (nuevo && opening.trim() !== "") {
      const q = leerCantidad(opening, unit)
      if (!q.ok) e.opening = q.error
      const v = value.trim() === "" ? 0 : leerEuros(value)
      if (v === null) e.value = "Escribe un importe, por ejemplo 12,50."
      if (q.ok && v !== null) apertura = { quantity: q.valor, valueCents: v }
    }
    setErrores(e)
    if (Object.keys(e).length > 0 || !m.ok) return
    const r = await ejecutar("guardarIngrediente", {
      ingredientId: ingrediente?.id ?? null,
      expectedRevision: ingrediente?.revision ?? null,
      ingredient: {
        name: name.trim(), unit, category: category.trim() === "" ? null : category.trim(),
        minQuantity: m.valor, targetQuantity: t?.ok ? t.valor : null, active,
      },
      opening: apertura,
    })
    if (!r) return
    toast.success(nuevo ? "Ingrediente creado." : "Ingrediente guardado.")
    onClose()
  }

  return (
    <Dialog open onOpenChange={(abierto) => { if (!abierto && !busy) onClose() }}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{nuevo ? "Nuevo ingrediente" : `Editar ${ingrediente.name.toLocaleLowerCase("es")}`}</DialogTitle>
          <DialogDescription>
            Las cantidades se guardan en enteros: gramos, mililitros o unidades. El coste lo calcula el servidor con lo que se recibe.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(ev) => { ev.preventDefault(); void guardar() }}>
          <TextField label="Nombre" value={name} maxLength={80} onChange={(ev) => setName(ev.target.value)} error={errores.name} />
          <SelectField
            label="Unidad base"
            value={unit}
            disabled={!nuevo}
            onChange={(ev) => setUnit(ev.target.value as BaseUnit)}
            hint={nuevo ? "No se puede cambiar cuando ya hay movimientos." : "La unidad no se cambia una vez creado."}
          >
            {UNIDADES.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
          </SelectField>
          <div>
            <TextField label="Categoría" value={category} maxLength={40} onChange={(ev) => setCategory(ev.target.value)} hint="Sirve para agrupar y filtrar. Es opcional." />
            {categorias.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Categorías que ya existen">
                {categorias.map((c) => (
                  <Button key={c} type="button" size="sm" variant={c === category ? "secondary" : "outline"} onClick={() => setCategory(c)}>{c}</Button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="Avisar a partir de" inputMode="decimal" value={min} onChange={(ev) => setMin(ev.target.value)} error={errores.min} hint={`${ayudaCantidad(unit)} Con 0 no hay aviso.`} />
            <TextField label="Reponer hasta (opcional)" inputMode="decimal" value={target} onChange={(ev) => setTarget(ev.target.value)} error={errores.target} hint="Sin dato, el doble del aviso." />
          </div>
          {nuevo ? (
            <fieldset className="grid gap-4 rounded-lg border p-3 sm:grid-cols-2">
              <legend className="px-1 text-sm font-medium">Existencias de partida (opcional)</legend>
              <TextField label="Cuánto hay hoy" inputMode="decimal" value={opening} onChange={(ev) => setOpening(ev.target.value)} error={errores.opening} hint={ayudaCantidad(unit)} />
              <TextField label="Lo que valen, sin IVA" inputMode="decimal" value={value} onChange={(ev) => setValue(ev.target.value)} error={errores.value} hint="En euros. Sirve para el coste medio." />
            </fieldset>
          ) : (
            <p className="text-sm text-muted-foreground">Ahora hay {textoCantidad(ingrediente.quantity, ingrediente.unit)}. Para cambiarlo usa Ajustar, Merma o un recuento.</p>
          )}
          <Field orientation="horizontal">
            <FieldLabel htmlFor="ingrediente-activo" className="flex-1">
              <span>
                En uso
                <FieldDescription>Apagado, el ingrediente no sale al apuntar merma ni al hacer recetas nuevas.</FieldDescription>
              </span>
            </FieldLabel>
            <Switch id="ingrediente-activo" checked={active} onCheckedChange={setActive} />
          </Field>
          <ErrorAccion error={error} />
          <DialogFooter>
            <Button type="button" variant="outline" size="lg" disabled={busy} onClick={onClose}>Volver</Button>
            <BotonAccion type="submit" size="lg" busy={busy} ocupado="Guardando…">{nuevo ? "Crear ingrediente" : "Guardar cambios"}</BotonAccion>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
