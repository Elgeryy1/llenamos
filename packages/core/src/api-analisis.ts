/**
 * Callables del panel de análisis, previsión, resumen diario y automatizaciones (fase 5).
 *
 * Los cálculos son del servidor con `analisis/` de core sobre instantáneas diarias
 * (`analyticsDays`) y lo vivo de hoy. Quien tiene `locationIds` solo ve sus locales; pedir uno
 * ajeno es `permission-denied`. El margen solo sale con `costes.ver` y el módulo `inventory`.
 * Periodos de como mucho 366 días; la exportación, 92.
 */
import { z } from "zod"
import { AmountCentsSchema, SignedCentsSchema } from "./caja/modelo"
import { DocIdSchema } from "./model"
import type { Module } from "./modules"
import { FechaSchema, sumarDias } from "./reservas/tiempo"
import { MillisSchema } from "./timestamp"
import type { Fase5Permission } from "./api-fidelizacion"
import { AutomationEventInstanceSchema, AutomationRuleInputSchema, RECOMMENDATIONS } from "./analisis/automatizaciones"
import { DailySummarySettingsSchema } from "./analisis/resumen"

const Rid = { restaurantId: DocIdSchema }
const RMutation = { ...Rid, requestId: DocIdSchema }
const Scope = { restaurantId: DocIdSchema, locationId: DocIdSchema }
const Ok = z.literal(true)
const Revision = z.number().int().min(1)
const Count = z.number().int().min(0)
const Bp = z.number().int()
const maxDays = (max: number) => (v: { from: string; to: string }) => v.from <= v.to && sumarDias(v.from, max - 1) >= v.to

export const AnalyticsSettingsSchema = z.strictObject({
  dailySummary: DailySummarySettingsSchema,
  /** Umbrales de los eventos de previsión para las automatizaciones, en puntos básicos. */
  forecast: z.strictObject({ lowOccupancyBp: z.number().int().min(0).max(10_000), highOccupancyBp: z.number().int().min(0).max(10_000), daysAhead: z.number().int().min(1).max(14) })
    .refine((v) => v.lowOccupancyBp < v.highOccupancyBp, "El umbral bajo debe ser menor que el alto."),
  /** Días sin venir para el evento `customer.lapsed`. */
  lapsedAfterDays: z.number().int().min(7).max(365),
})
export type AnalyticsSettings = z.infer<typeof AnalyticsSettingsSchema>

const Metrics = z.object({
  grossSalesCents: AmountCentsSchema, netSalesCents: SignedCentsSchema, refundCents: AmountCentsSchema, discountCents: AmountCentsSchema,
  bills: Count, guests: Count,
  averageTicketCents: AmountCentsSchema.nullable(), averagePerGuestCents: AmountCentsSchema.nullable(),
  rotationBp: Bp.nullable(), revenuePerSeatHourCents: AmountCentsSchema.nullable(), occupancyBp: Bp.nullable(),
  noShowBp: Bp.nullable(), noShows: Count, noShowCovers: Count,
})
const Comparison = z.object({ current: z.number().int().nullable(), previous: z.number().int().nullable(), delta: z.number().int().nullable(), deltaBp: z.number().int().nullable() })

export const PanelAnalisisInputSchema = z.strictObject({
  ...Rid, from: FechaSchema, to: FechaSchema,
  /** null = todos los locales a los que tiene acceso quien pregunta. */
  locationIds: z.array(DocIdSchema).min(1).max(50).nullable(),
  compare: z.enum(["previous", "none"]).default("previous"),
  slotMinutes: z.union([z.literal(15), z.literal(30), z.literal(60)]).default(60),
}).refine(maxDays(366), "Elige un periodo de como mucho un año, en orden.")
export const PanelAnalisisOutputSchema = z.object({
  from: FechaSchema, to: FechaSchema,
  total: Metrics,
  /** Contra el periodo anterior de la misma longitud; null con `compare: none` o sin base. */
  comparison: z.record(z.string(), Comparison).nullable(),
  byLocation: z.array(z.object({ locationId: DocIdSchema, metrics: Metrics, salesShareBp: Bp.nullable() })),
  byDay: z.array(z.object({ date: FechaSchema, metrics: Metrics })),
  hours: z.object({
    slots: z.array(z.object({ slot: z.string(), guests: Count, bills: Count, salesCents: AmountCentsSchema, reservations: Count, reservationCovers: Count })),
    peak: z.string().nullable(),
  }),
  dishes: z.object({
    top: z.array(z.object({ itemId: DocIdSchema, name: z.string(), units: Count, unitsInMenu: Count, salesCents: AmountCentsSchema })).max(20),
    bottom: z.array(z.object({ itemId: DocIdSchema, name: z.string(), units: Count, unitsInMenu: Count, salesCents: AmountCentsSchema })).max(20),
    zeroSales: z.array(z.object({ itemId: DocIdSchema, name: z.string() })).max(200),
  }),
  /** Solo con `costes.ver` e `inventory`; si no, null. */
  margin: z.object({ netCents: AmountCentsSchema, coveredNetCents: AmountCentsSchema, costCents: AmountCentsSchema, marginCents: SignedCentsSchema, marginBp: Bp.nullable(), coverageBp: Bp.nullable(), wasteCostCents: AmountCentsSchema }).nullable(),
  /** Hasta cuándo están calculados los días (los de hoy se calculan al momento). */
  computedAt: MillisSchema,
})

export const EXPORT_KINDS = ["sales_by_day", "dishes", "hours", "locations", "origins"] as const
export const ExportarAnalisisInputSchema = z.strictObject({ ...Rid, from: FechaSchema, to: FechaSchema, locationIds: z.array(DocIdSchema).min(1).max(50).nullable(), kind: z.enum(EXPORT_KINDS) })
  .refine(maxDays(92), "Exporta como mucho 92 días, en orden.")
export const ExportarAnalisisOutputSchema = z.object({ filename: z.string(), csv: z.string().max(5_000_000), rows: Count })

export const GuardarConfiguracionAnalisisInputSchema = z.strictObject({ ...RMutation, settings: AnalyticsSettingsSchema })
export const GuardarConfiguracionAnalisisOutputSchema = z.object({ ok: Ok })

export const PrevisionOcupacionInputSchema = z.strictObject({ ...Scope, from: FechaSchema, days: z.number().int().min(1).max(14) })
export const PrevisionOcupacionOutputSchema = z.object({
  seats: Count,
  days: z.array(z.object({
    date: FechaSchema, samples: Count, sampleDates: z.array(FechaSchema), confidence: z.enum(["low", "medium", "high"]), volatile: z.boolean(),
    slots: z.array(z.object({ slot: z.string(), minutes: Count, expected: Count, booked: Count, projected: Count, occupancyBp: Bp.nullable() })),
    peak: z.string().nullable(),
  })),
})

export const VerResumenDiarioInputSchema = z.strictObject({ ...Rid, date: FechaSchema })
export const VerResumenDiarioOutputSchema = z.object({ date: FechaSchema, text: z.string(), sentTo: z.array(z.object({ uid: z.string(), channel: z.enum(["email", "whatsapp"]), status: z.string() })) })

export const GuardarAutomatizacionInputSchema = z.strictObject({ ...RMutation, ruleId: DocIdSchema.nullable(), expectedRevision: Revision.nullable(), rule: AutomationRuleInputSchema })
export const GuardarAutomatizacionOutputSchema = z.object({ ruleId: DocIdSchema, revision: Revision })
export const BorrarAutomatizacionInputSchema = z.strictObject({ ...RMutation, ruleId: DocIdSchema, expectedRevision: Revision })
export const BorrarAutomatizacionOutputSchema = z.object({ ok: Ok })
/** Prueba una regla contra los eventos guardados del periodo (como mucho 92 días). No escribe. */
export const SimularAutomatizacionInputSchema = z.strictObject({ ...Rid, rule: AutomationRuleInputSchema, from: FechaSchema, to: FechaSchema })
  .refine(maxDays(92), "Simula como mucho 92 días, en orden.")
export const SimularAutomatizacionOutputSchema = z.object({
  events: Count,
  fired: z.array(z.object({ eventId: z.string(), subject: z.string(), at: MillisSchema })).max(500),
  skipped: z.object({ event: Count, location: Count, conditions: Count, cooldown: Count }),
  sample: z.array(AutomationEventInstanceSchema).max(20),
})
/** Aceptar o descartar no ejecuta nada: queda registrado quién y cuándo. */
export const ResolverRecomendacionInputSchema = z.strictObject({ ...RMutation, recommendationId: z.string().min(1).max(300), decision: z.enum(["accepted", "dismissed"]), note: z.string().trim().max(200).nullable() })
export const ResolverRecomendacionOutputSchema = z.object({ status: z.enum(["accepted", "dismissed"]), kind: z.enum(RECOMMENDATIONS) })

export const CALLABLES_FASE5_ANALISIS = {
  panelAnalisis: "panelAnalisis",
  exportarAnalisis: "exportarAnalisis",
  guardarConfiguracionAnalisis: "guardarConfiguracionAnalisis",
  previsionOcupacion: "previsionOcupacion",
  verResumenDiario: "verResumenDiario",
  guardarAutomatizacion: "guardarAutomatizacion",
  borrarAutomatizacion: "borrarAutomatizacion",
  simularAutomatizacion: "simularAutomatizacion",
  resolverRecomendacion: "resolverRecomendacion",
} as const

export const CALLABLE_SCHEMAS_FASE5_ANALISIS = {
  panelAnalisis: { input: PanelAnalisisInputSchema, output: PanelAnalisisOutputSchema },
  exportarAnalisis: { input: ExportarAnalisisInputSchema, output: ExportarAnalisisOutputSchema },
  guardarConfiguracionAnalisis: { input: GuardarConfiguracionAnalisisInputSchema, output: GuardarConfiguracionAnalisisOutputSchema },
  previsionOcupacion: { input: PrevisionOcupacionInputSchema, output: PrevisionOcupacionOutputSchema },
  verResumenDiario: { input: VerResumenDiarioInputSchema, output: VerResumenDiarioOutputSchema },
  guardarAutomatizacion: { input: GuardarAutomatizacionInputSchema, output: GuardarAutomatizacionOutputSchema },
  borrarAutomatizacion: { input: BorrarAutomatizacionInputSchema, output: BorrarAutomatizacionOutputSchema },
  simularAutomatizacion: { input: SimularAutomatizacionInputSchema, output: SimularAutomatizacionOutputSchema },
  resolverRecomendacion: { input: ResolverRecomendacionInputSchema, output: ResolverRecomendacionOutputSchema },
} as const satisfies Record<keyof typeof CALLABLES_FASE5_ANALISIS, { input: z.ZodType; output: z.ZodType }>

export const FASE5_ANALISIS_ACCESS: Record<keyof typeof CALLABLES_FASE5_ANALISIS, { permission: Fase5Permission; modules: readonly Module[] }> = {
  panelAnalisis: { permission: "analisis.ver", modules: ["analytics"] },
  exportarAnalisis: { permission: "analisis.ver", modules: ["analytics"] },
  guardarConfiguracionAnalisis: { permission: "analisis.configurar", modules: ["analytics"] },
  previsionOcupacion: { permission: "analisis.ver", modules: ["analytics", "reservations"] },
  verResumenDiario: { permission: "analisis.ver", modules: ["analytics"] },
  guardarAutomatizacion: { permission: "analisis.configurar", modules: ["analytics"] },
  borrarAutomatizacion: { permission: "analisis.configurar", modules: ["analytics"] },
  simularAutomatizacion: { permission: "analisis.configurar", modules: ["analytics"] },
  resolverRecomendacion: { permission: "analisis.ver", modules: ["analytics"] },
}
