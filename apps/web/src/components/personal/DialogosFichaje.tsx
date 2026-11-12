"use client"

import { defaultStaffSettings, entryMinutes, type StaffSettings, type TimeEntryEvent, type TimeEntryWithId } from "@llenamos/core"
import { PlusIcon, TrashIcon } from "@phosphor-icons/react"
import { useMemo, useState } from "react"
import { DatePicker } from "@/components/common/date-picker"
import { LoadingBlock } from "@/components/common/loading"
import { Notice } from "@/components/common/notice"
import { SelectField, TextField, TextareaField } from "@/components/common/form-fields"
import { LiveError } from "@/components/panel/LiveError"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { dateToFecha, fechaToDate } from "@/lib/reservas/formato"
import { useAccionPersonal, type Alcance } from "@/lib/personal/api"
import { useEventosFichaje } from "@/lib/personal/datos"
import {
  diaLargo, diaMes, duracion, fechaDe, formularioDeFichaje, horaTexto, instantesDeFormulario, type FormularioFichaje,
} from "@/lib/personal/modelo"
import type { MemberDoc } from "@/lib/data/parse"

export type AccionFichaje =
  | { tipo: "crear"; uidInicial: string | null; fecha: string }
  | { tipo: "corregir"; entry: TimeEntryWithId }
  | { tipo: "cerrar"; entry: TimeEntryWithId; salidaSugerida: number | null }
  | { tipo: "anular"; entry: TimeEntryWithId }
  | { tipo: "historial"; entry: TimeEntryWithId }

interface Comunes {
  scope: Alcance
  personas: MemberDoc[]
  nombre: (uid: string) => string
  ajustes: StaffSettings | null
  onClose: () => void
  /** Se llama tras guardar con éxito para recargar lo que dependa del servidor. */
  onGuardado: (texto: string) => void
}

export function DialogosFichaje({ accion, ...c }: { accion: AccionFichaje | null } & Comunes) {
  return (
    <Dialog open={accion !== null} onOpenChange={(abierto) => { if (!abierto) c.onClose() }}>
      {accion ? (
        <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto" aria-describedby="fichaje-dialogo-ayuda">
          {accion.tipo === "anular" ? <Anular accion={accion} {...c} /> : null}
          {accion.tipo === "historial" ? <Historial accion={accion} {...c} /> : null}
          {accion.tipo === "crear" || accion.tipo === "corregir" || accion.tipo === "cerrar" ? <Formulario accion={accion} {...c} /> : null}
        </DialogContent>
      ) : null}
    </Dialog>
  )
}

/** Campo de hora escrita («20:30»), con el teclado numérico en el móvil. */
export function HoraCampo({ label, value, onChange, error, disabled, hint }: { label: string; value: string; onChange: (v: string) => void; error?: string | null; disabled?: boolean; hint?: string }) {
  return (
    <TextField
      label={label} value={value} onChange={(e) => onChange(e.target.value)} error={error} hint={hint} disabled={disabled}
      inputMode="numeric" placeholder="20:30" maxLength={5} autoComplete="off" className="cifra" fieldClassName="min-w-0"
    />
  )
}

const MOTIVOS = ["Se olvidó de fichar", "Se equivocó al fichar", "Cambio de turno acordado", "Falló el móvil o la tableta", "Otro"] as const

function Motivo({ valor, onChange, error }: { valor: string; onChange: (v: string) => void; error: string | null }) {
  return (
    <TextareaField
      label="Motivo" value={valor} onChange={(e) => onChange(e.target.value)} error={error} maxLength={200} rows={2}
      hint={`Queda guardado con tu nombre. Por ejemplo: ${MOTIVOS[0].toLowerCase()}.`}
    />
  )
}

function Formulario({ accion, scope, personas, nombre, ajustes, onClose, onGuardado }: { accion: Extract<AccionFichaje, { tipo: "crear" | "corregir" | "cerrar" }> } & Comunes) {
  const { ejecutar, ocupado } = useAccionPersonal(scope)
  const entry = accion.tipo === "crear" ? null : accion.entry
  const inicial: FormularioFichaje = useMemo(
    () => entry
      ? formularioDeFichaje(entry, accion.tipo === "cerrar" && accion.salidaSugerida !== null ? horaTexto(accion.salidaSugerida) : "")
      : { fecha: accion.tipo === "crear" ? accion.fecha : "", entrada: "", salida: "", pausas: [] },
    [entry, accion],
  )
  const [uid, setUid] = useState(accion.tipo === "crear" ? (accion.uidInicial ?? personas[0]?.uid ?? "") : "")
  const [f, setF] = useState<FormularioFichaje>(inicial)
  const [motivo, setMotivo] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [errorMotivo, setErrorMotivo] = useState<string | null>(null)
  const cerrando = accion.tipo === "cerrar"

  // Al cerrar un fichaje abierto, una pausa sin fin se cierra a la hora de salida (como hace el servidor).
  const efectivo: FormularioFichaje = cerrando ? { ...f, pausas: f.pausas.map((p) => ({ ...p, fin: p.fin || f.salida })) } : f
  const calculo = instantesDeFormulario(efectivo)
  const previsto = calculo.ok ? entryMinutes({ startAt: calculo.startAt, endAt: calculo.endAt, breaks: calculo.breaks }, ajustes ?? defaultStaffSettings()) : null

  const titulo = accion.tipo === "crear" ? "Añadir un fichaje a mano" : cerrando ? "Cerrar el fichaje abierto" : "Corregir el fichaje"

  function setPausa(i: number, campo: "inicio" | "fin", v: string) {
    setF({ ...f, pausas: f.pausas.map((p, j) => (j === i ? { ...p, [campo]: v } : p)) })
  }

  async function guardar() {
    setError(null)
    setErrorMotivo(null)
    if (!motivo.trim()) { setErrorMotivo("Escribe el motivo."); return }
    if (accion.tipo === "crear" && !uid) { setError("Elige a la persona."); return }
    if (!calculo.ok) { setError(calculo.message); return }
    const comunes = { reason: motivo.trim() }
    const r = accion.tipo === "crear"
      ? await ejecutar("crearFichajeManual", { uid, startAt: calculo.startAt, endAt: calculo.endAt, breaks: calculo.breaks, ...comunes })
      : accion.tipo === "corregir"
        ? await ejecutar("corregirFichaje", { entryId: accion.entry.id, expectedRevision: accion.entry.revision, startAt: calculo.startAt, endAt: calculo.endAt, breaks: calculo.breaks, ...comunes })
        : await ejecutar("cerrarFichajeOlvidado", { entryId: accion.entry.id, expectedRevision: accion.entry.revision, endAt: calculo.endAt, ...comunes })
    if (!r) return
    if (r.ok) {
      const quien = accion.tipo === "crear" ? nombre(uid) : nombre(accion.entry.uid)
      onGuardado(`${accion.tipo === "crear" ? "Fichaje añadido" : cerrando ? "Fichaje cerrado" : "Fichaje corregido"} de ${quien}: ${duracion(r.data.workedMinutes)}.`)
    } else setError(r.message)
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{titulo}</DialogTitle>
        <DialogDescription id="fichaje-dialogo-ayuda">
          {entry ? `${nombre(entry.uid)}, ${diaLargo(entry.date)}. ` : ""}
          {cerrando ? "Pon la hora de salida real. " : "Escribe las horas en orden: si la salida es más temprano que la entrada, cuenta como del día siguiente. "}
          Queda anotado quién lo cambia y por qué.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4">
        {accion.tipo === "crear" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField label="Persona" value={uid} onChange={(e) => setUid(e.target.value)}>
              {personas.map((p) => <option key={p.uid} value={p.uid}>{p.displayName}</option>)}
            </SelectField>
            <div className="space-y-2">
              <p className="text-sm font-medium">Día de la entrada</p>
              <DatePicker value={fechaToDate(f.fecha)} onChange={(d) => setF({ ...f, fecha: dateToFecha(d) })} label="Día de la entrada" showYear className="w-full" />
            </div>
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-4">
          <HoraCampo label="Entrada" value={f.entrada} onChange={(v) => setF({ ...f, entrada: v })} disabled={cerrando} />
          <HoraCampo label="Salida" value={f.salida} onChange={(v) => setF({ ...f, salida: v })} />
        </div>
        {f.pausas.length ? (
          <div className="space-y-3">
            <p className="text-sm font-medium">Pausas</p>
            {f.pausas.map((p, i) => (
              <div key={i} className="flex items-end gap-3">
                <HoraCampo label={`Pausa ${i + 1}, empieza`} value={p.inicio} onChange={(v) => setPausa(i, "inicio", v)} disabled={cerrando} />
                <HoraCampo label="Acaba" value={p.fin} onChange={(v) => setPausa(i, "fin", v)} hint={cerrando && !p.fin ? "Se cierra con la salida" : undefined} />
                {!cerrando ? (
                  <Button type="button" variant="ghost" size="icon" aria-label={`Quitar la pausa ${i + 1}`} className="mb-0.5 shrink-0" onClick={() => setF({ ...f, pausas: f.pausas.filter((_, j) => j !== i) })}>
                    <TrashIcon aria-hidden />
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {!cerrando ? (
          <Button type="button" variant="outline" onClick={() => setF({ ...f, pausas: [...f.pausas, { inicio: "", fin: "" }] })}>
            <PlusIcon aria-hidden /> Añadir una pausa
          </Button>
        ) : null}
        <Motivo valor={motivo} onChange={setMotivo} error={errorMotivo} />
        {previsto ? (
          <p className="text-sm text-muted-foreground" role="status">
            Saldrán <span className="cifra font-medium text-foreground">{duracion(previsto.roundedMinutes)}</span> trabajadas
            {previsto.breakMinutes ? `, con ${duracion(previsto.breakMinutes)} de pausa` : ""}. El servidor lo vuelve a calcular al guardar.
          </p>
        ) : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={ocupado}>Cancelar</Button>
        <Button onClick={() => void guardar()} disabled={ocupado}>{ocupado ? "Guardando…" : cerrando ? "Cerrar el fichaje" : "Guardar"}</Button>
      </DialogFooter>
    </>
  )
}

function Anular({ accion, scope, nombre, onClose, onGuardado }: { accion: Extract<AccionFichaje, { tipo: "anular" }> } & Comunes) {
  const { ejecutar, ocupado } = useAccionPersonal(scope)
  const [motivo, setMotivo] = useState("")
  const [errorMotivo, setErrorMotivo] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const e = accion.entry
  async function anular() {
    if (!motivo.trim()) { setErrorMotivo("Escribe el motivo."); return }
    setErrorMotivo(null)
    const r = await ejecutar("anularFichaje", { entryId: e.id, expectedRevision: e.revision, reason: motivo.trim() })
    if (!r) return
    if (r.ok) onGuardado(`Fichaje de ${nombre(e.uid)} anulado.`)
    else setError(r.message)
  }
  return (
    <>
      <DialogHeader>
        <DialogTitle>Anular el fichaje</DialogTitle>
        <DialogDescription id="fichaje-dialogo-ayuda">
          {nombre(e.uid)}, {diaLargo(e.date)}, de {horaTexto(e.startAt)} a {e.endAt === null ? "sin salida" : horaTexto(e.endAt)}. No se borra: queda anulado y deja de sumar horas.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4">
        <Motivo valor={motivo} onChange={setMotivo} error={errorMotivo} />
        {error ? <Notice tone="error">{error}</Notice> : null}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={ocupado}>No anular</Button>
        <Button variant="destructive" onClick={() => void anular()} disabled={ocupado}>{ocupado ? "Anulando…" : "Anular el fichaje"}</Button>
      </DialogFooter>
    </>
  )
}

const TIPO_EVENTO: Record<TimeEntryEvent["kind"], string> = {
  clock_in: "Entrada", break_start: "Empieza la pausa", break_end: "Vuelve de la pausa", clock_out: "Salida",
  manual_create: "Creado a mano", correction: "Corregido", close_forgotten: "Cerrado por un encargado", void: "Anulado",
}
const ORIGEN: Record<TimeEntryEvent["source"], string> = { self: "desde el móvil", kiosk: "desde el puesto", manager: "por un encargado" }

function resumen(s: TimeEntryEvent["before"]): string {
  if (!s) return ""
  return `${horaTexto(s.startAt)} a ${s.endAt === null ? "sin salida" : horaTexto(s.endAt)}${s.breaks.length ? `, ${s.breaks.length} ${s.breaks.length === 1 ? "pausa" : "pausas"}` : ""}`
}

function Historial({ accion, scope, nombre }: { accion: Extract<AccionFichaje, { tipo: "historial" }> } & Comunes) {
  const eventos = useEventosFichaje(scope, accion.entry.id)
  return (
    <>
      <DialogHeader>
        <DialogTitle>Historial del fichaje</DialogTitle>
        <DialogDescription id="fichaje-dialogo-ayuda">{nombre(accion.entry.uid)}, {diaLargo(accion.entry.date)}. Cada cambio queda guardado y no se puede editar.</DialogDescription>
      </DialogHeader>
      {eventos.status === "loading" ? <LoadingBlock label="Cargando el historial…" /> : null}
      {eventos.status === "error" ? <LiveError title="No se puede leer el historial" error={eventos.error} /> : null}
      {eventos.status === "ready" ? (
        <ol className="divide-y rounded-lg border" aria-label="Cambios del fichaje">
          {eventos.data.length === 0 ? <li className="px-3 py-3 text-sm text-muted-foreground">Sin cambios guardados.</li> : null}
          {eventos.data.map((ev) => (
            <li key={ev.id} className="space-y-1 px-3 py-3 text-sm">
              <p className="flex items-baseline justify-between gap-3">
                <span className="font-medium">{TIPO_EVENTO[ev.kind]} <span className="font-normal text-muted-foreground">{ORIGEN[ev.source]}</span></span>
                <span className="cifra text-xs text-muted-foreground">{diaMes(fechaDe(ev.at))} {horaTexto(ev.at)}</span>
              </p>
              <p className="text-xs text-muted-foreground">Lo hizo {nombre(ev.by)}</p>
              {ev.before && ev.after ? <p className="cifra text-xs">{resumen(ev.before)} pasa a {resumen(ev.after)}</p> : null}
              {ev.reason ? <p className="text-xs">Motivo: {ev.reason}</p> : null}
            </li>
          ))}
        </ol>
      ) : null}
    </>
  )
}
