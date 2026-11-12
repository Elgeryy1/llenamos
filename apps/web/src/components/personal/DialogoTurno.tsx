"use client"

import type { StaffShiftWithId } from "@llenamos/core"
import { useState } from "react"
import { DatePicker } from "@/components/common/date-picker"
import { SelectField, TextField } from "@/components/common/form-fields"
import { Notice } from "@/components/common/notice"
import { TimeSelectField } from "@/components/common/time-select-field"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type { MemberDoc } from "@/lib/data/parse"
import { useAccionPersonal, type Alcance } from "@/lib/personal/api"
import { dateToFecha, fechaToDate } from "@/lib/reservas/formato"
import { diaLargo, horaTexto, turnoDeFormulario } from "@/lib/personal/modelo"

export type AccionTurno = { tipo: "nuevo"; uid: string | null; fecha: string } | { tipo: "editar"; turno: StaffShiftWithId }

const PUESTOS = ["Sala", "Cocina", "Barra", "Encargado"] as const
const PUESTO_POR_ROL: Record<string, string> = { owner: "Encargado", manager: "Encargado", waiter: "Sala", kitchen: "Cocina", bar: "Barra" }

export function DialogoTurno({ accion, scope, personas, nombre, onClose, onGuardado }: {
  accion: AccionTurno | null
  scope: Alcance
  personas: MemberDoc[]
  nombre: (uid: string) => string
  onClose: () => void
  onGuardado: (texto: string, avisos: string[]) => void
}) {
  return (
    <Dialog open={accion !== null} onOpenChange={(abierto) => { if (!abierto) onClose() }}>
      {accion ? (
        <DialogContent className="max-h-[90dvh] max-w-md overflow-y-auto" aria-describedby="turno-ayuda">
          <Formulario accion={accion} scope={scope} personas={personas} nombre={nombre} onClose={onClose} onGuardado={onGuardado} />
        </DialogContent>
      ) : null}
    </Dialog>
  )
}

function Formulario({ accion, scope, personas, nombre, onClose, onGuardado }: { accion: NonNullable<AccionTurno> } & Omit<Parameters<typeof DialogoTurno>[0], "accion">) {
  const { ejecutar, ocupado } = useAccionPersonal(scope)
  const turno = accion.tipo === "editar" ? accion.turno : null
  const uidInicial = accion.tipo === "nuevo" ? accion.uid : null
  const [uid, setUid] = useState(turno?.uid ?? uidInicial ?? personas[0]?.uid ?? "")
  const [fecha, setFecha] = useState(accion.tipo === "editar" ? accion.turno.date : accion.fecha)
  const [inicio, setInicio] = useState(turno ? horaTexto(turno.startAt) : "13:00")
  const [fin, setFin] = useState(turno ? horaTexto(turno.endAt) : "17:00")
  const [puesto, setPuesto] = useState(turno?.position ?? PUESTO_POR_ROL[personas.find((p) => p.uid === uid)?.role ?? ""] ?? "Sala")
  const [nota, setNota] = useState(turno?.note ?? "")
  const [error, setError] = useState<string | null>(null)
  const [confirmarBorrado, setConfirmarBorrado] = useState(false)

  async function guardar() {
    setError(null)
    if (!uid) { setError("Elige a la persona."); return }
    if (!puesto.trim()) { setError("Escribe el puesto, por ejemplo Sala."); return }
    const t = turnoDeFormulario(fecha, inicio, fin)
    if (!t.ok) { setError(t.message); return }
    const r = await ejecutar("guardarTurno", {
      shiftId: turno?.id ?? null, expectedRevision: turno?.revision ?? null,
      shift: { uid, startAt: t.startAt, endAt: t.endAt, position: puesto.trim(), note: nota.trim() },
    })
    if (!r) return
    if (r.ok) onGuardado(`Turno de ${nombre(uid)} guardado como borrador hasta que publiques la semana.`, r.data.warnings.map((w) => `${nombre(w.uid)}: ${w.message}`))
    else setError(r.message)
  }

  async function borrar() {
    if (!turno) return
    const r = await ejecutar("borrarTurno", { shiftId: turno.id, expectedRevision: turno.revision })
    if (!r) return
    if (r.ok) onGuardado(`Turno de ${nombre(turno.uid)} borrado.`, [])
    else setError(r.message)
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{turno ? "Cambiar el turno" : "Nuevo turno"}</DialogTitle>
        <DialogDescription id="turno-ayuda">
          {turno ? `${nombre(turno.uid)}, ${diaLargo(turno.date)}. ` : ""}Si acaba más temprano de lo que empieza, termina al día siguiente.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField label="Persona" value={uid} onChange={(e) => setUid(e.target.value)}>
            {personas.map((p) => <option key={p.uid} value={p.uid}>{p.displayName}</option>)}
            {turno && !personas.some((p) => p.uid === turno.uid) ? <option value={turno.uid}>{nombre(turno.uid)}</option> : null}
          </SelectField>
          <div className="space-y-2">
            <p className="text-sm font-medium">Día</p>
            <DatePicker value={fechaToDate(fecha)} onChange={(d) => setFecha(dateToFecha(d))} label="Día del turno" showYear className="w-full" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <TimeSelectField label="Empieza" value={inicio} onChange={setInicio} />
          <TimeSelectField label="Acaba" value={fin} onChange={setFin} />
        </div>
        <div className="space-y-2">
          <TextField label="Puesto" value={puesto} onChange={(e) => setPuesto(e.target.value)} maxLength={40} />
          <div className="flex flex-wrap gap-2" aria-label="Puestos habituales">
            {PUESTOS.map((p) => (
              <Button key={p} type="button" size="sm" variant={puesto === p ? "secondary" : "outline"} className="pointer-coarse:min-h-11" onClick={() => setPuesto(p)}>{p}</Button>
            ))}
          </div>
        </div>
        <TextField label="Nota (opcional)" value={nota} onChange={(e) => setNota(e.target.value)} maxLength={200} />
        {error ? <Notice tone="error">{error}</Notice> : null}
        {confirmarBorrado ? (
          <Notice tone="warning" title="¿Borrar este turno?" action={<><Button variant="destructive" disabled={ocupado} onClick={() => void borrar()}>Sí, borrarlo</Button><Button variant="outline" onClick={() => setConfirmarBorrado(false)}>No</Button></>}>
            Desaparece del cuadrante. Si ya estaba publicado, el equipo deja de verlo.
          </Notice>
        ) : null}
      </div>
      <DialogFooter>
        {turno && !confirmarBorrado ? <Button variant="destructive" className="sm:mr-auto" onClick={() => setConfirmarBorrado(true)} disabled={ocupado}>Borrar el turno</Button> : null}
        <Button variant="outline" onClick={onClose} disabled={ocupado}>Cancelar</Button>
        <Button onClick={() => void guardar()} disabled={ocupado}>{ocupado ? "Guardando…" : "Guardar"}</Button>
      </DialogFooter>
    </>
  )
}
