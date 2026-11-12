/**
 * Previsión de ocupación (fase 5): cuántos comensales habrá sentados en cada tramo de 15 minutos de
 * un día, a partir de los mismos días de la semana de hasta 12 semanas atrás, con más peso a lo
 * reciente, y de las reservas ya hechas. Es una estimación con su confianza, no una promesa: la
 * pantalla enseña siempre cuántas semanas la respaldan.
 *
 * - Peso de la semana k (1 = la pasada): 13 − k. Sin decimales: media ponderada redondeada.
 * - Los días cerrados no cuentan como cero: no entran en la muestra.
 * - Confianza: menos de 3 semanas, baja; de 3 a 7, media; 8 o más, alta. Si los totales del día
 *   varían más de un 25 % (desviación sobre la media), baja un nivel.
 * - `projected` es el mayor entre lo previsto y lo ya reservado en ese tramo.
 */
import { roundRatio } from "../caja/cuenta"
import { diaSemana, horaLocal, instanteDeHoraLocal, minutosAHora, sumarDias, type Fecha } from "../reservas/tiempo"

export const FORECAST_SLOT_MINUTES = 15
export const FORECAST_MAX_WEEKS = 12

export interface DayPresence {
  date: Fecha
  /** false si el local estuvo cerrado ese día (cierre, excepción o sin turnos). */
  open: boolean
  /** Comensales sentados al inicio de cada tramo, por minuto del día (0, 15, 30…). */
  slots: Readonly<Record<number, number>>
}

/**
 * Comensales presentes en cada tramo de 15 minutos de `date`: una mesa cuenta en un tramo si estaba
 * abierta en su inicio. Las mesas que cruzan la medianoche cuentan en su día de apertura.
 */
export function presenceBySlot(sessions: readonly { openedAt: number; closedAt: number | null; guests: number }[], date: Fecha, timezone: string, now: number): Record<number, number> {
  const out: Record<number, number> = {}
  for (const s of sessions) {
    if (horaLocal(s.openedAt, timezone).fecha !== date) continue
    const end = s.closedAt ?? now
    for (let m = 0; m < 48 * 60; m += FORECAST_SLOT_MINUTES) {
      const at = instanteDeHoraLocal(m < 24 * 60 ? date : sumarDias(date, 1), m % (24 * 60), timezone)
      if (at === null) continue // hora que no existe (adelanto de marzo)
      if (at >= end) break
      if (at >= s.openedAt) out[m] = (out[m] ?? 0) + s.guests
    }
  }
  return out
}

export type ForecastConfidence = "low" | "medium" | "high"
export const FORECAST_CONFIDENCE_LABEL: Record<ForecastConfidence, string> = { low: "baja", medium: "media", high: "alta" }

export interface ForecastSlot { slot: string; minutes: number; expected: number; booked: number; projected: number; occupancyBp: number | null }
export interface DayForecast {
  date: Fecha
  samples: number
  sampleDates: Fecha[]
  confidence: ForecastConfidence
  /** true si la variación entre semanas pasó del 25 % y bajó la confianza. */
  volatile: boolean
  slots: ForecastSlot[]
  peak: ForecastSlot | null
}

export function forecastDay(p: {
  date: Fecha
  history: readonly DayPresence[]
  seats: number
  /** Comensales de reservas vivas que estarán sentados en cada tramo (mismo formato). */
  booked: Readonly<Record<number, number>>
  maxWeeks?: number
}): DayForecast {
  const weeks = p.maxWeeks ?? FORECAST_MAX_WEEKS
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > FORECAST_MAX_WEEKS) throw new Error("Usa de 1 a 12 semanas.")
  const byDate = new Map(p.history.map((h) => [h.date, h]))
  const samples: { date: Fecha; weight: number; day: DayPresence }[] = []
  for (let k = 1; k <= weeks; k += 1) {
    const date = sumarDias(p.date, -7 * k)
    const day = byDate.get(date)
    if (day?.open) samples.push({ date, weight: FORECAST_MAX_WEEKS + 1 - k, day })
  }
  const keys = new Set<number>()
  for (const s of samples) for (const k of Object.keys(s.day.slots)) keys.add(Number(k))
  for (const k of Object.keys(p.booked)) keys.add(Number(k))
  const totalWeight = samples.reduce((s, x) => s + x.weight, 0)
  const slots: ForecastSlot[] = [...keys].sort((a, b) => a - b).map((minutes) => {
    const weighted = samples.reduce((s, x) => s + x.weight * (x.day.slots[minutes] ?? 0), 0)
    const expected = totalWeight > 0 ? roundRatio(BigInt(weighted), BigInt(totalWeight)) : 0
    const booked = p.booked[minutes] ?? 0
    const projected = Math.max(expected, booked)
    return { slot: minutosAHora(minutes % (24 * 60)), minutes, expected, booked, projected, occupancyBp: p.seats > 0 ? Math.min(10_000, roundRatio(BigInt(projected) * BigInt(10_000), BigInt(p.seats))) : null }
  })
  // Variación de los totales del día entre semanas (ponderada), sin decimales: var·16 > media².
  let volatile = false
  if (samples.length >= 2 && totalWeight > 0) {
    const totals = samples.map((s) => ({ w: BigInt(s.weight), v: BigInt(Object.values(s.day.slots).reduce((a, b) => a + b, 0)) }))
    const W = BigInt(totalWeight)
    const sum = totals.reduce((a, t) => a + t.w * t.v, BigInt(0))
    // var = Σw(v·W − sum)² / W³ y media = sum / W  →  var·16 > media²  ⇔  16·Σw(v·W − sum)² > sum²·W
    const dev = totals.reduce((a, t) => a + t.w * (t.v * W - sum) ** BigInt(2), BigInt(0))
    volatile = sum > BigInt(0) && BigInt(16) * dev > sum * sum * W
  }
  const base: ForecastConfidence = samples.length >= 8 ? "high" : samples.length >= 3 ? "medium" : "low"
  const confidence: ForecastConfidence = volatile ? (base === "high" ? "medium" : "low") : base
  const peak = slots.reduce<ForecastSlot | null>((best, s) => (s.projected > 0 && (best === null || s.projected > best.projected) ? s : best), null)
  return { date: p.date, samples: samples.length, sampleDates: samples.map((s) => s.date), confidence, volatile, slots, peak }
}

/** Mismo día de la semana: útil para que el servidor lea solo los días que hacen falta. */
export function forecastSampleDates(date: Fecha, weeks = FORECAST_MAX_WEEKS): Fecha[] {
  return Array.from({ length: weeks }, (_, i) => sumarDias(date, -7 * (i + 1)))
}

export function sameWeekday(a: Fecha, b: Fecha): boolean {
  return diaSemana(a) === diaSemana(b)
}
