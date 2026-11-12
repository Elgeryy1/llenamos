"use client"

import { clockState, type ClockAction, type ClockState, type TimeEntryWithId } from "@llenamos/core"
import { CoffeeIcon, PlayIcon, SignInIcon, SignOutIcon } from "@phosphor-icons/react"
import Link from "next/link"
import { useEffect, useMemo, useState } from "react"
import { LoadingBlock, LiveIndicator } from "@/components/common/loading"
import { Notice } from "@/components/common/notice"
import { PageHeading } from "@/components/common/page-heading"
import { LiveError } from "@/components/panel/LiveError"
import { usePanel } from "@/components/panel/PanelContext"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/cn"
import type { MemberDoc } from "@/lib/data/parse"
import { useAccionPersonal, type Alcance } from "@/lib/personal/api"
import { useAjustesPersonal, useFichajesAbiertos } from "@/lib/personal/datos"
import { diaLargo, diaMes, fechaDe, horaTexto } from "@/lib/personal/modelo"
import { useNow } from "@/lib/use-now"
import { ConEquipo, EstadoFichaje, Persona, PuertaPersonal } from "./piezas"
import { TecladoPin } from "./TecladoPin"

export function Puesto() {
  return (
    <PuertaPersonal permission="personal.gestionar" what="el puesto de fichaje">
      {(scope) => <PuestoLocal scope={scope} />}
    </PuertaPersonal>
  )
}

const ACCIONES: Record<ClockState, { action: ClockAction; label: string; principal?: boolean }[]> = {
  out: [{ action: "in", label: "Fichar entrada", principal: true }],
  working: [{ action: "break_start", label: "Pausa" }, { action: "out", label: "Salir", principal: true }],
  on_break: [{ action: "break_end", label: "Volver de la pausa", principal: true }, { action: "out", label: "Salir" }],
}
const ICONO: Record<ClockAction, typeof SignInIcon> = { in: SignInIcon, break_start: CoffeeIcon, break_end: PlayIcon, out: SignOutIcon }
const CONFIRMA: Record<ClockAction, string> = { in: "ha fichado la entrada", break_start: "ha empezado la pausa", break_end: "ha vuelto de la pausa", out: "ha fichado la salida" }

function PuestoLocal({ scope }: { scope: Alcance }) {
  const { location } = usePanel()
  const ahora = useNow(30_000)
  const ajustes = useAjustesPersonal(scope, true)
  const abiertos = useFichajesAbiertos(scope)
  const { ejecutar, ocupado } = useAccionPersonal(scope)
  const [activarError, setActivarError] = useState<string | null>(null)

  return (
    <div className="mt-5 space-y-5">
      <PageHeading
        title="Puesto de fichaje"
        eyebrow={<><span className="text-soft-foreground">{diaLargo(fechaDe(ahora.getTime()))}</span>{location ? ` · ${location.name}` : ""}</>}
        description="Toca tu nombre, escribe tu PIN y elige qué fichar. Pensado para la tableta del local."
        actions={<LiveIndicator time={horaTexto(ahora.getTime())} />}
      />
      {ajustes.status === "error" ? <LiveError title="No se pueden leer los ajustes de personal" error={ajustes.error} /> : null}
      {ajustes.status === "loading" ? <LoadingBlock label="Cargando los ajustes…" /> : null}
      {ajustes.status === "ready" && !ajustes.data.kioskEnabled ? (
        <Notice
          tone="warning"
          title="El puesto de fichaje está apagado en este local"
          action={
            <>
              <Button
                size="lg"
                disabled={ocupado}
                onClick={async () => {
                  setActivarError(null)
                  const r = await ejecutar("guardarConfiguracionPersonal", { settings: { ...ajustes.data, kioskEnabled: true } })
                  if (r && !r.ok) setActivarError(r.message)
                }}
              >
                Encender el puesto
              </Button>
              <Button size="lg" variant="outline" asChild><Link href="/panel/personal/ajustes">Ver los ajustes</Link></Button>
            </>
          }
        >
          Mientras esté apagado, nadie puede fichar desde la tableta.
          {activarError ? <span className="mt-1 block text-destructive">{activarError}</span> : null}
        </Notice>
      ) : null}
      {ajustes.status === "ready" && ajustes.data.kioskEnabled ? (
        <ConEquipo scope={scope}>
          {(equipo) => <Rejilla scope={scope} personas={equipo.personas} abiertos={abiertos} />}
        </ConEquipo>
      ) : null}
    </div>
  )
}

function Rejilla({ scope, personas, abiertos }: { scope: Alcance; personas: MemberDoc[]; abiertos: ReturnType<typeof useFichajesAbiertos> }) {
  const [elegida, setElegida] = useState<MemberDoc | null>(null)
  const porUid = useMemo(() => new Map((abiertos.status === "ready" ? abiertos.data : []).map((e) => [e.uid, e])), [abiertos])
  if (abiertos.status === "error") return <LiveError title="No se puede ver quién ha fichado" error={abiertos.error} />
  if (abiertos.status === "loading") return <LoadingBlock label="Cargando quién está dentro…" />
  const dentro = [...porUid.values()].filter((e) => !e.forgotten).length
  return (
    <>
      <p className="text-sm text-muted-foreground" role="status">
        {dentro === 0 ? "Ahora mismo no hay nadie fichado." : `${dentro} ${dentro === 1 ? "persona fichada" : "personas fichadas"} ahora.`}
      </p>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Equipo">
        {personas.map((p) => {
          const e = porUid.get(p.uid) ?? null
          const estado = clockState(e)
          return (
            <li key={p.uid}>
              <button
                type="button"
                onClick={() => setElegida(p)}
                className={cn(
                  "superficie flex min-h-24 w-full items-center justify-between gap-3 p-4 text-left transition-[background-color,box-shadow] duration-150 ease-(--ease-llenamos) hover:bg-surface-raised active:translate-y-px",
                  estado === "working" && "border-success/40", estado === "on_break" && "border-warning/50", e?.forgotten && "border-destructive/50",
                )}
              >
                <Persona nombre={p.displayName} size="lg" detalle={e ? (e.forgotten ? `Desde el ${diaMes(e.date)}` : `Entró a las ${horaTexto(e.startAt)}`) : "Toca para fichar"} />
                <EstadoFichaje state={estado} forgotten={e?.forgotten} className="shrink-0" />
              </button>
            </li>
          )
        })}
      </ul>
      <DialogoPin scope={scope} persona={elegida} fichaje={elegida ? (porUid.get(elegida.uid) ?? null) : null} onClose={() => setElegida(null)} />
    </>
  )
}

function DialogoPin({ scope, persona, fichaje, onClose }: { scope: Alcance; persona: MemberDoc | null; fichaje: TimeEntryWithId | null; onClose: () => void }) {
  return (
    <Dialog open={persona !== null} onOpenChange={(abierto) => { if (!abierto) onClose() }}>
      {persona ? (
        <DialogContent className="max-w-md" aria-describedby="pin-ayuda">
          {/* Con la clave de la persona, al elegir a otra el teclado empieza limpio. */}
          <ContenidoPin key={persona.uid} scope={scope} persona={persona} fichaje={fichaje} onClose={onClose} />
        </DialogContent>
      ) : null}
    </Dialog>
  )
}

function ContenidoPin({ scope, persona, fichaje, onClose }: { scope: Alcance; persona: MemberDoc; fichaje: TimeEntryWithId | null; onClose: () => void }) {
  const [pin, setPin] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [hecho, setHecho] = useState<string | null>(null)
  const { ejecutar, ocupado } = useAccionPersonal(scope)

  // Por seguridad el puesto se cierra solo a los 30 s sin tocar nada, y a los 3,5 s de fichar.
  useEffect(() => {
    const id = window.setTimeout(onClose, hecho ? 3500 : 30_000)
    return () => window.clearTimeout(id)
  }, [pin, hecho, onClose])

  const estado = clockState(fichaje)
  const olvidado = fichaje?.forgotten === true

  async function enviar(action: ClockAction) {
    if (pin.length < 4) return
    setError(null)
    const r = await ejecutar("ficharEnPuesto", { uid: persona.uid, pin, action })
    if (!r) return
    if (r.ok) {
      setHecho(`${persona.displayName} ${CONFIRMA[action]} a las ${horaTexto(r.data.at)}.`)
      setPin("")
    } else {
      setError(r.message)
      setPin("")
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{persona.displayName}</DialogTitle>
        <DialogDescription id="pin-ayuda">
          {hecho ? "Hecho." : olvidado ? "Su fichaje se quedó abierto de otro día." : "Escribe tu PIN y elige qué fichar."}
        </DialogDescription>
      </DialogHeader>
      {hecho ? (
        <div className="space-y-4 py-2" role="status">
          <p className="text-lg font-medium text-success">{hecho}</p>
          <Button size="xl" className="h-14 w-full" onClick={onClose}>Cerrar</Button>
        </div>
      ) : olvidado ? (
        <Notice tone="warning" title="Necesita que un encargado lo cierre">
          Se cierra desde la hoja de horas, con la hora de salida y el motivo. Mientras tanto no puede fichar aquí.
        </Notice>
      ) : (
        <div className="space-y-5">
          <div className="flex items-center justify-between gap-3">
            <EstadoFichaje state={estado} />
            {fichaje ? <span className="cifra text-sm text-muted-foreground">Entró a las {horaTexto(fichaje.startAt)}</span> : null}
          </div>
          <TecladoPin valor={pin} onChange={(v) => { setPin(v); setError(null) }} disabled={ocupado} />
          {error ? <Notice tone="error">{error}</Notice> : null}
          <div className={cn("grid gap-3", ACCIONES[estado].length > 1 ? "grid-cols-2" : "grid-cols-1")}>
            {ACCIONES[estado].map(({ action, label, principal }) => {
              const Icono = ICONO[action]
              return (
                <Button key={action} size="xl" variant={principal ? "default" : "outline"} className="h-16 text-lg shadow-soft" disabled={ocupado || pin.length < 4} onClick={() => void enviar(action)}>
                  <Icono aria-hidden weight={principal ? "bold" : "regular"} className="size-5" /> {label}
                </Button>
              )
            })}
          </div>
        </div>
      )}
    </>
  )
}
