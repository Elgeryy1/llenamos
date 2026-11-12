"use client"

import { ArrowCounterClockwiseIcon, PlusIcon, TrashIcon, WarningIcon } from "@phosphor-icons/react"
import { costOfQuantity, dishMargin, requiredQuantity, type IngredientCost, type IngredientWithId, type RecipeVersion, type RecipeWithId } from "@llenamos/core"
import { useMemo, useState } from "react"
import { toast } from "sonner"
import { TextField } from "@/components/common/form-fields"
import { Desplegable } from "@/components/common/desplegable"
import { Notice } from "@/components/common/notice"
import { Tag } from "@/components/common/tag"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { useAccion, type Alcance } from "@/lib/inventario/acciones"
import { useVersiones } from "@/lib/inventario/datos"
import {
  borradorDeReceta, costeDeReceta, costeMedio, diferenciasVersion, euros, leerCantidad, leerRendimiento, opcionesDelPlato, porcentaje, recetaDeBorrador, textoCantidad,
  type FilaPlato, type LineaBorrador, type RecetaBorrador,
} from "@/lib/inventario/modelo"
import { BotonAccion, Cargado, ErrorAccion } from "./piezas"

const formatoHora = (ms: number, timezone: string) =>
  new Intl.DateTimeFormat("es-ES", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: timezone }).format(ms)

export function RecetaEditor({
  alcance, base, fila, recetas, ingredientes, costes, puedeEditar, timezone, nombres, onGuardada, onSalir,
}: {
  alcance: Alcance
  base: string | null
  fila: FilaPlato
  recetas: readonly RecipeWithId[]
  ingredientes: readonly IngredientWithId[]
  costes: ReadonlyMap<string, IngredientCost>
  puedeEditar: boolean
  timezone: string
  nombres: ReadonlyMap<string, string>
  onGuardada: () => void
  onSalir: () => void
}) {
  const [propia, setPropia] = useState(false)
  const variantId = fila.variant?.id ?? null
  // Una variante sin receta propia edita la común, salvo que se pida crear la suya.
  const editaComun = fila.heredada && !propia
  const objetivo = editaComun ? fila.receta : propia ? null : fila.receta
  const destinoVariante = editaComun ? null : variantId
  return (
    <FormularioReceta
      key={`${fila.key}:${editaComun}:${objetivo?.id ?? "nueva"}:${objetivo?.version ?? 0}`}
      alcance={alcance}
      base={base}
      fila={fila}
      receta={objetivo}
      destinoVariante={destinoVariante}
      heredada={editaComun}
      onCrearPropia={() => setPropia(true)}
      recetas={recetas}
      ingredientes={ingredientes}
      costes={costes}
      puedeEditar={puedeEditar}
      timezone={timezone}
      nombres={nombres}
      onGuardada={onGuardada}
      onSalir={onSalir}
    />
  )
}

function FormularioReceta({
  alcance, base, fila, receta, destinoVariante, heredada, onCrearPropia, ingredientes, costes, puedeEditar, timezone, nombres, onGuardada, onSalir,
}: {
  alcance: Alcance
  base: string | null
  fila: FilaPlato
  receta: RecipeWithId | null
  destinoVariante: string | null
  heredada: boolean
  onCrearPropia: () => void
  recetas: readonly RecipeWithId[]
  ingredientes: readonly IngredientWithId[]
  costes: ReadonlyMap<string, IngredientCost>
  puedeEditar: boolean
  timezone: string
  nombres: ReadonlyMap<string, string>
  onGuardada: () => void
  onSalir: () => void
}) {
  const { ejecutar, busy, error, limpiar } = useAccion(alcance)
  const porId = useMemo(() => new Map(ingredientes.map((i) => [i.id, i])), [ingredientes])
  const unidad = (id: string) => porId.get(id)?.unit
  const [borrador, setBorrador] = useState<RecetaBorrador>(() => borradorDeReceta(receta, fila.etiqueta, unidad))
  const [errores, setErrores] = useState<string[]>([])
  const opciones = opcionesDelPlato(fila.item)
  const versiones = useVersiones(base, receta?.id ?? null)

  const convertido = recetaDeBorrador(borrador, { itemId: fila.item.id, variantId: destinoVariante }, porId)
  const coste = convertido.ok ? costeDeReceta(convertido.receta, ingredientes, costes) : null
  const margen = coste && coste.complete ? dishMargin({ grossCents: fila.priceCents, taxRate: fila.item.taxRate, costCents: coste.costCents }) : null
  const precioNeto = dishMargin({ grossCents: fila.priceCents, taxRate: fila.item.taxRate, costCents: 0 }).netCents
  const editable = puedeEditar

  async function guardar() {
    const r = recetaDeBorrador(borrador, { itemId: fila.item.id, variantId: destinoVariante }, porId)
    if (!r.ok) return setErrores(r.errores)
    setErrores([])
    const salida = await ejecutar("guardarReceta", { recipeId: receta?.id ?? null, expectedVersion: receta?.version ?? null, recipe: r.receta })
    if (!salida) return
    toast.success(`Receta guardada. Versión ${salida.version}.`)
    onGuardada()
  }

  function cambiarLineas(donde: "lines" | string, lineas: LineaBorrador[]) {
    setBorrador((b) => (donde === "lines" ? { ...b, lines: lineas } : { ...b, options: { ...b.options, [donde]: lineas } }))
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex flex-col gap-5">
        <div className="superficie flex flex-col gap-4 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">{fila.etiqueta}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Precio de carta {euros(fila.priceCents)} con IVA del {fila.item.taxRate} %
                {receta ? ` · versión ${receta.version}` : " · receta nueva"}
              </p>
            </div>
            <Button variant="ghost" className="min-h-11" onClick={onSalir}>Volver a los platos</Button>
          </div>
          {heredada && puedeEditar ? (
            <Notice title="Esta variante usa la receta común del plato">
              Lo que cambies aquí vale para todas las variantes que no tengan receta propia.
              <div className="mt-2">
                <Button variant="outline" onClick={onCrearPropia}>Hacer una receta solo para esta variante</Button>
              </div>
            </Notice>
          ) : null}
          {!puedeEditar ? <Notice>Puedes ver la receta, pero solo el encargado la edita.</Notice> : null}
          <TextField label="Nombre de la receta" value={borrador.name} disabled={!editable} maxLength={80} onChange={(e) => setBorrador({ ...borrador, name: e.target.value })} fieldClassName="sm:max-w-md" />
        </div>

        <section className="superficie flex flex-col gap-4 p-5" aria-label="Ingredientes de la receta">
          <div>
            <h3 className="text-base font-semibold">Ingredientes por ración</h3>
            <p className="mt-1 text-sm text-muted-foreground">Escribe lo que lleva neto el plato. El rendimiento sube lo que hay que comprar: con 200 g netos y un 80 % se descuentan 250 g.</p>
          </div>
          <Lineas
            etiqueta="Ingredientes"
            lineas={borrador.lines}
            onChange={(l) => cambiarLineas("lines", l)}
            ingredientes={ingredientes}
            costes={costes}
            editable={editable && borrador.manual.trim() === ""}
          />
          <TextField
            label="Coste manual por ración (opcional)"
            inputMode="decimal"
            fieldClassName="sm:max-w-xs"
            disabled={!editable || borrador.lines.length > 0}
            value={borrador.manual}
            onChange={(e) => setBorrador({ ...borrador, manual: e.target.value })}
            hint={borrador.lines.length > 0 ? "Quita los ingredientes si prefieres un coste fijo." : "En euros sin IVA, si no quieres detallar ingredientes."}
          />
        </section>

        {opciones.length > 0 ? (
          <section className="superficie flex flex-col gap-5 p-5" aria-label="Ingredientes de los extras">
            <div>
              <h3 className="text-base font-semibold">Extras que gastan ingredientes</h3>
              <p className="mt-1 text-sm text-muted-foreground">Si al elegir un extra se gasta algo más, añádelo aquí. Los extras sin ingredientes no descuentan nada.</p>
            </div>
            {opciones.map((o) => (
              <div key={o.id} className="border-t pt-4 first:border-t-0 first:pt-0">
                <p className="mb-2 text-sm font-medium">{o.nombre} <span className="font-normal text-muted-foreground">· {o.grupo}</span></p>
                <Lineas
                  etiqueta={`Extra ${o.nombre}`}
                  lineas={borrador.options[o.id] ?? []}
                  onChange={(l) => cambiarLineas(o.id, l)}
                  ingredientes={ingredientes}
                  costes={costes}
                  editable={editable}
                />
              </div>
            ))}
          </section>
        ) : null}

        <div className="superficie flex flex-col gap-4 p-5">
          <Field orientation="horizontal">
            <FieldLabel htmlFor="receta-activa" className="flex-1">
              <span>
                Receta en uso
                <FieldDescription>Apagada, el plato no descuenta ingredientes al venderse.</FieldDescription>
              </span>
            </FieldLabel>
            <Switch id="receta-activa" checked={borrador.active} disabled={!editable} onCheckedChange={(v) => setBorrador({ ...borrador, active: v })} />
          </Field>
          {errores.length > 0 ? (
            <Notice tone="error" title="Revisa la receta">
              <ul className="list-disc pl-4">{errores.map((e) => <li key={e}>{e}</li>)}</ul>
            </Notice>
          ) : null}
          <ErrorAccion error={error} />
          {editable ? (
            <div className="flex flex-wrap justify-end gap-3">
              <Button variant="outline" size="xl" disabled={busy} onClick={onSalir}>Cancelar</Button>
              <BotonAccion size="xl" busy={busy} ocupado="Guardando…" onClick={() => void guardar()}>
                {receta ? "Guardar receta" : "Crear receta"}
              </BotonAccion>
            </div>
          ) : null}
        </div>
      </div>

      <aside className="flex flex-col gap-5 xl:sticky xl:top-4 xl:self-start" aria-label="Coste y versiones">
        <section className="superficie p-5" aria-label="Coste y margen de esta receta">
          <h3 className="text-base font-semibold">Coste y margen</h3>
          <p className="mt-1 text-xs text-muted-foreground">Con los costes medios de hoy, sin IVA, por ración.</p>
          {coste ? (
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-4">
              <Dato etiqueta="Coste" valor={euros(coste.costCents)} />
              <Dato etiqueta="Precio sin IVA" valor={euros(precioNeto)} />
              <Dato etiqueta="Margen" valor={margen ? euros(margen.marginCents) : "—"} tono={margen && margen.marginCents < 0 ? "mal" : undefined} />
              <Dato etiqueta="Margen sobre precio" valor={porcentaje(margen?.marginBp ?? null)} />
              <Dato etiqueta="Materia prima sobre precio" valor={porcentaje(margen?.foodCostBp ?? null)} />
            </dl>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">Completa las líneas para ver el coste.</p>
          )}
          {coste && !coste.complete ? (
            <p className="mt-4 flex gap-2 text-sm text-warning">
              <WarningIcon aria-hidden className="mt-0.5 shrink-0" weight="fill" />
              {coste.missing.length > 0
                ? `Falta el coste de ${coste.missing.map((id) => porId.get(id)?.name ?? "un ingrediente").join(", ")}. Se conocerá con la primera recepción o existencias iniciales.`
                : "La receta no tiene ingredientes ni coste manual."}
            </p>
          ) : null}
        </section>

        {receta ? (
          <section className="superficie p-5" aria-label="Versiones de la receta">
            <h3 className="text-base font-semibold">Versiones</h3>
            <p className="mt-1 text-xs text-muted-foreground">La versión sube cuando cambian ingredientes, cantidades o coste. Lo ya vendido conserva su coste de entonces.</p>
            <Cargado live={versiones} label="las versiones">
              {(lista) => (
                <ul className="mt-3 flex flex-col divide-y">
                  {lista.map((v, i) => (
                    <FilaVersion
                      key={v.version}
                      version={v}
                      anterior={lista[i + 1] ?? null}
                      actual={v.version === receta.version}
                      nombreIngrediente={(id) => porId.get(id)?.name ?? "un ingrediente"}
                      autor={v.by ? (nombres.get(v.by) ?? "Alguien del equipo") : "Sistema"}
                      timezone={timezone}
                      onRecuperar={editable ? () => { setBorrador(borradorDeReceta({ ...v, id: receta.id }, fila.etiqueta, unidad)); limpiar(); setErrores([]) } : undefined}
                    />
                  ))}
                </ul>
              )}
            </Cargado>
          </section>
        ) : null}
      </aside>
    </div>
  )
}

function Dato({ etiqueta, valor, tono }: { etiqueta: string; valor: string; tono?: "mal" }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{etiqueta}</dt>
      <dd className={`cifra mt-1 text-xl font-medium ${tono === "mal" ? "text-destructive" : ""}`}>{valor}</dd>
    </div>
  )
}

function FilaVersion({
  version, anterior, actual, nombreIngrediente, autor, timezone, onRecuperar,
}: {
  version: RecipeVersion
  anterior: RecipeVersion | null
  actual: boolean
  nombreIngrediente: (id: string) => string
  autor: string
  timezone: string
  onRecuperar?: () => void
}) {
  const cambios = anterior ? diferenciasVersion(anterior, version, nombreIngrediente) : ["Primera versión"]
  return (
    <li className="py-3">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">Versión {version.version}</span>
        {actual ? <Tag tone="habitual">Actual</Tag> : null}
      </p>
      <p className="text-xs text-muted-foreground">{formatoHora(version.at, timezone)} · {autor}</p>
      <p className="mt-1 text-sm text-soft-foreground">{cambios.length > 0 ? cambios.join(". ") + "." : "Sin cambios en los ingredientes."}</p>
      {!actual && onRecuperar ? (
        <Button variant="ghost" size="sm" className="mt-1 -ml-2" onClick={onRecuperar}>
          <ArrowCounterClockwiseIcon aria-hidden />
          Cargar esta versión en el formulario
        </Button>
      ) : null}
    </li>
  )
}

/* Líneas de ingredientes --------------------------------------------------------------------- */

function Lineas({
  etiqueta, lineas, onChange, ingredientes, costes, editable,
}: {
  etiqueta: string
  lineas: LineaBorrador[]
  onChange: (lineas: LineaBorrador[]) => void
  ingredientes: readonly IngredientWithId[]
  costes: ReadonlyMap<string, IngredientCost>
  editable: boolean
}) {
  const usados = new Set(lineas.map((l) => l.ingredientId))
  const libres = ingredientes.filter((i) => i.active && !usados.has(i.id))
  const cambiar = (idx: number, parte: Partial<LineaBorrador>) => onChange(lineas.map((l, i) => (i === idx ? { ...l, ...parte } : l)))

  return (
    <div className="flex flex-col gap-3">
      {lineas.length === 0 ? <p className="text-sm text-muted-foreground">Sin ingredientes.</p> : null}
      <ul className="flex flex-col gap-3">
        {lineas.map((l, idx) => {
          const ing = ingredientes.find((i) => i.id === l.ingredientId)
          const q = ing ? parseNeta(l.cantidad, ing) : null
          const y = parseRend(l.rendimiento)
          const requerido = q !== null && y !== null ? requiredQuantity({ quantity: q, yieldBp: y }) : null
          const medio = ing ? costeMedio(ing, costes.get(ing.id)) : null
          const coste = requerido !== null && medio ? costOfQuantity(medio, requerido) : null
          return (
            <li key={l.ingredientId || `nuevo-${idx}`} className="grid gap-2 rounded-lg border p-3 lg:grid-cols-[minmax(0,1.4fr)_6rem_6rem_minmax(12rem,1fr)_auto] lg:items-end">
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground">Ingrediente</span>
                <Desplegable aria-label={`${etiqueta}, ingrediente ${idx + 1}`} value={l.ingredientId} disabled={!editable} onChange={(e) => cambiar(idx, { ingredientId: e.target.value })} className="h-9 pointer-coarse:h-11">
                  <option value="">Elige un ingrediente</option>
                  {ing ? <option value={ing.id}>{ing.name}</option> : null}
                  {libres.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                </Desplegable>
              </div>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground">Neto{ing ? ` (${ing.unit === "u" ? "ud" : ing.unit})` : ""}</span>
                <Input aria-label={`${etiqueta}, cantidad neta ${idx + 1}`} className="cifra h-9 pointer-coarse:h-11" inputMode="decimal" disabled={!editable} value={l.cantidad} onChange={(e) => cambiar(idx, { cantidad: e.target.value })} />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground">Rendimiento %</span>
                <Input aria-label={`${etiqueta}, rendimiento ${idx + 1}`} className="cifra h-9 pointer-coarse:h-11" inputMode="decimal" disabled={!editable} value={l.rendimiento} onChange={(e) => cambiar(idx, { rendimiento: e.target.value })} />
              </label>
              <p className="cifra min-h-9 text-sm text-muted-foreground sm:pb-2">
                {requerido !== null && ing ? `Descuenta ${textoCantidad(requerido, ing.unit)}` : "—"}
                {coste !== null ? ` · ${euros(coste)}` : ing && requerido !== null ? " · sin coste" : ""}
              </p>
              {editable ? (
                <Button variant="ghost" size="icon" className="pointer-coarse:size-11" aria-label={`Quitar línea ${idx + 1} de ${etiqueta}`} onClick={() => onChange(lineas.filter((_, i) => i !== idx))}>
                  <TrashIcon aria-hidden />
                </Button>
              ) : null}
            </li>
          )
        })}
      </ul>
      {editable ? (
        <div>
          <Button variant="outline" className="pointer-coarse:h-11" disabled={libres.length === 0} onClick={() => onChange([...lineas, { ingredientId: "", cantidad: "", rendimiento: "100" }])}>
            <PlusIcon aria-hidden />
            Añadir ingrediente
          </Button>
        </div>
      ) : null}
    </div>
  )
}


function parseNeta(texto: string, ing: IngredientWithId): number | null {
  const q = leerCantidad(texto, ing.unit)
  return q.ok ? q.valor : null
}
function parseRend(texto: string): number | null {
  return leerRendimiento(texto)
}
