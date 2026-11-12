/**
 * Automatizaciones «cuando pase X, haz Y» (fase 5). **En esta fase solo recomiendan**: una regla
 * que se cumple crea una recomendación visible para el encargado, que la acepta o la descarta.
 * Aceptar no ejecuta nada por sí solo (no lanza campañas, no pide a proveedores, no cambia
 * reservas): enlaza con la pantalla donde se hace a mano. Ejecutar de verdad exige ejecutores
 * idempotentes, aprobación que ejecuta y reversión, que quedan para más adelante.
 *
 * Cada regla tiene evento, condiciones (anidadas como mucho a dos niveles), recomendación y
 * enfriamiento. `simulateRule` la prueba contra eventos pasados sin escribir nada. El servidor
 * registra cada disparo con id determinista `{ruleId}.{eventId}` para no repetirlo.
 */
import { z } from "zod"
import { DocIdSchema } from "../model"
import { MillisSchema, TimestampSchema } from "../timestamp"

/** Eventos y los campos numéricos o de texto que cada uno ofrece a las condiciones. */
export const AUTOMATION_EVENTS = {
  "reservation.no_show": ["partySize", "customerNoShows", "hasDeposit"],
  "reservation.cancelled": ["partySize", "hoursBeforeStart"],
  "forecast.low_occupancy": ["occupancyBp", "daysAhead", "confidence"],
  "forecast.high_occupancy": ["occupancyBp", "daysAhead", "confidence"],
  "stock.low": ["level", "daysToRunOut"],
  "customer.lapsed": ["daysSinceVisit", "visits", "spentCents"],
  "day.closed": ["grossSalesCents", "salesDeltaBp", "noShowBp", "occupancyBp"],
} as const satisfies Record<string, readonly string[]>
export type AutomationEvent = keyof typeof AUTOMATION_EVENTS
export const AUTOMATION_EVENT_NAMES = Object.keys(AUTOMATION_EVENTS) as AutomationEvent[]

export const AUTOMATION_EVENT_LABEL: Record<AutomationEvent, string> = {
  "reservation.no_show": "Una reserva no se presenta",
  "reservation.cancelled": "Se cancela una reserva",
  "forecast.low_occupancy": "La previsión de un día sale baja",
  "forecast.high_occupancy": "La previsión de un día sale alta",
  "stock.low": "Un ingrediente baja del mínimo",
  "customer.lapsed": "Un cliente lleva tiempo sin venir",
  "day.closed": "Se cierra un día de servicio",
}

export const RECOMMENDATIONS = ["require_deposit", "contact_customer", "launch_campaign", "open_waitlist", "adjust_staffing", "review_stock", "review_day"] as const
export type RecommendationKind = (typeof RECOMMENDATIONS)[number]
export const RECOMMENDATION_LABEL: Record<RecommendationKind, string> = {
  require_deposit: "Pedir señal a este cliente la próxima vez",
  contact_customer: "Llamar o escribir al cliente",
  launch_campaign: "Preparar una campaña para ese segmento",
  open_waitlist: "Abrir la lista de espera para ese día",
  adjust_staffing: "Revisar el cuadrante de ese día",
  review_stock: "Revisar existencias y pedido a proveedor",
  review_day: "Revisar las cifras del día",
}

const Value = z.union([z.number().int(), z.string().max(40), z.boolean()])
export const ComparisonSchema = z.strictObject({
  field: z.string().min(1).max(40),
  op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in"]),
  value: z.union([Value, z.array(Value).max(10)]),
})
export type Comparison = z.infer<typeof ComparisonSchema>
export type ConditionGroup = { all: (Comparison | ConditionGroup)[] } | { any: (Comparison | ConditionGroup)[] }
const Leaf = ComparisonSchema
const Inner = z.union([z.strictObject({ all: z.array(Leaf).min(1).max(10) }), z.strictObject({ any: z.array(Leaf).min(1).max(10) })])
export const ConditionGroupSchema: z.ZodType<ConditionGroup> = z.union([
  z.strictObject({ all: z.array(z.union([Leaf, Inner])).max(10) }),
  z.strictObject({ any: z.array(z.union([Leaf, Inner])).min(1).max(10) }),
])

export const AutomationRuleInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean(),
  event: z.enum(AUTOMATION_EVENT_NAMES as [AutomationEvent, ...AutomationEvent[]]),
  conditions: ConditionGroupSchema,
  recommendation: z.strictObject({
    kind: z.enum(RECOMMENDATIONS),
    /** Texto propio del encargado; si falta, el de la lista. */
    note: z.string().trim().max(200).nullable(),
    /** Segmento para `launch_campaign`. */
    segmentId: DocIdSchema.nullable(),
  }),
  /** Minutos sin volver a recomendar lo mismo para la misma cosa (cliente, día o ingrediente). */
  cooldownMinutes: z.number().int().min(0).max(60 * 24 * 90),
  /** Vacío = todos los locales. */
  locationIds: z.array(DocIdSchema).max(50),
}).superRefine((v, ctx) => {
  const fields = AUTOMATION_EVENTS[v.event] as readonly string[]
  const walk = (g: ConditionGroup | Comparison, depth: number) => {
    if ("field" in g) {
      if (!fields.includes(g.field)) ctx.addIssue({ code: "custom", path: ["conditions"], message: `El evento no tiene el dato «${g.field}».` })
      return
    }
    if (depth > 2) ctx.addIssue({ code: "custom", path: ["conditions"], message: "Como mucho dos niveles de condiciones." })
    for (const c of "all" in g ? g.all : g.any) walk(c, depth + 1)
  }
  walk(v.conditions, 1)
  if (v.recommendation.kind === "launch_campaign" && v.recommendation.segmentId === null) ctx.addIssue({ code: "custom", path: ["recommendation", "segmentId"], message: "Elige el segmento de la campaña." })
})
export type AutomationRuleInput = z.output<typeof AutomationRuleInputSchema>
export type AutomationRule = AutomationRuleInput & { id: string; revision: number }

export const AutomationEventInstanceSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.enum(AUTOMATION_EVENT_NAMES as [AutomationEvent, ...AutomationEvent[]]),
  locationId: DocIdSchema.nullable(),
  /** Lo que se recomienda «para qué»: cliente, día o ingrediente; agrupa el enfriamiento. */
  subject: z.string().min(1).max(200),
  at: MillisSchema,
  data: z.record(z.string(), Value),
})
export type AutomationEventInstance = z.infer<typeof AutomationEventInstanceSchema>

function compare(actual: z.infer<typeof Value> | undefined, c: Comparison): boolean {
  if (actual === undefined) return false
  if (c.op === "in") return Array.isArray(c.value) && c.value.includes(actual)
  if (Array.isArray(c.value)) return false
  if (c.op === "eq") return actual === c.value
  if (c.op === "neq") return actual !== c.value
  if (typeof actual !== "number" || typeof c.value !== "number") return false
  if (c.op === "gt") return actual > c.value
  if (c.op === "gte") return actual >= c.value
  if (c.op === "lt") return actual < c.value
  return actual <= c.value
}

export function conditionsMatch(g: ConditionGroup | Comparison, data: AutomationEventInstance["data"]): boolean {
  if ("field" in g) return compare(data[g.field], g)
  if ("all" in g) return g.all.every((c) => conditionsMatch(c, data))
  return g.any.some((c) => conditionsMatch(c, data))
}

export type RuleDecision = { fire: true } | { fire: false; reason: "disabled" | "event" | "location" | "conditions" | "cooldown" }

/** ¿Recomienda esta regla ante este evento? `lastFiredAt`: último disparo para el mismo asunto. */
export function evaluateRule(rule: Pick<AutomationRule, "enabled" | "event" | "conditions" | "cooldownMinutes" | "locationIds">, event: AutomationEventInstance, lastFiredAt: number | null): RuleDecision {
  if (!rule.enabled) return { fire: false, reason: "disabled" }
  if (rule.event !== event.type) return { fire: false, reason: "event" }
  if (rule.locationIds.length > 0 && (event.locationId === null || !rule.locationIds.includes(event.locationId))) return { fire: false, reason: "location" }
  if (!conditionsMatch(rule.conditions, event.data)) return { fire: false, reason: "conditions" }
  if (lastFiredAt !== null && event.at - lastFiredAt < rule.cooldownMinutes * 60_000) return { fire: false, reason: "cooldown" }
  return { fire: true }
}

/** Id del disparo y de la recomendación: el mismo evento nunca recomienda dos veces. */
export const automationFiringId = (ruleId: string, eventId: string) => `${ruleId}.${eventId}`

/**
 * Prueba una regla (aunque esté apagada) contra eventos pasados, en orden, respetando el
 * enfriamiento por asunto. No escribe nada: devuelve lo que habría recomendado.
 */
export function simulateRule(rule: Pick<AutomationRule, "event" | "conditions" | "cooldownMinutes" | "locationIds">, events: readonly AutomationEventInstance[]): { fired: { eventId: string; subject: string; at: number }[]; skipped: Record<"event" | "location" | "conditions" | "cooldown", number> } {
  const last = new Map<string, number>()
  const fired: { eventId: string; subject: string; at: number }[] = []
  const skipped = { event: 0, location: 0, conditions: 0, cooldown: 0 }
  for (const e of [...events].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))) {
    const d = evaluateRule({ ...rule, enabled: true }, e, last.get(e.subject) ?? null)
    if (d.fire) {
      fired.push({ eventId: e.id, subject: e.subject, at: e.at })
      last.set(e.subject, e.at)
    } else if (d.reason !== "disabled") skipped[d.reason] += 1
  }
  return { fired, skipped }
}

export const RECOMMENDATION_STATUSES = ["open", "accepted", "dismissed", "expired"] as const
/** `recommendations/{firingId}` (solo servidor). Aceptar o descartar no ejecuta nada. */
export const RecommendationSchema = z.object({
  ruleId: DocIdSchema,
  eventId: z.string(),
  eventType: z.enum(AUTOMATION_EVENT_NAMES as [AutomationEvent, ...AutomationEvent[]]),
  locationId: DocIdSchema.nullable(),
  subject: z.string(),
  kind: z.enum(RECOMMENDATIONS),
  text: z.string().max(300),
  /** Por qué: los datos del evento que cumplieron las condiciones, sin datos personales. */
  evidence: z.record(z.string(), Value),
  status: z.enum(RECOMMENDATION_STATUSES),
  createdAt: TimestampSchema,
  /** Pasado este instante sin decidir, pasa a `expired`. */
  expiresAt: TimestampSchema,
  decidedBy: z.string().nullable(),
  decidedAt: TimestampSchema.nullable(),
  note: z.string().max(200).nullable(),
})
export type Recommendation = z.infer<typeof RecommendationSchema>
export const RECOMMENDATION_TRANSITIONS: Record<Recommendation["status"], readonly Recommendation["status"][]> = {
  open: ["accepted", "dismissed", "expired"], accepted: [], dismissed: [], expired: [],
}
