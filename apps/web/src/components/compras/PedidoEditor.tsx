"use client"

import { cantidadFormato } from "@/lib/compras/modelo"
import { horaLocal, purchaseTotal, type PurchaseOrderWithId } from "@llenamos/core"
import { TrashIcon } from "@phosphor-icons/react"
import { useState } from "react"
import { toast } from "sonner"
import { DateInput } from "@/components/common/date-picker"
import { SelectField, TextareaField } from "@/components/common/form-fields"
import { Notice } from "@/components/common/notice"
import { usePanel } from "@/components/panel/PanelContext"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import type { Scope } from "@/lib/compras/datos"
import { useNow } from "@/lib/use-now"
import { euros } from "@/lib/compras/dinero"
import { useOperacion } from "@/lib/compras/useOperacion"
import type { Base } from "./lecturas"

export interface PresetPedido {
  supplierId: string
  lines: { supplierItemId: string; formats: number }[]
}

interface Linea {
  supplierItemId: string
  formats: string
}

/**
 * Crear o editar un borrador. El precio que se enseña es el de lista de hoy; al guardar, el
 * servidor vuelve a poner el de cada formato y calcula el total, nunca se envía desde aquí.
 */
export function PedidoEditor({
  scope,
  base,
  pedido,
  preset,
  onClose,
  onSaved,
}: {
  scope: Scope
  base: Base
  pedido: PurchaseOrderWithId | null
  preset: PresetPedido | null
  onClose: () => void
  onSaved: (orderId: string) => void
}) {
  const { restaurant } = usePanel()
  const ahora = useNow()
  const hoy = horaLocal(ahora.getTime(), restaurant.timezone).fecha
  const [supplierId, setSupplierId] = useState(pedido?.supplierId ?? preset?.supplierId ?? "")
  const [lineas, setLineas] = useState<Linea[]>(() =>
    pedido
      ? pedido.lines.map((l) => ({ supplierItemId: l.supplierItemId, formats: String(l.orderedFormats) }))
      : (preset?.lines ?? []).map((l) => ({ supplierItemId: l.supplierItemId, formats: String(l.formats) })),
  )
  const [expectedOn, setExpectedOn] = useState(pedido?.expectedOn ?? "")
  const [notes, setNotes] = useState(pedido?.notes ?? "")
  const [error, setError] = useState<string | null>(null)
  const op = useOperacion()

  const proveedor = base.proveedorPorId.get(supplierId)
  const disponibles = base.formatos.filter((f) => f.supplierId === supplierId && f.active && !lineas.some((l) => l.supplierItemId === f.id))
  const filas = lineas.map((l) => {
    const item = base.formatoPorId.get(l.supplierItemId)
    const n = /^\d{1,6}$/.test(l.formats.trim()) ? Number(l.formats) : 0
    return { l, item, n }
  })
  const total = purchaseTotal(filas.filter((f) => f.item && f.n > 0).map((f) => ({ orderedFormats: f.n, priceCents: f.item!.priceCents })))
  const falta = proveedor && proveedor.minOrderCents > total ? proveedor.minOrderCents - total : 0

  function cambiarProveedor(id: string) {
    if (id === supplierId) return
    setSupplierId(id)
    setLineas([])
  }

  async function guardar(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!supplierId) return setError("Elige el proveedor.")
    if (lineas.length === 0) return setError("Añade al menos un formato al pedido.")
    if (filas.some((f) => f.n < 1 || f.n > 100_000)) return setError("Los formatos de cada línea son un número entero entre 1 y 100 000.")
    const out = await op.run("guardarPedidoProveedor", {
      ...scope,
      orderId: pedido?.id ?? null,
      expectedRevision: pedido?.revision ?? null,
      supplierId,
      lines: filas.map((f) => ({ supplierItemId: f.l.supplierItemId, formats: f.n })),
      expectedOn: expectedOn || null,
      notes,
    })
    if (!out) return
    toast.success(pedido ? `Borrador ${out.reference} guardado` : `Borrador ${out.reference} creado. Aún no se ha enviado a nadie.`)
    onSaved(out.orderId)
  }

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
        <form onSubmit={guardar} noValidate className="flex min-h-full flex-col">
          <SheetHeader className="gap-1 border-b pb-4">
            <SheetTitle className="text-xl">{pedido ? `Editar borrador ${pedido.reference}` : "Nuevo pedido"}</SheetTitle>
            <SheetDescription>
              {pedido
                ? "Al guardar se vuelven a coger los precios de lista de hoy."
                : "Se guarda como borrador. Cuando lo pidas al proveedor, márcalo como enviado: Llenamos no envía nada por sí solo."}
            </SheetDescription>
          </SheetHeader>
          <div className="flex flex-1 flex-col gap-5 p-4">
            <SelectField label="Proveedor" value={supplierId} onChange={(e) => cambiarProveedor(e.target.value)} disabled={pedido !== null} hint={pedido ? "Un pedido no cambia de proveedor." : undefined}>
              <option value="">Elige un proveedor</option>
              {base.proveedores
                .filter((p) => p.active || p.id === supplierId)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </SelectField>

            {proveedor ? (
              <section aria-label="Líneas del pedido" className="flex flex-col gap-3">
                <h3 className="text-sm font-medium">Qué pedir</h3>
                {filas.length === 0 ? (
                  <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Aún no hay nada en el pedido. Añade formatos de este proveedor.</p>
                ) : (
                  <ul className="divide-y rounded-lg border">
                    {filas.map(({ l, item, n }) => {
                      const ing = item ? base.ingredientePorId.get(item.ingredientId) : undefined
                      return (
                        <li key={l.supplierItemId} className="flex items-center gap-3 px-3.5 py-3">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[15px] font-medium">{item?.name ?? "Formato borrado"}</p>
                            <p className="truncate text-xs text-muted-foreground">
                              {ing?.name ?? ""} {item && ing ? <>· <span className="cifra">{cantidadFormato(item.baseQuantity, ing.unit)}</span> · <span className="cifra">{euros(item.priceCents)}</span></> : null}
                              {item && !item.active ? " · desactivado" : ""}
                            </p>
                          </div>
                          <label className="sr-only" htmlFor={`fmt-${l.supplierItemId}`}>
                            Formatos de {item?.name}
                          </label>
                          <Input
                            id={`fmt-${l.supplierItemId}`}
                            inputMode="numeric"
                            value={l.formats}
                            onChange={(e) => setLineas((xs) => xs.map((x) => (x.supplierItemId === l.supplierItemId ? { ...x, formats: e.target.value } : x)))}
                            className="cifra h-9 w-16 text-center pointer-coarse:h-11"
                          />
                          <span className="cifra w-20 text-right text-sm text-soft-foreground">{item && n > 0 ? euros(n * item.priceCents) : ""}</span>
                          <Button type="button" variant="ghost" size="icon" aria-label={`Quitar ${item?.name ?? "la línea"}`} onClick={() => setLineas((xs) => xs.filter((x) => x.supplierItemId !== l.supplierItemId))}>
                            <TrashIcon aria-hidden />
                          </Button>
                        </li>
                      )
                    })}
                  </ul>
                )}
                {disponibles.length > 0 ? (
                  <SelectField
                    label="Añadir un formato"
                    value=""
                    onChange={(e) => e.target.value && setLineas((xs) => [...xs, { supplierItemId: e.target.value, formats: "1" }])}
                  >
                    <option value="">Elige un formato</option>
                    {disponibles.map((f) => {
                      const ing = base.ingredientePorId.get(f.ingredientId)
                      return (
                        <option key={f.id} value={f.id}>
                          {f.name}
                          {ing ? ` · ${ing.name}` : ""} · {euros(f.priceCents)}
                        </option>
                      )
                    })}
                  </SelectField>
                ) : base.formatos.some((f) => f.supplierId === supplierId && f.active) ? null : (
                  <Notice tone="warning">Este proveedor no tiene formatos activos. Añádelos en Proveedores y formatos.</Notice>
                )}
                <p className="flex items-baseline justify-between border-t pt-3 text-sm">
                  <span className="text-muted-foreground">Total sin IVA</span>
                  <span className="cifra text-lg font-semibold">{euros(total)}</span>
                </p>
                {falta > 0 && filas.length > 0 ? (
                  <Notice tone="warning">
                    {proveedor.name} pide un mínimo de {euros(proveedor.minOrderCents)}. Con este pedido faltan {euros(falta)}. Puedes guardarlo igualmente.
                  </Notice>
                ) : null}
              </section>
            ) : null}

            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">Entrega esperada</span>
              <DateInput value={expectedOn} onChange={setExpectedOn} label="Día de entrega esperado" min={hoy} />
              {proveedor && !expectedOn ? (
                <p className="text-xs text-muted-foreground">
                  {proveedor.leadDays === 0 ? "Este proveedor sirve el mismo día." : `Este proveedor suele tardar ${proveedor.leadDays} ${proveedor.leadDays === 1 ? "día" : "días"}.`}
                </p>
              ) : null}
            </div>
            <TextareaField label="Notas para el proveedor" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} rows={2} hint="Salen en el texto del pedido." />
            {error || op.error ? <Notice tone="error">{error ?? op.error}</Notice> : null}
          </div>
          <SheetFooter className="border-t p-4">
            <Button type="submit" size="lg" disabled={op.busy} className="max-sm:w-full">
              {op.busy ? <Spinner role="presentation" aria-label={undefined} aria-hidden /> : null}
              {op.busy ? "Guardando…" : "Guardar borrador"}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
