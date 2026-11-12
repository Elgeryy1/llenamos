/**
 * Estados y transiciones de la sala: mesa abierta, comanda, línea, tarea y para llevar.
 *
 * Igual que las reservas: una tabla de transiciones permitidas, una función que comprueba
 * un cambio y otra que lo aplica (con historial). Las funciones del servidor usan estas
 * mismas funciones; la interfaz, para enseñar solo los botones que valen.
 */
import type { PublicLineStatus } from "../carta/i18n"
import type { StationKind } from "../carta/modelo"
import type { Permission } from "../roles"
import type {
  FloorTaskStatus,
  LineStatus,
  OrderLine,
  OrderStatus,
  TableSessionStatus,
  TakeawayStatus,
} from "./modelo"

export type Check = { ok: true } | { ok: false; reason: string }
const OK: Check = { ok: true }
const no = (reason: string): Check => ({ ok: false, reason })

/* Mesa abierta ----------------------------------------------------------------------------- */

export const SESSION_TRANSITIONS: Record<TableSessionStatus, readonly TableSessionStatus[]> = {
  open: ["bill_requested", "closed", "merged", "cancelled"],
  bill_requested: ["open", "closed", "merged", "cancelled"],
  // Reabrir una mesa cerrada por error (si sus mesas siguen libres; lo comprueba el servidor).
  closed: ["open"],
  merged: [],
  cancelled: [],
}

export function canSessionTransition(from: TableSessionStatus, to: TableSessionStatus): boolean {
  return SESSION_TRANSITIONS[from].includes(to)
}

/* Comanda ------------------------------------------------------------------------------------ */

export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending_approval: ["accepted", "rejected"],
  accepted: [],
  rejected: [],
}

/* Línea ----------------------------------------------------------------------------------- */

/**
 * Cambios permitidos de una línea. Los «hacia atrás» existen para deshacer un toque por
 * error (desmarchar, «no estaba listo», «no lo he servido»).
 */
export const LINE_TRANSITIONS: Record<LineStatus, readonly LineStatus[]> = {
  pending: ["held", "fired", "cancelled"],
  held: ["fired", "cancelled"],
  fired: ["held", "preparing", "ready", "served", "cancelled"],
  preparing: ["fired", "ready", "served", "cancelled"],
  ready: ["preparing", "served", "cancelled"],
  served: ["ready", "cancelled"],
  cancelled: [],
}

/** Estados en los que la cocina ya tiene la línea: anularla pide `comandas.anular` y motivo. */
export const LINE_STATUSES_IN_KITCHEN: readonly LineStatus[] = ["fired", "preparing", "ready", "served"]

/** Líneas sin servir: cuentan para no dejar cerrar la mesa. */
export function lineIsUnserved(status: LineStatus): boolean {
  return status !== "served" && status !== "cancelled"
}

/** Permiso de la estación según su tipo; sin estación, lo hace la sala. */
export function stationPermission(kind: StationKind | null): Permission {
  if (kind === "kitchen") return "cocina.preparar"
  if (kind === "bar") return "barra.preparar"
  return "comandas.tomar"
}

/**
 * Permisos con los que se puede hacer un cambio de línea (basta uno). Vacío = no se puede.
 *
 * - Aceptar o rechazar lo pendiente, marchar y desmarchar: la sala (`comandas.tomar`).
 * - Empezar, terminar y deshacer en la estación: la estación (`cocina.preparar` o `barra.preparar`).
 * - Servir o deshacer el servido: la sala o la estación.
 * - Anular antes de cocina: la sala. Una vez en cocina: `comandas.anular`, con motivo.
 */
export function lineTransitionPermissions(from: LineStatus, to: LineStatus, stationKind: StationKind | null): Permission[] {
  if (!LINE_TRANSITIONS[from].includes(to)) return []
  const estacion = stationPermission(stationKind)
  if (to === "cancelled") return LINE_STATUSES_IN_KITCHEN.includes(from) ? ["comandas.anular"] : ["comandas.tomar"]
  if (from === "pending" || to === "held" || (from === "held" && to === "fired")) return ["comandas.tomar"]
  if (to === "served" || from === "served") return [...new Set<Permission>(["comandas.tomar", estacion])]
  return [estacion]
}

export function lineTransitionNeedsReason(from: LineStatus, to: LineStatus): boolean {
  return to === "cancelled" && LINE_STATUSES_IN_KITCHEN.includes(from)
}

/**
 * Comprueba un cambio de línea para quien lo pide (`can` dice si tiene un permiso; en las
 * funciones, `(p) => can(member.role, p)`).
 */
export function checkLineTransition(
  line: Pick<OrderLine, "status" | "kind" | "stationKind">,
  to: LineStatus,
  can: (permission: Permission) => boolean,
  reason: string | null = null,
): Check {
  if (line.kind === "menu") return no("El estado de un menú sale de sus platos: cambia los platos.")
  if (line.status === to) return no("La línea ya está así.")
  const permisos = lineTransitionPermissions(line.status, to, line.stationKind)
  if (permisos.length === 0) return no(`No se puede pasar de «${line.status}» a «${to}».`)
  if (!permisos.some(can)) return no("No tienes permiso para este cambio.")
  if (lineTransitionNeedsReason(line.status, to) && !reason?.trim()) return no("Para anular algo que ya está en cocina hace falta un motivo.")
  return OK
}

type LineaConHoras = Pick<OrderLine, "status" | "firedAt" | "startedAt" | "readyAt" | "servedAt" | "cancelReason" | "history">

/**
 * Aplica un cambio de estado (ya comprobado) y apunta las horas: marchar pone `firedAt`,
 * empezar `startedAt`, listo `readyAt` y servido `servedAt`. Volver atrás borra las horas
 * de los pasos que se deshacen. Devuelve una copia.
 */
export function applyLineStatus<L extends LineaConHoras>(line: L, to: LineStatus, now: number, by: string | null, reason: string | null = null): L {
  const from = line.status
  const r: L = { ...line, status: to, history: [...line.history, { from, to, at: now, by, reason }] }
  const orden: LineStatus[] = ["pending", "held", "fired", "preparing", "ready", "served"]
  const pos = orden.indexOf(to)
  if (to === "cancelled") {
    r.cancelReason = reason
    return r
  }
  if (to === "fired" && r.firedAt === null) r.firedAt = now
  if (to === "preparing" && r.startedAt === null) r.startedAt = now
  if (to === "ready" && r.readyAt === null) r.readyAt = now
  if (to === "served" && r.servedAt === null) r.servedAt = now
  // Hacia atrás: se borran las horas de los pasos posteriores.
  if (pos < orden.indexOf("fired")) r.firedAt = null
  if (pos < orden.indexOf("preparing")) r.startedAt = null
  if (pos < orden.indexOf("ready")) r.readyAt = null
  if (pos < orden.indexOf("served")) r.servedAt = null
  return r
}

/** Orden de avance: el estado de un menú es el de su plato menos avanzado. */
const AVANCE: Record<LineStatus, number> = { pending: 0, held: 1, fired: 2, preparing: 3, ready: 4, served: 5, cancelled: 6 }

/** Estado de la línea de un menú a partir de sus platos (anulada si lo están todos). */
export function menuLineStatus(components: readonly Pick<OrderLine, "status">[]): LineStatus {
  const vivos = components.filter((c) => c.status !== "cancelled")
  if (vivos.length === 0) return "cancelled"
  return vivos.reduce<LineStatus>((min, c) => (AVANCE[c.status] < AVANCE[min] ? c.status : min), "served")
}

/* Tareas -------------------------------------------------------------------------------- */

export const TASK_TRANSITIONS: Record<FloorTaskStatus, readonly FloorTaskStatus[]> = {
  open: ["claimed", "done", "cancelled"],
  claimed: ["open", "done", "cancelled"],
  done: [],
  cancelled: [],
}

/* Para llevar ---------------------------------------------------------------------------- */

export const TAKEAWAY_TRANSITIONS: Record<TakeawayStatus, readonly TakeawayStatus[]> = {
  pending: ["accepted", "cancelled"],
  accepted: ["ready", "cancelled"],
  ready: ["picked_up", "accepted", "cancelled"],
  picked_up: [],
  cancelled: [],
}

export function canTakeawayTransition(from: TakeawayStatus, to: TakeawayStatus): boolean {
  return TAKEAWAY_TRANSITIONS[from].includes(to)
}

/** Estado que toca a un para llevar aceptado según sus líneas: listo si todo está listo o servido. */
export function takeawayStatusFromLines(current: TakeawayStatus, lines: readonly Pick<OrderLine, "status" | "kind">[]): TakeawayStatus {
  if (current !== "accepted" && current !== "ready") return current
  const vivas = lines.filter((l) => l.kind !== "menu" && l.status !== "cancelled")
  if (vivas.length === 0) return current
  const listo = vivas.every((l) => l.status === "ready" || l.status === "served")
  return listo ? "ready" : "accepted"
}

/* Lo que ve el cliente --------------------------------------------------------------------- */

/** Estado de una línea para el cliente (mesa y para llevar), sin detalles de cocina. */
export function publicLineStatus(status: LineStatus): PublicLineStatus {
  switch (status) {
    case "pending":
      return "pending"
    case "held":
      return "held"
    case "fired":
    case "preparing":
      return "in_kitchen"
    case "ready":
      return "on_its_way"
    case "served":
      return "served"
    case "cancelled":
      return "cancelled"
  }
}
