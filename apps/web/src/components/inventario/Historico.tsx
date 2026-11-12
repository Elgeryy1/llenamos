"use client"

import { ChartBarIcon } from "@phosphor-icons/react"

import { EmptyState } from "@/components/common/empty-state"
import { Notice } from "@/components/common/notice"
import { SummaryStrip } from "@/components/common/summary-strip"
import { Tag } from "@/components/common/tag"
import { euros, porcentaje, type FilaPlato } from "@/lib/inventario/modelo"
import type { Margenes } from "@/lib/inventario/margenes"

/** Margen real de lo vendido en el periodo, con el coste y el precio de cada momento. */
export function Historico({ vendidos, filas }: { vendidos: Margenes["sold"]; filas: readonly FilaPlato[] }) {
  const nombre = (itemId: string, variantId: string | null) => {
    const f = filas.find((x) => x.item.id === itemId && (x.variant?.id ?? null) === variantId) ?? filas.find((x) => x.item.id === itemId)
    return f ? (variantId && !f.variant ? `${f.item.name.es}` : f.etiqueta) : "Plato retirado"
  }
  const filasVenta = vendidos.filter((r) => r.units > 0 || r.wasteCostCents > 0)
  if (filasVenta.length === 0) {
    return (
      <EmptyState
        icon={<ChartBarIcon />}
        title="Sin ventas con receta en este periodo"
        description="El margen histórico sale de los platos con receta que han marchado a cocina. Prueba con otro periodo."
      />
    )
  }
  const sueltos = filasVenta.filter((r) => !r.inMenu)
  const neto = sueltos.reduce((s, r) => s + r.coveredNetCents, 0)
  const coste = sueltos.reduce((s, r) => s + r.costCents, 0)
  const merma = filasVenta.reduce((s, r) => s + r.wasteCostCents, 0)
  const uds = sueltos.reduce((s, r) => s + r.units, 0)
  const conCoste = sueltos.reduce((s, r) => s + r.coveredUnits, 0)
  const margenBp = neto > 0 ? Math.round(((neto - coste) * 10000) / neto) : null
  return (
    <div className="flex flex-col gap-5">
      <SummaryStrip
        label="Resumen del periodo"
        items={[
          { label: "Platos vendidos", value: uds, hint: `${conCoste} con coste completo` },
          { label: "Ingreso sin IVA", value: euros(neto) },
          { label: "Coste de lo vendido", value: euros(coste) },
          { label: "Margen real", value: porcentaje(margenBp), hint: euros(neto - coste), tone: margenBp !== null && margenBp < 0 ? "destructive" : undefined },
        ]}
      />
      {merma > 0 ? <Notice tone="warning" title={`Pérdida por anulaciones: ${euros(merma)}`}>Platos anulados después de empezar a prepararlos. No devuelven ingredientes al almacén.</Notice> : null}
      <div className="superficie overflow-x-auto">
        <table className="w-full min-w-[46rem] text-sm">
          <caption className="sr-only">Margen histórico por plato</caption>
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th scope="col" className="px-4 py-3 font-medium">Plato</th>
              <th scope="col" className="px-2 py-3 text-right font-medium">Vendidos</th>
              <th scope="col" className="px-2 py-3 text-right font-medium">Ingreso sin IVA</th>
              <th scope="col" className="px-2 py-3 text-right font-medium">Coste</th>
              <th scope="col" className="px-2 py-3 text-right font-medium">Margen</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Margen %</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filasVenta.map((r) => (
              <tr key={`${r.itemId}:${r.variantId ?? "-"}:${r.inMenu}`}>
                <td className="px-4 py-2.5">
                  <span className="font-medium">{nombre(r.itemId, r.variantId)}</span>
                  {r.inMenu ? <Tag className="ml-2">En menú del día</Tag> : null}
                  {r.coveredUnits < r.units ? <Tag tone="aviso" className="ml-2">{r.units - r.coveredUnits} sin coste</Tag> : null}
                  {r.wasteCostCents > 0 ? <Tag tone="alergia" className="ml-2">Anulados: {euros(r.wasteCostCents)}</Tag> : null}
                </td>
                <td className="cifra px-2 py-2.5 text-right">{r.units}</td>
                <td className="cifra px-2 py-2.5 text-right">{r.inMenu ? "En el menú" : r.units === 0 ? "—" : euros(r.coveredNetCents)}</td>
                <td className="cifra px-2 py-2.5 text-right text-muted-foreground">{r.units === 0 ? "—" : euros(r.costCents)}</td>
                <td className="cifra px-2 py-2.5 text-right">{r.inMenu || r.units === 0 ? "—" : euros(r.marginCents)}</td>
                <td className={`cifra px-4 py-2.5 text-right font-medium ${r.marginBp !== null && r.marginBp < 0 ? "text-destructive" : ""}`}>{r.inMenu ? "—" : porcentaje(r.marginBp)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        El ingreso es el precio de carta sin IVA de cada línea y no reparte descuentos ni invitaciones de caja. Los platos dentro de un menú del día no se comparan con su precio suelto.
      </p>
    </div>
  )
}

