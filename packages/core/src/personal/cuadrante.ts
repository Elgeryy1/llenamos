/**
 * Cuadrante: semanas, turnos, conflictos, avisos y comparación con lo fichado.
 *
 * Un turno pertenece al día local en que empieza, aunque cruce la medianoche. La semana empieza
 * en lunes. Los avisos de descanso y de horas por semana son orientativos: los límites salen de
 * los ajustes y no son asesoría laboral (el convenio de cada restaurante puede ser otro).
 */
import { DIAS_SEMANA, diaSemana, horaLocal, instanteDeHoraLocal, sumarDias, type Fecha } from "../reservas/tiempo"
import { MINUTE_MS, type StaffShift, type StaffShiftWithId, type StaffSettings, type TimeEntry } from "./modelo"

/** Lunes de la semana de una fecha. */
export function weekStartOf(fecha: Fecha): Fecha {
  return sumarDias(fecha, -DIAS_SEMANA.indexOf(diaSemana(fecha)))
}

/** Las siete fechas de una semana, de lunes a domingo. */
export function weekDates(weekStart: Fecha): Fecha[] {
  if (diaSemana(weekStart) !== "lun") throw new Error("La semana empieza en lunes.")
  return Array.from({ length: 7 }, (_, i) => sumarDias(weekStart, i))
}

/** Fecha local y semana de un turno, que guarda el servidor al crearlo o moverlo. */
export function shiftPlacement(startAt: number, zona: string): { date: Fecha; weekStart: Fecha } {
  const date = horaLocal(startAt, zona).fecha
  return { date, weekStart: weekStartOf(date) }
}

export const shiftMinutes = (s: Pick<StaffShift, "startAt" | "endAt">): number => Math.floor((s.endAt - s.startAt) / MINUTE_MS)

type ShiftTimes = Pick<StaffShiftWithId, "id" | "uid" | "startAt" | "endAt">

/** Turnos de la misma persona que se pisan con `candidate` (el propio turno no cuenta). */
export function findShiftConflicts(shifts: readonly ShiftTimes[], candidate: Omit<ShiftTimes, "id"> & { id?: string }): string[] {
  return shifts
    .filter((s) => s.uid === candidate.uid && s.id !== candidate.id && candidate.startAt < s.endAt && candidate.endAt > s.startAt)
    .map((s) => s.id)
}

export interface ScheduleWarning {
  kind: "overlap" | "short_rest" | "weekly_hours"
  uid: string
  shiftIds: string[]
  message: string
}

/**
 * Avisos del cuadrante, por persona: turnos que se pisan, descanso entre turnos menor que el de
 * los ajustes y horas planificadas por semana por encima del máximo. No bloquean; los solapes
 * sí los rechaza `guardarTurno` antes de guardar.
 */
export function scheduleWarnings(shifts: readonly StaffShiftWithId[], settings: Pick<StaffSettings, "minRestMinutes" | "maxWeeklyMinutes">): ScheduleWarning[] {
  const out: ScheduleWarning[] = []
  const porPersona = new Map<string, StaffShiftWithId[]>()
  for (const s of shifts) porPersona.set(s.uid, [...(porPersona.get(s.uid) ?? []), s])
  for (const [uid, lista] of [...porPersona].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const orden = [...lista].sort((a, b) => a.startAt - b.startAt || a.endAt - b.endAt)
    for (let i = 1; i < orden.length; i++) {
      const previo = orden[i - 1]!
      const actual = orden[i]!
      if (actual.startAt < previo.endAt) out.push({ kind: "overlap", uid, shiftIds: [previo.id, actual.id], message: "Hay dos turnos a la vez." })
      else if ((actual.startAt - previo.endAt) / MINUTE_MS < settings.minRestMinutes) {
        out.push({ kind: "short_rest", uid, shiftIds: [previo.id, actual.id], message: `Descansa menos de ${Math.round(settings.minRestMinutes / 60)} horas entre dos turnos.` })
      }
    }
    const semanas = new Map<string, StaffShiftWithId[]>()
    for (const s of orden) semanas.set(s.weekStart, [...(semanas.get(s.weekStart) ?? []), s])
    for (const [, turnos] of [...semanas].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const total = turnos.reduce((m, s) => m + shiftMinutes(s), 0)
      if (total > settings.maxWeeklyMinutes) out.push({ kind: "weekly_hours", uid, shiftIds: turnos.map((s) => s.id), message: `Pasa de ${Math.round(settings.maxWeeklyMinutes / 60)} horas esa semana.` })
    }
  }
  return out
}

/** Minutos planificados por persona. */
export function plannedMinutesByUid(shifts: readonly Pick<StaffShift, "uid" | "startAt" | "endAt">[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const s of shifts) out[s.uid] = (out[s.uid] ?? 0) + shiftMinutes(s)
  return out
}

function diasEntre(a: Fecha, b: Fecha): number {
  const t = (f: Fecha) => Date.UTC(Number(f.slice(0, 4)), Number(f.slice(5, 7)) - 1, Number(f.slice(8, 10)))
  return Math.round((t(b) - t(a)) / 86_400_000)
}

export interface CopiedShift { uid: string; startAt: number; endAt: number; position: string; note: string }

/**
 * Copia los turnos de una semana a otra manteniendo la hora de pared (las 21:00 siguen siendo
 * las 21:00 aunque cambie la hora). Un turno cuya hora no existe en el destino (adelanto de
 * hora) no se copia y se devuelve aparte. Los copiados son borradores nuevos.
 */
export function copyWeek(
  shifts: readonly Pick<StaffShiftWithId, "id" | "uid" | "startAt" | "endAt" | "position" | "note">[],
  fromWeekStart: Fecha, toWeekStart: Fecha, zona: string,
): { copied: CopiedShift[]; skipped: { shiftId: string; reason: string }[] } {
  const desfase = diasEntre(fromWeekStart, toWeekStart)
  const copied: CopiedShift[] = []
  const skipped: { shiftId: string; reason: string }[] = []
  for (const s of shifts) {
    const ini = horaLocal(s.startAt, zona)
    const fin = horaLocal(s.endAt, zona)
    const nuevoIni = instanteDeHoraLocal(sumarDias(ini.fecha, desfase), ini.minutos, zona)
    const nuevoFin = instanteDeHoraLocal(sumarDias(fin.fecha, desfase), fin.minutos, zona)
    if (nuevoIni === null || nuevoFin === null || nuevoFin <= nuevoIni) {
      skipped.push({ shiftId: s.id, reason: "Esa hora no existe en la semana de destino." })
      continue
    }
    copied.push({ uid: s.uid, startAt: nuevoIni, endAt: nuevoFin, position: s.position, note: s.note })
  }
  return { copied, skipped }
}

export const PLAN_STATUS_LABEL = {
  upcoming: "Aún no toca",
  on_time: "A su hora",
  late: "Ha llegado tarde",
  absent: "No ha fichado",
} as const
export type PlanStatus = keyof typeof PLAN_STATUS_LABEL

export interface PlanVsReal {
  shiftId: string
  uid: string
  status: PlanStatus
  lateMinutes: number
  entryId: string | null
  plannedMinutes: number
  workedMinutes: number | null
}

/**
 * Compara cada turno con el fichaje de esa persona que empieza desde dos horas antes del turno
 * hasta que acaba. Si no hay fichaje: «aún no toca» hasta pasar la tolerancia, «no ha fichado»
 * después. Con fichaje: «a su hora» o «ha llegado tarde» según la tolerancia de los ajustes.
 */
export function planVsReal(
  shifts: readonly StaffShiftWithId[],
  entries: readonly (Pick<TimeEntry, "uid" | "startAt" | "status" | "workedMinutes"> & { id: string })[],
  settings: Pick<StaffSettings, "lateToleranceMinutes">, now: number,
): PlanVsReal[] {
  return [...shifts].sort((a, b) => a.startAt - b.startAt || (a.id < b.id ? -1 : 1)).map((s) => {
    const plannedMinutes = shiftMinutes(s)
    const entry = entries
      .filter((e) => e.uid === s.uid && e.status !== "voided" && e.startAt >= s.startAt - 120 * MINUTE_MS && e.startAt < s.endAt)
      .sort((a, b) => a.startAt - b.startAt)[0] ?? null
    if (!entry) {
      const tarde = now >= s.startAt + settings.lateToleranceMinutes * MINUTE_MS
      return { shiftId: s.id, uid: s.uid, status: tarde ? "absent" : "upcoming", lateMinutes: 0, entryId: null, plannedMinutes, workedMinutes: null } as PlanVsReal
    }
    const lateMinutes = Math.max(0, Math.floor((entry.startAt - s.startAt) / MINUTE_MS))
    return {
      shiftId: s.id, uid: s.uid, status: lateMinutes > settings.lateToleranceMinutes ? "late" : "on_time",
      lateMinutes, entryId: entry.id, plannedMinutes, workedMinutes: entry.workedMinutes,
    } as PlanVsReal
  })
}
