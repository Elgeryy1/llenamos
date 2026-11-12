"use client"

import { SupplierItemEditableSchema, UNIT_LABEL, formatQuantity, parseQuantity, type SupplierItemWithId } from "@llenamos/core"
import { useState } from "react"
import { toast } from "sonner"
import { Notice } from "@/components/common/notice"
import { SelectField, TextField } from "@/components/common/form-fields"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import type { Scope } from "@/lib/compras/datos"
import { euros, eurosParaCampo, parseEuros } from "@/lib/compras/dinero"
import { precioPorUnidad } from "@/lib/compras/modelo"
import { useOperacion } from "@/lib/compras/useOperacion"
import type { Base } from "./lecturas"

const EJEMPLO: Record<string, string> = { g: "25 kg o 500 g", ml: "5 l o 750 ml", u: "12" }

/** Alta y edición de un formato: «Saco 25 kg» de un ingrediente, con su precio sin IVA. */
export function FormatoDialog({ scope, base, proveedorId, item, onClose }: { scope: Scope; base: Base; proveedorId: string; item: SupplierItemWithId | null; onClose: () => void }) {
  const edit = item !== null
  const ing0 = item ? base.ingredientePorId.get(item.ingredientId) : undefined
  const [ingredientId, setIngredientId] = useState(item?.ingredientId ?? "")
  const [name, setName] = useState(item?.name ?? "")
  const [sku, setSku] = useState(item?.sku ?? "")
  const [cantidad, setCantidad] = useState(item && ing0 ? formatQuantity(item.baseQuantity, ing0.unit) : "")
  const [precio, setPrecio] = useState(item ? eurosParaCampo(item.priceCents) : "")
  const [preferred, setPreferred] = useState(item?.preferred ?? false)
  const [active, setActive] = useState(item?.active ?? true)
  const [errores, setErrores] = useState<Record<string, string>>({})
  const op = useOperacion()

  const ing = base.ingredientePorId.get(ingredientId)
  const baseQuantity = ing ? parseQuantity(cantidad, ing.unit) : null
  const cents = parseEuros(precio)
  const actualPreferido = ing ? base.formatos.find((f) => f.ingredientId === ing.id && f.preferred && f.id !== item?.id) : undefined
  const ingredientes = base.ingredientes.filter((i) => i.active || i.id === item?.ingredientId)

  async function guardar(e: React.FormEvent) {
    e.preventDefault()
    const nuevos: Record<string, string> = {}
    if (!ing) nuevos.ingredientId = "Elige el ingrediente que vende este formato."
    if (ing && (baseQuantity === null || baseQuantity < 1)) nuevos.cantidad = `Escribe cuánto trae, en ${UNIT_LABEL[ing.unit]} o su múltiplo, sin decimales sobrantes (por ejemplo ${EJEMPLO[ing.unit]}).`
    if (cents === null) nuevos.precio = "Escribe el precio de un formato, con un máximo de dos decimales."
    const parsed = SupplierItemEditableSchema.safeParse({
      supplierId: proveedorId,
      ingredientId,
      name,
      sku: sku.trim() || null,
      baseQuantity: baseQuantity ?? 1,
      priceCents: cents ?? 0,
      preferred,
      active,
    })
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const k = String(issue.path[0])
        if (k === "name" || k === "sku") nuevos[k] ??= issue.message
        if (k === "baseQuantity") nuevos.cantidad ??= "La cantidad del formato es demasiado grande."
      }
    }
    setErrores(nuevos)
    if (!parsed.success || Object.keys(nuevos).length > 0) return
    const out = await op.run("guardarFormatoProveedor", { ...scope, itemId: item?.id ?? null, item: parsed.data })
    if (!out) return
    toast.success(edit ? "Formato guardado" : "Formato añadido")
    onClose()
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{edit ? "Editar formato" : "Añadir formato"}</DialogTitle>
          <DialogDescription>El formato en que compras: se pide y se recibe por formatos enteros y entra en el almacén en la unidad base del ingrediente.</DialogDescription>
        </DialogHeader>
        <form onSubmit={guardar} noValidate className="flex flex-col gap-4">
          <SelectField
            label="Ingrediente"
            value={ingredientId}
            onChange={(e) => setIngredientId(e.target.value)}
            disabled={edit}
            error={errores.ingredientId}
            hint={edit ? "Un formato no cambia de ingrediente: crea otro." : "Solo ingredientes activos del almacén."}
          >
            <option value="">Elige un ingrediente</option>
            {ingredientes.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} ({UNIT_LABEL[i.unit]})
              </option>
            ))}
          </SelectField>
          <TextField label="Nombre del formato" value={name} onChange={(e) => setName(e.target.value)} error={errores.name} placeholder="Saco 25 kg" maxLength={80} autoComplete="off" />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Cuánto trae"
              value={cantidad}
              onChange={(e) => setCantidad(e.target.value)}
              error={errores.cantidad}
              hint={ing ? `Por ejemplo ${EJEMPLO[ing.unit]}` : "Elige antes el ingrediente."}
              disabled={!ing}
              className="cifra"
              autoComplete="off"
            />
            <TextField
              label="Precio sin IVA (€)"
              inputMode="decimal"
              value={precio}
              onChange={(e) => setPrecio(e.target.value)}
              error={errores.precio}
              hint={
                ing && baseQuantity && cents !== null && baseQuantity > 0
                  ? precioPorUnidad(cents, baseQuantity, ing.unit)
                  : "Lo que cuesta un formato entero."
              }
              className="cifra"
              autoComplete="off"
            />
          </div>
          <TextField label="Código del proveedor (opcional)" value={sku} onChange={(e) => setSku(e.target.value)} error={errores.sku} maxLength={40} autoComplete="off" />
          <Field orientation="horizontal">
            <Switch id="formato-preferido" checked={preferred} onCheckedChange={setPreferred} />
            <FieldLabel htmlFor="formato-preferido" className="font-normal">
              Preferido para este ingrediente (el que se propone al sugerir pedidos)
            </FieldLabel>
          </Field>
          {preferred && actualPreferido ? (
            <Notice tone="info">
              Hoy el preferido es «{actualPreferido.name}» de {base.proveedorPorId.get(actualPreferido.supplierId)?.name ?? "otro proveedor"}. Solo puede haber uno por ingrediente: dejará de serlo.
            </Notice>
          ) : null}
          <Field orientation="horizontal">
            <Switch id="formato-activo" checked={active} onCheckedChange={setActive} />
            <FieldLabel htmlFor="formato-activo" className="font-normal">
              Activo (un formato desactivado no se pide ni se sugiere)
            </FieldLabel>
          </Field>
          {edit && item.lastPriceCents !== null ? (
            <p className="text-xs text-muted-foreground">
              Último precio pagado: <span className="cifra text-soft-foreground">{euros(item.lastPriceCents)}</span>. Lo escribe la recepción de mercancía.
            </p>
          ) : null}
          {op.error ? <Notice tone="error">{op.error}</Notice> : null}
          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" size="lg" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" size="lg" disabled={op.busy}>
              {op.busy ? <Spinner role="presentation" aria-label={undefined} aria-hidden /> : null}
              {op.busy ? "Guardando…" : edit ? "Guardar formato" : "Añadir formato"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
