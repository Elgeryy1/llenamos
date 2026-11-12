/**
 * Presentación y cuentas de personal que no son cálculo de negocio: textos de horas y fechas,
 * periodos, conversión de lo que escribe el encargado a instantes y agrupación del cuadrante.
 * Los cálculos de verdad (horas, avisos, comparación con lo fichado) viven en `@llenamos/core`
 * y se reutilizan; esto solo los pone en la pantalla. Todo en la zona del restaurante.
 */
import {
  DIA_SEMANA_LABEL,
  MINUTE_MS,
  diaSemana,
  horaAMinutos,
  horaLocal,
  instanteDeHoraLocal,
  sumarDias,
  weekDates,
  weekStartOf,
  type EntryBreak,
  type Fecha,
  type ScheduleWarning,
  type StaffShiftWithId,
} from "@llenamos/core"
import { TIMEZONE } from "@/lib/format"

export { TIMEZONE, weekStartOf, weekDates, sumarDias }

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"]
const MESES_CORTOS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"]

const partes = (f: Fecha) => ({ a: Number(f.slice(0, 4)), m: Number(f.slice(5, 7)), d: Number(f.slice(8, 10)) })

/** Fecha local de hoy en el restaurante. */
export function fechaDe(ms: number): Fecha {
  return horaLocal(ms, TIMEZONE).fecha
}

/** «20:30» en la zona del restaurante. */
export function horaTexto(ms: number): string {
  return horaLocal(ms, TIMEZONE).hora
}

/** «lun 9» para cabeceras estrechas. */
export function diaCorto(f: Fecha): string {
  return `${DIA_SEMANA_LABEL[diaSemana(f)].slice(0, 3)} ${partes(f).d}`
}

/** «lun 9 nov». */
export function diaMes(f: Fecha): string {
  const p = partes(f)
  return `${DIA_SEMANA_LABEL[diaSemana(f)].slice(0, 3)} ${p.d} ${MESES_CORTOS[p.m - 1]}`
}

/** «lunes 9 de noviembre». */
export function diaLargo(f: Fecha): string {
  const p = partes(f)
  return `${DIA_SEMANA_LABEL[diaSemana(f)]} ${p.d} de ${MESES[p.m - 1]}`
}

/** «9 al 15 de noviembre» o «27 de octubre al 2 de noviembre». */
export function rangoTexto(from: Fecha, to: Fecha): string {
  const a = partes(from)
  const b = partes(to)
  if (from === to) return `${b.d} de ${MESES[b.m - 1]}`
  if (a.a === b.a && a.m === b.m) return `${a.d} al ${b.d} de ${MESES[b.m - 1]}`
  return `${a.d} de ${MESES[a.m - 1]} al ${b.d} de ${MESES[b.m - 1]}`
}

/** «7 h 30 min», «45 min», «2 h». */
export function duracion(minutos: number): string {
  const m = Math.max(0, Math.round(minutos))
  const h = Math.floor(m / 60)
  const r = m % 60
  if (h === 0) return `${r} min`
  return r === 0 ? `${h} h` : `${h} h ${r} min`
}

/** «7:30» para columnas de cifras. */
export function horasMinutos(minutos: number): string {
  const m = Math.max(0, Math.round(minutos))
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`
}

/* Periodos ---------------------------------------------------------------------------------- */

export type TipoPeriodo = "semana" | "mes"
export interface Periodo { from: Fecha; to: Fecha }

function ultimoDiaDelMes(f: Fecha): Fecha {
  const { a, m } = partes(f)
  return sumarDias(`${String(m === 12 ? a + 1 : a).padStart(4, "0")}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01`, -1)
}

/** El periodo (lunes a domingo, o mes natural) que contiene la fecha de anclaje. */
export function periodoDe(tipo: TipoPeriodo, ancla: Fecha): Periodo {
  if (tipo === "semana") {
    const from = weekStartOf(ancla)
    return { from, to: sumarDias(from, 6) }
  }
  const from = `${ancla.slice(0, 7)}-01`
  return { from, to: ultimoDiaDelMes(ancla) }
}

/** El periodo anterior (-1) o siguiente (+1), devuelto como nueva fecha de anclaje. */
export function moverAncla(tipo: TipoPeriodo, ancla: Fecha, paso: -1 | 1): Fecha {
  if (tipo === "semana") return sumarDias(ancla, 7 * paso)
  const { from, to } = periodoDe("mes", ancla)
  return paso === 1 ? sumarDias(to, 1) : sumarDias(from, -1)
}

export function fechasEntre(from: Fecha, to: Fecha): Fecha[] {
  const out: Fecha[] = []
  for (let f = from; f <= to && out.length < 62; f = sumarDias(f, 1)) out.push(f)
  return out
}

/* Horas que escribe el encargado ------------------------------------------------------------ */

/** Acepta «9:30», «09:30», «930» o «0930» y devuelve «09:30»; null si no es una hora. */
export function normalizarHora(texto: string): string | null {
  const t = texto.trim().replace(".", ":")
  const m = /^(\d{1,2}):?(\d{2})$/.exec(t) ?? /^(\d{1,2})$/.exec(t)
  if (!m) return null
  const h = Number(m[1])
  const min = m[2] === undefined ? 0 : Number(m[2])
  if (h > 23 || min > 59) return null
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`
}

/**
 * Pasa una lista de horas escritas EN ORDEN (entrada, inicio y fin de cada pausa, salida) a
 * instantes. La primera cae en `fecha`; cada una siguiente es la primera vez que el reloj marca esa
 * hora desde la anterior, así una salida «02:10» tras una entrada «20:00» es del día siguiente.
 * `null` en una posición sin escribir (pausa sin cerrar) se respeta.
 */
export function secuenciaDeHoras(fecha: Fecha, horas: readonly (string | null)[]): { ok: true; ms: (number | null)[] } | { ok: false; message: string; index: number } {
  const ms: (number | null)[] = []
  let previo = Number.NEGATIVE_INFINITY
  let dia = fecha
  for (const [index, texto] of horas.entries()) {
    if (texto === null) { ms.push(null); continue }
    const hora = normalizarHora(texto)
    if (!hora) return { ok: false, message: "Escribe la hora como 20:30.", index }
    let instante: number | null = null
    // Hasta dos días hacia delante: una pausa o una salida nunca va más allá de eso.
    for (let paso = 0; paso < 3 && instante === null; paso++) {
      const candidato = instanteDeHoraLocal(dia, horaAMinutos(hora), TIMEZONE)
      if (candidato === null) return { ok: false, message: "Esa hora no existe ese día por el cambio de hora.", index }
      if (candidato >= previo) instante = candidato
      else dia = sumarDias(dia, 1)
    }
    if (instante === null) return { ok: false, message: "No se puede situar esa hora.", index }
    ms.push(instante)
    previo = instante
  }
  return { ok: true, ms }
}

export interface FormularioFichaje {
  fecha: Fecha
  entrada: string
  salida: string
  pausas: { inicio: string; fin: string }[]
}

export type InstantesFichaje =
  | { ok: true; startAt: number; endAt: number; breaks: { startAt: number; endAt: number }[] }
  | { ok: false; message: string }

/** De lo que se ve en el formulario a los instantes que pide la callable. */
export function instantesDeFormulario(f: FormularioFichaje): InstantesFichaje {
  const lista: string[] = [f.entrada, ...f.pausas.flatMap((p) => [p.inicio, p.fin]), f.salida]
  const r = secuenciaDeHoras(f.fecha, lista)
  if (!r.ok) {
    const nombre = r.index === 0 ? "la entrada" : r.index === lista.length - 1 ? "la salida" : `la pausa ${Math.ceil(r.index / 2)}`
    return { ok: false, message: `Revisa ${nombre}: ${r.message.charAt(0).toLowerCase()}${r.message.slice(1)}` }
  }
  const ms = r.ms as number[]
  const startAt = ms[0]!
  const endAt = ms[ms.length - 1]!
  if (endAt <= startAt) return { ok: false, message: "La salida tiene que ser después de la entrada." }
  const breaks = f.pausas.map((_, i) => ({ startAt: ms[1 + i * 2]!, endAt: ms[2 + i * 2]! }))
  return { ok: true, startAt, endAt, breaks }
}

/** El formulario de un fichaje que ya existe (las pausas abiertas se dejan sin fin). */
export function formularioDeFichaje(e: { date: Fecha; startAt: number; endAt: number | null; breaks: readonly EntryBreak[] }, salidaPorDefecto = ""): FormularioFichaje {
  return {
    fecha: e.date,
    entrada: horaTexto(e.startAt),
    salida: e.endAt === null ? salidaPorDefecto : horaTexto(e.endAt),
    pausas: e.breaks.map((b) => ({ inicio: horaTexto(b.startAt), fin: b.endAt === null ? "" : horaTexto(b.endAt) })),
  }
}

/* Cuadrante --------------------------------------------------------------------------------- */

/** Turnos de la semana agrupados por persona y día. */
export function turnosPorCelda<T extends Pick<StaffShiftWithId, "uid" | "date" | "startAt">>(turnos: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const t of turnos) {
    const k = `${t.uid}|${t.date}`
    out.set(k, [...(out.get(k) ?? []), t].sort((a, b) => a.startAt - b.startAt))
  }
  return out
}

export const claveCelda = (uid: string, fecha: Fecha) => `${uid}|${fecha}`

/** «13:00 a 17:30». */
export function turnoTexto(t: { startAt: number; endAt: number }): string {
  return `${horaTexto(t.startAt)} a ${horaTexto(t.endAt)}`
}

/** Avisos por turno, para marcarlos en la rejilla. */
export function avisosPorTurno(avisos: readonly ScheduleWarning[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const a of avisos) for (const id of a.shiftIds) out.set(id, [...(out.get(id) ?? []), a.message])
  return out
}

/** Un turno puede cruzar la medianoche: la hora de fin se resuelve respecto al inicio. */
export function turnoDeFormulario(fecha: Fecha, inicio: string, fin: string): { ok: true; startAt: number; endAt: number } | { ok: false; message: string } {
  const r = secuenciaDeHoras(fecha, [inicio, fin])
  if (!r.ok) return { ok: false, message: r.message }
  const [startAt, endAt] = r.ms as [number, number]
  if (endAt <= startAt) return { ok: false, message: "El turno acaba después de empezar." }
  if ((endAt - startAt) / MINUTE_MS > 16 * 60) return { ok: false, message: "Un turno no pasa de 16 horas." }
  return { ok: true, startAt, endAt }
}

/** Junta motivos repetidos: «Se pisa con otro turno (19 turnos)» en lugar de 19 líneas iguales. */
export function agruparMotivos(motivos: readonly string[]): string[] {
  const cuenta = new Map<string, number>()
  for (const m of motivos) cuenta.set(m, (cuenta.get(m) ?? 0) + 1)
  return [...cuenta].map(([m, n]) => (n === 1 ? m : `${m.replace(/\.$/, "")} (${n} turnos).`))
}
