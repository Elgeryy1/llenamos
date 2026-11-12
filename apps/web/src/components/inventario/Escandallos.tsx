"use client"

import { BookOpenTextIcon, CookingPotIcon, WarningIcon } from "@phosphor-icons/react"
import { dishMargin, horaLocal, sumarDias, type IngredientCost, type IngredientWithId } from "@llenamos/core"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useMemo, useState } from "react"
import { DateInput } from "@/components/common/date-picker"
import { EmptyState } from "@/components/common/empty-state"
import { LoadingBlock } from "@/components/common/loading"
import { Notice } from "@/components/common/notice"
import { PageHeading } from "@/components/common/page-heading"
import { SegmentedControl } from "@/components/common/segmented-control"
import { SummaryStrip } from "@/components/common/summary-strip"
import { Tag } from "@/components/common/tag"
import { LiveError } from "@/components/panel/LiveError"
import { usePanel } from "@/components/panel/PanelContext"
import { RequireModule } from "@/components/panel/RequireModule"
import { RequirePermission } from "@/components/panel/RequirePermission"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { useMembers } from "@/lib/data/hooks"
import { useNow } from "@/lib/use-now"
import { describeError } from "@/lib/firebase/errors"
import { useCostes, useIngredientes, usePlatos, useRecetas } from "@/lib/inventario/datos"
import { useMargenes, type Margenes } from "@/lib/inventario/margenes"
import { claveFila, estadoReceta, euros, filasPlatos, porcentaje, type FilaPlato } from "@/lib/inventario/modelo"
import { MagnifyingGlassIcon } from "@phosphor-icons/react"
import { Historico } from "./Historico"
import { RecetaEditor } from "./RecetaEditor"
import { useLocalInventario } from "./piezas"

export function Escandallos() {
  const { location } = usePanel()
  return (
    <RequirePermission permission="costes.ver" what="los escandallos">
      <RequireModule module="inventory">
        <PageHeading
          title="Escandallos"
          eyebrow={location?.name}
          description="Cuánto cuesta cada plato y cuánto deja. El coste teórico usa los costes medios de hoy; el histórico, lo que costaba cada plato cuando se vendió."
        />
        {location ? <Contenido /> : <Notice>Elige un local para ver sus escandallos.</Notice>}
      </RequireModule>
    </RequirePermission>
  )
}

type Vista = "platos" | "historico"
type Periodo = "hoy" | "7" | "30" | "rango"

function Contenido() {
  const { base, alcance, puede, timezone } = useLocalInventario()
  const { restaurant } = usePanel()
  const router = useRouter()
  const params = useSearchParams()
  const platos = usePlatos(base)
  const recetas = useRecetas(base)
  const ingredientes = useIngredientes(base)
  const costes = useCostes(base, true)
  const miembros = useMembers(restaurant.id)

  const hoy = horaLocal(useNow(3_600_000).getTime(), timezone).fecha
  const [periodo, setPeriodo] = useState<Periodo>("7")
  const [rango, setRango] = useState({ from: sumarDias(hoy, -6), to: hoy })
  const desde = periodo === "hoy" ? hoy : periodo === "7" ? sumarDias(hoy, -6) : periodo === "30" ? sumarDias(hoy, -29) : rango.from
  const hasta = periodo === "rango" ? rango.to : hoy
  const margenes = useMargenes(alcance, desde, hasta <= desde ? desde : hasta)

  const vista: Vista = params.get("vista") === "historico" ? "historico" : "platos"
  const platoSel = params.get("plato")
  const varianteSel = params.get("variante")

  const nombres = useMemo(() => new Map(miembros.status === "ready" ? miembros.data.map((m) => [m.uid, m.displayName]) : []), [miembros])

  if (!alcance) return null
  const lecturas = [platos, recetas, ingredientes, costes]
  const error = lecturas.find((l) => l.status === "error")
  if (error && error.status === "error") return <LiveError title="No se pueden leer los escandallos" error={error.error} />
  if (platos.status !== "ready" || recetas.status !== "ready" || ingredientes.status !== "ready" || costes.status !== "ready") return <LoadingBlock label="Cargando los escandallos…" />

  const filas = filasPlatos(platos.data, recetas.data)
  const fila = platoSel ? filas.find((f) => f.key === claveFila(platoSel, varianteSel && varianteSel !== "-" ? varianteSel : null)) : undefined

  if (fila) {
    return (
      <RecetaEditor
        alcance={alcance}
        base={base}
        fila={fila}
        recetas={recetas.data}
        ingredientes={ingredientes.data}
        costes={costes.data}
        puedeEditar={puede.recetas}
        timezone={timezone}
        nombres={nombres}
        onGuardada={margenes.recargar}
        onSalir={() => router.push("/panel/escandallos")}
      />
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <nav className="flex gap-2" aria-label="Escandallos">
        <Button asChild variant={vista === "platos" ? "secondary" : "ghost"} className="min-h-11">
          <Link href="/panel/escandallos" aria-current={vista === "platos" ? "page" : undefined}><CookingPotIcon aria-hidden />Platos y recetas</Link>
        </Button>
        <Button asChild variant={vista === "historico" ? "secondary" : "ghost"} className="min-h-11">
          <Link href="/panel/escandallos?vista=historico" aria-current={vista === "historico" ? "page" : undefined}><BookOpenTextIcon aria-hidden />Margen vendido</Link>
        </Button>
      </nav>

      {vista === "platos" ? (
        <Platos filas={filas} margenes={margenes.live} recargar={margenes.recargar} ingredientes={ingredientes.data} costes={costes.data} puedeEditar={puede.recetas} />
      ) : (
        <>
          <div className="superficie flex flex-wrap items-end gap-4 p-4">
            <SegmentedControl
              label="Periodo"
              value={periodo}
              onValueChange={setPeriodo}
              options={[{ value: "hoy", label: "Hoy" }, { value: "7", label: "7 días" }, { value: "30", label: "30 días" }, { value: "rango", label: "Elegir fechas" }]}
            />
            {periodo === "rango" ? (
              <div className="flex flex-wrap items-center gap-2">
                <DateInput label="Desde" clearable={false} value={rango.from} onChange={(v) => v && setRango({ ...rango, from: v, to: rango.to < v ? v : rango.to })} />
                <DateInput label="Hasta" clearable={false} min={rango.from} value={rango.to} onChange={(v) => v && setRango({ ...rango, to: v })} />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Del {desde} al {hasta}</p>
            )}
            <Button variant="ghost" className="ml-auto min-h-11" onClick={margenes.recargar}>Actualizar</Button>
          </div>
          <Resultado live={margenes.live} etiqueta="el margen vendido">
            {(m) => <Historico vendidos={m.sold} filas={filas} />}
          </Resultado>
        </>
      )}
    </div>
  )
}

function Resultado({ live, etiqueta, children }: { live: ReturnType<typeof useMargenes>["live"]; etiqueta: string; children: (m: Margenes) => React.ReactNode }) {
  if (live.status === "loading") return <LoadingBlock label={`Calculando ${etiqueta}…`} />
  if (live.status === "error") {
    const info = describeError(live.error)
    return <Notice tone="error" title={`No se ha podido calcular ${etiqueta}`} detail={info.code}>{info.message}</Notice>
  }
  return <>{children(live.data)}</>
}

/* Platos y recetas --------------------------------------------------------------------------- */

type Filtro = "todos" | "sin" | "incompletos"

function Platos({
  filas, margenes, recargar, puedeEditar,
}: {
  filas: FilaPlato[]
  margenes: ReturnType<typeof useMargenes>["live"]
  recargar: () => void
  ingredientes: readonly IngredientWithId[]
  costes: ReadonlyMap<string, IngredientCost>
  puedeEditar: boolean
}) {
  const [texto, setTexto] = useState("")
  const [filtro, setFiltro] = useState<Filtro>("todos")
  const teorico = margenes.status === "ready" ? new Map(margenes.data.theoretical.map((t) => [t.recipeId, t])) : null

  const detalle = filas.map((f) => {
    const t = f.receta && f.receta.active ? (teorico?.get(f.receta.id) ?? null) : null
    const margen = t && t.complete ? dishMargin({ grossCents: f.priceCents, taxRate: f.item.taxRate, costCents: t.costCents }) : null
    return { f, t, margen }
  })
  const conReceta = detalle.filter((d) => d.f.receta?.active).length
  const conMargen = detalle.filter((d) => d.margen && d.margen.marginBp !== null)
  const peor = [...conMargen].sort((a, b) => (a.margen!.marginBp! - b.margen!.marginBp!))[0]
  const q = texto.trim().toLocaleLowerCase("es")
  const visibles = detalle.filter(({ f, t }) => {
    if (q && !f.etiqueta.toLocaleLowerCase("es").includes(q)) return false
    if (filtro === "sin") return !f.receta || !f.receta.active
    if (filtro === "incompletos") return t !== null && !t.complete
    return true
  })

  return (
    <div className="flex flex-col gap-5">
      <SummaryStrip
        label="Resumen de los escandallos"
        items={[
          { label: "Platos con receta", value: conReceta, hint: `de ${filas.length} platos` },
          { label: "Sin receta", value: filas.length - conReceta, tone: filas.length - conReceta > 0 ? "warning" : undefined },
          { label: "Margen más bajo", value: peor ? porcentaje(peor.margen!.marginBp) : "—", hint: peor?.f.etiqueta },
        ]}
      />
      {margenes.status === "error" ? (
        <Notice tone="error" title="No se ha podido calcular el coste teórico" detail={describeError(margenes.error).code} action={<Button variant="outline" onClick={recargar}>Volver a intentarlo</Button>}>
          {describeError(margenes.error).message}
        </Notice>
      ) : null}
      <div className="superficie overflow-hidden">
        <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center">
          <InputGroup className="sm:max-w-sm">
            <InputGroupAddon><MagnifyingGlassIcon aria-hidden /></InputGroupAddon>
            <InputGroupInput aria-label="Buscar un plato" placeholder="Buscar un plato" value={texto} onChange={(e) => setTexto(e.target.value)} className="pointer-coarse:h-11" />
          </InputGroup>
          <SegmentedControl
            label="Qué platos ver"
            value={filtro}
            onValueChange={setFiltro}
            options={[{ value: "todos", label: "Todos" }, { value: "sin", label: "Sin receta" }, { value: "incompletos", label: "Coste incompleto" }]}
          />
        </div>
        {filas.length === 0 ? (
          <EmptyState className="m-4" icon={<CookingPotIcon />} title="La carta no tiene platos" description="Crea los platos en la carta y vuelve aquí para escribir su receta." />
        ) : visibles.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">Ningún plato coincide.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] text-sm">
              <caption className="sr-only">Coste y margen teórico por plato</caption>
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th scope="col" className="px-4 py-3 font-medium">Plato</th>
                  <th scope="col" className="px-2 py-3 font-medium">Receta</th>
                  <th scope="col" className="px-2 py-3 text-right font-medium">Precio con IVA</th>
                  <th scope="col" className="px-2 py-3 text-right font-medium">Coste</th>
                  <th scope="col" className="px-2 py-3 text-right font-medium">Margen</th>
                  <th scope="col" className="px-2 py-3 text-right font-medium">Margen %</th>
                  <th scope="col" className="px-2 py-3 text-right font-medium">Materia prima</th>
                  <th scope="col" className="px-4 py-3"><span className="sr-only">Acciones</span></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {visibles.map(({ f, t, margen }) => (
                  <tr key={f.key}>
                    <td className="px-4 py-3 font-medium">{f.etiqueta}</td>
                    <td className="px-2 py-3">
                      <Tag tone={f.receta?.active ? (f.heredada ? "neutro" : "habitual") : "aviso"}>{estadoReceta({ ...f })}</Tag>
                    </td>
                    <td className="cifra px-2 py-3 text-right">{euros(f.priceCents)}</td>
                    <td className="cifra px-2 py-3 text-right">
                      {t ? (t.complete ? euros(t.costCents) : "Sin coste") : "—"}
                      {t && !t.complete ? <WarningIcon aria-label="Coste incompleto: falta el coste de algún ingrediente" className="ml-1.5 inline text-warning" weight="fill" /> : null}
                    </td>
                    <td className="cifra px-2 py-3 text-right">{margen ? euros(margen.marginCents) : "—"}</td>
                    <td className={`cifra px-2 py-3 text-right font-medium ${margen && margen.marginBp !== null && margen.marginBp < 0 ? "text-destructive" : ""}`}>{porcentaje(margen?.marginBp ?? null)}</td>
                    <td className="cifra px-2 py-3 text-right text-muted-foreground">{porcentaje(margen?.foodCostBp ?? null)}</td>
                    <td className="px-4 py-3 text-right">
                      <Button asChild variant={f.receta ? "outline" : "default"} className="min-h-11 pointer-fine:min-h-9">
                        <Link href={`/panel/escandallos?plato=${encodeURIComponent(f.item.id)}&variante=${encodeURIComponent(f.variant?.id ?? "-")}`}>
                          {puedeEditar ? (f.receta ? "Editar receta" : "Crear receta") : "Ver receta"}
                          <span className="sr-only">: {f.etiqueta}</span>
                        </Link>
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
