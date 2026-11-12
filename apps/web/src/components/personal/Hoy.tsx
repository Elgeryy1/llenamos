"use client"

import { PLAN_STATUS_LABEL, clockState, defaultStaffSettings, planVsReal, type PlanVsReal, type TimeEntryWithId } from "@llenamos/core"
import Link from "next/link"
import { useMemo } from "react"
import { LiveIndicator, LoadingBlock } from "@/components/common/loading"
import { Notice } from "@/components/common/notice"
import { PageHeading } from "@/components/common/page-heading"
import { SummaryStrip } from "@/components/common/summary-strip"
import { Tag } from "@/components/common/tag"
import { LiveError } from "@/components/panel/LiveError"
import { Button } from "@/components/ui/button"
import { useNow } from "@/lib/use-now"
import type { Alcance } from "@/lib/personal/api"
import { useAjustesPersonal, useFichajesAbiertos, useFichajesPeriodo, useTurnosSemana } from "@/lib/personal/datos"
import { diaLargo, diaMes, fechaDe, horaTexto, sumarDias, turnoTexto, weekStartOf } from "@/lib/personal/modelo"
import { ConEquipo, EstadoFichaje, NavegacionPersonal, Persona, PuertaPersonal, type Equipo } from "./piezas"

export function Hoy() {
  return (
    <PuertaPersonal permission="personal.gestionar" what="el personal">
      {(scope) => <HoyLocal scope={scope} />}
    </PuertaPersonal>
  )
}

function HoyLocal({ scope }: { scope: Alcance }) {
  const ahora = useNow(30_000).getTime()
  return (
    <div className="mt-5">
      <PageHeading
        title="Quién está trabajando"
        eyebrow={<span className="text-soft-foreground">{diaLargo(fechaDe(ahora))}</span>}
        description="Lo fichado ahora frente a los turnos de hoy."
        actions={<LiveIndicator time={horaTexto(ahora)} />}
      />
      <NavegacionPersonal />
      <ConEquipo scope={scope}>{(equipo) => <Panel scope={scope} equipo={equipo} ahora={ahora} />}</ConEquipo>
    </div>
  )
}

function Panel({ scope, equipo, ahora }: { scope: Alcance; equipo: Equipo; ahora: number }) {
  const hoy = fechaDe(ahora)
  const ajustesLive = useAjustesPersonal(scope, true)
  const ajustes = ajustesLive.status === "ready" ? ajustesLive.data : defaultStaffSettings()
  const abiertos = useFichajesAbiertos(scope)
  const delDia = useFichajesPeriodo(scope, sumarDias(hoy, -1), hoy)
  const turnos = useTurnosSemana(scope, weekStartOf(hoy), false)

  const turnosHoy = useMemo(() => (turnos.status === "ready" ? turnos.data.filter((t) => t.date === hoy) : []), [turnos, hoy])
  const plan = useMemo(
    () => new Map<string, PlanVsReal>(planVsReal(turnosHoy, delDia.status === "ready" ? delDia.data : [], ajustes, ahora).map((p) => [p.shiftId, p])),
    [turnosHoy, delDia, ajustes, ahora],
  )

  if (abiertos.status === "error") return <LiveError title="No se puede ver quién ha fichado" error={abiertos.error} />
  if (abiertos.status === "loading" || turnos.status === "loading") return <LoadingBlock label="Cargando el personal…" />
  if (turnos.status === "error") return <LiveError title="No se puede leer el cuadrante" error={turnos.error} />

  const porUid = new Map<string, TimeEntryWithId>(abiertos.data.map((e) => [e.uid, e]))
  const dentro = abiertos.data.filter((e) => !e.forgotten && clockState(e) === "working").length
  const enPausa = abiertos.data.filter((e) => !e.forgotten && clockState(e) === "on_break").length
  const olvidados = abiertos.data.filter((e) => e.forgotten)
  const sinFichar = [...plan.values()].filter((p) => p.status === "absent").length
  // Quien tiene turno hoy o está fichado va primero; luego el resto del equipo.
  const conTurno = new Set(turnosHoy.map((t) => t.uid))
  const orden = [...equipo.personas].sort((a, b) => Number(porUid.has(b.uid) || conTurno.has(b.uid)) - Number(porUid.has(a.uid) || conTurno.has(a.uid)))

  return (
    <div className="space-y-5">
      <SummaryStrip
        label="Resumen de hoy"
        items={[
          { label: "Trabajando", value: dentro, tone: dentro ? "success" : undefined },
          { label: "En pausa", value: enPausa, tone: enPausa ? "warning" : undefined },
          { label: "Sin fichar a su hora", value: sinFichar, tone: sinFichar ? "destructive" : undefined, hint: "Con turno ya empezado" },
          { label: "Olvidados", value: olvidados.length, tone: olvidados.length ? "destructive" : undefined, hint: olvidados.length ? "Hay que cerrarlos" : "Ninguno" },
        ]}
      />
      {olvidados.length ? (
        <Notice tone="warning" title={`${olvidados.length === 1 ? "Hay un fichaje olvidado" : `Hay ${olvidados.length} fichajes olvidados`}`} action={<Button asChild size="lg"><Link href="/panel/personal/horas">Resolverlos en las horas</Link></Button>}>
          {olvidados.map((e) => equipo.nombre(e.uid)).join(", ")}: no suman horas hasta que un encargado los cierre.
        </Notice>
      ) : null}

      <section className="superficie overflow-hidden" aria-label="Equipo">
        <h2 className="border-b px-5 py-3 text-base font-semibold">Equipo</h2>
        <ul className="divide-y">
          {orden.map((p) => {
            const e = porUid.get(p.uid) ?? null
            const misTurnos = turnosHoy.filter((t) => t.uid === p.uid)
            return (
              <li key={p.uid} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-3">
                <div className="min-w-0 flex-1 basis-56">
                  <Persona nombre={p.displayName} detalle={e ? (e.forgotten ? `Entró el ${diaMes(e.date)} y no ha salido` : `Entró a las ${horaTexto(e.startAt)}`) : "Sin fichaje abierto"} />
                </div>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  {misTurnos.length === 0 ? <span className="text-muted-foreground">Sin turno hoy</span> : null}
                  {misTurnos.map((t) => {
                    const pv = plan.get(t.id)
                    return (
                      <span key={t.id} className="flex items-center gap-2">
                        <span className="cifra">{turnoTexto(t)}</span>
                        {pv ? <Tag tone={pv.status === "on_time" ? "habitual" : pv.status === "upcoming" ? "neutro" : pv.status === "late" ? "aviso" : "alergia"}>{pv.status === "late" ? `Tarde ${pv.lateMinutes} min` : PLAN_STATUS_LABEL[pv.status]}</Tag> : null}
                      </span>
                    )
                  })}
                </div>
                <EstadoFichaje state={clockState(e)} forgotten={e?.forgotten} className="w-28 justify-end" />
              </li>
            )
          })}
        </ul>
      </section>
      {turnosHoy.some((t) => t.status === "draft") ? (
        <p className="text-xs text-muted-foreground">Hay turnos de hoy en borrador: el equipo aún no los ve. Publícalos desde el cuadrante.</p>
      ) : null}
    </div>
  )
}
