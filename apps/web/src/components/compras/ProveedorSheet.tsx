"use client"

import { SupplierEditableSchema, type SupplierItemWithId } from "@llenamos/core"
import { PencilSimpleIcon, PlusIcon } from "@phosphor-icons/react"
import { useState } from "react"
import { toast } from "sonner"
import { Notice } from "@/components/common/notice"
import { Tag } from "@/components/common/tag"
import { TextField, TextareaField } from "@/components/common/form-fields"
import { Button } from "@/components/ui/button"
import { Field, FieldLabel } from "@/components/ui/field"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import type { Scope } from "@/lib/compras/datos"
import { derivaDePrecio, cantidadFormato, precioPorUnidad } from "@/lib/compras/modelo"
import { euros, eurosParaCampo, parseEuros, variacionTexto } from "@/lib/compras/dinero"
import { useOperacion } from "@/lib/compras/useOperacion"
import { BotonPrecioLista } from "./BotonPrecioLista"
import { FormatoDialog } from "./FormatoDialog"
import type { Base } from "./lecturas"

interface Borrador {
  name: string
  contact: string
  phone: string
  email: string
  leadDays: string
  minOrder: string
  notes: string
  active: boolean
}

export function ProveedorSheet({ scope, base, proveedorId, onClose }: { scope: Scope; base: Base; proveedorId: string | null; onClose: () => void }) {
  const [id, setId] = useState(proveedorId)
  const actual = id ? base.proveedorPorId.get(id) : undefined
  const [d, setD] = useState<Borrador>(() => ({
    name: actual?.name ?? "",
    contact: actual?.contact ?? "",
    phone: actual?.phone ?? "",
    email: actual?.email ?? "",
    leadDays: String(actual?.leadDays ?? 1),
    minOrder: actual ? eurosParaCampo(actual.minOrderCents) : "0,00",
    notes: actual?.notes ?? "",
    active: actual?.active ?? true,
  }))
  const [errores, setErrores] = useState<Partial<Record<keyof Borrador, string>>>({})
  const op = useOperacion()
  const [formato, setFormato] = useState<{ item: SupplierItemWithId | null } | null>(null)
  const formatos = id ? base.formatos.filter((f) => f.supplierId === id) : []
  const set = <K extends keyof Borrador>(k: K, v: Borrador[K]) => setD((x) => ({ ...x, [k]: v }))

  async function guardar(e: React.FormEvent) {
    e.preventDefault()
    const minimo = parseEuros(d.minOrder)
    const dias = /^\d{1,2}$/.test(d.leadDays.trim()) ? Number(d.leadDays) : NaN
    const nuevos: typeof errores = {}
    if (minimo === null) nuevos.minOrder = "Escribe un importe con un máximo de dos decimales."
    if (!Number.isInteger(dias) || dias > 60) nuevos.leadDays = "Escribe los días de entrega, de 0 a 60."
    const parsed = SupplierEditableSchema.safeParse({
      name: d.name,
      phone: d.phone.trim() || null,
      email: d.email.trim() || null,
      contact: d.contact.trim() || null,
      leadDays: dias,
      minOrderCents: minimo ?? 0,
      notes: d.notes,
      active: d.active,
    })
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const campo = issue.path[0] as keyof Borrador | "minOrderCents" | "leadDays" | undefined
        if (campo === "minOrderCents" || campo === "leadDays") continue
        if (campo && !nuevos[campo]) nuevos[campo] = campo === "email" ? "Escribe un correo válido." : issue.message
      }
    }
    setErrores(nuevos)
    if (!parsed.success || Object.keys(nuevos).length > 0) return
    const out = await op.run("guardarProveedor", { ...scope, supplierId: id, supplier: parsed.data })
    if (!out) return
    toast.success(id ? "Proveedor guardado" : "Proveedor creado. Ya puedes añadir sus formatos.")
    // Un proveedor nuevo se queda abierto para añadir sus formatos sin perder el sitio.
    if (!id) setId(out.supplierId)
  }

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
        <SheetHeader className="gap-1 border-b pb-4">
          <SheetTitle className="text-xl">{id ? (actual?.name ?? "Proveedor") : "Nuevo proveedor"}</SheetTitle>
          <SheetDescription>Cuánto tarda en servir, qué pedido mínimo exige y los formatos que te vende. Precios sin IVA.</SheetDescription>
        </SheetHeader>
        <form onSubmit={guardar} noValidate className="flex flex-col gap-4 p-4">
          <TextField label="Nombre" value={d.name} onChange={(e) => set("name", e.target.value)} error={errores.name} maxLength={80} autoComplete="off" />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="Persona de contacto" value={d.contact} onChange={(e) => set("contact", e.target.value)} error={errores.contact} maxLength={80} autoComplete="off" />
            <TextField label="Teléfono" type="tel" value={d.phone} onChange={(e) => set("phone", e.target.value)} error={errores.phone} maxLength={30} autoComplete="off" />
          </div>
          <TextField label="Correo" type="email" value={d.email} onChange={(e) => set("email", e.target.value)} error={errores.email} autoComplete="off" />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Días de entrega"
              inputMode="numeric"
              value={d.leadDays}
              onChange={(e) => set("leadDays", e.target.value)}
              error={errores.leadDays}
              hint="Entre pedir y recibir. 0 es el mismo día."
              className="cifra"
            />
            <TextField
              label="Pedido mínimo sin IVA (€)"
              inputMode="decimal"
              value={d.minOrder}
              onChange={(e) => set("minOrder", e.target.value)}
              error={errores.minOrder}
              hint="0 si no exige mínimo."
              className="cifra"
            />
          </div>
          <TextareaField label="Notas" value={d.notes} onChange={(e) => set("notes", e.target.value)} error={errores.notes} maxLength={500} rows={2} hint="Horario de pedidos, cómo prefiere recibirlos…" />
          <Field orientation="horizontal">
            <Switch id="proveedor-activo" checked={d.active} onCheckedChange={(v) => set("active", v)} />
            <FieldLabel htmlFor="proveedor-activo" className="font-normal">
              Activo (se puede pedir y se propone al sugerir pedidos)
            </FieldLabel>
          </Field>
          {op.error ? <Notice tone="error">{op.error}</Notice> : null}
          <SheetFooter className="p-0">
            <Button type="submit" size="lg" disabled={op.busy} className="max-sm:w-full">
              {op.busy ? <Spinner role="presentation" aria-label={undefined} aria-hidden /> : null}
              {op.busy ? "Guardando…" : id ? "Guardar proveedor" : "Crear proveedor"}
            </Button>
          </SheetFooter>
        </form>

        {id ? (
          <section className="border-t p-4" aria-label="Formatos del proveedor">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-base font-semibold">Formatos que vende</h3>
              <Button type="button" variant="outline" size="lg" onClick={() => setFormato({ item: null })}>
                <PlusIcon aria-hidden /> Añadir formato
              </Button>
            </div>
            {formatos.length === 0 ? (
              <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                Aún no tiene formatos. Añade, por ejemplo, «Saco 25 kg» de patata con su precio: así se podrá pedir y sugerir.
              </p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {formatos.map((f) => {
                  const ing = base.ingredientePorId.get(f.ingredientId)
                  const unidad = ing?.unit ?? "u"
                  const deriva = derivaDePrecio(f)
                  return (
                    <li key={f.id} className="flex flex-col gap-1.5 px-3.5 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="flex flex-wrap items-center gap-2 text-[15px] font-medium">
                            <span className={f.active ? "" : "text-muted-foreground"}>{f.name}</span>
                            {f.preferred ? <Tag tone="habitual">Preferido</Tag> : null}
                            {!f.active ? <Tag>Desactivado</Tag> : null}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {ing?.name ?? "Ingrediente borrado"} · trae <span className="cifra">{cantidadFormato(f.baseQuantity, unidad)}</span>
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="cifra text-[15px] font-medium">{euros(f.priceCents)}</p>
                          <p className="text-xs text-muted-foreground">{precioPorUnidad(f.priceCents, f.baseQuantity, unidad)}</p>
                        </div>
                        <Button type="button" variant="ghost" size="icon" aria-label={`Editar ${f.name}`} onClick={() => setFormato({ item: f })}>
                          <PencilSimpleIcon aria-hidden />
                        </Button>
                      </div>
                      {f.lastPriceCents !== null ? (
                        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                          <span>
                            Último precio pagado <span className="cifra text-soft-foreground">{euros(f.lastPriceCents)}</span>
                          </span>
                          {deriva !== null ? (
                            <>
                              <Tag tone="aviso">{variacionTexto(deriva)} sobre el precio de lista</Tag>
                              <BotonPrecioLista scope={scope} item={f} cents={f.lastPriceCents ?? f.priceCents} />
                            </>
                          ) : (
                            <span>igual que el de lista</span>
                          )}
                        </p>
                      ) : (
                        <p className="text-xs text-muted-foreground">Aún no se ha recibido.</p>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        ) : null}
      </SheetContent>
      {formato && id ? <FormatoDialog scope={scope} base={base} proveedorId={id} item={formato.item} onClose={() => setFormato(null)} /> : null}
    </Sheet>
  )
}
