"use client"

import { MagnifyingGlassIcon, MinusCircleIcon, PackageIcon, SlidersHorizontalIcon, WarningIcon } from "@phosphor-icons/react"
import type { IngredientCost, IngredientWithId, StockAlert } from "@llenamos/core"
import { useState } from "react"
import { toast } from "sonner"
import { EmptyState } from "@/components/common/empty-state"
import { SelectField } from "@/components/common/form-fields"
import { Notice } from "@/components/common/notice"
import { SegmentedControl } from "@/components/common/segmented-control"
import { SummaryStrip } from "@/components/common/summary-strip"
import { Tag } from "@/components/common/tag"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { useAccion } from "@/lib/inventario/acciones"
import { useAvisos, useCostes, useIngredientes } from "@/lib/inventario/datos"
import {
  NIVEL_TONO, categoriasDe, etiquetaNivel, euros, filtrarExistencias, nivelDe, ordenarExistencias, resumirExistencias,
  textoCantidad, textoCosteUnitario, valorAlmacen, type FiltroExistencias,
} from "@/lib/inventario/modelo"
import { AjusteDialog } from "./AjusteDialog"
import { MermaDialog } from "./MermaDialog"
import { Cargado, ErrorAccion, useLocalInventario } from "./piezas"

type Dialogo = { tipo: "merma"; ingrediente: IngredientWithId | null } | { tipo: "ajuste"; ingrediente: IngredientWithId }

export function Existencias() {
  const { base, alcance, puede } = useLocalInventario()
  const ingredientes = useIngredientes(base)
  const avisos = useAvisos(base)
  const costes = useCostes(base, puede.costes)
  const [filtro, setFiltro] = useState<FiltroExistencias>({ texto: "", categoria: "", soloAvisos: false, incluirInactivos: false })
  const [dialogo, setDialogo] = useState<Dialogo | null>(null)
  const visto = useAccion(alcance ?? { restaurantId: "", locationId: "" })

  if (!alcance) return null
  return (
    <Cargado live={ingredientes} label="las existencias">
      {(lista) => {
        const activos = lista.filter((i) => i.active)
        const resumen = resumirExistencias(lista)
        const costesListos = puede.costes && costes.status === "ready" ? costes.data : null
        const avisosListos = avisos.status === "ready" ? avisos.data : new Map<string, StockAlert>()
        const visibles = ordenarExistencias(filtrarExistencias(lista, filtro))
        const categorias = categoriasDe(lista)
        const pendientes = [...avisosListos].filter(([, a]) => a.status === "open")

        async function reconocer(ingrediente: IngredientWithId) {
          const r = await visto.ejecutar("reconocerAvisoStock", { ingredientId: ingrediente.id })
          if (r) toast.success(`Aviso de ${ingrediente.name.toLocaleLowerCase("es")} visto.`)
        }

        return (
          <div className="flex flex-col gap-5">
            <SummaryStrip
              label="Resumen del almacén"
              items={[
                { label: "Ingredientes", value: resumen.total },
                { label: "Con aviso", value: resumen.conAviso, tone: resumen.conAviso > 0 ? "warning" : undefined, hint: resumen.negativos > 0 ? `${resumen.negativos} en negativo` : undefined },
                { label: "Agotados", value: resumen.agotados, tone: resumen.agotados > 0 ? "destructive" : undefined },
                ...(puede.costes ? [{ label: "Valor del almacén", value: costesListos ? euros(valorAlmacen(costesListos, lista)) : "—", hint: "Sin IVA" }] : []),
              ]}
            />

            {pendientes.length > 0 ? (
              <Notice tone="warning" title={pendientes.length === 1 ? "Un ingrediente pide atención" : `${pendientes.length} ingredientes piden atención`}>
                {pendientes
                  .map(([id]) => lista.find((i) => i.id === id)?.name)
                  .filter(Boolean)
                  .join(", ")}
                . Cuando hayas visto un aviso, márcalo como visto: volverá a sonar solo si empeora.
              </Notice>
            ) : null}
            <ErrorAccion error={visto.error} />

            <div className="superficie overflow-hidden">
              <div className="flex flex-col gap-3 border-b p-4 lg:flex-row lg:items-end">
                <InputGroup className="lg:max-w-sm">
                  <InputGroupAddon><MagnifyingGlassIcon aria-hidden /></InputGroupAddon>
                  <InputGroupInput
                    aria-label="Buscar un ingrediente"
                    placeholder="Buscar un ingrediente"
                    value={filtro.texto}
                    onChange={(e) => setFiltro({ ...filtro, texto: e.target.value })}
                    className="pointer-coarse:h-11"
                  />
                </InputGroup>
                {categorias.length > 0 ? (
                  <SelectField label="Categoría" fieldClassName="lg:w-52" value={filtro.categoria} onChange={(e) => setFiltro({ ...filtro, categoria: e.target.value })} className="pointer-coarse:h-11">
                    <option value="">Todas</option>
                    {categorias.map((c) => <option key={c} value={c}>{c}</option>)}
                  </SelectField>
                ) : null}
                <SegmentedControl
                  label="Qué ingredientes ver"
                  value={filtro.soloAvisos ? "avisos" : "todos"}
                  onValueChange={(v) => setFiltro({ ...filtro, soloAvisos: v === "avisos" })}
                  options={[{ value: "todos", label: "Todos" }, { value: "avisos", label: "Con aviso" }]}
                />
                {puede.mermar ? (
                  <Button size="xl" className="lg:ml-auto" onClick={() => setDialogo({ tipo: "merma", ingrediente: null })}>
                    <MinusCircleIcon aria-hidden />
                    Apuntar merma
                  </Button>
                ) : null}
              </div>

              {activos.length === 0 ? (
                <EmptyState
                  className="m-4"
                  icon={<PackageIcon />}
                  title="Todavía no hay ingredientes"
                  description={puede.gestionar ? "Crea el primero en la pestaña Ingredientes para empezar a controlar el almacén." : "Cuando el encargado cree los ingredientes, los verás aquí."}
                />
              ) : visibles.length === 0 ? (
                <p className="p-6 text-sm text-muted-foreground">Ningún ingrediente coincide con lo que buscas.</p>
              ) : (
                <ul className="divide-y" aria-label="Existencias">
                  {visibles.map((i) => (
                    <FilaExistencia
                      key={i.id}
                      ingrediente={i}
                      aviso={avisosListos.get(i.id) ?? null}
                      coste={costesListos ? (costesListos.get(i.id) ?? null) : undefined}
                      puede={puede}
                      ocupado={visto.busy}
                      onMerma={() => setDialogo({ tipo: "merma", ingrediente: i })}
                      onAjuste={() => setDialogo({ tipo: "ajuste", ingrediente: i })}
                      onVisto={() => void reconocer(i)}
                    />
                  ))}
                </ul>
              )}
            </div>

            {dialogo?.tipo === "merma" ? (
              <MermaDialog key={dialogo.ingrediente?.id ?? "nuevo"} alcance={alcance} ingredientes={lista} elegido={dialogo.ingrediente} onClose={() => setDialogo(null)} />
            ) : null}
            {dialogo?.tipo === "ajuste" ? <AjusteDialog key={dialogo.ingrediente.id} alcance={alcance} ingrediente={dialogo.ingrediente} onClose={() => setDialogo(null)} /> : null}
          </div>
        )
      }}
    </Cargado>
  )
}

function FilaExistencia({
  ingrediente: i, aviso, coste, puede, ocupado, onMerma, onAjuste, onVisto,
}: {
  ingrediente: IngredientWithId
  aviso: StockAlert | null
  /** undefined: quien mira no ve costes. null: no hay coste guardado todavía. */
  coste: IngredientCost | null | undefined
  puede: ReturnType<typeof useLocalInventario>["puede"]
  ocupado: boolean
  onMerma: () => void
  onAjuste: () => void
  onVisto: () => void
}) {
  const nivel = nivelDe(i)
  return (
    <li className="grid gap-3 px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center" data-nivel={nivel}>
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-base font-medium">{i.name}</span>
          {!i.active ? <Tag>Apagado</Tag> : null}
          {nivel !== "ok" ? <Tag tone={NIVEL_TONO[nivel]}>{etiquetaNivel(nivel)}</Tag> : null}
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {i.category ?? "Sin categoría"}
          {i.minQuantity > 0 ? ` · aviso a partir de ${textoCantidad(i.minQuantity, i.unit)}` : " · sin aviso"}
          {coste !== undefined ? ` · ${coste ? textoCosteUnitario(i, coste) : "sin coste"}` : ""}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 sm:justify-end">
        <div className="min-w-24 sm:text-right">
          <p className={`cifra text-xl font-medium ${nivel === "ok" ? "" : nivel === "low" ? "text-warning" : "text-destructive"}`}>{textoCantidad(i.quantity, i.unit)}</p>
          {coste ? <p className="cifra text-xs text-muted-foreground">{euros(coste.valueCents)}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {aviso?.status === "open" ? (
            <Button variant="outline" className="pointer-coarse:h-11" disabled={ocupado} onClick={onVisto}>
              <WarningIcon aria-hidden />
              Marcar visto<span className="sr-only">: {i.name}</span>
            </Button>
          ) : aviso?.status === "acknowledged" ? <Tag>Aviso visto</Tag> : null}
          {puede.mermar ? (
            <Button variant="outline" className="pointer-coarse:h-11" onClick={onMerma}>
              <MinusCircleIcon aria-hidden />
              Merma<span className="sr-only">: {i.name}</span>
            </Button>
          ) : null}
          {puede.gestionar ? (
            <Button variant="ghost" className="pointer-coarse:h-11" onClick={onAjuste}>
              <SlidersHorizontalIcon aria-hidden />
              Ajustar<span className="sr-only">: {i.name}</span>
            </Button>
          ) : null}
        </div>
      </div>
    </li>
  )
}
