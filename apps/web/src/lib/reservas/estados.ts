/**
 * Cómo se enseña cada reserva (estado visible, filtros, búsqueda) y qué se puede hacer
 * con ella ahora. Las transiciones son las de core (`nextStatuses`): la interfaz solo
 * ofrece lo que el servidor va a aceptar.
 */
import {
  nextStatuses,
  normalizeReference,
  occupiesTable,
  tryNormalizePhone,
  type ReservationStatus,
  type ReservationWithId,
} from "@llenamos/core"

const MINUTE = 60_000

/** Tono del punto de estado (ver docs/diseno/README.md, «Estados de reserva»). */
export type StatusTone = "waiting" | "late" | "seated" | "finished" | "cancelled" | "pending"

export interface VisibleStatus {
  tone: StatusTone
  /** «por llegar», «retraso 12 min», «sentada»… en minúscula. */
  label: string
  /** La fila va apagada (terminada, cancelada, no presentada). */
  muted: boolean
}

/** Minutos de retraso de una reserva que aún no ha llegado (0 si no va tarde). */
export function lateMinutes(r: Pick<ReservationWithId, "status" | "startAt">, now: number): number {
  if (r.status !== "pending" && r.status !== "confirmed") return 0
  return Math.max(0, Math.floor((now - r.startAt) / MINUTE))
}

/** Minutos que lleva sentada. */
export function seatedMinutes(r: Pick<ReservationWithId, "status" | "startAt" | "history">, now: number): number {
  if (r.status !== "seated") return 0
  const seatedAt = [...r.history].reverse().find((h) => h.to === "seated")?.at ?? r.startAt
  return Math.max(0, Math.floor((now - seatedAt) / MINUTE))
}

/** «12 min», «1 h 05». */
export function formatMinutes(total: number): string {
  if (total < 60) return `${total} min`
  const h = Math.floor(total / 60)
  const m = total % 60
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, "0")}`
}

export function visibleStatus(r: Pick<ReservationWithId, "status" | "startAt">, now: number): VisibleStatus {
  switch (r.status) {
    case "pending": {
      const late = lateMinutes(r, now)
      return late > 0
        ? { tone: "late", label: `sin confirmar, retraso ${formatMinutes(late)}`, muted: false }
        : { tone: "pending", label: "sin confirmar", muted: false }
    }
    case "confirmed": {
      const late = lateMinutes(r, now)
      return late > 0 ? { tone: "late", label: `retraso ${formatMinutes(late)}`, muted: false } : { tone: "waiting", label: "por llegar", muted: false }
    }
    case "seated":
      return { tone: "seated", label: "sentada", muted: false }
    case "finished":
      return { tone: "finished", label: "terminada", muted: true }
    case "cancelled":
      return { tone: "cancelled", label: "cancelada", muted: true }
    case "no_show":
      return { tone: "cancelled", label: "no presentada", muted: true }
  }
}

/* Filtros por estado ------------------------------------------------------ */

export const STATUS_FILTERS = ["all", "toArrive", "seated", "finished", "dropped"] as const
export type StatusFilter = (typeof STATUS_FILTERS)[number]

export const STATUS_FILTER_LABEL: Record<StatusFilter, string> = {
  all: "Todas",
  toArrive: "Por llegar",
  seated: "Sentadas",
  finished: "Terminadas",
  dropped: "Canceladas y no presentadas",
}

const FILTER_STATUSES: Record<StatusFilter, readonly ReservationStatus[] | null> = {
  all: null,
  toArrive: ["pending", "confirmed"],
  seated: ["seated"],
  finished: ["finished"],
  dropped: ["cancelled", "no_show"],
}

export function matchesFilter(status: ReservationStatus, filter: StatusFilter): boolean {
  const list = FILTER_STATUSES[filter]
  return list === null || list.includes(status)
}

export function countByFilter(reservations: readonly Pick<ReservationWithId, "status">[]): Record<StatusFilter, number> {
  const out = { all: 0, toArrive: 0, seated: 0, finished: 0, dropped: 0 } satisfies Record<StatusFilter, number>
  for (const r of reservations) {
    for (const f of STATUS_FILTERS) if (matchesFilter(r.status, f)) out[f] += 1
  }
  return out
}

/* Búsqueda ---------------------------------------------------------------- */

/** Minúsculas y sin acentos, para buscar «nuria» y encontrar «Núria». */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim()
}

function digits(text: string): string {
  return text.replace(/\D/g, "")
}

/**
 * Busca por nombre (sin acentos ni mayúsculas), por teléfono (con o sin prefijo, con
 * espacios) o por referencia («k7q2md» encuentra «K7Q2MD»).
 */
export function matchesSearch(r: Pick<ReservationWithId, "guestName" | "phone" | "reference">, search: string): boolean {
  const q = fold(search)
  if (q === "") return true
  if (fold(r.guestName).includes(q)) return true
  const ref = normalizeReference(search)
  if (ref.length >= 3 && r.reference.includes(ref)) return true
  const d = digits(search)
  if (d.length >= 3) {
    if (digits(r.phone).includes(d)) return true
    const e164 = tryNormalizePhone(search)
    if (e164 && e164 === r.phone) return true
  }
  return false
}

/* Acciones ---------------------------------------------------------------- */

export type ReservationAction =
  | { kind: "status"; to: ReservationStatus; label: string; destructive: boolean; needsConfirm: boolean }
  | { kind: "seatAt"; tableIds: string[]; label: string }
  | { kind: "tables"; label: string }
  | { kind: "move"; label: string }

const STATUS_ACTION_LABEL: Record<ReservationStatus, string> = {
  pending: "Dejar pendiente",
  confirmed: "Confirmar",
  seated: "Sentar",
  finished: "Terminar y liberar mesa",
  cancelled: "Cancelar reserva",
  no_show: "No se ha presentado",
}

export interface ActionPlan {
  /** La acción principal (el botón ámbar), o null si no queda nada que hacer. */
  primary: ReservationAction | null
  secondary: ReservationAction[]
}

/**
 * Qué se puede hacer con una reserva ahora mismo.
 *
 * - Pendiente: confirmar es lo principal.
 * - Confirmada o no presentada (llegó tarde): sentar. Si no tiene mesa y el motor
 *   sugirió una, «Sentar en S3» asigna esa mesa y la sienta.
 * - Sentada: terminar.
 * - Cancelar y no presentada piden confirmación.
 * - Cambiar mesa mientras ocupe mesa; mover solo si está pendiente o confirmada.
 */
export function actionsFor(
  r: Pick<ReservationWithId, "status" | "startAt" | "tableIds" | "suggestedTableIds">,
  now: number,
  tableNames: ReadonlyMap<string, string>,
  options: { canManage: boolean },
): ActionPlan {
  if (!options.canManage) return { primary: null, secondary: [] }
  const next = nextStatuses(r.status, r.startAt, now)
  const status = (to: ReservationStatus): ReservationAction => ({
    kind: "status",
    to,
    label: STATUS_ACTION_LABEL[to],
    destructive: to === "cancelled" || to === "no_show",
    needsConfirm: to === "cancelled" || to === "no_show",
  })

  let primary: ReservationAction | null = null
  if (r.status === "pending" && next.includes("confirmed")) primary = status("confirmed")
  else if (next.includes("seated")) primary = seatAction(r, tableNames)
  else if (next.includes("finished")) primary = status("finished")

  const secondary: ReservationAction[] = []
  if (r.status === "pending" && next.includes("seated")) secondary.push(seatAction(r, tableNames))
  if (occupiesTable(r.status)) secondary.push({ kind: "tables", label: r.tableIds.length > 0 ? "Cambiar mesa" : "Asignar mesa" })
  if (r.status === "pending" || r.status === "confirmed") secondary.push({ kind: "move", label: "Mover" })
  for (const to of next) {
    if (to === "cancelled" || to === "no_show") secondary.push(status(to))
  }
  return { primary, secondary }
}

function seatAction(r: Pick<ReservationWithId, "tableIds" | "suggestedTableIds">, names: ReadonlyMap<string, string>): ReservationAction {
  if (r.tableIds.length > 0) {
    return { kind: "status", to: "seated", label: `Sentar en ${tableLabel(r.tableIds, names)}`, destructive: false, needsConfirm: false }
  }
  if (r.suggestedTableIds.length > 0) {
    return { kind: "seatAt", tableIds: [...r.suggestedTableIds], label: `Sentar en ${tableLabel(r.suggestedTableIds, names)}` }
  }
  return { kind: "status", to: "seated", label: "Sentar sin mesa", destructive: false, needsConfirm: false }
}

/** «S4 + S5»; si una mesa ya no existe, se enseña su id para no esconder el dato. */
export function tableLabel(ids: readonly string[], names: ReadonlyMap<string, string>): string {
  return ids.map((id) => names.get(id) ?? id).join(" + ")
}
