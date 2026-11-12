"use client"

import {
  FLOOR_TASK_TYPE_LABEL,
  lateAlerts,
  taskDelay, sortTasks,
  type OrderLineWithId,
  type FloorTaskWithId,
} from "@llenamos/core"
import { ColaServicio } from "@/components/sin-conexion/ColaServicio"
import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import { Notice } from "@/components/common/notice"
import { usePanel } from "@/components/panel/PanelContext"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { llamarSala } from "@/lib/comandero/callables"
import { useTareas, useServicio, type Alcance } from "@/lib/comandero/datos"
import { useNow } from "@/lib/reservas/hooks"
import { EstadoLectura, useOperacion } from "@/components/comandero/Servicio"

export function TareaFila({
  task,
  uid,
  privileged,
  now,
  busy,
  onAction, lines = [],
}: {
  lines?: OrderLineWithId[]
  task: FloorTaskWithId
  uid: string
  privileged: boolean
  now: number
  busy: boolean
  onAction: (action: "claim" | "release" | "done" | "cancel") => void
}) {
  const delay = taskDelay(task, now)
  return (
    <li className="space-y-3 px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium">
            {task.label || "Sala"} · {FLOOR_TASK_TYPE_LABEL[task.type]}
          </p>
          <p className="text-sm text-soft-foreground">{task.note}</p>
        </div>
        <span
          className={
            delay?.level === "late" ? "text-warning" : "text-muted-foreground"
          }
        >
          {delay?.level === "late"
            ? `Retraso ${delay.lateByMinutes} min`
            : `${delay?.elapsedMinutes ?? 0} min`}
        </span>
      </div>
      {task.requests?.length ? <ul className="text-sm text-soft-foreground">{task.requests.map((r, i) => <li key={i}>{({ water: "Agua", cutlery: "Cubiertos", napkins: "Servilletas", order: "Quiero pedir", other: "Otra petición" })[r.reason]}{r.note ? ` · ${r.note}` : ""}</li>)}</ul> : null}
      {task.type === "pickup" ? <div className="space-y-2">
        <ul className="space-y-2">{task.lineIds.map(id => {
          const line = lines.find(l => l.id === id)
          return <li key={id} className="text-sm">{line ? <><strong>{line.quantity} × {line.name.es}</strong>{line.variant ? ` · ${line.variant.name.es}` : ""}{line.modifiers.map(m => ` · ${m.name.es}`).join("")}{line.notes ? <p className="text-warning">Nota: {line.notes}</p> : null}{line.guest ? <p>Comensal {line.guest}</p> : null}</> : "Cargando detalle del plato…"}</li>
        })}</ul>
        {task.count > 1 ? <Notice tone="warning">Han llegado más platos a esta recogida. El responsable y el plazo se mantienen. Revisa toda la bandeja antes de servir.</Notice> : <p className="text-xs text-muted-foreground">Si llegan más platos, se suman aquí y se mantiene el responsable.</p>}
      </div> : null}
      <p className="text-sm">
        {task.claimedBy
          ? task.claimedBy === uid
            ? "Vas tú"
            : `Va ${task.claimedByName ?? "otra persona"}`
          : "Sin dueño"}
        {task.count > 1 ? ` · ${task.count} avisos` : ""}
      </p>
      <div className="flex flex-wrap gap-2">
        {!task.claimedBy ? (
          <Button
            variant="outline"
            className="h-12"
            disabled={busy}
            onClick={() => onAction("claim")}
          >
            Voy yo
          </Button>
        ) : task.claimedBy === uid || privileged ? (
          <Button
            variant="outline"
            className="h-12"
            disabled={busy}
            onClick={() => onAction("release")}
          >
            Soltar tarea
          </Button>
        ) : null}
        {task.type !== "approve_order" ? (
          <Button
            variant="outline"
            className="h-12"
            disabled={busy}
            onClick={() => onAction("done")}
          >
            {task.type === "pickup" ? "Recogido y servido" : "Atendido"}
          </Button>
        ) : null}
        {task.sessionId || task.takeawayId ? (
          <Button asChild variant="outline" className="h-12">
            <Link
              href={
                task.sessionId
                  ? `/panel/comandero?s=${encodeURIComponent(task.sessionId)}`
                  : `/panel/para-llevar?t=${encodeURIComponent(task.takeawayId!)}`
              }
            >
              {task.type === "approve_order" ? "Revisar pedido" : "Ver pedido"}
            </Link>
          </Button>
        ) : null}
        <Button
          variant="ghost"
          className="h-12"
          disabled={busy}
          onClick={() => onAction("cancel")}
        >
          Anular tarea
        </Button>
      </div>
    </li>
  )
}

export function TareasSala({
  scope,
  sessionId = null,
}: {
  scope: Alcance
  sessionId?: string | null
}) {
  const { user, role } = usePanel()
  const tasks = useTareas(scope)
  const lines = useServicio(scope)
  const now = useNow()
  const [note, setNote] = useState("")
  const [claim, setClaim] = useState(false)
  const [alerts, setAlerts] = useState(false)
  const lastCheck = useRef<number | null>(null)
  const [taken, setTaken] = useState<string | null>(null)
  const op = useOperacion()
  useEffect(() => {
    if (tasks.status !== "ready") return
    if (
      alerts &&
      lastCheck.current !== null &&
      lateAlerts(tasks.data, lastCheck.current, now).length > 0 &&
      document.visibilityState === "visible"
    )
      navigator.vibrate?.([150, 80, 150])
    lastCheck.current = now
    return () => {
      lastCheck.current = now
    }
  }, [tasks, now, alerts])
  // Al ocultarse una página de Next se olvida el último control para no avisar al volver.
  useEffect(
    () => () => {
      lastCheck.current = null
    },
    [],
  )
  const action = (
    task: FloorTaskWithId,
    action: "claim" | "release" | "done" | "cancel",
  ) =>
    op.run(async () => {
      const result = await llamarSala("cambiarEstadoTarea", {
        ...scope,
        taskId: task.id,
        action,
        ...(task.type === "pickup" && action === "done" ? { expectedLineIds: task.lineIds } : {}),
      })
      if (result.result === "taken") {
        setTaken(
          `Ya va ${result.claimedByName ?? "otra persona"}. La tarea no es tuya.`,
        )
        return "El servidor ha confirmado quién atiende la tarea."
      }
      setTaken(null)
      return "Tarea actualizada."
    })
  return (
    <section className="superficie overflow-hidden" aria-label="Tareas de sala">
      <ColaServicio entities={tasks.status === "ready" ? tasks.data.map(t => ({ kind: "task" as const, id: t.id, observed: t })).slice(0, 100) : []} />
      <header className="space-y-2 border-b p-4">
        <h2 className="text-lg font-semibold">Tareas con dueño</h2>
        <p className="text-xs text-muted-foreground">
          Primero las tareas vencidas, con las tuyas al principio de cada grupo y después por antigüedad. Atender una petición de cuenta no registra ningún pago.
        </p>
        <label className="flex min-h-12 items-center gap-3 text-sm">
          <input
            type="checkbox"
            checked={alerts}
            onChange={(e) => setAlerts(e.target.checked)}
          />
          Vibrar solo al empezar un retraso mientras esta pantalla está abierta
        </label>
      </header>
      <div className="space-y-3 p-4">
        {op.feedback}
        {taken ? <Notice tone="warning">{taken}</Notice> : null}
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void op.run(async () => {
              await llamarSala("crearTarea", {
                ...scope,
                sessionId,
                note,
                claim,
              })
              setNote("")
              return "Tarea creada."
            })
          }}
        >
          <label className="min-w-40 flex-1 text-sm">
            {sessionId ? "Tarea para esta mesa" : "Tarea general de sala"}
            <Input
              className="h-12"
              maxLength={200}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              required
            />
          </label>
          <label className="flex min-h-12 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={claim}
              onChange={(e) => setClaim(e.target.checked)}
            />
            Voy yo
          </label>
          <Button
            type="submit"
            variant="outline"
            className="h-12"
            disabled={op.busy || !note.trim()}
          >
            Crear tarea
          </Button>
        </form>
      </div>
      <EstadoLectura live={tasks} label="las tareas">
        {(data) => {
          const shown = sortTasks(data.filter((t) => !sessionId || t.sessionId === sessionId), now, user.uid)
          return shown.length ? (
            <ul className="divide-y border-t">
              {shown.map((t) => (
                <TareaFila
                  key={t.id}
                  task={t}
                  uid={user.uid}
                  privileged={role === "owner" || role === "manager"}
                  now={now}
                  lines={lines.status === "ready" ? lines.data : []}
                  busy={op.busy || (t.type === "pickup" && lines.status !== "ready")}
                  onAction={(a) => void action(t, a)}
                />
              ))}
            </ul>
          ) : (
            <p className="p-4 text-sm text-muted-foreground">
              Todo atendido. No hay tareas abiertas.
            </p>
          )
        }}
      </EstadoLectura>
    </section>
  )
}
