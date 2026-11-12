"use client"

import type { CallableOutput } from "@llenamos/core"
import { ArrowClockwiseIcon, LightbulbIcon } from "@phosphor-icons/react"
import Link from "next/link"
import { useEffect, useState } from "react"
import { Notice } from "@/components/common/notice"
import { Tag } from "@/components/common/tag"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { errorCompras, llamarCompras } from "@/lib/compras/api"
import type { Scope } from "@/lib/compras/datos"
import { euros } from "@/lib/compras/dinero"
import { cantidadFormato } from "@/lib/compras/modelo"
import { formatQuantity } from "@llenamos/core"
import type { Base } from "./lecturas"
import type { PresetPedido } from "./PedidoEditor"

type Sugerido = CallableOutput<"sugerirPedidos">
type Estado = { fase: "cargando" } | { fase: "error"; mensaje: string } | { fase: "listo"; datos: Sugerido }

/**
 * Lo que propone el servidor para reponer: ingredientes en el mínimo o por debajo (contando lo
 * que ya viene pedido), en formatos enteros hasta el objetivo. Es una propuesta: nada se crea
 * hasta que el encargado abre el borrador y lo guarda.
 */
export function Sugerencias({ scope, base, huella, onCrear }: { scope: Scope; base: Base; huella: string; onCrear: (preset: PresetPedido) => void }) {
  const [estado, setEstado] = useState<Estado>({ fase: "cargando" })
  const [vuelta, setVuelta] = useState(0)
  useEffect(() => {
    let vivo = true
    llamarCompras("sugerirPedidos", scope).then(
      (datos) => vivo && setEstado({ fase: "listo", datos }),
      (e) => vivo && setEstado({ fase: "error", mensaje: errorCompras(e) }),
    )
    return () => {
      vivo = false
    }
    // La huella cambia cuando cambia algún pedido: lo ya pedido cuenta para sugerir.
  }, [scope, huella, vuelta])

  const recargar = () => {
    setEstado({ fase: "cargando" })
    setVuelta((v) => v + 1)
  }
  const nombre = (id: string) => base.ingredientePorId.get(id)?.name ?? "Ingrediente borrado"

  return (
    <section className="superficie overflow-hidden" aria-label="Sugerencias de pedido">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <LightbulbIcon aria-hidden className="size-4 text-warning" /> Para reponer
        </h2>
        <Button type="button" variant="ghost" size="sm" onClick={recargar} disabled={estado.fase === "cargando"}>
          {estado.fase === "cargando" ? <Spinner role="presentation" aria-label={undefined} aria-hidden /> : <ArrowClockwiseIcon aria-hidden />}
          Actualizar
        </Button>
      </div>
      {estado.fase === "cargando" ? (
        <p role="status" className="px-5 py-5 text-sm text-muted-foreground">
          Calculando qué falta…
        </p>
      ) : estado.fase === "error" ? (
        <div className="p-4">
          <Notice tone="error" title="No se han podido calcular las sugerencias">
            {estado.mensaje}
          </Notice>
        </div>
      ) : estado.datos.orders.length === 0 && estado.datos.withoutSupplier.length === 0 ? (
        <p className="px-5 py-5 text-sm text-muted-foreground">Nada por reponer ahora. Ningún ingrediente con mínimo está en el mínimo o por debajo, contando lo que ya has pedido.</p>
      ) : (
        <div className="divide-y">
          {estado.datos.orders.map((o) => {
            const proveedor = base.proveedorPorId.get(o.supplierId)
            return (
              <article key={o.supplierId} className="flex flex-col gap-3 px-5 py-4" aria-label={`Sugerencia para ${proveedor?.name ?? "proveedor"}`}>
                <header className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-[15px] font-medium">{proveedor?.name ?? "Proveedor borrado"}</h3>
                    {o.belowMinimum ? <Tag tone="aviso">No llega al mínimo de {euros(proveedor?.minOrderCents ?? 0)}</Tag> : null}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="cifra text-sm text-soft-foreground">{euros(o.totalCents)} sin IVA</span>
                    <Button type="button" variant="outline" size="lg" onClick={() => onCrear({ supplierId: o.supplierId, lines: o.lines.map((l) => ({ supplierItemId: l.supplierItemId, formats: l.formats })) })}>
                      Preparar borrador
                    </Button>
                  </div>
                </header>
                <ul className="grid gap-x-8 gap-y-1.5 text-sm sm:grid-cols-2">
                  {o.lines.map((l) => {
                    const ing = base.ingredientePorId.get(l.ingredientId)
                    const item = base.formatoPorId.get(l.supplierItemId)
                    return (
                      <li key={l.supplierItemId} className="flex items-baseline justify-between gap-3">
                        <span className="min-w-0 truncate">
                          <span className="cifra">{l.formats}</span> × {item?.name ?? "formato"}
                          <span className="text-muted-foreground">
                            {" "}
                            · {nombre(l.ingredientId)}
                            {ing ? ` (quedan ${formatQuantity(ing.quantity, ing.unit)}, mínimo ${formatQuantity(ing.minQuantity, ing.unit)})` : ""}
                          </span>
                        </span>
                        <span className="cifra shrink-0 text-soft-foreground" title={item && ing ? cantidadFormato(item.baseQuantity, ing.unit) : undefined}>
                          {euros(l.totalCents)}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              </article>
            )
          })}
          {estado.datos.withoutSupplier.length > 0 ? (
            <div className="px-5 py-4">
              <Notice
                tone="warning"
                title="Hay que reponer, pero no tienen formato de ningún proveedor activo"
                action={
                  <Button asChild variant="outline" size="sm">
                    <Link href="/panel/compras/proveedores">Añadir formatos</Link>
                  </Button>
                }
              >
                {estado.datos.withoutSupplier.map(nombre).join(", ")}.
              </Notice>
            </div>
          ) : null}
        </div>
      )}
    </section>
  )
}
