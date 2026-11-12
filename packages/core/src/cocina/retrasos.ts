/**
 * Retrasos: cuándo una línea, una comanda o una tarea «se está cayendo».
 *
 * Cada cosa tiene un inicio y una hora límite:
 * - línea marchada o en preparación: desde `firedAt`, límite `firedAt + targetMinutes`;
 * - línea lista sin recoger: desde `readyAt`, límite `readyAt + pickupMinutes` (el plato se enfría);
 * - tarea abierta o cogida: desde `openedAt`, límite `dueAt`.
 *
 * Niveles: a tiempo, en riesgo (pasado el 75 % del tiempo) y tarde. Los avisos al móvil
 * solo saltan al pasar a **tarde** (`lateAlerts`), una vez por cosa: si no, la gente los silencia.
 */
import type { FloorTask, OrderLine } from "../sala/modelo"

const MINUTO = 60_000

export const DELAY_LEVELS = ["on_time", "at_risk", "late"] as const
export type DelayLevel = (typeof DELAY_LEVELS)[number]

export const DELAY_LEVEL_LABEL: Record<DelayLevel, string> = { on_time: "a tiempo", at_risk: "justo", late: "tarde" }

/** Parte del tiempo pasada la cual algo está «en riesgo». */
export const AT_RISK_RATIO = 0.75

export interface Delay {
  level: DelayLevel
  /** Desde cuándo cuenta (ms UTC). */
  since: number
  /** Hora límite (ms UTC). */
  dueAt: number
  /** Minutos que lleva (redondeado hacia abajo). */
  elapsedMinutes: number
  /** Minutos que pasa del límite (0 si no ha llegado). */
  lateByMinutes: number
}

export function delayFor(since: number, dueAt: number, now: number): Delay {
  const total = Math.max(1, dueAt - since)
  const pasado = now - since
  const level: DelayLevel = now >= dueAt ? "late" : pasado >= total * AT_RISK_RATIO ? "at_risk" : "on_time"
  return {
    level,
    since,
    dueAt,
    elapsedMinutes: Math.max(0, Math.floor(pasado / MINUTO)),
    lateByMinutes: Math.max(0, Math.floor((now - dueAt) / MINUTO)),
  }
}

type LineaTiempos = Pick<OrderLine, "status" | "firedAt" | "readyAt" | "targetMinutes">

/** Inicio y límite de una línea según su estado, o null si no corre el reloj (en espera, servida…). */
export function lineWindow(line: LineaTiempos, pickupMinutes: number): { since: number; dueAt: number } | null {
  if ((line.status === "fired" || line.status === "preparing") && line.firedAt !== null && line.targetMinutes !== null) {
    return { since: line.firedAt, dueAt: line.firedAt + line.targetMinutes * MINUTO }
  }
  if (line.status === "ready" && line.readyAt !== null) return { since: line.readyAt, dueAt: line.readyAt + pickupMinutes * MINUTO }
  return null
}

export function lineDelay(line: LineaTiempos, now: number, pickupMinutes: number): Delay | null {
  const w = lineWindow(line, pickupMinutes)
  return w ? delayFor(w.since, w.dueAt, now) : null
}

const PESO: Record<DelayLevel, number> = { on_time: 0, at_risk: 1, late: 2 }

/** El peor retraso de un grupo (una comanda, una mesa); a igual nivel, el que más lleva. */
export function worstDelay(delays: readonly (Delay | null)[]): Delay | null {
  let peor: Delay | null = null
  for (const d of delays) {
    if (!d) continue
    if (!peor || PESO[d.level] > PESO[peor.level] || (PESO[d.level] === PESO[peor.level] && d.dueAt < peor.dueAt)) peor = d
  }
  return peor
}

export function taskDelay(task: Pick<FloorTask, "status" | "openedAt" | "dueAt">, now: number): Delay | null {
  if (task.status !== "open" && task.status !== "claimed") return null
  return delayFor(task.openedAt, task.dueAt, now)
}

/**
 * Lo que ha pasado a tarde entre la última comprobación y ahora: lo que tiene que avisar
 * (vibrar). La pantalla lo llama cada pocos segundos con su `lastCheckAt`; como solo mira
 * si el límite cae en ese tramo, cada cosa avisa una sola vez y sin guardar nada.
 */
export function lateAlerts<T extends { dueAt: number }>(items: readonly T[], lastCheckAt: number, now: number): T[] {
  return items.filter((i) => (!("claimedBy" in i) || (!i.claimedBy && (!("status" in i) || i.status === "open"))) && i.dueAt > lastCheckAt && i.dueAt <= now)
}
