/**
 * Fichaje: estados, acciones, validación de tiempos y PIN del puesto.
 *
 * Funciones puras. El reloj entra como dato y el servidor guarda siempre sus propios instantes
 * (truncados al minuto): ninguna acción de fichar admite una hora enviada por el cliente. Solo
 * un encargado puede crear o corregir horas, con motivo, y queda en `timeEntryEvents`.
 */
import { sha256Hex } from "../sha256"
import { MAX_BREAKS, MAX_ENTRY_MINUTES, MINUTE_MS, type PinRecord, type TimeEntry, type TimeEventKind } from "./modelo"
import { truncateToMinute, type EntryTimes } from "./horas"

export const CLOCK_ACTIONS = ["in", "break_start", "break_end", "out"] as const
export type ClockAction = (typeof CLOCK_ACTIONS)[number]
export type ClockState = "out" | "working" | "on_break"

export const CLOCK_STATE_LABEL: Record<ClockState, string> = {
  out: "Fuera",
  working: "Trabajando",
  on_break: "En pausa",
}

/** Estado de una persona a partir de su fichaje abierto (null = no tiene ninguno). */
export function clockState(entry: Pick<TimeEntry, "status" | "breaks"> | null): ClockState {
  if (!entry || entry.status !== "open") return "out"
  return entry.breaks.some((b) => b.endAt === null) ? "on_break" : "working"
}

export type ClockErrorCode = "already_open" | "not_open" | "already_on_break" | "not_on_break" | "forgotten" | "too_many_breaks"

export type ClockResult =
  | { ok: true; times: EntryTimes; event: TimeEventKind; state: ClockState; at: number }
  | { ok: false; code: ClockErrorCode; message: string }

const FALLO: Record<ClockErrorCode, string> = {
  already_open: "Ya tienes el fichaje abierto.",
  not_open: "No tienes ningún fichaje abierto.",
  already_on_break: "Ya estás en pausa.",
  not_on_break: "No estás en pausa.",
  forgotten: "Ese fichaje se quedó abierto de otro día. Pide a un encargado que lo cierre.",
  too_many_breaks: "Has llegado al máximo de pausas de un fichaje.",
}
const fallo = (code: ClockErrorCode): ClockResult => ({ ok: false, code, message: FALLO[code] })

/**
 * Aplica una acción de fichar. `current` es el fichaje abierto de la persona o null. Devuelve
 * los instantes nuevos y el evento a auditar. Salir con una pausa abierta la cierra a esa hora.
 * Un fichaje olvidado no se puede cerrar fichando: lo corrige un encargado.
 */
export function applyClockAction(current: (EntryTimes & Pick<TimeEntry, "forgotten">) | null, action: ClockAction, now: number): ClockResult {
  const at = truncateToMinute(now)
  if (action === "in") {
    if (current) return fallo(current.forgotten ? "forgotten" : "already_open")
    return { ok: true, times: { startAt: at, endAt: null, breaks: [] }, event: "clock_in", state: "working", at }
  }
  if (!current) return fallo("not_open")
  if (current.forgotten) return fallo("forgotten")
  const when = Math.max(at, current.startAt)
  const abierta = current.breaks.findIndex((b) => b.endAt === null)
  if (action === "break_start") {
    if (abierta >= 0) return fallo("already_on_break")
    if (current.breaks.length >= MAX_BREAKS) return fallo("too_many_breaks")
    return { ok: true, times: { ...current, breaks: [...current.breaks, { startAt: when, endAt: null }] }, event: "break_start", state: "on_break", at: when }
  }
  if (action === "break_end") {
    if (abierta < 0) return fallo("not_on_break")
    const breaks = current.breaks.map((b, i) => (i === abierta ? { startAt: b.startAt, endAt: Math.max(when, b.startAt) } : b))
    return { ok: true, times: { ...current, breaks }, event: "break_end", state: "working", at: when }
  }
  const breaks = current.breaks.map((b) => (b.endAt === null ? { startAt: b.startAt, endAt: Math.max(when, b.startAt) } : b))
  return { ok: true, times: { startAt: current.startAt, endAt: when, breaks }, event: "clock_out", state: "out", at: when }
}

export interface EntryIssue { code: "future" | "order" | "too_long" | "too_many_breaks" | "break_outside" | "break_order" | "break_overlap" | "overlaps_entry"; message: string }

/**
 * Comprueba unos instantes que escribe un encargado (fichaje manual, corrección o cierre de uno
 * olvidado). `others` son los demás fichajes de esa misma persona (el propio, ya excluido por
 * quien llama): no pueden solaparse, ni con los abiertos, que cuentan hasta `now`.
 */
export function validateEntryTimes(
  t: EntryTimes, ctx: { now: number; others: readonly { startAt: number; endAt: number | null; status: TimeEntry["status"] }[] },
): EntryIssue[] {
  const issues: EntryIssue[] = []
  const add = (code: EntryIssue["code"], message: string) => issues.push({ code, message })
  const end = t.endAt
  if (t.startAt > ctx.now || (end !== null && end > ctx.now)) add("future", "No se puede fichar en el futuro.")
  if (end !== null && end < t.startAt) add("order", "La salida no puede ser anterior a la entrada.")
  else if (end !== null && (end - t.startAt) / MINUTE_MS > MAX_ENTRY_MINUTES) add("too_long", "Un fichaje no pasa de 16 horas.")
  if (t.breaks.length > MAX_BREAKS) add("too_many_breaks", "Hay demasiadas pausas.")
  const limite = end ?? ctx.now
  const orden = [...t.breaks].sort((a, b) => a.startAt - b.startAt)
  orden.forEach((b, i) => {
    if (b.endAt !== null && b.endAt < b.startAt) add("break_order", "Una pausa acaba antes de empezar.")
    if (b.startAt < t.startAt || (b.endAt ?? b.startAt) > limite) add("break_outside", "Una pausa queda fuera del fichaje.")
    const previa = orden[i - 1]
    if (previa && (previa.endAt === null || b.startAt < previa.endAt)) add("break_overlap", "Hay pausas que se solapan.")
  })
  for (const o of ctx.others) {
    if (o.status === "voided") continue
    const oEnd = o.endAt ?? ctx.now
    if (t.startAt < oEnd && limite > o.startAt) { add("overlaps_entry", "Se solapa con otro fichaje de esta persona."); break }
  }
  return issues
}

/** Foto de unos instantes para la auditoría. */
export function snapshotOf(t: EntryTimes): { startAt: number; endAt: number | null; breaks: { startAt: number; endAt: number | null }[] } {
  return { startAt: t.startAt, endAt: t.endAt, breaks: t.breaks.map((b) => ({ startAt: b.startAt, endAt: b.endAt })) }
}

/* PIN del puesto de fichaje ------------------------------------------------------------------ */

export const PIN_MAX_ATTEMPTS = 5
export const PIN_LOCK_MS = 5 * MINUTE_MS

/** Huella del PIN con sal propia de cada persona. La sal (32 hex) la genera el servidor. */
export function pinHash(pin: string, uid: string, salt: string): string {
  return sha256Hex(JSON.stringify(["llenamos-pin", uid, salt, pin]))
}

export function newPinRecord(pin: string, uid: string, salt: string): PinRecord {
  return { pinHash: pinHash(pin, uid, salt), salt, failedAttempts: 0, lockedUntil: null }
}

export type PinCheck =
  | { ok: true; record: PinRecord }
  | { ok: false; reason: "locked" | "wrong"; record: PinRecord; lockedUntil: number | null; attemptsLeft: number }

function iguales(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Comprueba un PIN. Cinco fallos seguidos bloquean el PIN cinco minutos, también si luego se
 * acierta. Acertar reinicia los fallos. Es una comodidad del puesto, no una barrera fuerte:
 * el puesto exige además la sesión de un encargado.
 */
export function checkPin(record: PinRecord, pin: string, uid: string, now: number): PinCheck {
  if (record.lockedUntil !== null && now < record.lockedUntil) {
    return { ok: false, reason: "locked", record, lockedUntil: record.lockedUntil, attemptsLeft: 0 }
  }
  const base: PinRecord = { ...record, lockedUntil: null }
  if (iguales(pinHash(pin, uid, record.salt), record.pinHash)) return { ok: true, record: { ...base, failedAttempts: 0 } }
  const fallos = base.failedAttempts + 1
  if (fallos >= PIN_MAX_ATTEMPTS) {
    const lockedUntil = now + PIN_LOCK_MS
    return { ok: false, reason: "locked", record: { ...base, failedAttempts: 0, lockedUntil }, lockedUntil, attemptsLeft: 0 }
  }
  return { ok: false, reason: "wrong", record: { ...base, failedAttempts: fallos }, lockedUntil: null, attemptsLeft: PIN_MAX_ATTEMPTS - fallos }
}
