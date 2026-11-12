/** Textos de fechas, horas e importes del panel del día, siempre en la hora del local. */
import { horaLocal, sumarDias, type Fecha } from "@llenamos/core"

/** «21:00» en la zona del local. */
export function timeOf(ms: number, timezone: string): string {
  return horaLocal(ms, timezone).hora
}

const longDay = new Intl.DateTimeFormat("es-ES", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })
const shortDay = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", timeZone: "UTC" })
const shortDayYear = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })

function utcNoon(date: Fecha): Date {
  return new Date(`${date}T12:00:00Z`)
}

/** «martes 10 de noviembre». */
export function longDate(date: Fecha): string {
  return longDay.format(utcNoon(date)).replace(",", "")
}

/** «hoy», «mañana», «ayer» o «martes 10 de noviembre». */
export function relativeDay(date: Fecha, today: Fecha): string {
  if (date === today) return "hoy"
  if (date === sumarDias(today, 1)) return "mañana"
  if (date === sumarDias(today, -1)) return "ayer"
  return `el ${longDate(date)}`
}

/** «10 nov» (o «10 nov 2025» si es de otro año). */
export function shortDate(ms: number, timezone: string, today?: Fecha): string {
  const date = horaLocal(ms, timezone).fecha
  const f = today && today.slice(0, 4) !== date.slice(0, 4) ? shortDayYear : shortDay
  return f.format(utcNoon(date)).replace(/\./g, "")
}

/** «Fecha» del calendario (día elegido en el navegador) ↔ «AAAA-MM-DD». */
export function dateToFecha(d: Date): Fecha {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

export function fechaToDate(date: Fecha): Date {
  const [y, m, d] = date.split("-").map(Number)
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1)
}

/** «30 €», «12,50 €». */
export function euros(cents: number): string {
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", minimumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100)
}

/** «+34 612 34 56 78» para leerlo mejor (solo los móviles y fijos españoles). */
export function prettyPhone(e164: string): string {
  const m = /^\+34(\d{3})(\d{2})(\d{2})(\d{2})$/.exec(e164)
  return m ? `+34 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : e164
}

/** «1 h 30» a partir de minutos. */
export function duration(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m} min`
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, "0")}`
}
