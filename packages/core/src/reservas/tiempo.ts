/**
 * Fechas y horas locales sin dependencias: todo con `Intl`.
 *
 * El motor trabaja con dos tipos de tiempo:
 * - El **instante**: milisegundos desde 1970 en UTC. Es lo que se guarda y lo que se
 *   compara para saber si dos reservas se solapan. No le afectan los cambios de hora.
 * - La **hora de pared**: fecha `AAAA-MM-DD` y minutos desde medianoche tal como los ve
 *   el restaurante en su zona horaria. Es como se escriben los horarios.
 *
 * Los cambios de hora hacen que la conversión de pared a instante no sea siempre 1 a 1:
 * - En el adelanto (último domingo de marzo en Madrid, de 02:00 se salta a 03:00) las
 *   horas de 02:00 a 02:59 **no existen**.
 * - En el retraso (último domingo de octubre, de 03:00 se vuelve a 02:00) las horas de
 *   02:00 a 02:59 **ocurren dos veces**.
 */
import { z } from "zod"

const MINUTO = 60_000
const DIA = 24 * 60 * MINUTO

/** Fecha de calendario: "2026-11-09". */
export type Fecha = string

/** Hora de pared: "13:30". */
export type Hora = string

const REGEX_FECHA = /^(\d{4})-(\d{2})-(\d{2})$/
const REGEX_HORA = /^([01]\d|2[0-3]):([0-5]\d)$/

function partesFecha(fecha: Fecha): [number, number, number] {
  const m = REGEX_FECHA.exec(fecha)
  if (!m) throw new Error(`Fecha no válida: ${fecha}. Usa AAAA-MM-DD.`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

export function esFechaValida(fecha: string): boolean {
  const m = REGEX_FECHA.exec(fecha)
  if (!m) return false
  const [a, mes, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const t = new Date(Date.UTC(a, mes - 1, d))
  return t.getUTCFullYear() === a && t.getUTCMonth() === mes - 1 && t.getUTCDate() === d
}

export const FechaSchema = z
  .string()
  .regex(REGEX_FECHA, "Usa una fecha como 2026-11-09.")
  .refine(esFechaValida, "Esa fecha no existe.")

export const HoraSchema = z.string().regex(REGEX_HORA, "Usa una hora como 13:30.")

export function esZonaHorariaValida(zona: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zona })
    return true
  } catch {
    return false
  }
}

export const ZonaHorariaSchema = z.string().min(1).refine(esZonaHorariaValida, "Zona horaria desconocida.")

/** Días de la semana en el orden de un calendario español (lunes primero). */
export const DIAS_SEMANA = ["lun", "mar", "mie", "jue", "vie", "sab", "dom"] as const
export type DiaSemana = (typeof DIAS_SEMANA)[number]

export const DIA_SEMANA_LABEL: Record<DiaSemana, string> = {
  lun: "lunes",
  mar: "martes",
  mie: "miércoles",
  jue: "jueves",
  vie: "viernes",
  sab: "sábado",
  dom: "domingo",
}

function formatearFechaUTC(t: number): Fecha {
  const d = new Date(t)
  const a = String(d.getUTCFullYear()).padStart(4, "0")
  const m = String(d.getUTCMonth() + 1).padStart(2, "0")
  const dia = String(d.getUTCDate()).padStart(2, "0")
  return `${a}-${m}-${dia}`
}

/** Suma (o resta) días de calendario. No depende de la zona horaria. */
export function sumarDias(fecha: Fecha, dias: number): Fecha {
  const [a, m, d] = partesFecha(fecha)
  return formatearFechaUTC(Date.UTC(a, m - 1, d + dias))
}

/** Día de la semana de una fecha de calendario. */
export function diaSemana(fecha: Fecha): DiaSemana {
  const [a, m, d] = partesFecha(fecha)
  const domingoCero = new Date(Date.UTC(a, m - 1, d)).getUTCDay()
  // getUTCDay: 0 = domingo. Lo pasamos a 0 = lunes.
  return DIAS_SEMANA[(domingoCero + 6) % 7] as DiaSemana
}

/** "13:30" → 810 */
export function horaAMinutos(hora: Hora): number {
  const m = REGEX_HORA.exec(hora)
  if (!m) throw new Error(`Hora no válida: ${hora}. Usa HH:MM.`)
  return Number(m[1]) * 60 + Number(m[2])
}

/** 810 → "13:30". Acepta minutos de 0 a 1439. */
export function minutosAHora(minutos: number): Hora {
  if (!Number.isInteger(minutos) || minutos < 0 || minutos >= 1440) {
    throw new Error(`Minutos fuera del día: ${minutos}.`)
  }
  return `${String(Math.floor(minutos / 60)).padStart(2, "0")}:${String(minutos % 60).padStart(2, "0")}`
}

const formateadores = new Map<string, Intl.DateTimeFormat>()

function formateador(zona: string): Intl.DateTimeFormat {
  let f = formateadores.get(zona)
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zona,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
    formateadores.set(zona, f)
  }
  return f
}

/** La hora de pared de un instante, expresada como si fuera un instante UTC (en ms, sin milisegundos). */
function paredComoUTC(instante: number, zona: string): number {
  const valores: Record<string, number> = {}
  for (const p of formateador(zona).formatToParts(new Date(instante))) {
    if (p.type !== "literal") valores[p.type] = Number(p.value)
  }
  const hora = valores.hour === 24 ? 0 : (valores.hour ?? 0)
  return Date.UTC(
    valores.year ?? 1970,
    (valores.month ?? 1) - 1,
    valores.day ?? 1,
    hora,
    valores.minute ?? 0,
    valores.second ?? 0,
  )
}

/** Diferencia con UTC en minutos en ese instante: +60 en invierno en Madrid, +120 en verano. */
export function desfaseMinutos(instante: number, zona: string): number {
  const sinMs = instante - (((instante % 1000) + 1000) % 1000)
  return Math.round((paredComoUTC(instante, zona) - sinMs) / MINUTO)
}

export interface HoraLocal {
  fecha: Fecha
  /** Minutos desde medianoche, de 0 a 1439. */
  minutos: number
  hora: Hora
}

/** Qué fecha y hora marca el reloj del restaurante en un instante. */
export function horaLocal(instante: number, zona: string): HoraLocal {
  const pared = paredComoUTC(instante, zona)
  const fecha = formatearFechaUTC(pared)
  const minutos = Math.floor((((pared % DIA) + DIA) % DIA) / MINUTO)
  return { fecha, minutos, hora: minutosAHora(minutos) }
}

/**
 * Todos los instantes en los que el reloj de la zona marca esa fecha y hora.
 * Devuelve [] si la hora no existe (adelanto), dos instantes si se repite (retraso)
 * y uno en el resto de casos. Ordenados de menor a mayor.
 */
export function instantesDeHoraLocal(fecha: Fecha, minutos: number, zona: string): number[] {
  const [a, m, d] = partesFecha(fecha)
  const pared = Date.UTC(a, m - 1, d, 0, minutos)
  // Los desfases posibles son los de un día antes, el propio momento y un día después.
  const desfases = new Set([
    desfaseMinutos(pared - DIA, zona),
    desfaseMinutos(pared, zona),
    desfaseMinutos(pared + DIA, zona),
  ])
  const instantes = new Set<number>()
  for (const desfase of desfases) {
    const candidato = pared - desfase * MINUTO
    if (desfaseMinutos(candidato, zona) === desfase) instantes.add(candidato)
  }
  return [...instantes].sort((x, y) => x - y)
}

/**
 * El primer instante en el que el reloj marca esa fecha y hora, o null si no existe.
 * Si la hora se repite (retraso de octubre) se toma la primera vez, que es la que
 * entiende cualquier cliente al leer «02:30».
 */
export function instanteDeHoraLocal(fecha: Fecha, minutos: number, zona: string): number | null {
  return instantesDeHoraLocal(fecha, minutos, zona)[0] ?? null
}
