"use client"

import { PURCHASE_STATUS_LABEL, type CallableOutput, type PurchaseOrderWithId, type SupplierItemWithId } from "@llenamos/core"
import { TrashIcon } from "@phosphor-icons/react"
import { useState } from "react"
import { toast } from "sonner"
import { SelectField, TextField } from "@/components/common/form-fields"
import { Notice } from "@/components/common/notice"
import { Tag } from "@/components/common/tag"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import type { Scope } from "@/lib/compras/datos"
import { cambioBp, euros, eurosParaCampo, parseEuros, variacionTexto } from "@/lib/compras/dinero"
import { cantidadFormato } from "@/lib/compras/modelo"
import { useOperacion } from "@/lib/compras/useOperacion"
import { BotonPrecioLista } from "./BotonPrecioLista"
import type { Base } from "./lecturas"

export type Recepcion = CallableOutput<"recibirPedidoProveedor">
export type ModoRecepcion = { tipo: "pedido"; pedido: PurchaseOrderWithId } | { tipo: "directa" }

interface Fila {
  supplierItemId: string
  formats: string
  price: string
}

const entero = (t: string) => (/^\d{1,6}$/.test(t.trim()) ? Number(t) : null)

/** Precio contra el que el servidor avisa: el último pagado o, si nunca se recibió, el de lista. */
const previo = (item: SupplierItemWithId) => item.lastPriceCents ?? item.priceCents

/**
 * Albarán de recepción. Se escribe lo que llega y el precio que pone el albarán, que entra en el
 * almacén y actualiza el coste medio. Se puede recibir en varias veces y de más; los cambios de
 * precio frente al último pagado se avisan antes y después de guardar.
 */
export function RecepcionForm({ scope, base, modo, onDone, onCancel }: { scope: Scope; base: Base; modo: ModoRecepcion; onDone: (r: Recepcion, supplierId: string) => void; onCancel: () => void }) {
  const pedido = modo.tipo === "pedido" ? modo.pedido : null
  const [supplierId, setSupplierId] = useState(pedido?.supplierId ?? "")
  const [filas, setFilas] = useState<Fila[]>(() =>
    pedido
      ? pedido.lines.map((l) => ({
          supplierItemId: l.supplierItemId,
          formats: String(Math.max(0, l.orderedFormats - l.receivedFormats)),
          price: eurosParaCampo(l.priceCents),
        }))
      : [],
  )
  const [nota, setNota] = useState("")
  const [error, setError] = useState<string | null>(null)
  const op = useOperacion()

  const disponibles = pedido ? [] : base.formatos.filter((f) => f.supplierId === supplierId && f.active && !filas.some((x) => x.supplierItemId === f.id))
  const detalle = filas.map((f) => {
    const item = base.formatoPorId.get(f.supplierItemId)
    const linea = pedido?.lines.find((l) => l.supplierItemId === f.supplierItemId)
    const n = entero(f.formats)
    const cents = parseEuros(f.price)
    return { f, item, linea, n, cents }
  })
  const total = detalle.reduce((s, d) => s + (d.n && d.cents !== null ? d.n * d.cents : 0), 0)

  const set = (id: string, campo: "formats" | "price", v: string) => setFilas((xs) => xs.map((x) => (x.supplierItemId === id ? { ...x, [campo]: v } : x)))

  async function guardar(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!supplierId) return setError("Elige el proveedor del albarán.")
    const conCantidad = detalle.filter((d) => (d.n ?? 0) > 0)
    if (conCantidad.length === 0) return setError("Escribe al menos un formato recibido.")
    if (detalle.some((d) => d.f.formats.trim() !== "" && d.n === null)) return setError("Los formatos recibidos son un número entero, sin decimales.")
    if (conCantidad.some((d) => d.cents === null)) return setError("Escribe el precio del albarán de cada línea, con un máximo de dos decimales.")
    const out = await op.run("recibirPedidoProveedor", {
      ...scope,
      supplierId,
      purchaseOrderId: pedido?.id ?? null,
      expectedRevision: pedido?.revision ?? null,
      deliveryNote: nota.trim() || null,
      lines: conCantidad.map((d) => ({ supplierItemId: d.f.supplierItemId, receivedFormats: d.n!, priceCents: d.cents! })),
    })
    if (!out) return
    toast.success(`Albarán guardado por ${euros(out.totalCents)}`)
    onDone(out, supplierId)
  }

  return (
    <form onSubmit={guardar} noValidate className="flex flex-col gap-5">
      {!pedido ? (
        <SelectField
          label="Proveedor"
          value={supplierId}
          onChange={(e) => {
            setSupplierId(e.target.value)
            setFilas([])
          }}
          hint="Compra directa: entra en el almacén sin pedido previo."
        >
          <option value="">Elige un proveedor</option>
          {base.proveedores
            .filter((p) => p.active)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </SelectField>
      ) : null}

      <TextField label="Número de albarán (opcional)" value={nota} onChange={(e) => setNota(e.target.value)} maxLength={60} autoComplete="off" className="cifra" />

      <section aria-label="Líneas del albarán" className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">Qué ha llegado</h3>
        {detalle.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{supplierId ? "Añade los formatos que han llegado." : "Elige primero el proveedor."}</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {detalle.map(({ f, item, linea, n, cents }) => {
              const ing = item ? base.ingredientePorId.get(item.ingredientId) : undefined
              const falta = linea ? Math.max(0, linea.orderedFormats - linea.receivedFormats) : null
              const deMas = linea && n !== null && n > (falta ?? 0) ? n - (falta ?? 0) : 0
              const ref = item ? previo(item) : null
              const bp = ref !== null && cents !== null ? cambioBp(ref, cents) : 0
              const cambia = ref !== null && cents !== null && cents !== ref
              return (
                <li key={f.supplierItemId} className="flex flex-col gap-3 px-3.5 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[15px] font-medium">{item?.name ?? "Formato borrado"}</p>
                      <p className="text-xs text-muted-foreground">
                        {ing?.name}
                        {item && ing ? <> · trae <span className="cifra">{cantidadFormato(linea?.baseQuantity ?? item.baseQuantity, ing.unit)}</span></> : null}
                        {linea ? (
                          <>
                            {" "}
                            · pedido <span className="cifra">{linea.orderedFormats}</span>, recibido <span className="cifra">{linea.receivedFormats}</span>, falta <span className="cifra">{falta}</span>
                          </>
                        ) : null}
                      </p>
                    </div>
                    {!pedido ? (
                      <Button type="button" variant="ghost" size="icon" aria-label={`Quitar ${item?.name ?? "la línea"}`} onClick={() => setFilas((xs) => xs.filter((x) => x.supplierItemId !== f.supplierItemId))}>
                        <TrashIcon aria-hidden />
                      </Button>
                    ) : null}
                  </div>
                  <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-3">
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                      Formatos recibidos
                      <Input inputMode="numeric" value={f.formats} onChange={(e) => set(f.supplierItemId, "formats", e.target.value)} className="cifra h-9 text-base pointer-coarse:h-11 md:text-sm" aria-invalid={f.formats.trim() !== "" && n === null ? true : undefined} />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                      Precio del albarán por formato (€)
                      <Input inputMode="decimal" value={f.price} onChange={(e) => set(f.supplierItemId, "price", e.target.value)} className="cifra h-9 text-base pointer-coarse:h-11 md:text-sm" aria-invalid={f.price.trim() !== "" && cents === null ? true : undefined} />
                    </label>
                    <span className="cifra pb-2 text-right text-sm text-soft-foreground">{n && cents !== null ? euros(n * cents) : ""}</span>
                  </div>
                  {deMas > 0 || cambia ? (
                    <div className="flex flex-wrap gap-2">
                      {deMas > 0 ? <Tag tone="aviso">Recibes {deMas} {deMas === 1 ? "formato" : "formatos"} de más</Tag> : null}
                      {cambia && ref !== null ? (
                        <Tag tone="aviso">
                          {variacionTexto(bp)} frente al {item?.lastPriceCents != null ? "último precio pagado" : "precio de lista"} ({euros(ref)})
                        </Tag>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
        {!pedido && disponibles.length > 0 ? (
          <SelectField
            label="Añadir un formato"
            value=""
            onChange={(e) => {
              const item = base.formatoPorId.get(e.target.value)
              if (item) setFilas((xs) => [...xs, { supplierItemId: item.id, formats: "1", price: eurosParaCampo(item.priceCents) }])
            }}
          >
            <option value="">Elige un formato</option>
            {disponibles.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name} · {base.ingredientePorId.get(f.ingredientId)?.name ?? ""} · {euros(f.priceCents)}
              </option>
            ))}
          </SelectField>
        ) : null}
        <p className="flex items-baseline justify-between border-t pt-3 text-sm">
          <span className="text-muted-foreground">Total del albarán sin IVA</span>
          <span className="cifra text-lg font-semibold">{euros(total)}</span>
        </p>
      </section>

      {error || op.error ? <Notice tone="error">{error ?? op.error}</Notice> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" size="lg" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit" size="lg" disabled={op.busy}>
          {op.busy ? <Spinner role="presentation" aria-label={undefined} aria-hidden /> : null}
          {op.busy ? "Guardando…" : "Guardar albarán"}
        </Button>
      </div>
    </form>
  )
}

/** Qué ha pasado al guardar el albarán: total, lo que falta, lo recibido de más y los cambios de precio. */
export function ResultadoRecepcion({ scope, base, out, pedido, onClose }: { scope: Scope; base: Base; out: Recepcion; pedido: PurchaseOrderWithId | null; onClose: () => void }) {
  const nombreLinea = (id: string) => pedido?.lines.find((l) => l.lineId === id)?.name ?? "línea"
  return (
    <div className="flex flex-col gap-4" aria-live="polite">
      <Notice tone="success" title={`Albarán guardado por ${euros(out.totalCents)} sin IVA`}>
        La mercancía ya está en el almacén al precio del albarán y el coste medio se ha actualizado.
        {out.orderStatus ? <> El pedido queda como «{PURCHASE_STATUS_LABEL[out.orderStatus]}».</> : null}
      </Notice>
      {out.priceChanges.length > 0 ? (
        <Notice tone="warning" title="Han cambiado precios respecto al último pagado">
          <ul className="mt-1 flex flex-col gap-2.5">
            {out.priceChanges.map((c) => {
              const item = base.formatoPorId.get(c.supplierItemId)
              return (
                <li key={c.supplierItemId} className="flex flex-col items-start gap-1.5">
                  <span>
                    <span className="font-medium text-foreground">{item?.name ?? "Formato"}</span>: de <span className="cifra">{euros(c.previousCents)}</span> a <span className="cifra">{euros(c.newCents)}</span> (
                    <span className="cifra">{variacionTexto(c.changeBp)}</span>)
                  </span>
                  {item ? <BotonPrecioLista scope={scope} item={item} cents={c.newCents} /> : null}
                </li>
              )
            })}
          </ul>
        </Notice>
      ) : null}
      {out.exceeded.length > 0 ? (
        <Notice tone="warning" title="Has recibido de más">
          {out.exceeded.map((x) => `${x.extraFormats} × ${nombreLinea(x.lineId)}`).join(", ")}. Queda anotado en el albarán.
        </Notice>
      ) : null}
      {out.pending.length > 0 ? (
        <Notice tone="info" title="Aún falta por recibir">
          {out.pending.map((x) => `${x.formats} × ${nombreLinea(x.lineId)}`).join(", ")}. Puedes recibirlo cuando llegue o cerrar el pedido sin completar.
        </Notice>
      ) : null}
      <div className="flex justify-end">
        <Button type="button" size="lg" variant="outline" onClick={onClose}>
          Hecho
        </Button>
      </div>
    </div>
  )
}
