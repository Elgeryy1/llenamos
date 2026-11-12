/**
 * Lógica del formulario de horarios y reservas (`/panel/horarios`).
 *
 * El borrador es una `ReservationSettings` tal cual (la misma forma que se guarda),
 * así la validación es exactamente la de core (`ReservationSettingsSchema`) y la de
 * la función `guardarConfiguracionReservas`. Aquí solo hay ayudas para editarla y
 * para enseñar los errores en castellano junto a cada campo.
 */
import {
  DIA_TO_WEEKDAY,
  DIAS_SEMANA,
  DIA_SEMANA_LABEL,
  formatMoney,
  franjasDelDia,
  GuardarConfiguracionReservasInputSchema,
  parseMoney,
  ReservationSettingsSchema,
  settingsToConfiguracion,
  WEEKDAY_TO_DIA,
  WEEKDAYS,
  type Closure,
  type Exception,
  type ReservationSettings,
  type Shift,
  type Weekday,
} from "@llenamos/core"
import type { z } from "zod"

export type Settings = ReservationSettings

/* Días ------------------------------------------------------------------------- */

/** Días en el orden de un calendario español, con su nombre: [["mon", "lunes"], …]. */
export const WEEKDAY_LABELS: ReadonlyArray<readonly [Weekday, string]> = WEEKDAYS.map(
  (w) => [w, DIA_SEMANA_LABEL[WEEKDAY_TO_DIA[w]]] as const,
)

export function weekdayLabel(w: Weekday): string {
  return DIA_SEMANA_LABEL[WEEKDAY_TO_DIA[w]]
}

/** Día de la semana de una fecha «AAAA-MM-DD» (sin depender de la zona del ordenador). */
export function weekdayOf(fecha: string): Weekday {
  const [a, m, d] = fecha.split("-").map(Number) as [number, number, number]
  const dia = new Date(Date.UTC(a, m - 1, d)).getUTCDay() // 0 = domingo
  return DIA_TO_WEEKDAY[DIAS_SEMANA[(dia + 6) % 7]!]
}

/* Errores ----------------------------------------------------------------------- */

/**
 * Mensajes en castellano para los errores que no traen uno propio en el esquema
 * (los propios, como «Usa una hora como 13:30.», ganan siempre).
 */
export function spanishIssue(issue: z.core.$ZodRawIssue): string | undefined {
  switch (issue.code) {
    case "invalid_type":
      if (issue.expected === "number" || issue.expected === "int") return "Escribe un número."
      return "Falta este dato."
    case "too_small":
      if (issue.origin === "number" || issue.origin === "int") return `Como mínimo ${String(issue.minimum)}.`
      if (issue.origin === "string") return "Escribe algo en este campo."
      if (issue.origin === "array") return "Añade al menos uno."
      return "Es demasiado pequeño."
    case "too_big":
      if (issue.origin === "number" || issue.origin === "int") return `Como mucho ${String(issue.maximum)}.`
      if (issue.origin === "string") return `Como mucho ${String(issue.maximum)} caracteres.`
      if (issue.origin === "array") return `Como mucho ${String(issue.maximum)}.`
      return "Es demasiado grande."
    case "invalid_format":
      return "El formato no es válido."
    case "invalid_value":
      return "Elige una de las opciones."
    default:
      return undefined
  }
}

/** Clave de un campo: "week.tue.0.from", "deposit.amountCents". */
export type FieldPath = string

export function pathKey(path: ReadonlyArray<PropertyKey>): FieldPath {
  return path.map(String).join(".")
}

export interface SettingsValidation {
  ok: boolean
  data: Settings | null
  /** Primer error de cada campo. */
  errors: Record<FieldPath, string>
}

/** Valida el borrador con el esquema de core y devuelve los errores por campo. */
export function validateSettings(draft: Settings): SettingsValidation {
  const r = ReservationSettingsSchema.safeParse(draft, { error: spanishIssue })
  if (r.success) return { ok: true, data: r.data, errors: {} }
  const errors: Record<FieldPath, string> = {}
  for (const issue of r.error.issues) {
    const key = pathKey(issue.path)
    if (!(key in errors)) errors[key] = issue.message
  }
  return { ok: false, data: null, errors }
}

/** Errores de un trozo del formulario (por ejemplo, todo el martes: "week.tue"). */
export function errorsUnder(errors: Record<FieldPath, string>, prefix: FieldPath): string[] {
  return Object.entries(errors)
    .filter(([k]) => k === prefix || k.startsWith(`${prefix}.`))
    .map(([, v]) => v)
}

/** Nombre legible de la sección de un error, para el resumen de arriba del formulario. */
export function sectionOf(key: FieldPath): string {
  const [head, second] = key.split(".")
  if (head === "week" && second) return `Horario del ${weekdayLabel(second as Weekday)}`
  const SECTIONS: Record<string, string> = {
    exceptions: "Días especiales",
    closures: "Cierres",
    duration: "Duración",
    bufferMinutes: "Margen entre reservas",
    maxGuestsPerSlot: "Capacidad",
    minPartySize: "Tamaño de grupo",
    maxPartySize: "Tamaño de grupo",
    minNoticeMinutes: "Antelación",
    maxAdvanceDays: "Antelación",
    maxJoinedTables: "Mesas unidas",
    seatsLostPerJoin: "Mesas unidas",
    stepMinutes: "Intervalo entre horas",
    deposit: "Señal",
    cancellation: "Cancelación",
    reminders: "Recordatorio",
    reviews: "Reseñas",
    waitlist: "Lista de espera",
    timezone: "Zona horaria",
  }
  return SECTIONS[head ?? ""] ?? "Configuración"
}

/** Lo que se envía a `guardarConfiguracionReservas`, validado con el esquema de la callable. */
export function saveInput(restaurantId: string, locationId: string, settings: Settings) {
  return GuardarConfiguracionReservasInputSchema.parse({ restaurantId, locationId, settings })
}

/* Números escritos a mano ---------------------------------------------------------- */

/** Texto de un campo numérico → número entero, o NaN si no es un entero (el esquema lo dirá). */
export function intFromInput(text: string): number {
  const t = text.trim()
  if (!/^-?\d+$/.test(t)) return Number.NaN
  return Number(t)
}

/** Igual, pero vacío significa «sin límite» (null). */
export function optionalIntFromInput(text: string): number | null {
  return text.trim() === "" ? null : intFromInput(text)
}

/** Para pintar un número en un campo: NaN se queda como estaba escrito, por eso se pasa el texto aparte. */
export function intToInput(n: number | null | undefined): string {
  return n === null || n === undefined || Number.isNaN(n) ? "" : String(n)
}

/**
 * Hora escrita a mano → «HH:MM» de 24 horas: «930», «9:30», «9.30» o «9h30» → «09:30»;
 * «21» → «21:00». Si no se entiende, se devuelve tal cual (y el esquema avisa).
 */
export function normalizeTimeInput(text: string): string {
  const t = text.trim()
  const m = /^(\d{1,2})(?:[:.h]?(\d{2}))?$/.exec(t)
  if (!m) return t
  const h = Number(m[1])
  const min = m[2] === undefined ? 0 : Number(m[2])
  if (h > 23 || min > 59) return t
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`
}

/** «12,50» → 1250 céntimos; NaN si no se entiende. */
export function centsFromInput(text: string): number {
  const c = parseMoney(text)
  return c === null || c < 0 ? Number.NaN : c
}

/** 1250 → «12,50» (sin el símbolo, para un campo con «€» al lado). */
export function centsToInput(cents: number): string {
  if (!Number.isFinite(cents)) return ""
  return (cents / 100).toFixed(2).replace(".", ",")
}

export function money(cents: number): string {
  return formatMoney(cents)
}

/* Turnos -------------------------------------------------------------------------- */

/** Turno nuevo para un día: comida si no hay ninguno, cena si ya hay uno, y si no uno genérico. */
export function newShift(existing: readonly Shift[]): Shift {
  if (existing.length === 0) return { name: "Comida", from: "13:00", lastEntry: "15:30" }
  if (existing.length === 1) return { name: "Cena", from: "20:00", lastEntry: "22:30" }
  return { name: `Turno ${existing.length + 1}`, from: "17:00", lastEntry: "18:00" }
}

export function setDayShifts(s: Settings, day: Weekday, shifts: Shift[]): Settings {
  return { ...s, week: { ...s.week, [day]: shifts } }
}

export function addShift(s: Settings, day: Weekday): Settings {
  return setDayShifts(s, day, [...s.week[day], newShift(s.week[day])])
}

export function updateShift(s: Settings, day: Weekday, index: number, patch: Partial<Shift>): Settings {
  return setDayShifts(
    s,
    day,
    s.week[day].map((sh, i) => (i === index ? withOptional({ ...sh, ...patch }) : sh)),
  )
}

export function removeShift(s: Settings, day: Weekday, index: number): Settings {
  return setDayShifts(
    s,
    day,
    s.week[day].filter((_, i) => i !== index),
  )
}

/** Copia los turnos de un día a otros. */
export function copyDay(s: Settings, from: Weekday, to: readonly Weekday[]): Settings {
  const week = { ...s.week }
  for (const d of to) if (d !== from) week[d] = s.week[from].map((sh) => ({ ...sh }))
  return { ...s, week }
}

/** Firestore no admite `undefined`: los límites vacíos de un turno se quitan del objeto. */
function withOptional(sh: Shift): Shift {
  const out: Shift = { name: sh.name, from: sh.from, lastEntry: sh.lastEntry }
  if (sh.maxGuestsPerSlot !== undefined && sh.maxGuestsPerSlot !== null) out.maxGuestsPerSlot = sh.maxGuestsPerSlot
  if (sh.maxGuestsPerShift !== undefined && sh.maxGuestsPerShift !== null) out.maxGuestsPerShift = sh.maxGuestsPerShift
  return out
}

/** Límite opcional de un turno escrito a mano: vacío lo quita. */
export function shiftLimitFromInput(text: string): number | undefined {
  return text.trim() === "" ? undefined : intFromInput(text)
}

/* Días especiales y cierres ----------------------------------------------------------- */

export function sortExceptions(list: readonly Exception[]): Exception[] {
  return [...list].sort((a, b) => a.date.localeCompare(b.date))
}

export function addException(s: Settings, date: string, type: Exception["type"]): Settings {
  const e: Exception =
    type === "closed" ? { type: "closed", date } : { type: "hours", date, shifts: [{ name: "Especial", from: "13:00", lastEntry: "15:30" }] }
  return { ...s, exceptions: sortExceptions([...s.exceptions, e]) }
}

export function updateException(s: Settings, index: number, e: Exception): Settings {
  return { ...s, exceptions: s.exceptions.map((x, i) => (i === index ? e : x)) }
}

export function removeException(s: Settings, index: number): Settings {
  return { ...s, exceptions: s.exceptions.filter((_, i) => i !== index) }
}

/** Cambia un día especial entre «cerrado» y «horario especial» conservando fecha y motivo. */
export function switchExceptionType(e: Exception): Exception {
  const reason = e.reason !== undefined ? { reason: e.reason } : {}
  if (e.type === "closed") return { type: "hours", date: e.date, shifts: [{ name: "Especial", from: "13:00", lastEntry: "15:30" }], ...reason }
  return { type: "closed", date: e.date, ...reason }
}

export function addClosure(s: Settings, from: string, to: string): Settings {
  const c: Closure = { from, to }
  return { ...s, closures: [...s.closures, c].sort((a, b) => a.from.localeCompare(b.from)) }
}

export function updateClosure(s: Settings, index: number, patch: Partial<Closure>): Settings {
  return {
    ...s,
    closures: s.closures.map((c, i) => {
      if (i !== index) return c
      const next = { ...c, ...patch }
      // Un motivo vacío se quita en vez de guardar "".
      if (next.reason !== undefined && next.reason.trim() === "") delete next.reason
      return next
    }),
  }
}

export function removeClosure(s: Settings, index: number): Settings {
  return { ...s, closures: s.closures.filter((_, i) => i !== index) }
}

/* Duración por tamaño de grupo -------------------------------------------------------- */

export function addTier(s: Settings): Settings {
  const tiers = s.duration.tiers
  const last = tiers.at(-1)
  const upToGuests = (last?.upToGuests ?? 0) + 2
  const minutes = last?.minutes ?? 90
  return { ...s, duration: { ...s.duration, tiers: [...tiers, { upToGuests, minutes }] } }
}

export function updateTier(s: Settings, index: number, patch: Partial<{ upToGuests: number; minutes: number }>): Settings {
  return { ...s, duration: { ...s.duration, tiers: s.duration.tiers.map((t, i) => (i === index ? { ...t, ...patch } : t)) } }
}

export function removeTier(s: Settings, index: number): Settings {
  return { ...s, duration: { ...s.duration, tiers: s.duration.tiers.filter((_, i) => i !== index) } }
}

/** «Hasta 2 personas: 1 h 30 min». */
export function formatMinutes(min: number): string {
  if (!Number.isFinite(min)) return ""
  const h = Math.floor(min / 60)
  const m = min % 60
  if (h === 0) return `${m} min`
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

/* Resumen y vista previa ------------------------------------------------------------ */

/** Horas que se ofrecerían un día concreto con el borrador (solo si el borrador es válido). */
export function previewSlots(s: Settings, fecha: string): { turno: string; horas: string[] }[] | null {
  const valid = validateSettings(s)
  if (!valid.data) return null
  const franjas = franjasDelDia(settingsToConfiguracion(valid.data), fecha)
  const out: { turno: string; horas: string[] }[] = []
  for (const f of franjas) {
    const last = out.at(-1)
    if (last && last.turno === f.turno) last.horas.push(f.hora)
    else out.push({ turno: f.turno, horas: [f.hora] })
  }
  return out
}

/** «Abre 6 días · 11 turnos a la semana». */
export function weekSummary(s: Settings): string {
  const open = WEEKDAYS.filter((d) => s.week[d].length > 0).length
  const shifts = WEEKDAYS.reduce((n, d) => n + s.week[d].length, 0)
  if (open === 0) return "Cerrado toda la semana"
  return `Abre ${open} ${open === 1 ? "día" : "días"} · ${shifts} ${shifts === 1 ? "turno" : "turnos"} a la semana`
}

/** Comparación estable para saber si hay cambios sin guardar. */
export function sameSettings(a: Settings, b: Settings): boolean {
  return stableStringify(a) === stableStringify(b)
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`
  }
  // NaN y null se distinguen: un campo a medio escribir cuenta como cambio.
  if (typeof value === "number" && Number.isNaN(value)) return "NaN"
  return JSON.stringify(value)
}
