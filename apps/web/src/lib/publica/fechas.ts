/**
 * Fechas de la página pública, siempre en la hora del restaurante (no la del móvil).
 *
 * Las fechas de calendario (`AAAA-MM-DD`) se formatean como instantes UTC a medianoche
 * con `timeZone: "UTC"`, así el día de la semana no depende de la zona del navegador.
 */
import { horaLocal, sumarDias, type Language } from "@llenamos/core"
import { INTL_LOCALE, type Translate } from "./i18n"

const cache = new Map<string, Intl.DateTimeFormat>()

function format(lang: Language, options: Intl.DateTimeFormatOptions, timeZone = "UTC"): Intl.DateTimeFormat {
  const key = `${lang}|${timeZone}|${JSON.stringify(options)}`
  let f = cache.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat(INTL_LOCALE[lang], { ...options, timeZone })
    cache.set(key, f)
  }
  return f
}

function utcNoon(date: string): Date {
  const [y, m, d] = date.split("-").map(Number)
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12))
}

/** Día de hoy en el restaurante. */
export function todayIn(timezone: string, nowMs: number): string {
  return horaLocal(nowMs, timezone).fecha
}

/** Quita el punto de las abreviaturas («nov.» → «nov»). */
function clean(text: string): string {
  return text.replace(/\./g, "").trim()
}

export interface DayOption {
  date: string
  /** «hoy», «mañana» o el día de la semana abreviado. */
  label: string
  /** Número del día del mes. */
  day: string
  /** Nombre completo para lectores de pantalla: «jueves 12 de noviembre». */
  accessible: string
}

/** Días que se pueden elegir: desde hoy hasta `maxAdvanceDays` (como mucho `limit`). */
export function dayOptions(today: string, maxAdvanceDays: number, lang: Language, t: Translate, limit = 60): DayOption[] {
  const count = Math.max(1, Math.min(maxAdvanceDays + 1, limit))
  const weekday = format(lang, { weekday: "short" })
  const dayNum = format(lang, { day: "numeric" })
  const accessible = format(lang, { weekday: "long", day: "numeric", month: "long" })
  return Array.from({ length: count }, (_, i) => {
    const date = sumarDias(today, i)
    const d = utcNoon(date)
    const label = i === 0 ? t("today") : i === 1 ? t("tomorrow") : clean(weekday.format(d))
    return { date, label, day: dayNum.format(d), accessible: accessible.format(d) }
  })
}

/** «jueves 12 nov» (o «dijous 12 de nov», «Thursday 12 Nov»), en minúscula salvo en inglés. */
export function formatLongDate(date: string, lang: Language): string {
  const text = clean(format(lang, { weekday: "long", day: "numeric", month: "short" }).format(utcNoon(date)))
  return text.replace(/,/g, "")
}

/** Fecha y hora de pared de un instante en el restaurante. */
export function wallOf(ms: number, timezone: string): { date: string; time: string } {
  const local = horaLocal(ms, timezone)
  return { date: local.fecha, time: local.hora }
}

/** Mes corto para el titular de la tira de días: «noviembre 2026». */
export function monthLabel(date: string, lang: Language): string {
  return format(lang, { month: "long", year: "numeric" }).format(utcNoon(date))
}
