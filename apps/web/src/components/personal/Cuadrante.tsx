"use client"

import {
  PLAN_STATUS_LABEL, defaultStaffSettings, plannedMinutesByUid, planVsReal, scheduleWarnings, shiftMinutes,
  type PlanVsReal, type StaffShiftWithId,
} from "@llenamos/core"
import { CaretLeftIcon, CaretRightIcon, CopyIcon, PlusIcon, WarningIcon } from "@phosphor-icons/react"
import { useMemo, useState } from "react"
import { LoadingBlock } from "@/components/common/loading"
import { Notice } from "@/components/common/notice"
import { PageHeading } from "@/components/common/page-heading"
import { SegmentedControl } from "@/components/common/segmented-control"
import { SummaryStrip } from "@/components/common/summary-strip"
import { Tag } from "@/components/common/tag"
import { LiveError } from "@/components/panel/LiveError"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/cn"
import { useNow } from "@/lib/use-now"
import { useAccionPersonal, type Alcance } from "@/lib/personal/api"
import { useAjustesPersonal, useFichajesPeriodo, useTurnosSemana } from "@/lib/personal/datos"
import {
  agruparMotivos, avisosPorTurno, claveCelda, diaCorto, diaLargo, duracion, fechaDe, horasMinutos, rangoTexto, sumarDias, turnoTexto, turnosPorCelda, weekDates, weekStartOf,
} from "@/lib/personal/modelo"
import { DialogoTurno, type AccionTurno } from "./DialogoTurno"
import { ConEquipo, NavegacionPersonal, Persona, PuertaPersonal, type Equipo } from "./piezas"

export function Cuadrante() {
  return (
    <PuertaPersonal permission="personal.gestionar" what="el cuadrante">
      {(scope) => (
        <div className="mt-5">
          <PageHeading title="Cuadrante semanal" description="Turnos por persona y día. Son borrador hasta que publicas la semana: entonces los ve todo el equipo en su fichaje." />
          <NavegacionPersonal />
          <ConEquipo scope={scope}>{(equipo) => <CuadranteLocal scope={scope} equipo={equipo} />}</ConEquipo>
        </div>
      )}
    </PuertaPersonal>
  )
}

type Modo = "plan" | "real"

const TONO_PLAN: Record<PlanVsReal["status"], "habitual" | "aviso" | "alergia" | "neutro"> = { on_time: "habitual", late: "aviso", absent: "alergia", upcoming: "neutro" }

function CuadranteLocal({ scope, equipo }: { scope: Alcance; equipo: Equipo }) {
  const ahora = useNow(60_000).getTime()
  const hoy = fechaDe(ahora)
  const [semana, setSemana] = useState(weekStartOf(hoy))
  const [modo, setModo] = useState<Modo>("plan")
  const [accion, setAccion] = useState<AccionTurno | null>(null)
  const [aviso, setAviso] = useState<{ tono: "success" | "warning" | "error"; texto: string; detalles: string[] } | null>(null)
  const [copiar, setCopiar] = useState(false)
  const { ejecutar, ocupado } = useAccionPersonal(scope)

  const ajustesLive = useAjustesPersonal(scope, true)
  const ajustes = useMemo(() => (ajustesLive.status === "ready" ? ajustesLive.data : defaultStaffSettings()), [ajustesLive])
  const turnos = useTurnosSemana(scope, semana, false)
  const fichajes = useFichajesPeriodo(scope, semana, sumarDias(semana, 6))
  const dias = weekDates(semana)

  const lista = useMemo<StaffShiftWithId[]>(() => (turnos.status === "ready" ? turnos.data : []), [turnos])
  const celdas = useMemo(() => turnosPorCelda(lista), [lista])
  const avisos = useMemo(() => scheduleWarnings(lista, ajustes), [lista, ajustes])
  const porTurno = useMemo(() => avisosPorTurno(avisos), [avisos])
  const minutos = useMemo(() => plannedMinutesByUid(lista), [lista])
  const fichadas = fichajes.status === "ready" ? fichajes.data : null
  const comparacion = new Map(planVsReal(lista, fichadas ?? [], ajustes, ahora).map((p) => [p.shiftId, p]))
  const publicados = lista.filter((t) => t.status === "published").length
  const borradores = lista.length - publicados
  const uids = [...new Set([...equipo.personas.map((p) => p.uid), ...lista.map((t) => t.uid)])]
  const totalMin = lista.reduce((m, t) => m + shiftMinutes(t), 0)
  const semanaTexto = rangoTexto(semana, sumarDias(semana, 6))

  async function publicar(publish: boolean) {
    setAviso(null)
    const r = await ejecutar("publicarCuadrante", { weekStart: semana, publish })
    if (!r) return
    if (r.ok) {
      setAviso({
        tono: publish ? "success" : "success",
        texto: publish
          ? `Cuadrante publicado: ${r.data.shifts} turnos ya los ve el equipo. Llenamos no manda avisos en esta fase: díselo al equipo.`
          : `Cuadrante pasado a borrador: el equipo deja de ver ${r.data.shifts} turnos.`,
        detalles: r.data.warnings.map((w) => `${equipo.nombre(w.uid)}: ${w.message}`),
      })
    } else setAviso({ tono: "error", texto: r.message, detalles: [] })
  }

  async function copiarAnterior() {
    setCopiar(false)
    setAviso(null)
    const r = await ejecutar("copiarSemanaCuadrante", { fromWeekStart: sumarDias(semana, -7), toWeekStart: semana })
    if (!r) return
    if (r.ok) {
      setAviso({
        tono: r.data.skipped.length ? "warning" : "success",
        texto: `Copiados ${r.data.copied} turnos de la semana anterior como borrador.${r.data.skipped.length ? ` Se han dejado ${r.data.skipped.length} sin copiar.` : ""}`,
        detalles: agruparMotivos(r.data.skipped.map((s) => s.reason)),
      })
    } else setAviso({ tono: "error", texto: r.message, detalles: [] })
  }

  return (
    <div className="space-y-5">
      <div className="superficie flex flex-col gap-3 p-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" aria-label="Semana anterior" onClick={() => setSemana(sumarDias(semana, -7))}><CaretLeftIcon aria-hidden /></Button>
          <p className="min-w-0 flex-1 text-center text-[15px] font-medium sm:min-w-44 sm:flex-none" aria-live="polite">{semanaTexto}</p>
          <Button variant="outline" size="icon" aria-label="Semana siguiente" onClick={() => setSemana(sumarDias(semana, 7))}><CaretRightIcon aria-hidden /></Button>
          <Button variant="ghost" onClick={() => setSemana(weekStartOf(hoy))} disabled={semana === weekStartOf(hoy)}>Esta semana</Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl label="Qué ver" value={modo} onValueChange={setModo} options={[{ value: "plan", label: "Lo planificado" }, { value: "real", label: "Comparar con lo fichado", short: "Comparar" }]} />
          <Button variant="outline" size="lg" className="pointer-coarse:h-11" onClick={() => setCopiar(true)} disabled={ocupado}><CopyIcon aria-hidden /> Copiar la semana anterior</Button>
          {borradores > 0 || lista.length === 0 ? (
            <Button size="lg" className="shadow-soft pointer-coarse:h-11" onClick={() => void publicar(true)} disabled={ocupado || lista.length === 0}>
              {borradores > 0 && publicados > 0 ? `Publicar ${borradores} nuevos` : "Publicar la semana"}
            </Button>
          ) : (
            <Button size="lg" variant="outline" className="pointer-coarse:h-11" onClick={() => void publicar(false)} disabled={ocupado}>Pasar a borrador</Button>
          )}
        </div>
      </div>

      {aviso ? (
        <Notice tone={aviso.tono} title={aviso.texto}>
          {aviso.detalles.length ? <ul className="list-disc pl-5">{aviso.detalles.map((d, i) => <li key={i}>{d}</li>)}</ul> : null}
        </Notice>
      ) : null}
      {turnos.status === "error" ? <LiveError title="No se puede leer el cuadrante" error={turnos.error} /> : null}
      {ajustesLive.status === "error" ? <LiveError title="No se pueden leer los ajustes de personal" error={ajustesLive.error} /> : null}

      {turnos.status === "loading" ? <LoadingBlock label="Cargando el cuadrante…" /> : null}
      {turnos.status === "ready" ? (
        <>
          <SummaryStrip
            label="Resumen de la semana"
            items={[
              { label: "Horas planificadas", value: horasMinutos(totalMin), hint: duracion(totalMin) },
              { label: "Turnos", value: lista.length, hint: `${publicados} publicados, ${borradores} en borrador` },
              { label: "Personas", value: Object.keys(minutos).length },
              { label: "Avisos", value: avisos.length, tone: avisos.length ? "warning" : undefined, hint: avisos.length ? "Mira el detalle abajo" : "Todo en orden" },
            ]}
          />
          {avisos.length ? (
            <Notice tone="warning" title="Avisos del cuadrante (orientativos, no bloquean)">
              <ul className="list-disc pl-5">{avisos.map((a, i) => <li key={i}>{equipo.nombre(a.uid)}: {a.message}</li>)}</ul>
              <p className="mt-1 text-xs">Límites de descanso y de horas de los ajustes. No es asesoría laboral: el convenio de cada restaurante puede ser otro.</p>
            </Notice>
          ) : null}

          {/* Rejilla de escritorio y tableta */}
          <section className="superficie hidden overflow-x-auto lg:block" aria-label="Cuadrante por persona y día">
            <table className="w-full min-w-[820px] table-fixed text-sm">
              <caption className="sr-only">Turnos de la semana del {semanaTexto}</caption>
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th scope="col" className="w-44 px-4 py-2 text-left font-normal">Persona</th>
                  {dias.map((d) => <th key={d} scope="col" className={cn("px-1 py-2 text-left font-normal", d === hoy && "text-warning")}>{diaCorto(d)}{d === hoy ? " · hoy" : ""}</th>)}
                  <th scope="col" className="w-20 px-4 py-2 text-right font-normal">Horas</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {uids.map((uid) => {
                  const semanal = avisos.some((a) => a.uid === uid && a.kind === "weekly_hours")
                  return (
                    <tr key={uid} className="align-top">
                      <th scope="row" className="px-4 py-2 text-left font-normal"><Persona nombre={equipo.nombre(uid)} size="sm" /></th>
                      {dias.map((d) => (
                        <td key={d} className={cn("space-y-1 px-1 py-1.5", d === hoy && "bg-surface-raised/50")}>
                          {(celdas.get(claveCelda(uid, d)) ?? []).map((t) => (
                            <ChipTurno key={t.id} t={t} nombre={equipo.nombre(uid)} avisos={porTurno.get(t.id)} plan={modo === "real" ? comparacion.get(t.id) : undefined} onClick={() => setAccion({ tipo: "editar", turno: t })} />
                          ))}
                          <button
                            type="button"
                            aria-label={`Añadir un turno a ${equipo.nombre(uid)} el ${diaLargo(d)}`}
                            onClick={() => setAccion({ tipo: "nuevo", uid, fecha: d })}
                            className="flex h-6 w-full items-center justify-center rounded-md text-ash opacity-60 transition-[opacity,background-color] hover:bg-surface-raised hover:text-foreground hover:opacity-100 focus-visible:opacity-100 pointer-coarse:h-9 pointer-coarse:opacity-100"
                          >
                            <PlusIcon aria-hidden className="size-3.5" />
                          </button>
                        </td>
                      ))}
                      <td className={cn("cifra px-4 py-3 text-right text-base font-semibold", semanal && "text-warning")}>{horasMinutos(minutos[uid] ?? 0)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </section>

          {/* Lista por día para el móvil */}
          <section className="space-y-4 lg:hidden" aria-label="Cuadrante por día">
            {dias.map((d) => {
              const delDia = lista.filter((t) => t.date === d).sort((a, b) => a.startAt - b.startAt)
              return (
                <div key={d} className="superficie overflow-hidden">
                  <h2 className={cn("flex items-center justify-between border-b px-4 py-3 text-base font-semibold", d === hoy && "text-warning")}>
                    <span>{diaLargo(d)}{d === hoy ? " · hoy" : ""}</span>
                    <Button variant="outline" size="sm" className="pointer-coarse:min-h-11" aria-label={`Añadir un turno el ${diaLargo(d)}`} onClick={() => setAccion({ tipo: "nuevo", uid: null, fecha: d })}><PlusIcon aria-hidden /> Turno</Button>
                  </h2>
                  {delDia.length === 0 ? <p className="px-4 py-3 text-sm text-muted-foreground">Sin turnos.</p> : null}
                  <ul className="divide-y">
                    {delDia.map((t) => (
                      <li key={t.id}>
                        <button type="button" className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-surface-raised" onClick={() => setAccion({ tipo: "editar", turno: t })}>
                          <Persona nombre={equipo.nombre(t.uid)} size="sm" detalle={<>{t.position}{t.status === "draft" ? " · borrador" : ""}</>} />
                          <span className="flex flex-col items-end gap-1">
                            <span className="cifra text-[15px] font-medium">{turnoTexto(t)}</span>
                            {porTurno.get(t.id) ? <Tag tone="aviso"><WarningIcon aria-hidden /> Aviso</Tag> : null}
                            {modo === "real" && comparacion.get(t.id) ? <EtiquetaPlan p={comparacion.get(t.id)!} /> : null}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })}
          </section>

          <p className="text-xs text-muted-foreground">
            Los turnos con borde de puntos son borrador: el equipo no los ve hasta que publiques. Para ver o cambiar un turno, tócalo.
          </p>
        </>
      ) : null}

      <DialogoTurno
        accion={accion}
        scope={scope}
        personas={equipo.personas}
        nombre={equipo.nombre}
        onClose={() => setAccion(null)}
        onGuardado={(texto, detalles) => { setAccion(null); setAviso({ tono: detalles.length ? "warning" : "success", texto, detalles }) }}
      />

      <Dialog open={copiar} onOpenChange={setCopiar}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Copiar la semana anterior</DialogTitle>
            <DialogDescription>
              Se copian los turnos del {rangoTexto(sumarDias(semana, -7), sumarDias(semana, -1))} a esta semana, con las mismas horas, como borrador.
              {lista.length ? " Los turnos que ya tienes no se tocan: los que se pisen con ellos se dejan sin copiar." : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCopiar(false)}>Cancelar</Button>
            <Button onClick={() => void copiarAnterior()} disabled={ocupado}>Copiar los turnos</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function EtiquetaPlan({ p }: { p: PlanVsReal }) {
  return (
    <Tag tone={TONO_PLAN[p.status]}>
      {p.status === "late" ? `Tarde ${p.lateMinutes} min` : PLAN_STATUS_LABEL[p.status]}
    </Tag>
  )
}

function ChipTurno({ t, nombre, avisos, plan, onClick }: { t: StaffShiftWithId; nombre: string; avisos: string[] | undefined; plan: PlanVsReal | undefined; onClick: () => void }) {
  const borrador = t.status === "draft"
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Turno de ${nombre}, ${turnoTexto(t)}, ${t.position}${borrador ? ", borrador" : ""}${avisos ? `, aviso: ${avisos.join(" ")}` : ""}`}
      className={cn(
        "block w-full rounded-md border bg-card px-1.5 py-1 text-left text-xs shadow-soft transition-colors hover:bg-surface-raised pointer-coarse:min-h-11",
        borrador && "border-dashed border-soft-foreground/40",
        avisos && "border-warning/60",
      )}
    >
      <span className="cifra block text-[11.5px] font-medium whitespace-nowrap">{turnoTexto(t)}</span>
      <span className="flex items-center justify-between gap-1 text-muted-foreground">
        <span className="truncate">{t.position}</span>
        {avisos ? <WarningIcon aria-hidden weight="fill" className="size-3 shrink-0 text-warning" /> : null}
      </span>
      {plan ? (
        <span className="mt-1 flex flex-wrap items-center gap-1">
          <EtiquetaPlan p={plan} />
          {plan.workedMinutes !== null ? <span className="cifra text-[11px] text-muted-foreground">{horasMinutos(plan.workedMinutes)} de {horasMinutos(plan.plannedMinutes)}</span> : null}
        </span>
      ) : null}
    </button>
  )
}
