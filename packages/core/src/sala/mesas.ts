/**
 * Mesas abiertas: quién ocupa cada mesa, mover, juntar, separar, cerrar y el total.
 *
 * Todo puro: el servidor lee en la transacción las sesiones abiertas del local, las mesas
 * y las líneas, llama a estas funciones y escribe lo que devuelven. Si devuelven problemas,
 * no escribe nada y responde con el primero en castellano (`TABLE_PROBLEM_MESSAGE`).
 */
import type { Table } from "../model"
import type { Reservation } from "../reservation-model"
import type { ReservaOcupacion } from "../reservas/reserva"
import { lineIsUnserved } from "./estados"
import { MAX_SESSION_TABLES, sessionIsOpen, type OrderLine, type TableSession, type TableSessionStatus } from "./modelo"

type MesaPlano = Pick<Table, "name" | "enabled" | "joinableWith">
type Mesas = Readonly<Record<string, MesaPlano | undefined>>
type SesionMesas = { id: string; status: TableSessionStatus; tableIds: readonly string[] }

export const TABLE_PROBLEMS = [
  "table_not_found",
  "table_disabled",
  "table_occupied",
  "table_not_in_session",
  "too_many_tables",
  "too_many_guests",
  "same_tables",
  "would_leave_empty",
  "nothing_to_do",
  "session_not_open",
  "line_not_in_session",
  "line_is_menu_component",
  "lines_pending_approval",
  "lines_unserved",
  "has_lines",
] as const
export type TableProblemCode = (typeof TABLE_PROBLEMS)[number]
export interface TableProblem {
  code: TableProblemCode
  /** Mesa, sesión o línea afectada, o null. */
  ref: string | null
}

export const TABLE_PROBLEM_MESSAGE: Record<TableProblemCode, string> = {
  table_not_found: "Esa mesa no existe.",
  table_disabled: "Esa mesa está deshabilitada en el plano.",
  table_occupied: "Esa mesa ya está ocupada por otra mesa abierta.",
  table_not_in_session: "Esa mesa no es de esta mesa abierta.",
  too_many_tables: `Como mucho ${MAX_SESSION_TABLES} mesas juntas.`,
  too_many_guests: "Como mucho 200 comensales en una mesa abierta.",
  same_tables: "Ya está en esas mesas.",
  would_leave_empty: "Tiene que quedar al menos una mesa.",
  nothing_to_do: "No hay nada que cambiar.",
  session_not_open: "Esa mesa ya no está abierta.",
  line_not_in_session: "Esa línea no es de esta mesa.",
  line_is_menu_component: "Un plato de un menú se mueve con su menú entero.",
  lines_pending_approval: "Hay pedidos desde la mesa sin aceptar ni rechazar.",
  lines_unserved: "Quedan platos sin servir: sírvelos o anúlalos antes de cerrar.",
  has_lines: "Tiene cosas pedidas: no se puede anular, ciérrala.",
}

export type TablePlan<T> = ({ ok: true } & T) | { ok: false; problems: TableProblem[] }

/* Ocupación ------------------------------------------------------------------------------ */

/** Mesa del plano → sesión abierta que la ocupa. Si dos la reclaman (no debería), gana la primera. */
export function tableOccupancy(sessions: readonly SesionMesas[]): Record<string, string> {
  const r: Record<string, string> = {}
  for (const s of sessions) {
    if (!sessionIsOpen(s.status)) continue
    for (const t of s.tableIds) r[t] ??= s.id
  }
  return r
}

/** «S3+S4»: nombres de las mesas en orden natural (S2 antes que S10). */
export function sessionLabel(tableIds: readonly string[], tables: Mesas): string {
  const nombres = tableIds.map((id) => tables[id]?.name ?? id)
  return nombres.sort((a, b) => a.localeCompare(b, "es", { numeric: true })).join("+")
}

function comprobarMesas(tableIds: readonly string[], tables: Mesas, occupancy: Readonly<Record<string, string>>, ownSessionId: string | null): TableProblem[] {
  const problems: TableProblem[] = []
  if (tableIds.length > MAX_SESSION_TABLES) problems.push({ code: "too_many_tables", ref: null })
  for (const id of tableIds) {
    const t = tables[id]
    if (!t) problems.push({ code: "table_not_found", ref: id })
    else if (!t.enabled) problems.push({ code: "table_disabled", ref: id })
    const ocupa = occupancy[id]
    if (ocupa !== undefined && ocupa !== ownSessionId) problems.push({ code: "table_occupied", ref: id })
  }
  return problems
}

/** Si un conjunto de mesas está unido por `joinableWith` (leído en los dos sentidos). */
export function tablesAreJoinable(tableIds: readonly string[], tables: Mesas): boolean {
  if (tableIds.length <= 1) return true
  const ids = new Set(tableIds)
  const vecinos = (id: string) =>
    tableIds.filter((o) => o !== id && ((tables[id]?.joinableWith.includes(o) ?? false) || (tables[o]?.joinableWith.includes(id) ?? false)))
  const vistos = new Set<string>([tableIds[0] as string])
  const cola = [tableIds[0] as string]
  while (cola.length > 0) {
    const id = cola.pop() as string
    for (const v of vecinos(id)) {
      if (ids.has(v) && !vistos.has(v)) {
        vistos.add(v)
        cola.push(v)
      }
    }
  }
  return vistos.size === ids.size
}

/* Abrir ---------------------------------------------------------------------------------- */

export function planOpen(tableIds: readonly string[], tables: Mesas, occupancy: Readonly<Record<string, string>>): TablePlan<{ label: string; joinable: boolean }> {
  if (tableIds.length === 0) return { ok: false, problems: [{ code: "nothing_to_do", ref: null }] }
  const problems = comprobarMesas(tableIds, tables, occupancy, null)
  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, label: sessionLabel(tableIds, tables), joinable: tablesAreJoinable(tableIds, tables) }
}

/* Mover ---------------------------------------------------------------------------------- */

/** Mover una mesa abierta a otras mesas (todas libres o ya suyas). */
export function planMove(
  session: SesionMesas,
  targetTableIds: readonly string[],
  tables: Mesas,
  occupancy: Readonly<Record<string, string>>,
): TablePlan<{ tableIds: string[]; label: string; freedTableIds: string[] }> {
  if (!sessionIsOpen(session.status)) return { ok: false, problems: [{ code: "session_not_open", ref: session.id }] }
  if (targetTableIds.length === 0) return { ok: false, problems: [{ code: "would_leave_empty", ref: null }] }
  const iguales = targetTableIds.length === session.tableIds.length && targetTableIds.every((t) => session.tableIds.includes(t))
  if (iguales) return { ok: false, problems: [{ code: "same_tables", ref: null }] }
  const problems = comprobarMesas(targetTableIds, tables, occupancy, session.id)
  if (problems.length > 0) return { ok: false, problems }
  return {
    ok: true,
    tableIds: [...targetTableIds],
    label: sessionLabel(targetTableIds, tables),
    freedTableIds: session.tableIds.filter((t) => !targetTableIds.includes(t)),
  }
}

/* Juntar --------------------------------------------------------------------------------- */

export interface JoinPlan {
  tableIds: string[]
  label: string
  /** Mesas libres que se añaden. */
  addedTableIds: string[]
  /** Sesiones abiertas que se juntan en esta (pasan a merged y sus líneas vienen aquí). */
  mergedSessionIds: string[]
  /** Comensales sumados. */
  guests: number
  /** false si las mesas no están unidas en el plano: se permite, pero la interfaz lo avisa. */
  joinable: boolean
}

/**
 * Juntar mesas en una mesa abierta: las mesas libres se añaden y, si alguna es de otra mesa
 * abierta, esa sesión entera se junta aquí (sus mesas, comensales y líneas).
 */
export function planJoin(
  target: SesionMesas & { guests: number },
  tableIds: readonly string[],
  sessions: readonly (SesionMesas & { guests: number })[],
  tables: Mesas,
  occupancy: Readonly<Record<string, string>>,
): TablePlan<JoinPlan> {
  if (!sessionIsOpen(target.status)) return { ok: false, problems: [{ code: "session_not_open", ref: target.id }] }
  const nuevas = tableIds.filter((t) => !target.tableIds.includes(t))
  if (nuevas.length === 0) return { ok: false, problems: [{ code: "nothing_to_do", ref: null }] }
  const problems: TableProblem[] = []
  const merged: string[] = []
  const added: string[] = []
  for (const id of nuevas) {
    const t = tables[id]
    if (!t) problems.push({ code: "table_not_found", ref: id })
    else if (!t.enabled) problems.push({ code: "table_disabled", ref: id })
    const otra = occupancy[id]
    if (otra !== undefined && otra !== target.id) {
      if (!merged.includes(otra)) merged.push(otra)
    } else added.push(id)
  }
  const mergedSessions = merged.map((id) => sessions.find((s) => s.id === id))
  mergedSessions.forEach((s, i) => {
    if (!s || !sessionIsOpen(s.status)) problems.push({ code: "session_not_open", ref: merged[i] ?? null })
  })
  const todas = [...target.tableIds, ...added]
  for (const s of mergedSessions) for (const t of s?.tableIds ?? []) if (!todas.includes(t)) todas.push(t)
  if (todas.length > MAX_SESSION_TABLES) problems.push({ code: "too_many_tables", ref: null })
  const guests = target.guests + mergedSessions.reduce((s, x) => s + (x?.guests ?? 0), 0)
  if (guests > 200) problems.push({ code: "too_many_guests", ref: null })
  if (problems.length > 0) return { ok: false, problems }
  return {
    ok: true,
    tableIds: todas,
    label: sessionLabel(todas, tables),
    addedTableIds: added,
    mergedSessionIds: merged,
    guests,
    joinable: tablesAreJoinable(todas, tables),
  }
}

/* Separar -------------------------------------------------------------------------------- */

export interface SplitPlan {
  keepTableIds: string[]
  keepLabel: string
  /** Mesas que salen. Si hay líneas que mover, forman una mesa abierta nueva; si no, quedan libres. */
  splitTableIds: string[]
  splitLabel: string
  /** Líneas que pasan a la mesa nueva (con los platos de sus menús). */
  movedLineIds: string[]
  /** true si se crea una mesa abierta nueva. */
  createsSession: boolean
}

/**
 * Separar mesas de una mesa abierta. Sin líneas, las mesas solo se liberan. Con líneas, las
 * mesas separadas abren una mesa nueva con esas líneas (el grupo se divide). Un plato de un
 * menú no se separa de su menú: se pide el menú y se mueven sus platos con él.
 */
export function planSplit(
  session: SesionMesas,
  tableIds: readonly string[],
  lineIds: readonly string[],
  lines: readonly (Pick<OrderLine, "sessionId" | "kind" | "parentLineId"> & { id: string })[],
  tables: Mesas,
): TablePlan<SplitPlan> {
  if (!sessionIsOpen(session.status)) return { ok: false, problems: [{ code: "session_not_open", ref: session.id }] }
  const problems: TableProblem[] = []
  if (tableIds.length === 0) problems.push({ code: "nothing_to_do", ref: null })
  for (const t of tableIds) if (!session.tableIds.includes(t)) problems.push({ code: "table_not_in_session", ref: t })
  const keep = session.tableIds.filter((t) => !tableIds.includes(t))
  if (keep.length === 0) problems.push({ code: "would_leave_empty", ref: null })
  const moved: string[] = []
  for (const id of lineIds) {
    const l = lines.find((x) => x.id === id)
    if (!l || l.sessionId !== session.id) problems.push({ code: "line_not_in_session", ref: id })
    else if (l.kind === "menu_component") problems.push({ code: "line_is_menu_component", ref: id })
    else {
      moved.push(id)
      if (l.kind === "menu") for (const c of lines) if (c.parentLineId === id) moved.push(c.id)
    }
  }
  if (problems.length > 0) return { ok: false, problems }
  return {
    ok: true,
    keepTableIds: keep,
    keepLabel: sessionLabel(keep, tables),
    splitTableIds: [...tableIds],
    splitLabel: sessionLabel(tableIds, tables),
    movedLineIds: moved,
    createsSession: moved.length > 0,
  }
}

/* Cerrar y anular ------------------------------------------------------------------------- */

type LineaEstado = Pick<OrderLine, "status" | "kind">

/** Para cerrar: nada por aceptar y todo servido o anulado. */
export function checkCloseSession(lines: readonly LineaEstado[]): TableProblem[] {
  const problems: TableProblem[] = []
  const reales = lines.filter((l) => l.kind !== "menu")
  if (reales.some((l) => l.status === "pending")) problems.push({ code: "lines_pending_approval", ref: null })
  if (reales.some((l) => l.status !== "pending" && lineIsUnserved(l.status))) problems.push({ code: "lines_unserved", ref: null })
  return problems
}

/** Para anular una mesa abierta por error: no tiene que tener nada pedido (salvo anulado). */
export function checkCancelSession(lines: readonly LineaEstado[]): TableProblem[] {
  return lines.some((l) => l.status !== "cancelled") ? [{ code: "has_lines", ref: null }] : []
}

/* Totales ---------------------------------------------------------------------------------- */

export interface SessionTotals {
  totalCents: number
  lineCount: number
  unservedCount: number
}

/**
 * Total de una mesa o un para llevar: suma de `totalCents` de todas las líneas no anuladas
 * (la del menú lleva el precio del menú y sus platos, los suplementos). `lineCount` cuenta
 * platos y menús; `unservedCount`, lo que falta por servir (sin contar la línea del menú).
 */
export function sessionTotals(lines: readonly Pick<OrderLine, "status" | "kind" | "totalCents">[]): SessionTotals {
  let totalCents = 0
  let lineCount = 0
  let unservedCount = 0
  for (const l of lines) {
    if (l.status === "cancelled") continue
    totalCents += l.totalCents
    if (l.kind !== "menu_component") lineCount += 1
    if (l.kind !== "menu" && lineIsUnserved(l.status)) unservedCount += 1
  }
  if (!Number.isSafeInteger(totalCents)) throw new Error("Total fuera de rango.")
  return { totalCents, lineCount, unservedCount }
}

/* Reservas ---------------------------------------------------------------------------------- */

/** Campos con los que se abre una mesa al sentar una reserva. */
export function sessionFromReservation(
  reservation: Pick<Reservation, "tableIds" | "partySize" | "customerId" | "guestName">,
  reservationId: string,
): Pick<TableSession, "tableIds" | "guests" | "reservationId" | "customerId" | "guestName"> {
  return {
    tableIds: [...reservation.tableIds],
    guests: reservation.partySize,
    reservationId,
    customerId: reservation.customerId,
    guestName: reservation.guestName,
  }
}

/**
 * Toda sesión abierta ocupa sus mesas actuales, también al moverla, juntarla o reabrirla.
 * El servidor excluye las reservas sentadas representadas por estas sesiones al preparar
 * la ocupación del motor para no contar dos veces al mismo grupo.
 */
export function sessionToOcupacion(
  id: string,
  session: Pick<TableSession, "status" | "tableIds" | "guests" | "openedAt" | "reservationId">,
  expectedMinutes: number,
): ReservaOcupacion | null {
  if (!sessionIsOpen(session.status)) return null
  return {
    id: `session:${id}`,
    inicio: session.openedAt,
    duracionMinutos: expectedMinutes,
    comensales: session.guests,
    estado: "sentada",
    mesaIds: [...session.tableIds],
  }
}
