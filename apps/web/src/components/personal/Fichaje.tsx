"use client"

import {
  clockState,
  defaultStaffSettings,
  entryMinutes,
  type ClockAction,
  type TimeEntryWithId,
} from "@llenamos/core"
import { CoffeeIcon, PlayIcon, SignInIcon, SignOutIcon } from "@phosphor-icons/react"
import { useMemo, useState } from "react"
import { LoadingBlock } from "@/components/common/loading"
import { Notice } from "@/components/common/notice"
import { PageHeading } from "@/components/common/page-heading"
import { SummaryStrip } from "@/components/common/summary-strip"
import { Tag } from "@/components/common/tag"
import { LiveError } from "@/components/panel/LiveError"
import { usePanel } from "@/components/panel/PanelContext"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/cn"
import { useNow } from "@/lib/use-now"
import { useAccionPersonal, type Alcance } from "@/lib/personal/api"
import { useFichajesDe, useInformeHoras, useTurnosSemana } from "@/lib/personal/datos"
import {
  diaLargo, diaMes, duracion, fechaDe, horaTexto, periodoDe, sumarDias, turnoTexto,
} from "@/lib/personal/modelo"
import { ExportarRegistro } from "./ExportarRegistro"
import { EstadoFichaje, PuertaPersonal } from "./piezas"

export function Fichaje() {
  return (
    <PuertaPersonal permission="fichaje.registrar" what="el fichaje">
      {(scope) => <FichajeLocal scope={scope} />}
    </PuertaPersonal>
  )
}

const TEXTO_ACCION: Record<ClockAction, string> = {
  in: "Entrada fichada",
  break_start: "Pausa empezada",
  break_end: "Vuelta de la pausa fichada",
  out: "Salida fichada",
}

/** Las marcas de un fichaje, en orden, para enseñar lo que ya se ha pulsado. */
function marcasDe(e: TimeEntryWithId): { at: number; texto: string }[] {
  const marcas = [{ at: e.startAt, texto: "Entrada" }]
  for (const b of e.breaks) {
    marcas.push({ at: b.startAt, texto: "Empieza la pausa" })
    if (b.endAt !== null) marcas.push({ at: b.endAt, texto: "Vuelve de la pausa" })
  }
  if (e.endAt !== null) marcas.push({ at: e.endAt, texto: "Salida" })
  return marcas.sort((a, b) => a.at - b.at)
}

function FichajeLocal({ scope }: { scope: Alcance }) {
  const { user, location } = usePanel()
  const ahora = useNow(30_000)
  const now = ahora.getTime()
  const hoy = fechaDe(now)
  const semana = periodoDe("semana", hoy)
  const [recarga, setRecarga] = useState(0)
  const [confirmarSalida, setConfirmarSalida] = useState(false)
  const [resultado, setResultado] = useState<{ tono: "success" | "error"; texto: string } | null>(null)
  const { ejecutar, ocupado } = useAccionPersonal(scope)

  const fichajes = useFichajesDe(scope, user.uid, sumarDias(hoy, -13), hoy)
  const turnos = useTurnosSemana(scope, semana.from, true)
  const informe = useInformeHoras(scope, semana.from, semana.to, user.uid, recarga)

  const abierto = useMemo(
    () => (fichajes.status === "ready" ? (fichajes.data.find((e) => e.status === "open") ?? null) : null),
    [fichajes],
  )
  const estado = clockState(abierto)
  const olvidado = abierto?.forgotten === true

  async function fichar(action: ClockAction) {
    setConfirmarSalida(false)
    setResultado(null)
    const r = await ejecutar("fichar", { action, note: null })
    if (!r) return
    if (r.ok) {
      setResultado({ tono: "success", texto: `${TEXTO_ACCION[action]} a las ${horaTexto(r.data.at)}.` })
      setRecarga((n) => n + 1)
    } else setResultado({ tono: "error", texto: r.message })
  }

  const trabajado = abierto && !olvidado ? entryMinutes(abierto, defaultStaffSettings(), Math.max(now, abierto.startAt)).workedMinutes : null
  const misTurnos = turnos.status === "ready" ? turnos.data.filter((t) => t.uid === user.uid) : []
  const turnoHoy = misTurnos.find((t) => t.date === hoy) ?? null
  const planificado = misTurnos.reduce((m, t) => m + Math.floor((t.endAt - t.startAt) / 60_000), 0)
  const fila = informe.status === "ready" ? informe.rows[0] : undefined
  const marcasHoy = fichajes.status === "ready"
    ? fichajes.data.filter((e) => e.status !== "voided" && (e.status === "open" || e.date === hoy)).flatMap(marcasDe).sort((a, b) => a.at - b.at)
    : []

  const titulo = olvidado
    ? "Tu fichaje sigue abierto de otro día"
    : estado === "working" ? `Trabajando desde las ${horaTexto(abierto!.startAt)}`
    : estado === "on_break" ? "Estás en pausa"
    : "Aún no has fichado"

  return (
    <div className="mt-5 space-y-5">
      <PageHeading
        title={titulo}
        eyebrow={<><span className="text-soft-foreground">{diaLargo(hoy)}</span>{location ? ` · ${location.name}` : ""}</>}
        description="Cada marca queda con la hora del servidor, no con la del móvil."
      />

      {fichajes.status === "error" ? <LiveError title="No se pueden leer tus fichajes" error={fichajes.error} /> : null}
      {fichajes.status === "loading" ? <LoadingBlock label="Cargando tus fichajes…" /> : null}

      {fichajes.status === "ready" ? (
        <div className="grid items-start gap-5 lg:grid-cols-2">
          <section className="superficie space-y-5 p-5" aria-label="Fichar">
            <div className="flex items-start justify-between gap-4">
              <EstadoFichaje state={estado} forgotten={olvidado} className="text-base" />
              {trabajado !== null ? (
                <p className="text-right">
                  <span className="cifra block text-3xl leading-none font-semibold" data-testid="trabajado">{duracion(trabajado)}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">trabajados hasta ahora</span>
                </p>
              ) : null}
            </div>

            {olvidado ? (
              <Notice tone="warning" title="No se puede fichar hasta que un encargado lo cierre">
                Tu fichaje del {diaMes(abierto!.date)} se quedó abierto. Avisa a un encargado: pondrá la hora de salida y el motivo.
              </Notice>
            ) : confirmarSalida ? (
              <div className="space-y-3" role="group" aria-label="Confirmar la salida">
                <p className="text-sm">¿Fichas ahora la salida? Si estás en pausa, se cierra también.</p>
                <div className="grid grid-cols-2 gap-3">
                  <Button size="xl" className="h-16 text-lg shadow-soft" disabled={ocupado} onClick={() => void fichar("out")}>
                    <SignOutIcon aria-hidden weight="bold" /> Sí, salir
                  </Button>
                  <Button size="xl" variant="outline" className="h-16 text-lg" disabled={ocupado} onClick={() => setConfirmarSalida(false)}>Seguir</Button>
                </div>
              </div>
            ) : (
              <div className={cn("grid gap-3", estado === "out" ? "grid-cols-1" : "grid-cols-2")}>
                {estado === "out" ? (
                  <Button size="xl" className="h-20 text-xl shadow-soft" disabled={ocupado} onClick={() => void fichar("in")}>
                    <SignInIcon aria-hidden weight="bold" className="size-6" /> Fichar entrada
                  </Button>
                ) : null}
                {estado === "working" ? (
                  <>
                    <Button size="xl" variant="outline" className="h-20 text-lg shadow-soft" disabled={ocupado} onClick={() => void fichar("break_start")}>
                      <CoffeeIcon aria-hidden className="size-5" /> Pausa
                    </Button>
                    <Button size="xl" className="h-20 text-lg shadow-soft" disabled={ocupado} onClick={() => setConfirmarSalida(true)}>
                      <SignOutIcon aria-hidden weight="bold" className="size-5" /> Salir
                    </Button>
                  </>
                ) : null}
                {estado === "on_break" ? (
                  <>
                    <Button size="xl" className="h-20 text-lg shadow-soft" disabled={ocupado} onClick={() => void fichar("break_end")}>
                      <PlayIcon aria-hidden weight="fill" className="size-5" /> Volver de la pausa
                    </Button>
                    <Button size="xl" variant="outline" className="h-20 text-lg shadow-soft" disabled={ocupado} onClick={() => setConfirmarSalida(true)}>
                      <SignOutIcon aria-hidden className="size-5" /> Salir
                    </Button>
                  </>
                ) : null}
              </div>
            )}

            {resultado ? (
              <Notice tone={resultado.tono}>{resultado.texto}</Notice>
            ) : null}

            {marcasHoy.length ? (
              <div>
                <h2 className="mb-2 text-sm font-semibold">Tus marcas de hoy</h2>
                <ol className="divide-y rounded-lg border">
                  {marcasHoy.map((m, i) => (
                    <li key={`${m.at}-${i}`} className="flex items-baseline justify-between px-3 py-2 text-sm">
                      <span>{m.texto}</span>
                      <span className="cifra text-base font-medium">{horaTexto(m.at)}</span>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
          </section>

          <div className="space-y-5">
            <SummaryStrip
              label="Tu semana"
              items={[
                { label: "Hoy empiezas", value: turnoHoy ? horaTexto(turnoHoy.startAt) : "Libre", hint: turnoHoy ? `Hasta las ${horaTexto(turnoHoy.endAt)} · ${turnoHoy.position}` : "Sin turno publicado hoy" },
                { label: "Fichado esta semana", value: informe.status === "ready" ? duracion(fila?.minutes ?? 0) : "…", hint: fila && fila.openEntries > 0 ? "Sin contar el fichaje abierto" : undefined },
                { label: "Planificado", value: duracion(planificado), hint: "Turnos publicados" },
                { label: "Fichajes", value: informe.status === "ready" ? (fila?.entries ?? 0) : "…", hint: "Cerrados esta semana" },
              ]}
            />
            {informe.status === "error" ? <Notice tone="error">{informe.message}</Notice> : null}

            <section className="superficie overflow-hidden" aria-label="Mis turnos de la semana">
              <h2 className="border-b px-5 py-3 text-base font-semibold">Mis turnos esta semana</h2>
              {turnos.status === "error" ? <div className="p-4"><LiveError title="No se puede leer el cuadrante" error={turnos.error} /></div> : null}
              {turnos.status === "ready" && misTurnos.length === 0 ? (
                <p className="px-5 py-4 text-sm text-muted-foreground">No tienes turnos publicados esta semana.</p>
              ) : null}
              <ul className="divide-y">
                {misTurnos.map((t) => (
                  <li key={t.id} className={cn("flex items-center justify-between gap-3 px-5 py-3", t.date === hoy && "bg-surface-raised")}>
                    <div className="min-w-0">
                      <p className="text-[15px] font-medium">{diaMes(t.date)}{t.date === hoy ? " · hoy" : ""}</p>
                      <p className="truncate text-xs text-muted-foreground">{t.position}{t.note ? ` · ${t.note}` : ""}</p>
                    </div>
                    <span className="cifra text-base font-medium">{turnoTexto(t)}</span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="superficie overflow-hidden" aria-label="Mis últimos fichajes">
              <h2 className="border-b px-5 py-3 text-base font-semibold">Mis últimos fichajes</h2>
              {fichajes.data.length === 0 ? <p className="px-5 py-4 text-sm text-muted-foreground">Todavía no has fichado estos días.</p> : null}
              <ul className="divide-y">
                {[...fichajes.data].sort((a, b) => b.startAt - a.startAt).slice(0, 8).map((e) => (
                  <li key={e.id} className={cn("flex items-center justify-between gap-3 px-5 py-3", e.status === "voided" && "opacity-60")}>
                    <div className="min-w-0">
                      <p className="text-[15px] font-medium">{diaMes(e.date)}</p>
                      <p className="cifra text-xs text-muted-foreground">
                        {horaTexto(e.startAt)} a {e.endAt === null ? "sin salida" : horaTexto(e.endAt)}
                      </p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {e.status === "voided" ? <Tag tone="alergia">Anulado</Tag> : null}
                        {e.forgotten ? <Tag tone="aviso">Olvidado</Tag> : null}
                        {e.needsReview && e.status !== "voided" ? <Tag>Lo ha tocado el encargado</Tag> : null}
                      </div>
                    </div>
                    <span className="cifra text-base font-medium">
                      {e.status === "voided" ? "" : e.workedMinutes === null ? "abierto" : duracion(e.workedMinutes)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            <ExportarRegistro scope={scope} uid={null} />
          </div>
        </div>
      ) : null}
    </div>
  )
}
