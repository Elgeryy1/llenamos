/** Fechas y textos en castellano, siempre en la zona horaria del restaurante. */

export const TIMEZONE = "Europe/Madrid"

const time = new Intl.DateTimeFormat("es-ES", { hour: "2-digit", minute: "2-digit", timeZone: TIMEZONE })
const dayMonth = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", timeZone: TIMEZONE })
const dayMonthYear = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", year: "numeric", timeZone: TIMEZONE })
const full = new Intl.DateTimeFormat("es-ES", { dateStyle: "full", timeStyle: "short", timeZone: TIMEZONE })
const ymd = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: TIMEZONE })

/** Día natural en Madrid («2026-11-09»), para comparar «hoy» y «ayer». */
function dayKey(d: Date): string {
  return ymd.format(d)
}

function shortMonth(text: string): string {
  // «9 nov» en vez de «9 nov.»
  return text.replace(/\./g, "")
}

/**
 * «ahora mismo», «hace 5 min», «hace 2 h», «ayer a las 14:05», «3 nov, 14:05».
 */
export function formatRelative(date: Date, now: Date = new Date()): string {
  const diff = now.getTime() - date.getTime()
  const minutes = Math.floor(diff / 60_000)
  if (diff < 45_000 && diff > -60_000) return "ahora mismo"
  if (minutes >= 1 && minutes < 60) return `hace ${minutes} min`

  const today = dayKey(now)
  const yesterday = dayKey(new Date(now.getTime() - 24 * 3_600_000))
  const key = dayKey(date)

  if (key === today && minutes >= 60) return `hace ${Math.floor(minutes / 60)} h`
  if (key === yesterday) return `ayer a las ${time.format(date)}`
  if (key.slice(0, 4) === today.slice(0, 4)) return `${shortMonth(dayMonth.format(date))}, ${time.format(date)}`
  return `${shortMonth(dayMonthYear.format(date))}, ${time.format(date)}`
}

/** Fecha completa para el atributo title: «lunes, 9 de noviembre de 2026, 14:05». */
export function formatFull(date: Date): string {
  return full.format(date)
}

/** «Hola, Laia» con el primer nombre. */
export function firstName(name: string | null | undefined): string | null {
  const first = name?.trim().split(/\s+/)[0]
  return first ? first : null
}

/** «1 mesa», «3 mesas». */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}
