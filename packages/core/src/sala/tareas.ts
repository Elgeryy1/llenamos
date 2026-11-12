/**
 * Tareas de sala con dueño («voy yo»).
 *
 * Una tarea abierta no es de nadie; quien la coge es su dueño y los demás ven «va Lucía».
 * Coger una tarea ya cogida por otra persona **falla**: dos camareros no van a por el mismo
 * plato. El servidor lo hace en una transacción con `claimTask`.
 *
 * Para no duplicar, cada tipo tiene una clave (`taskDedupeKey`): mientras hay una tarea
 * abierta con esa clave, lo nuevo se suma a ella (otra llamada sube `count`; otro plato
 * listo se añade a `lineIds`).
 */
import { TASK_TRANSITIONS } from "./estados"
import type { FloorSettings, FloorTask, FloorTaskStatus, FloorTaskType } from "./modelo"

const MINUTO = 60_000

export interface TaskRefs {
  sessionId?: string | null
  takeawayId?: string | null
  tableId?: string | null
  orderId?: string | null
  stationId?: string | null
}

/** Clave de una tarea para no duplicarla, o null si no se agrupa (las escritas a mano). */
export function taskDedupeKey(type: FloorTaskType, refs: TaskRefs): string | null {
  const donde = refs.sessionId ? `session:${refs.sessionId}` : refs.takeawayId ? `takeaway:${refs.takeawayId}` : refs.tableId ? `table:${refs.tableId}` : null
  switch (type) {
    case "pickup":
      return donde && refs.stationId ? `pickup:${donde}:${refs.stationId}` : null
    case "call_waiter":
      return donde ? `call_waiter:${donde}` : null
    case "bill_request":
      return donde ? `bill_request:${donde}` : null
    case "approve_order":
      return refs.orderId ? `approve_order:${refs.orderId}` : null
    case "custom":
      return null
  }
}

/** Hora límite de una tarea según su tipo y los tiempos de los ajustes. */
export function taskDueAt(type: FloorTaskType, openedAt: number, targets: FloorSettings["targets"]): number {
  const minutos: Record<FloorTaskType, number> = {
    pickup: targets.pickupMinutes,
    call_waiter: targets.callWaiterMinutes,
    bill_request: targets.billMinutes,
    approve_order: targets.approveMinutes,
    custom: targets.customMinutes,
  }
  return openedAt + minutos[type] * MINUTO
}

export function taskIsActive(status: FloorTaskStatus): boolean {
  return status === "open" || status === "claimed"
}

type TareaDueno = Pick<FloorTask, "status" | "claimedBy" | "claimedByName" | "claimedAt" | "doneAt" | "doneBy">

export type TaskResult<T> = { ok: true; task: T } | { ok: false; reason: "taken"; claimedBy: string; claimedByName: string | null } | { ok: false; reason: "closed" | "not_owner" }

/** «Voy yo». Si ya la tiene otra persona, falla con su nombre. Cogerla otra vez uno mismo no cambia nada. */
export function claimTask<T extends TareaDueno>(task: T, uid: string, name: string | null, now: number): TaskResult<T> {
  if (!taskIsActive(task.status)) return { ok: false, reason: "closed" }
  if (task.status === "claimed" && task.claimedBy !== null && task.claimedBy !== uid) {
    return { ok: false, reason: "taken", claimedBy: task.claimedBy, claimedByName: task.claimedByName }
  }
  if (task.status === "claimed") return { ok: true, task }
  return { ok: true, task: { ...task, status: "claimed", claimedBy: uid, claimedByName: name, claimedAt: now } }
}

/** Soltarla: solo su dueño, o quien gestiona la sala (`canOverride`, p. ej. el encargado). */
export function releaseTask<T extends TareaDueno>(task: T, uid: string, canOverride: boolean): TaskResult<T> {
  if (task.status !== "claimed") return { ok: false, reason: "closed" }
  if (task.claimedBy !== uid && !canOverride) return { ok: false, reason: "not_owner" }
  return { ok: true, task: { ...task, status: "open", claimedBy: null, claimedByName: null, claimedAt: null } }
}

/**
 * Hecha. Cualquiera con `tareas.atender` puede darla por hecha aunque la tuviera otro (si
 * el plato ya está en la mesa, está en la mesa); queda apuntado quién.
 */
export function completeTask<T extends TareaDueno>(task: T, uid: string, now: number): TaskResult<T> {
  if (!TASK_TRANSITIONS[task.status].includes("done")) return { ok: false, reason: "closed" }
  return { ok: true, task: { ...task, status: "done", doneAt: now, doneBy: uid } }
}

export function cancelTask<T extends TareaDueno>(task: T, uid: string, now: number): TaskResult<T> {
  if (!TASK_TRANSITIONS[task.status].includes("cancelled")) return { ok: false, reason: "closed" }
  return { ok: true, task: { ...task, status: "cancelled", doneAt: now, doneBy: uid } }
}

/**
 * Orden de la lista de tareas: primero las que se están cayendo, luego las más antiguas.
 * Las de uno mismo arriba dentro de cada grupo.
 */
export function sortTasks<T extends Pick<FloorTask, "dueAt" | "openedAt" | "claimedBy">>(tasks: readonly T[], now: number, uid: string | null): T[] {
  return [...tasks].sort((a, b) => {
    const tardeA = a.dueAt <= now ? 0 : 1
    const tardeB = b.dueAt <= now ? 0 : 1
    if (tardeA !== tardeB) return tardeA - tardeB
    const mioA = uid !== null && a.claimedBy === uid ? 0 : 1
    const mioB = uid !== null && b.claimedBy === uid ? 0 : 1
    if (mioA !== mioB) return mioA - mioB
    return a.openedAt - b.openedAt
  })
}
