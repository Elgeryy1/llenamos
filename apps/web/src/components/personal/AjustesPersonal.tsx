"use client"

import { PinSchema, type StaffSettings } from "@llenamos/core"
import { KeyIcon } from "@phosphor-icons/react"
import { useState } from "react"
import { LoadingBlock } from "@/components/common/loading"
import { Notice } from "@/components/common/notice"
import { PageHeading } from "@/components/common/page-heading"
import { SelectField, TextField } from "@/components/common/form-fields"
import { SettingsSection } from "@/components/common/settings-section"
import { SwitchRow } from "@/components/horarios/campos"
import { LiveError } from "@/components/panel/LiveError"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type { MemberDoc } from "@/lib/data/parse"
import { useAccionPersonal, type Alcance } from "@/lib/personal/api"
import { useAjustesPersonal } from "@/lib/personal/datos"
import { ConEquipo, NavegacionPersonal, Persona, PuertaPersonal } from "./piezas"

export function AjustesPersonal() {
  return (
    <PuertaPersonal permission="personal.gestionar" what="los ajustes de personal">
      {(scope) => (
        <div className="mt-5">
          <PageHeading title="Ajustes de personal" description="Cómo se cuentan las horas, cuándo un fichaje se da por olvidado y los PIN del puesto de fichaje." />
          <NavegacionPersonal />
          <AjustesLocal scope={scope} />
        </div>
      )}
    </PuertaPersonal>
  )
}

/** Opciones numéricas; si el valor guardado no está en la lista (otro valor válido), se conserva. */
function opciones(valores: readonly number[], actual: number, texto: (v: number) => string) {
  const todos = valores.includes(actual) ? valores : [...valores, actual].sort((a, b) => a - b)
  return todos.map((v) => <option key={v} value={v}>{texto(v)}</option>)
}

const horas = (m: number) => (m % 60 === 0 ? `${m / 60} ${m === 60 ? "hora" : "horas"}` : `${Math.floor(m / 60)} h ${m % 60} min`)

type Mensaje = { tono: "success" | "error"; texto: string } | null

function AjustesLocal({ scope }: { scope: Alcance }) {
  const ajustes = useAjustesPersonal(scope, true)
  // El mensaje vive aquí: al guardar, el formulario se vuelve a montar con los ajustes nuevos.
  const [msg, setMsg] = useState<Mensaje>(null)
  if (ajustes.status === "loading") return <LoadingBlock label="Cargando los ajustes…" />
  if (ajustes.status === "error") return <LiveError title="No se pueden leer los ajustes de personal" error={ajustes.error} />
  return (
    <div className="space-y-5">
      <FormularioAjustes scope={scope} guardados={ajustes.data} key={JSON.stringify(ajustes.data)} msg={msg} setMsg={setMsg} />
      <SeccionPin scope={scope} />
    </div>
  )
}

function FormularioAjustes({ scope, guardados, msg, setMsg }: { scope: Alcance; guardados: StaffSettings; msg: Mensaje; setMsg: (m: Mensaje) => void }) {
  const [s, setS] = useState<StaffSettings>(guardados)
  const { ejecutar, ocupado } = useAccionPersonal(scope)
  const cambiado = JSON.stringify(s) !== JSON.stringify(guardados)
  const num = (k: keyof StaffSettings) => (e: { target: { value: string } }) => setS({ ...s, [k]: Number(e.target.value) } as StaffSettings)

  async function guardar() {
    setMsg(null)
    const r = await ejecutar("guardarConfiguracionPersonal", { settings: s })
    if (!r) return
    setMsg(r.ok ? { tono: "success", texto: "Ajustes guardados. Las horas ya cerradas no cambian: solo cuentan los fichajes nuevos y las correcciones." } : { tono: "error", texto: r.message })
  }

  return (
    <SettingsSection
      id="horas"
      title="Cómo se cuentan las horas"
      description="Se aplica al cerrar cada fichaje y queda guardado: cambiarlo después no reescribe las horas pasadas."
      action={<Button size="lg" className="shadow-soft" disabled={!cambiado || ocupado} onClick={() => void guardar()}>{ocupado ? "Guardando…" : "Guardar los ajustes"}</Button>}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField label="Redondeo de cada fichaje" value={s.roundingMinutes} onChange={num("roundingMinutes")} hint="Sobre el total trabajado de cada fichaje.">
          <option value={0}>Sin redondeo</option><option value={5}>A 5 minutos</option><option value={10}>A 10 minutos</option><option value={15}>A 15 minutos</option>
        </SelectField>
        <SelectField label="Cómo se redondea" value={s.roundingMode} disabled={s.roundingMinutes === 0} onChange={(e) => setS({ ...s, roundingMode: e.target.value as StaffSettings["roundingMode"] })}>
          <option value="nearest">Al más cercano</option><option value="down">Siempre hacia abajo</option>
        </SelectField>
      </div>
      <SwitchRow label="Las pausas cuentan como tiempo trabajado" description="Apagado: se descuentan de las horas. Es lo habitual." checked={s.breaksPaid} onChange={(v) => setS({ ...s, breaksPaid: v })} />
      <SelectField label="Un fichaje abierto se da por olvidado a las" value={s.forgottenAfterMinutes} onChange={num("forgottenAfterMinutes")} hint="Un olvidado no suma horas y solo lo cierra un encargado." fieldClassName="sm:max-w-xs">
        {opciones([240, 360, 480, 600, 720, 900, 1080, 1440], s.forgottenAfterMinutes, (v) => `${horas(v)} abierto`)}
      </SelectField>
      <div className="border-t pt-5">
        <h3 className="mb-3 text-sm font-semibold">Cuadrante y comparación</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <SelectField label="Tolerancia de llegada" value={s.lateToleranceMinutes} onChange={num("lateToleranceMinutes")} hint="Hasta ahí no cuenta como tarde.">
            {opciones([0, 5, 10, 15, 20, 30], s.lateToleranceMinutes, (v) => `${v} min`)}
          </SelectField>
          <SelectField label="Descanso mínimo entre turnos" value={s.minRestMinutes} onChange={num("minRestMinutes")} hint="Aviso orientativo.">
            {opciones([480, 600, 660, 720, 780, 840], s.minRestMinutes, horas)}
          </SelectField>
          <SelectField label="Horas máximas por semana" value={s.maxWeeklyMinutes} onChange={num("maxWeeklyMinutes")} hint="Aviso orientativo.">
            {opciones([1200, 1800, 2100, 2400, 2700, 3000], s.maxWeeklyMinutes, horas)}
          </SelectField>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">Son avisos, no bloqueos, y no son asesoría laboral: el convenio de tu restaurante puede pedir otros límites.</p>
      </div>
      <div className="border-t pt-5">
        <SwitchRow label="Puesto de fichaje en la tableta del local" description="Cada persona ficha con su PIN y la sesión de un encargado abierta en la tableta." checked={s.kioskEnabled} onChange={(v) => setS({ ...s, kioskEnabled: v })} />
      </div>
      {msg ? <Notice tone={msg.tono}>{msg.texto}</Notice> : null}
    </SettingsSection>
  )
}

function SeccionPin({ scope }: { scope: Alcance }) {
  const [persona, setPersona] = useState<MemberDoc | null>(null)
  const [aviso, setAviso] = useState<string | null>(null)
  return (
    <SettingsSection
      id="pin"
      title="PIN del puesto de fichaje"
      description="De 4 a 6 cifras. Se guarda cifrado: nadie puede verlo, solo cambiarlo o quitarlo. Cinco fallos seguidos lo bloquean cinco minutos."
    >
      {aviso ? <Notice tone="success">{aviso}</Notice> : null}
      <ConEquipo scope={scope}>
        {(equipo) => (
          <ul className="-my-1 divide-y">
            {equipo.personas.map((p) => (
              <li key={p.uid} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <Persona nombre={p.displayName} detalle={p.email} />
                <Button variant="outline" size="lg" onClick={() => { setAviso(null); setPersona(p) }}><KeyIcon aria-hidden /> Poner o cambiar el PIN</Button>
              </li>
            ))}
          </ul>
        )}
      </ConEquipo>
      <DialogoPin scope={scope} persona={persona} onClose={() => setPersona(null)} onGuardado={(t) => { setPersona(null); setAviso(t) }} />
    </SettingsSection>
  )
}

function DialogoPin({ scope, persona, onClose, onGuardado }: { scope: Alcance; persona: MemberDoc | null; onClose: () => void; onGuardado: (t: string) => void }) {
  return (
    <Dialog open={persona !== null} onOpenChange={(a) => { if (!a) onClose() }}>
      {persona ? <FormularioPin key={persona.uid} scope={scope} persona={persona} onClose={onClose} onGuardado={onGuardado} /> : null}
    </Dialog>
  )
}

function FormularioPin({ scope, persona, onClose, onGuardado }: { scope: Alcance; persona: MemberDoc; onClose: () => void; onGuardado: (t: string) => void }) {
  const [pin, setPin] = useState("")
  const [error, setError] = useState<string | null>(null)
  const { ejecutar, ocupado } = useAccionPersonal(scope)

  async function guardar(valor: string | null) {
    setError(null)
    if (valor !== null) {
      const ok = PinSchema.safeParse(valor)
      if (!ok.success) { setError(ok.error.issues[0]?.message ?? "El PIN lleva de 4 a 6 cifras."); return }
    }
    const r = await ejecutar("guardarPinFichaje", { uid: persona.uid, pin: valor })
    if (!r) return
    if (r.ok) onGuardado(valor === null ? `PIN de ${persona.displayName} quitado.` : `PIN de ${persona.displayName} guardado. Díselo en persona: no se puede volver a ver.`)
    else setError(r.message)
  }

  return (
    <DialogContent className="max-w-sm" aria-describedby="pin-persona-ayuda">
      <DialogHeader>
        <DialogTitle>PIN de {persona.displayName}</DialogTitle>
        <DialogDescription id="pin-persona-ayuda">Elige de 4 a 6 cifras que no sean obvias. Sustituye al PIN anterior, si lo había.</DialogDescription>
      </DialogHeader>
      <TextField
        label="PIN nuevo" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
        inputMode="numeric" autoComplete="off" className="cifra text-lg tracking-widest" error={error}
        onKeyDown={(e) => { if (e.key === "Enter") void guardar(pin) }}
      />
      <DialogFooter>
        <Button variant="destructive" className="sm:mr-auto" disabled={ocupado} onClick={() => void guardar(null)}>Quitar el PIN</Button>
        <Button variant="outline" onClick={onClose} disabled={ocupado}>Cancelar</Button>
        <Button onClick={() => void guardar(pin)} disabled={ocupado || pin.length < 4}>{ocupado ? "Guardando…" : "Guardar el PIN"}</Button>
      </DialogFooter>
    </DialogContent>
  )
}
