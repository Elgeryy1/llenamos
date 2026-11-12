/**
 * Resumen diario al propietario (fase 5): las cifras del último día de servicio frente al mismo día
 * de la semana anterior, las reservas de hoy y los avisos abiertos, en un texto corto que sale por
 * la cola de mensajes existente (correo o WhatsApp, plantilla `daily_summary`). Sin claves del
 * proveedor no se envía nada: el mensaje queda `captured` en el emulador o `not_configured`.
 */
import { z } from "zod"
import { formatMoney } from "../money"
import { HoraSchema, horaAMinutos, horaLocal, sumarDias, type Fecha } from "../reservas/tiempo"
import { comparePeriods, type MetricTotals } from "./metricas"

export const DailySummarySettingsSchema = z.strictObject({
  enabled: z.boolean(),
  /** Hora local a partir de la cual se envía el resumen. */
  hour: HoraSchema,
  channels: z.array(z.enum(["email", "whatsapp"])).min(1).max(2),
  /** Personas del equipo que lo reciben (owner o manager activos). */
  recipientUids: z.array(z.string().min(1).max(128)).min(1).max(10),
  /** `previous`: el día anterior (por la mañana); `same`: el propio día (por la noche, tras cerrar). */
  covers: z.enum(["previous", "same"]),
})
export type DailySummarySettings = z.infer<typeof DailySummarySettingsSchema>

/** Día que resume un envío hecho en `now`, o null si aún no es la hora de ese día. */
export function dailySummaryDate(now: number, timezone: string, settings: Pick<DailySummarySettings, "enabled" | "hour" | "covers">): Fecha | null {
  if (!settings.enabled) return null
  const { fecha, minutos } = horaLocal(now, timezone)
  if (minutos < horaAMinutos(settings.hour)) return null
  return settings.covers === "previous" ? sumarDias(fecha, -1) : fecha
}

/** Id determinista: un resumen por día, persona y canal aunque el proceso pase varias veces. */
export const dailySummaryMessageId = (date: Fecha, uid: string, channel: "email" | "whatsapp") => `daily-summary.${date}.${uid}.${channel}`

export interface DailySummary {
  date: Fecha
  restaurantName: string
  totals: MetricTotals
  /** Mismo día de la semana anterior; null si no hay base. */
  previous: MetricTotals | null
  today: { reservations: number; covers: number; pending: number }
  /** Avisos abiertos que conviene mirar: stock bajo, fichajes olvidados, recomendaciones. */
  alerts: readonly string[]
}

const pct = (bp: number | null) => (bp === null ? "sin datos" : `${(bp / 100).toFixed(1).replace(".", ",")} %`)
const delta = (bp: number | null) => (bp === null ? "" : ` (${bp >= 0 ? "+" : ""}${(bp / 100).toFixed(0)} % frente a hace una semana)`)

/** Texto llano en castellano para el mensaje. */
export function renderDailySummary(s: DailySummary): string {
  const c = comparePeriods(s.totals, s.previous)
  const money = (v: number | null) => (v === null ? "sin datos" : formatMoney(v))
  const lines = [
    `Resumen del ${s.date}`,
    `Ventas: ${money(c.grossSalesCents.current)}${delta(c.grossSalesCents.deltaBp)}`,
    `Cuentas: ${s.totals.bills} · comensales: ${s.totals.guests} · ticket medio: ${money(c.averageTicketCents.current)}`,
    `Ocupación: ${pct(c.occupancyBp.current)} · no presentados: ${s.totals.noShows} (${pct(c.noShowBp.current)})`,
    s.totals.refundCents > 0 ? `Devoluciones: ${money(s.totals.refundCents)}` : "",
    `Hoy: ${s.today.reservations} reservas, ${s.today.covers} comensales${s.today.pending > 0 ? `, ${s.today.pending} por confirmar` : ""}`,
    ...s.alerts.slice(0, 5).map((a) => `Aviso: ${a}`),
  ]
  return lines.filter(Boolean).join("\n")
}
