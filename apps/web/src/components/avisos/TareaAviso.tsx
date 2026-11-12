"use client"

import { CALLABLE_SCHEMAS, FloorTaskSchema, can, hasModule, FLOOR_TASK_TYPE_LABEL } from "@llenamos/core"
import { useSearchParams } from "next/navigation"
import Link from "next/link"
import { useEffect, useState } from "react"
import { usePanel } from "@/components/panel/PanelContext"
import { PageHeading } from "@/components/common/page-heading"
import { Button } from "@/components/ui/button"
import { useDemoDoc } from "@/lib/sala/demo"
import { invokeOperation } from "@/lib/api/operations"
import { useDerivado, enVps, useServicioVivo } from "@/lib/sala/vivo"
import { describeError } from "@/lib/firebase/errors"

type Alcance = { restaurantId: string; locationId: string }
/** Demo: el documento de la tarea. VPS: la tarea dentro del servicio vivo (solo tareas abiertas o cogidas). */
function useTareaFs(scope: Alcance | null, taskId: string | null) {
  return useDemoDoc(scope && taskId ? `restaurants/${scope.restaurantId}/locations/${scope.locationId}/floorTasks/${taskId}` : null, (_id, data) => data ? FloorTaskSchema.parse(data) : null)
}
function useTareaVps(scope: Alcance | null, taskId: string | null) {
  return useDerivado(useServicioVivo(taskId ? scope : null), v => v.tasks.find(t => t.id === taskId) ?? null)
}
const useTarea = enVps ? useTareaVps : useTareaFs

export function TareaAviso() {
  const panel = usePanel(), params = useSearchParams()
  const restaurantId = params.get("restaurant"), locationId = params.get("local"), taskId = params.get("task")
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (restaurantId && panel.restaurant.id !== restaurantId && panel.restaurants.some(r => r.id === restaurantId)) panel.selectRestaurant(restaurantId)
    else if (locationId && panel.location?.id !== locationId && panel.locations.some(l => l.id === locationId)) panel.selectLocation(locationId)
  }, [restaurantId, locationId, panel])
  const allowed = can(panel.role, "tareas.atender") && hasModule(panel.restaurant, "floor") && panel.restaurant.id === restaurantId && panel.location?.id === locationId && taskId && !taskId.includes("/")
  const task = useTarea(allowed ? { restaurantId: restaurantId!, locationId: locationId! } : null, allowed ? taskId : null)
  async function claim() {
    setBusy(true)
    try {
      const input = CALLABLE_SCHEMAS.cambiarEstadoTarea.input.parse({ restaurantId, locationId, taskId, action: "claim" })
      const result = CALLABLE_SCHEMAS.cambiarEstadoTarea.output.parse(await invokeOperation("cambiarEstadoTarea", input))
      setMessage(result.result === "taken" ? `Ya va ${result.claimedByName ?? "otra persona"}.` : "Vas tú. Los siguientes avisos de esta tarea quedan silenciados.")
    } catch (error) { setMessage(describeError(error).message) }
    finally { setBusy(false) }
  }
  return <>
    <PageHeading title="La tarea de tu aviso" description="El estado se consulta en directo antes de cogerla." />
    {!allowed ? <p>No tienes acceso al local del aviso.</p> : task.status === "error" ? <p role="alert">{describeError(task.error).message}</p> : task.status !== "ready" ? <p role="status">Consultando tarea…</p> : !task.data ? <p>La tarea ya no existe.</p> : <section className="superficie space-y-4 p-5">
      <h2 className="text-2xl font-semibold">{task.data.label || "Sala"} · {FLOOR_TASK_TYPE_LABEL[task.data.type]}</h2>
      <p className="text-lg">{task.data.note}</p>
      <p>{task.data.claimedBy ? `Va ${task.data.claimedByName ?? "otra persona"}` : task.data.status === "open" ? "Sin responsable" : "Tarea cerrada"}</p>
      {task.data.status === "open" ? <Button className="h-12" disabled={busy} onClick={() => void claim()}>Voy yo</Button> : null}
      <Button asChild variant="outline" className="ml-3 h-12"><Link href={task.data.takeawayId ? `/panel/para-llevar?t=${encodeURIComponent(task.data.takeawayId)}` : task.data.sessionId ? `/panel/comandero?s=${encodeURIComponent(task.data.sessionId)}` : "/panel/comandero"}>Ver pedido y tareas</Link></Button>
    </section>}
    {message ? <p role="status" className="mt-4">{message}</p> : null}
  </>
}
