"use client"

import { CheckCircleIcon, ClipboardTextIcon, PlusIcon } from "@phosphor-icons/react"
import type { CallableOutput, IngredientWithId, StockCount } from "@llenamos/core"
import { useMemo, useState } from "react"
import { toast } from "sonner"
import { EmptyState } from "@/components/common/empty-state"
import { TextField } from "@/components/common/form-fields"
import { Notice } from "@/components/common/notice"
import { SummaryStrip } from "@/components/common/summary-strip"
import { Tag } from "@/components/common/tag"
import { RequirePermission } from "@/components/panel/RequirePermission"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useAccion, type Alcance } from "@/lib/inventario/acciones"
import { useIngredientes, useMovimientosDesde, useRecuentos } from "@/lib/inventario/datos"
import { categoriasDe, euros, leerCantidad, reconciliar, textoCantidad, type ConId } from "@/lib/inventario/modelo"
import { BotonAccion, Cargado, ErrorAccion, useLocalInventario } from "./piezas"

export function Recuento() {
  return (
    <RequirePermission permission="inventario.gestionar" what="los recuentos">
      <Panel />
    </RequirePermission>
  )
}

type Resultado = { nombre: string; datos: CallableOutput<"aplicarRecuento"> }

function formatoFecha(ms: number, timezone: string) {
  return new Intl.DateTimeFormat("es-ES", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: timezone }).format(ms)
}

function Panel() {
  const { base, alcance, timezone } = useLocalInventario()
  const recuentos = useRecuentos(base)
  const ingredientes = useIngredientes(base)
  const [abierto, setAbierto] = useState<string | null>(null)
  const [resultado, setResultado] = useState<Resultado | null>(null)
  if (!alcance) return null
  return (
    <Cargado live={ingredientes} label="los ingredientes">
      {(lista) => (
        <Cargado live={recuentos} label="los recuentos">
          {(cuentas) => {
            const actual = cuentas.find((c) => c.id === abierto)
            if (resultado) {
              return <Aplicado resultado={resultado} ingredientes={lista} onCerrar={() => { setResultado(null); setAbierto(null) }} />
            }
            if (actual && actual.status === "draft") {
              return (
                <Asistente
                  key={actual.id}
                  alcance={alcance}
                  base={base}
                  recuento={actual}
                  ingredientes={lista}
                  onSalir={() => setAbierto(null)}
                  onAplicado={(datos) => setResultado({ nombre: actual.name, datos })}
                />
              )
            }
            return <Lista alcance={alcance} timezone={timezone} cuentas={cuentas} ingredientes={lista} onAbrir={setAbierto} />
          }}
        </Cargado>
      )}
    </Cargado>
  )
}

/* Lista y comienzo de un recuento ------------------------------------------------------------ */

const ESTADO: Record<StockCount["status"], string> = { draft: "En curso", applied: "Aplicado", cancelled: "Cancelado" }

function Lista({
  alcance, timezone, cuentas, ingredientes, onAbrir,
}: { alcance: Alcance; timezone: string; cuentas: ConId<StockCount>[]; ingredientes: IngredientWithId[]; onAbrir: (id: string) => void }) {
  const { ejecutar, busy, error } = useAccion(alcance)
  const activos = ingredientes.filter((i) => i.active)
  const categorias = categoriasDe(activos)
  const [nombre, setNombre] = useState(() => `Recuento del ${new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "long", timeZone: timezone }).format(Date.now())}`)
  const [elegidas, setElegidas] = useState<string[]>([])
  const [errorNombre, setErrorNombre] = useState<string | null>(null)

  const aContar = elegidas.length === 0 ? activos : activos.filter((i) => elegidas.includes(i.category ?? ""))

  async function empezar() {
    if (nombre.trim() === "") return setErrorNombre("Ponle un nombre al recuento.")
    setErrorNombre(null)
    const r = await ejecutar("iniciarRecuento", { name: nombre.trim(), ingredientIds: elegidas.length === 0 ? null : aContar.map((i) => i.id) })
    if (r) onAbrir(r.countId)
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="superficie flex flex-col gap-4 p-5" aria-label="Empezar un recuento">
        <div>
          <h2 className="text-lg font-semibold">Empezar un recuento</h2>
          <p className="mt-1 text-sm text-muted-foreground">Cuenta con calma: el servicio puede seguir. Cada cantidad se guarda con la hora a la que la contaste.</p>
        </div>
        <TextField label="Nombre" value={nombre} maxLength={80} onChange={(e) => setNombre(e.target.value)} error={errorNombre} fieldClassName="sm:max-w-md" />
        {categorias.length > 0 ? (
          <div>
            <p className="mb-2 text-sm font-medium">Qué vas a contar</p>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Categorías a contar">
              <Button type="button" variant={elegidas.length === 0 ? "secondary" : "outline"} aria-pressed={elegidas.length === 0} className="min-h-11" onClick={() => setElegidas([])}>Todo el almacén</Button>
              {categorias.map((c) => {
                const on = elegidas.includes(c)
                return (
                  <Button key={c} type="button" variant={on ? "secondary" : "outline"} aria-pressed={on} className="min-h-11" onClick={() => setElegidas(on ? elegidas.filter((x) => x !== c) : [...elegidas, c])}>
                    {c}
                  </Button>
                )
              })}
            </div>
          </div>
        ) : null}
        <ErrorAccion error={error} />
        <div className="flex flex-wrap items-center gap-3">
          <BotonAccion size="xl" busy={busy} ocupado="Preparando…" disabled={aContar.length === 0} onClick={() => void empezar()}>
            <PlusIcon aria-hidden />
            Empezar a contar {aContar.length} {aContar.length === 1 ? "ingrediente" : "ingredientes"}
          </BotonAccion>
        </div>
      </section>

      {cuentas.length === 0 ? (
        <EmptyState icon={<ClipboardTextIcon />} title="Aún no has hecho ningún recuento" description="El primero fija lo que de verdad hay y corrige lo que el sistema creía." />
      ) : (
        <section aria-label="Recuentos anteriores" className="superficie overflow-hidden">
          <h2 className="border-b px-5 py-4 text-lg font-semibold">Recuentos</h2>
          <ul className="divide-y">
            {cuentas.map((c) => {
              const contadas = c.lines.filter((l) => l.countedQuantity !== null).length
              return (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{c.name}</span>
                      <Tag tone={c.status === "draft" ? "aviso" : c.status === "applied" ? "habitual" : "neutro"}>{ESTADO[c.status]}</Tag>
                    </p>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      Empezó {formatoFecha(c.startedAt, timezone)} · {contadas} de {c.lines.length} contados
                      {c.appliedAt ? ` · aplicado ${formatoFecha(c.appliedAt, timezone)}` : ""}
                    </p>
                  </div>
                  {c.status === "draft" ? <Button className="min-h-11" onClick={() => onAbrir(c.id)}>Continuar</Button> : null}
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </div>
  )
}

/* Asistente por pasos ------------------------------------------------------------------------ */

function Pasos({ paso }: { paso: 2 | 3 }) {
  const pasos = ["Elegir qué contar", "Contar", "Revisar y aplicar"]
  return (
    <ol className="flex flex-wrap gap-x-6 gap-y-2 text-sm" aria-label="Pasos del recuento">
      {pasos.map((texto, i) => {
        const n = i + 1
        const estado = n < paso ? "hecho" : n === paso ? "actual" : "pendiente"
        return (
          <li key={texto} aria-current={estado === "actual" ? "step" : undefined} className={`flex items-center gap-2 ${estado === "pendiente" ? "text-muted-foreground" : ""}`}>
            <span className={`cifra grid size-6 place-items-center rounded-full text-xs ${estado === "actual" ? "bg-primary text-primary-foreground" : estado === "hecho" ? "bg-success/20 text-success" : "bg-muted"}`}>
              {estado === "hecho" ? <CheckCircleIcon aria-hidden weight="fill" /> : n}
            </span>
            <span className={estado === "actual" ? "font-medium" : ""}>{texto}</span>
          </li>
        )
      })}
    </ol>
  )
}

function Asistente({
  alcance, base, recuento, ingredientes, onSalir, onAplicado,
}: {
  alcance: Alcance
  base: string | null
  recuento: ConId<StockCount>
  ingredientes: IngredientWithId[]
  onSalir: () => void
  onAplicado: (datos: CallableOutput<"aplicarRecuento">) => void
}) {
  const { ejecutar, busy, error } = useAccion(alcance)
  const [paso, setPaso] = useState<2 | 3>(2)
  const porId = useMemo(() => new Map(ingredientes.map((i) => [i.id, i])), [ingredientes])
  const [textos, setTextos] = useState<Record<string, string>>(() =>
    Object.fromEntries(recuento.lines.map((l) => [l.ingredientId, l.countedQuantity === null ? "" : String(l.countedQuantity)])),
  )
  const [errores, setErrores] = useState<Record<string, string>>({})
  const [guardado, setGuardado] = useState(false)
  // La revisión llega en directo, pero justo después de guardar puede ir un paso por detrás.
  const [revisionGuardada, setRevisionGuardada] = useState(recuento.revision)
  const revision = Math.max(revisionGuardada, recuento.revision)
  const movimientos = useMovimientosDesde(base, recuento.startedAt)

  const lineas = useMemo(
    () => [...recuento.lines].sort((a, b) => (porId.get(a.ingredientId)?.category ?? "~").localeCompare(porId.get(b.ingredientId)?.category ?? "~", "es") || (porId.get(a.ingredientId)?.name ?? "").localeCompare(porId.get(b.ingredientId)?.name ?? "", "es")),
    [recuento.lines, porId],
  )
  const contados = recuento.lines.filter((l) => l.countedQuantity !== null).length

  /** Guarda todas las cantidades escritas; devuelve false si alguna no se entiende. */
  async function guardar(): Promise<boolean> {
    const nuevos: Record<string, string> = {}
    const lines: { ingredientId: string; countedQuantity: number | null }[] = []
    for (const l of recuento.lines) {
      const ing = porId.get(l.ingredientId)
      const texto = textos[l.ingredientId] ?? ""
      if (texto.trim() === "" || !ing) { lines.push({ ingredientId: l.ingredientId, countedQuantity: null }); continue }
      const q = leerCantidad(texto, ing.unit, { permitirCero: true })
      if (!q.ok) { nuevos[l.ingredientId] = q.error; continue }
      lines.push({ ingredientId: l.ingredientId, countedQuantity: q.valor })
    }
    setErrores(nuevos)
    if (Object.keys(nuevos).length > 0) return false
    const r = await ejecutar("guardarRecuento", { countId: recuento.id, expectedRevision: revision, lines })
    if (!r) return false
    setRevisionGuardada(r.revision)
    return true
  }

  async function aplicar() {
    const r = await ejecutar("aplicarRecuento", { countId: recuento.id, expectedRevision: revision })
    if (r) onAplicado(r)
  }

  async function cancelar() {
    const r = await ejecutar("cancelarRecuento", { countId: recuento.id, expectedRevision: revision })
    if (r) {
      toast.success("Recuento cancelado.")
      onSalir()
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="superficie flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{recuento.name}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{contados} de {recuento.lines.length} contados</p>
          </div>
          <Button variant="ghost" className="min-h-11" disabled={busy} onClick={onSalir}>Dejarlo para luego</Button>
        </div>
        <Pasos paso={paso} />
      </div>
      <ErrorAccion error={error} />

      {paso === 2 ? (
        <section className="superficie overflow-hidden" aria-label="Contar">
          <ul className="divide-y">
            {lineas.map((l, idx) => {
              const ing = porId.get(l.ingredientId)
              if (!ing) return null
              const anterior = lineas[idx - 1] ? porId.get(lineas[idx - 1]!.ingredientId) : undefined
              const nuevaCategoria = idx === 0 || (anterior?.category ?? "") !== (ing.category ?? "")
              return (
                <li key={l.ingredientId}>
                  {nuevaCategoria ? <p className="border-b bg-surface-sunken/60 px-5 py-2 text-xs font-medium text-muted-foreground">{ing.category ?? "Sin categoría"}</p> : null}
                  <div className="grid items-center gap-2 px-5 py-3 sm:grid-cols-[minmax(0,1fr)_14rem]">
                    <div>
                      <label htmlFor={`cuenta-${ing.id}`} className="text-base font-medium">{ing.name}</label>
                      {l.countedQuantity !== null ? <p className="text-xs text-success">Guardado: {textoCantidad(l.countedQuantity, ing.unit)}</p> : null}
                      {errores[ing.id] ? <p role="alert" className="text-xs text-destructive">{errores[ing.id]}</p> : null}
                    </div>
                    <div className="flex items-center gap-2">
                      <Input
                        id={`cuenta-${ing.id}`}
                        inputMode="decimal"
                        autoComplete="off"
                        className="cifra h-11 text-right text-base"
                        aria-invalid={errores[ing.id] ? true : undefined}
                        value={textos[ing.id] ?? ""}
                        placeholder="Sin contar"
                        onChange={(e) => { setGuardado(false); setTextos({ ...textos, [ing.id]: e.target.value }) }}
                      />
                      <span className="w-8 text-sm text-muted-foreground">{ing.unit === "u" ? "ud" : ing.unit}</span>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t p-4">
            <BotonAccion variant="destructive" size="lg" busy={false} disabled={busy} onClick={() => void cancelar()}>Cancelar recuento</BotonAccion>
            <div className="flex flex-wrap items-center gap-3">
              {guardado && !busy ? <p role="status" className="text-sm text-success">Progreso guardado</p> : null}
              <BotonAccion variant="outline" size="xl" busy={busy} ocupado="Guardando…" onClick={async () => { setGuardado(false); if (await guardar()) setGuardado(true) }}>Guardar progreso</BotonAccion>
              <BotonAccion size="xl" busy={busy} ocupado="Guardando…" onClick={async () => { if (await guardar()) setPaso(3) }}>Revisar</BotonAccion>
            </div>
          </div>
        </section>
      ) : (
        <Revision
          recuento={recuento}
          ingredientes={porId}
          movimientos={movimientos}
          busy={busy}
          onVolver={() => setPaso(2)}
          onAplicar={() => void aplicar()}
        />
      )}
    </div>
  )
}

/* Revisión y reconciliación ------------------------------------------------------------------ */

function Revision({
  recuento, ingredientes, movimientos, busy, onVolver, onAplicar,
}: {
  recuento: ConId<StockCount>
  ingredientes: ReadonlyMap<string, IngredientWithId>
  movimientos: ReturnType<typeof useMovimientosDesde>
  busy: boolean
  onVolver: () => void
  onAplicar: () => void
}) {
  return (
    <Cargado live={movimientos} label="los movimientos del recuento">
      {(movs) => {
        const filas = recuento.lines.map((l) => {
          const ing = ingredientes.get(l.ingredientId)
          return { ing, l, r: reconciliar(l, ing?.quantity ?? 0, movs) }
        })
        const contadas = filas.filter((f) => f.r.diferencia !== null)
        const conDiferencia = contadas.filter((f) => f.r.diferencia !== 0)
        const sinContar = filas.length - contadas.length
        return (
          <section className="flex flex-col gap-5" aria-label="Revisar y aplicar">
            <SummaryStrip
              label="Resumen del recuento"
              items={[
                { label: "Contados", value: contadas.length },
                { label: "Con diferencia", value: conDiferencia.length, tone: conDiferencia.length > 0 ? "warning" : undefined },
                { label: "Sin contar", value: sinContar, hint: sinContar > 0 ? "No se tocan" : undefined },
              ]}
            />
            <Notice>
              La diferencia compara lo que has contado con lo que el sistema tenía en el momento de contar. Si has vendido o recibido mientras contabas, eso ya está descontado y no se cuenta como pérdida.
            </Notice>
            {contadas.length === 0 ? (
              <EmptyState icon={<ClipboardTextIcon />} title="No has contado nada" description="Vuelve al paso anterior y escribe lo que hay. Lo que dejes en blanco no se toca." />
            ) : (
              <div className="superficie overflow-x-auto">
                <table className="w-full min-w-[40rem] text-sm">
                  <caption className="sr-only">Diferencias del recuento</caption>
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th scope="col" className="px-4 py-3 font-medium">Ingrediente</th>
                      <th scope="col" className="px-2 py-3 text-right font-medium">Esperado al contar</th>
                      <th scope="col" className="px-2 py-3 text-right font-medium">Contado</th>
                      <th scope="col" className="px-2 py-3 text-right font-medium">Diferencia</th>
                      <th scope="col" className="px-4 py-3 font-medium">Mientras contabas</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {contadas.map(({ ing, l, r }) => {
                      if (!ing || r.diferencia === null || r.contado === null || r.esperado === null) return null
                      return (
                        <tr key={l.ingredientId}>
                          <td className="px-4 py-2.5 font-medium">{ing.name}</td>
                          <td className="cifra px-2 py-2.5 text-right text-muted-foreground">{textoCantidad(r.esperado, ing.unit)}</td>
                          <td className="cifra px-2 py-2.5 text-right">{textoCantidad(r.contado, ing.unit)}</td>
                          <td className={`cifra px-2 py-2.5 text-right font-medium ${r.diferencia === 0 ? "text-muted-foreground" : r.diferencia < 0 ? "text-destructive" : "text-success"}`}>
                            {r.diferencia > 0 ? "+" : ""}{textoCantidad(r.diferencia, ing.unit)}
                          </td>
                          <td className="px-4 py-2.5 text-muted-foreground">
                            {r.movido === 0 ? "Sin cambios" : `${r.movido > 0 ? "Entraron" : "Salieron"} ${textoCantidad(Math.abs(r.movido), ing.unit)}`}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Button variant="outline" size="xl" disabled={busy} onClick={onVolver}>Volver a contar</Button>
              <BotonAccion size="xl" busy={busy} ocupado="Aplicando…" disabled={contadas.length === 0} onClick={onAplicar}>
                Aplicar el recuento
              </BotonAccion>
            </div>
          </section>
        )
      }}
    </Cargado>
  )
}

function Aplicado({ resultado, ingredientes, onCerrar }: { resultado: Resultado; ingredientes: IngredientWithId[]; onCerrar: () => void }) {
  const { datos } = resultado
  const porId = new Map(ingredientes.map((i) => [i.id, i]))
  const perdida = datos.adjusted.filter((a) => a.valueCents < 0).reduce((s, a) => s + a.valueCents, 0)
  const sobrante = datos.adjusted.filter((a) => a.valueCents > 0).reduce((s, a) => s + a.valueCents, 0)
  return (
    <section className="flex flex-col gap-5" aria-label="Recuento aplicado">
      <Notice tone="success" title={`Recuento aplicado: ${resultado.nombre}`}>
        El almacén ya refleja lo contado. Cada ajuste queda en Movimientos como ajuste de recuento.
      </Notice>
      <SummaryStrip
        label="Resultado del recuento"
        items={[
          { label: "Ajustados", value: datos.adjusted.length },
          { label: "Sin diferencia", value: datos.unchanged },
          { label: "Sin contar", value: datos.uncounted },
          { label: "Pérdida valorada", value: euros(Math.abs(perdida)), tone: perdida < 0 ? "warning" : undefined, hint: sobrante > 0 ? `Sobrante: ${euros(sobrante)}` : "Sin IVA" },
        ]}
      />
      {datos.adjusted.length > 0 ? (
        <ul className="superficie divide-y overflow-hidden" aria-label="Ajustes aplicados">
          {datos.adjusted.map((a) => {
            const ing = porId.get(a.ingredientId)
            return (
              <li key={a.ingredientId} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <span className="font-medium">{ing?.name ?? "Ingrediente"}</span>
                <span className="flex items-center gap-4">
                  <span className={`cifra ${a.quantity < 0 ? "text-destructive" : "text-success"}`}>{a.quantity > 0 ? "+" : ""}{textoCantidad(a.quantity, ing?.unit ?? "u")}</span>
                  <span className="cifra w-24 text-right text-muted-foreground">{euros(a.valueCents)}</span>
                </span>
              </li>
            )
          })}
        </ul>
      ) : null}
      <div><Button size="xl" onClick={onCerrar}>Hecho</Button></div>
    </section>
  )
}
