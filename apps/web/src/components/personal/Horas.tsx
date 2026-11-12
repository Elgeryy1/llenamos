"use client"

import { clockState, suggestedCloseAt, weekStartOf, type TimeEntryWithId } from "@llenamos/core"
import { CaretLeftIcon, CaretRightIcon, ClockClockwiseIcon, DotsThreeIcon, PencilSimpleIcon, PlusIcon, ProhibitIcon, SignOutIcon } from "@phosphor-icons/react"
import { useMemo, useState } from "react"
import { ExportarRegistro } from "./ExportarRegistro"
import { LoadingBlock } from "@/components/common/loading"
import { Notice } from "@/components/common/notice"
import { PageHeading } from "@/components/common/page-heading"
import { SegmentedControl } from "@/components/common/segmented-control"
import { SelectField } from "@/components/common/form-fields"
import { SummaryStrip } from "@/components/common/summary-strip"
import { Tag } from "@/components/common/tag"
import { LiveError } from "@/components/panel/LiveError"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/cn"
import { useNow } from "@/lib/use-now"
import type { Alcance } from "@/lib/personal/api"
import { useAjustesPersonal, useFichajesAbiertos, useFichajesPeriodo, useInformeHoras, useTurnosSemana } from "@/lib/personal/datos"
import {
  diaCorto, diaLargo, diaMes, duracion, fechaDe, fechasEntre, horaTexto, horasMinutos, moverAncla, periodoDe, rangoTexto, type TipoPeriodo,
} from "@/lib/personal/modelo"
import { DialogosFichaje, type AccionFichaje } from "./DialogosFichaje"
import { ConEquipo, NavegacionPersonal, Persona, PuertaPersonal, type Equipo } from "./piezas"

export function Horas() {
  return (
    <PuertaPersonal permission="personal.gestionar" what="las horas del equipo">
      {(scope) => (
        <div className="mt-5">
          <PageHeading title="Horas del equipo" description="Lo fichado por cada persona, con correcciones, fichajes olvidados y anulaciones. Todo cambio queda con su motivo." />
          <NavegacionPersonal />
          <ConEquipo scope={scope}>{(equipo) => <HorasLocal scope={scope} equipo={equipo} />}</ConEquipo>
        </div>
      )}
    </PuertaPersonal>
  )
}

function HorasLocal({ scope, equipo }: { scope: Alcance; equipo: Equipo }) {
  const ahora = useNow(60_000).getTime()
  const hoy = fechaDe(ahora)
  const [tipo, setTipo] = useState<TipoPeriodo>("semana")
  const [ancla, setAncla] = useState(hoy)
  const [uid, setUid] = useState("")
  const [recarga, setRecarga] = useState(0)
  const [accion, setAccion] = useState<AccionFichaje | null>(null)
  const [cerrando, setCerrando] = useState<TimeEntryWithId | null>(null)
  const [aviso, setAviso] = useState<string | null>(null)

  const { from, to } = periodoDe(tipo, ancla)
  const ajustes = useAjustesPersonal(scope, true)
  const informe = useInformeHoras(scope, from, to, uid || null, recarga)
  const fichajes = useFichajesPeriodo(scope, from, to)
  const abiertos = useFichajesAbiertos(scope)
  // Para proponer la salida de un olvidado se miran los turnos de la semana de ese fichaje.
  const turnosCierre = useTurnosSemana(scope, weekStartOf(cerrando?.date ?? hoy), false)

  const lista = useMemo(
    () => (fichajes.status === "ready" ? fichajes.data.filter((e) => !uid || e.uid === uid) : []),
    [fichajes, uid],
  )
  const filas = informe.status === "ready" ? informe.rows : []
  const total = filas.reduce((m, r) => m + r.minutes, 0)
  const porResolver = (abiertos.status === "ready" ? abiertos.data : []).filter((e) => !uid || e.uid === uid)
  const olvidados = porResolver.filter((e) => e.forgotten)
  const porRevisar = lista.filter((e) => e.needsReview && e.status !== "voided").length
  const dias = fechasEntre(from, to)

  const accionActiva: AccionFichaje | null = cerrando
    ? turnosCierre.status === "loading"
      ? null
      : {
          tipo: "cerrar",
          entry: cerrando,
          salidaSugerida: turnosCierre.status === "ready"
            ? suggestedCloseAt(cerrando, turnosCierre.data.find((t) => t.uid === cerrando.uid && t.date === cerrando.date) ?? null)
            : null,
        }
    : accion

  const cerrarDialogo = () => { setAccion(null); setCerrando(null) }
  function alAbrir(e: TimeEntryWithId, a: "corregir" | "cerrar" | "anular" | "historial") {
    setAviso(null)
    if (a === "cerrar") setCerrando(e)
    else setAccion({ tipo: a, entry: e })
  }

  return (
    <div className="space-y-5">
      <div className="superficie flex flex-col gap-3 p-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <SegmentedControl
            label="Periodo"
            value={tipo}
            onValueChange={(t) => { setTipo(t); setAncla(hoy) }}
            options={[{ value: "semana", label: "Semana" }, { value: "mes", label: "Mes" }]}
          />
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" aria-label="Periodo anterior" onClick={() => setAncla(moverAncla(tipo, ancla, -1))}><CaretLeftIcon aria-hidden /></Button>
            <p className="min-w-0 flex-1 text-center text-[15px] font-medium sm:min-w-40 sm:flex-none" aria-live="polite">{rangoTexto(from, to)}</p>
            <Button variant="outline" size="icon" aria-label="Periodo siguiente" onClick={() => setAncla(moverAncla(tipo, ancla, 1))}><CaretRightIcon aria-hidden /></Button>
            <Button variant="ghost" onClick={() => setAncla(hoy)} disabled={from <= hoy && hoy <= to}>Hoy</Button>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <SelectField label="Persona" value={uid} onChange={(e) => setUid(e.target.value)} fieldClassName="min-w-52">
            <option value="">Todo el equipo</option>
            {equipo.personas.map((p) => <option key={p.uid} value={p.uid}>{p.displayName}</option>)}
            {equipo.antiguas.length ? <optgroup label="Ya no trabajan aquí">{equipo.antiguas.map((p) => <option key={p.uid} value={p.uid}>{p.displayName}</option>)}</optgroup> : null}
          </SelectField>
          <Button size="lg" className="shadow-soft pointer-coarse:h-11" onClick={() => { setAviso(null); setAccion({ tipo: "crear", uidInicial: uid || null, fecha: to < hoy ? to : hoy }) }}>
            <PlusIcon aria-hidden weight="bold" /> Añadir fichaje
          </Button>
        </div>
      </div>

      {aviso ? <Notice tone="success">{aviso}</Notice> : null}

      <SummaryStrip
        label="Resumen del periodo"
        items={[
          { label: "Horas trabajadas", value: informe.status === "ready" ? horasMinutos(total) : "…", hint: informe.status === "ready" ? duracion(total) : undefined },
          { label: "Fichajes", value: informe.status === "ready" ? filas.reduce((m, r) => m + r.entries, 0) : "…", hint: "Cerrados en el periodo" },
          { label: "Sin cerrar", value: porResolver.length, tone: olvidados.length ? "destructive" : porResolver.length ? "warning" : undefined, hint: olvidados.length ? `${olvidados.length} ${olvidados.length === 1 ? "olvidado" : "olvidados"}` : "Fichando ahora" },
          { label: "Por revisar", value: porRevisar, hint: "Tocados por un encargado" },
        ]}
      />

      {abiertos.status === "error" ? <LiveError title="No se pueden leer los fichajes abiertos" error={abiertos.error} /> : null}
      {olvidados.length ? (
        <section className="superficie overflow-hidden border-destructive/40" aria-label="Fichajes olvidados">
          <h2 className="border-b px-5 py-3 text-base font-semibold text-destructive">Fichajes olvidados: hay que cerrarlos</h2>
          <p className="px-5 pt-3 text-sm text-muted-foreground">Mientras sigan abiertos no suman horas ni se pueden cerrar fichando. Pon la hora real de salida o anúlalos.</p>
          <ul className="divide-y">
            {olvidados.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <Persona nombre={equipo.nombre(e.uid)} detalle={`Entró el ${diaMes(e.date)} a las ${horaTexto(e.startAt)}`} />
                <div className="flex gap-2">
                  <Button size="lg" onClick={() => alAbrir(e, "cerrar")}><SignOutIcon aria-hidden /> Cerrar con su hora</Button>
                  <Button size="lg" variant="outline" onClick={() => alAbrir(e, "anular")}>Anular</Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="superficie overflow-hidden" aria-label="Horas por persona">
        <h2 className="border-b px-5 py-3 text-base font-semibold">Por persona</h2>
        {informe.status === "loading" ? <LoadingBlock label="Calculando las horas…" className="p-5" /> : null}
        {informe.status === "error" ? <div className="p-4"><Notice tone="error">{informe.message}</Notice></div> : null}
        {informe.status === "ready" && filas.length === 0 ? <p className="px-5 py-4 text-sm text-muted-foreground">Nadie ha fichado en este periodo.</p> : null}
        {filas.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[320px] text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b">
                  <th scope="col" className="px-5 py-2 text-left font-normal">Persona</th>
                  {tipo === "semana" ? dias.map((d) => <th key={d} scope="col" className={cn("hidden px-2 py-2 text-right font-normal lg:table-cell", d === hoy && "text-warning")}>{diaCorto(d)}</th>) : null}
                  <th scope="col" className="px-5 py-2 text-right font-normal">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filas.map((r) => (
                  <tr key={r.uid} className="hover:bg-surface-raised">
                    <td className="px-5 py-3">
                      <button type="button" className="text-left" onClick={() => setUid(uid === r.uid ? "" : r.uid)} aria-pressed={uid === r.uid} aria-label={`${uid === r.uid ? "Quitar el filtro de" : "Ver solo a"} ${equipo.nombre(r.uid)}`}>
                        <Persona nombre={equipo.nombre(r.uid)} detalle={
                          <>
                            {r.entries} {r.entries === 1 ? "fichaje" : "fichajes"}
                            {r.forgottenEntries ? <span className="text-destructive"> · {r.forgottenEntries} olvidado</span> : r.openEntries ? <span className="text-warning"> · {duracion(r.provisionalMinutes)} en curso</span> : null}
                          </>
                        } />
                      </button>
                    </td>
                    {tipo === "semana" ? dias.map((d) => <td key={d} className="cifra hidden px-2 py-3 text-right lg:table-cell">{r.byDate[d] ? horasMinutos(r.byDate[d]) : <span className="text-ash">·</span>}</td>) : null}
                    <td className="cifra px-5 py-3 text-right text-base font-semibold">{horasMinutos(r.minutes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="superficie overflow-hidden" aria-label="Fichajes del periodo">
        <h2 className="border-b px-5 py-3 text-base font-semibold">Fichajes</h2>
        {fichajes.status === "loading" ? <LoadingBlock label="Cargando los fichajes…" className="p-5" /> : null}
        {fichajes.status === "error" ? <div className="p-4"><LiveError title="No se pueden leer los fichajes" error={fichajes.error} /></div> : null}
        {fichajes.status === "ready" && lista.length === 0 ? <p className="px-5 py-4 text-sm text-muted-foreground">No hay fichajes en este periodo.</p> : null}
        {[...new Set(lista.map((e) => e.date))].sort().reverse().map((d) => (
          <div key={d}>
            <h3 className="border-y bg-surface-sunken/50 px-5 py-1.5 text-xs font-medium text-muted-foreground first:border-t-0">{diaLargo(d)}</h3>
            <ul className="divide-y">
              {lista.filter((e) => e.date === d).map((e) => (
                <FilaFichaje key={e.id} e={e} nombre={equipo.nombre(e.uid)} onAccion={alAbrir} />
              ))}
            </ul>
          </div>
        ))}
      </section>

      {uid ? <ExportarRegistro key={uid} scope={scope} uid={uid} etiqueta={`Descargar el registro de ${equipo.nombre(uid)}`} /> : null}

      <DialogosFichaje
        accion={accionActiva}
        scope={scope}
        personas={equipo.personas}
        nombre={equipo.nombre}
        ajustes={ajustes.status === "ready" ? ajustes.data : null}
        onClose={cerrarDialogo}
        onGuardado={(texto) => { cerrarDialogo(); setAviso(texto); setRecarga((n) => n + 1) }}
      />
    </div>
  )
}

function FilaFichaje({ e, nombre, onAccion }: { e: TimeEntryWithId; nombre: string; onAccion: (e: TimeEntryWithId, a: "corregir" | "cerrar" | "anular" | "historial") => void }) {
  const anulado = e.status === "voided"
  const abierto = e.status === "open"
  const estado = clockState(e)
  return (
    <li className={cn("flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-3", anulado && "opacity-60")}>
      <div className="min-w-0 flex-1 basis-56">
        <Persona nombre={nombre} detalle={
          <span className="cifra">
            {horaTexto(e.startAt)} a {e.endAt === null ? "sin salida" : horaTexto(e.endAt)}
            {e.breaks.length ? ` · ${e.breaks.length} ${e.breaks.length === 1 ? "pausa" : "pausas"}${e.breakMinutes ? ` de ${duracion(e.breakMinutes)}` : ""}` : ""}
          </span>
        } />
        <div className="mt-1.5 flex flex-wrap gap-1 pl-12">
          {anulado ? <Tag tone="alergia">Anulado</Tag> : null}
          {abierto && e.forgotten ? <Tag tone="aviso">Olvidado</Tag> : null}
          {abierto && !e.forgotten ? <Tag tone="habitual">{estado === "on_break" ? "En pausa" : "Fichando"}</Tag> : null}
          {e.needsReview && !anulado ? <Tag>Tocado por un encargado</Tag> : null}
          {e.startSource === "kiosk" ? <Tag>Desde el puesto</Tag> : null}
        </div>
      </div>
      <span className="cifra w-20 text-right text-base font-semibold">{anulado ? "" : e.workedMinutes === null ? "abierto" : horasMinutos(e.workedMinutes)}</span>
      <div className="flex items-center gap-1">
        {!anulado ? (
          <Button variant="outline" size="lg" onClick={() => onAccion(e, abierto ? "cerrar" : "corregir")}>
            {abierto ? <><SignOutIcon aria-hidden /> Cerrar</> : <><PencilSimpleIcon aria-hidden /> Corregir</>}
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={`Más acciones del fichaje de ${nombre}`}><DotsThreeIcon aria-hidden weight="bold" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem className="min-h-11" onSelect={() => onAccion(e, "historial")}><ClockClockwiseIcon aria-hidden /> Ver el historial</DropdownMenuItem>
            {!anulado ? <DropdownMenuItem className="min-h-11" variant="destructive" onSelect={() => onAccion(e, "anular")}><ProhibitIcon aria-hidden /> Anular el fichaje</DropdownMenuItem> : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  )
}
