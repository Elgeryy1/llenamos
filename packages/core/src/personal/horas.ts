/**
 * Horas trabajadas: pausas, redondeo, medianoche y cambios de hora.
 *
 * Todo trabaja con instantes (ms UTC) truncados al minuto por el servidor, así los minutos
 * son exactos. La zona horaria del restaurante y el reloj entran como datos: nada lee la hora
 * del sistema. El reparto de minutos entre días usa restos mayores (`allocateCents`): la
 * suma por día coincide siempre con el total del fichaje.
 */
import { allocateCents } from "../caja/cuenta"
import { horaLocal, instanteDeHoraLocal, sumarDias, type Fecha } from "../reservas/tiempo"
import { MINUTE_MS, type StaffSettings, type TimeEntry } from "./modelo"

export interface EntryTimes {
  startAt: number
  endAt: number | null
  breaks: readonly { startAt: number; endAt: number | null }[]
}
export type Interval = readonly [number, number]

/** El servidor guarda cada instante de fichaje sin segundos ni milisegundos. */
export function truncateToMinute(ms: number): number {
  return ms - (((ms % MINUTE_MS) + MINUTE_MS) % MINUTE_MS)
}

function intervalMs(intervals: readonly Interval[]): number {
  return intervals.reduce((s, [a, b]) => s + (b - a), 0)
}

/** Pausas recortadas al fichaje, sin solapes y ordenadas. Una pausa abierta acaba en `until`. */
export function breakIntervals(t: EntryTimes, until: number): Interval[] {
  const end = t.endAt ?? until
  if (end <= t.startAt) return []
  const cut: [number, number][] = []
  for (const b of t.breaks) {
    const s = Math.max(b.startAt, t.startAt)
    const e = Math.min(b.endAt ?? end, end)
    if (e > s) cut.push([s, e])
  }
  cut.sort((x, y) => x[0] - y[0] || x[1] - y[1])
  const merged: [number, number][] = []
  for (const iv of cut) {
    const last = merged[merged.length - 1]
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1])
    else merged.push([iv[0], iv[1]])
  }
  return merged
}

/** Tramos de trabajo: todo el fichaje, menos las pausas si no se pagan. */
export function workIntervals(t: EntryTimes, settings: Pick<StaffSettings, "breaksPaid">, until: number): Interval[] {
  const end = t.endAt ?? until
  if (end <= t.startAt) return []
  if (settings.breaksPaid) return [[t.startAt, end]]
  const out: [number, number][] = []
  let cursor = t.startAt
  for (const [s, e] of breakIntervals(t, until)) {
    if (s > cursor) out.push([cursor, s])
    cursor = e
  }
  if (cursor < end) out.push([cursor, end])
  return out
}

/** Redondea minutos a un múltiplo de `step`: al más cercano (mitad hacia arriba) o hacia abajo. */
export function roundMinutes(minutes: number, step: number, mode: StaffSettings["roundingMode"]): number {
  if (!Number.isSafeInteger(minutes) || minutes < 0) throw new Error("Minutos no válidos.")
  if (step <= 0) return minutes
  return mode === "down" ? Math.floor(minutes / step) * step : Math.floor((minutes + step / 2) / step) * step
}

export interface EntryMinutes {
  /** Entrada a salida, sin descontar nada. */
  grossMinutes: number
  breakMinutes: number
  /** Trabajados antes de redondear: bruto menos pausas, salvo que se paguen. */
  workedMinutes: number
  /** Los que se guardan y se suman: trabajados con el redondeo de los ajustes. */
  roundedMinutes: number
}

/** Minutos de un fichaje. Si sigue abierto hace falta `until` (el reloj del servidor). */
export function entryMinutes(t: EntryTimes, settings: StaffSettings, until?: number): EntryMinutes {
  const end = t.endAt ?? until
  if (end === undefined) throw new Error("El fichaje sigue abierto: indica hasta cuándo contar.")
  if (end < t.startAt) throw new Error("La salida no puede ser anterior a la entrada.")
  const grossMinutes = Math.floor((end - t.startAt) / MINUTE_MS)
  const breakMinutes = Math.floor(intervalMs(breakIntervals(t, end)) / MINUTE_MS)
  const workedMinutes = Math.floor(intervalMs(workIntervals(t, settings, end)) / MINUTE_MS)
  return { grossMinutes, breakMinutes, workedMinutes, roundedMinutes: roundMinutes(workedMinutes, settings.roundingMinutes, settings.roundingMode) }
}

/** Primer instante de la medianoche local siguiente a `instante`. */
function nextLocalMidnight(instante: number, zona: string): number {
  const dia = horaLocal(instante, zona).fecha
  const siguiente = instanteDeHoraLocal(sumarDias(dia, 1), 0, zona)
  // Si en esa zona la medianoche no existe (adelanto a las 00:00), vale el primer instante del día siguiente.
  return siguiente !== null && siguiente > instante ? siguiente : instante + 24 * 60 * MINUTE_MS
}

/** Milisegundos de trabajo por fecha local, partiendo cada tramo en las medianoches. */
function msByLocalDay(intervals: readonly Interval[], zona: string): Map<Fecha, number> {
  const out = new Map<Fecha, number>()
  for (const [s, e] of intervals) {
    let cursor = s
    while (cursor < e) {
      const dia = horaLocal(cursor, zona).fecha
      const corte = Math.min(e, nextLocalMidnight(cursor, zona))
      out.set(dia, (out.get(dia) ?? 0) + (corte - cursor))
      cursor = corte
    }
  }
  return out
}

/**
 * Reparte los minutos redondeados de un fichaje entre los días locales que toca (un turno de
 * 21:00 a 02:00 cuenta en dos días). La suma por día es exactamente `roundedMinutes`.
 */
export function minutesByLocalDay(t: EntryTimes, settings: StaffSettings, zona: string, until?: number, total?: number): Record<Fecha, number> {
  const end = t.endAt ?? until
  if (end === undefined) throw new Error("El fichaje sigue abierto: indica hasta cuándo contar.")
  const minutos = total ?? entryMinutes(t, settings, end).roundedMinutes
  const porDia = msByLocalDay(workIntervals(t, settings, end), zona)
  const dias = [...porDia.keys()].sort()
  if (dias.length === 0) return minutos === 0 ? {} : { [horaLocal(t.startAt, zona).fecha]: minutos }
  const reparto = allocateCents(minutos, dias.map((d) => porDia.get(d) ?? 0))
  const out: Record<Fecha, number> = {}
  dias.forEach((d, i) => { out[d] = reparto[i] ?? 0 })
  return out
}

export type EntryLike = Pick<TimeEntry, "uid" | "date" | "startAt" | "endAt" | "breaks" | "status" | "forgotten" | "workedMinutes">

export interface HoursRow {
  uid: string
  /** Minutos de fichajes cerrados dentro del periodo (los guardados al cerrar). */
  minutes: number
  entries: number
  /** Fichajes abiertos de esos días: no suman hasta cerrarse. */
  openEntries: number
  forgottenEntries: number
  /** Lo que llevan los abiertos no olvidados hasta ahora, sin redondeo. Solo orientativo. */
  provisionalMinutes: number
  byDate: Record<Fecha, number>
}

/**
 * Horas por persona entre dos fechas locales (ambas incluidas). Los fichajes anulados no
 * cuentan. Los minutos de cada fichaje cerrado son los guardados al cerrarlo (un cambio de
 * ajustes no reescribe horas pasadas) y se reparten por día con los tramos de trabajo.
 */
export function hoursReport(
  entries: readonly EntryLike[],
  opts: { from: Fecha; to: Fecha; timezone: string; settings: StaffSettings; now: number },
): HoursRow[] {
  const rows = new Map<string, HoursRow>()
  const row = (uid: string): HoursRow => {
    let r = rows.get(uid)
    if (!r) { r = { uid, minutes: 0, entries: 0, openEntries: 0, forgottenEntries: 0, provisionalMinutes: 0, byDate: {} }; rows.set(uid, r) }
    return r
  }
  for (const e of entries) {
    if (e.status === "voided") continue
    if (e.status === "open") {
      if (e.date < opts.from || e.date > opts.to) continue
      const r = row(e.uid)
      r.openEntries++
      if (e.forgotten) r.forgottenEntries++
      else r.provisionalMinutes += Math.max(0, entryMinutes(e, { ...opts.settings, roundingMinutes: 0 }, Math.max(e.startAt, opts.now)).workedMinutes)
      continue
    }
    const total = e.workedMinutes ?? 0
    const porDia = minutesByLocalDay(e, opts.settings, opts.timezone, undefined, total)
    const dentro = Object.entries(porDia).filter(([d]) => d >= opts.from && d <= opts.to)
    if (dentro.length === 0) continue
    const r = row(e.uid)
    r.entries++
    for (const [d, m] of dentro) { r.byDate[d] = (r.byDate[d] ?? 0) + m; r.minutes += m }
  }
  return [...rows.values()].sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0))
}

/** Fichajes abiertos que han pasado el límite y aún no están marcados como olvidados. */
export function findForgottenEntries<E extends Pick<TimeEntry, "status" | "startAt" | "forgotten">>(
  entries: readonly (E & { id: string })[], now: number, settings: Pick<StaffSettings, "forgottenAfterMinutes">,
): string[] {
  return entries
    .filter((e) => e.status === "open" && !e.forgotten && now - e.startAt >= settings.forgottenAfterMinutes * MINUTE_MS)
    .map((e) => e.id)
}

/** Salida sugerida para cerrar un fichaje olvidado: el final del turno de ese día, si lo hay. */
export function suggestedCloseAt(entry: Pick<TimeEntry, "startAt">, shift: { startAt: number; endAt: number } | null): number | null {
  if (!shift || shift.endAt <= entry.startAt) return null
  return truncateToMinute(shift.endAt)
}

export interface TipHours {
  hours: { uid: string; minutes: number }[]
  /** Personas con un fichaje olvidado dentro de la ventana: sus horas reales no se conocen. */
  incomplete: string[]
}

/**
 * Minutos trabajados dentro de la ventana de una caja (apertura a cierre), por persona, en la
 * forma que espera `repartirPropinas` de la fase 3. Cuenta los tramos de trabajo (sin pausas
 * si no se pagan) que caen en la ventana, sin redondeo. Un fichaje abierto cuenta hasta el
 * final de la ventana; si está olvidado no se cuenta y la persona queda en `incomplete`.
 * Solo personas con minutos mayores que cero, ordenadas por uid.
 */
export function tipHoursForWindow(
  entries: readonly EntryLike[], window: { startAt: number; endAt: number }, settings: Pick<StaffSettings, "breaksPaid">,
): TipHours {
  if (window.endAt < window.startAt) throw new Error("La ventana de la caja no es válida.")
  const ms = new Map<string, number>()
  const incomplete = new Set<string>()
  for (const e of entries) {
    if (e.status === "voided") continue
    const end = e.endAt ?? window.endAt
    if (end <= window.startAt || e.startAt >= window.endAt) continue
    if (e.status === "open" && e.forgotten) { incomplete.add(e.uid); continue }
    const tramos = workIntervals({ startAt: e.startAt, endAt: e.endAt, breaks: e.breaks }, settings, window.endAt)
    let dentro = 0
    for (const [s, f] of tramos) dentro += Math.max(0, Math.min(f, window.endAt) - Math.max(s, window.startAt))
    ms.set(e.uid, (ms.get(e.uid) ?? 0) + dentro)
  }
  const hours = [...ms]
    .map(([uid, m]) => ({ uid, minutes: Math.floor(m / MINUTE_MS) }))
    .filter((h) => h.minutes > 0)
    .sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0))
  return { hours, incomplete: [...incomplete].sort() }
}
