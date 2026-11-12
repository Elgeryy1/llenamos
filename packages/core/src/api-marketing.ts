/**
 * Callables de campañas y origen de las reservas (fase 5). Región europe-west1.
 *
 * Ninguna devuelve teléfonos ni correos: los recuentos y las muestras llevan solo nombre e id del
 * cliente. Ninguna envía nada al momento: lanzar programa, y el trabajador encola por páginas con
 * la comprobación de consentimiento y de frecuencia en cada transacción.
 */
import { z } from "zod"
import { CustomerIdSchema, LinkTokenSchema } from "./ids"
import { DocIdSchema, SlugSchema } from "./model"
import type { Module } from "./modules"
import { FechaSchema } from "./reservas/tiempo"
import { MillisSchema } from "./timestamp"
import type { Fase5Permission } from "./api-fidelizacion"
import {
  CAMPAIGN_CHANNELS, CAMPAIGN_EXCLUSIONS, CAMPAIGN_STATUSES, CampaignInputSchema, MarketingSettingsSchema, SegmentInputSchema, SegmentRuleSchema,
} from "./marketing/campanas"
import { OriginChannelSchema } from "./marketing/origen"

const Rid = { restaurantId: DocIdSchema }
const RMutation = { ...Rid, requestId: DocIdSchema }
const Ok = z.literal(true)
const Reason = z.string().trim().min(1, "Escribe el motivo.").max(200)
const Revision = z.number().int().min(1)
const Count = z.number().int().min(0)
const Period = { from: FechaSchema, to: FechaSchema }
const periodOk = (v: { from: string; to: string }) => v.from <= v.to
const ExclusionCounts = z.object(Object.fromEntries(CAMPAIGN_EXCLUSIONS.map((k) => [k, Count])) as Record<(typeof CAMPAIGN_EXCLUSIONS)[number], typeof Count>)

export const GuardarConfiguracionMarketingInputSchema = z.strictObject({ ...RMutation, settings: MarketingSettingsSchema })
export const GuardarConfiguracionMarketingOutputSchema = z.object({ ok: Ok })

export const GuardarSegmentoInputSchema = z.strictObject({ ...RMutation, segmentId: DocIdSchema.nullable(), expectedRevision: Revision.nullable(), segment: SegmentInputSchema })
export const GuardarSegmentoOutputSchema = z.object({ segmentId: DocIdSchema, revision: Revision })
export const BorrarSegmentoInputSchema = z.strictObject({ ...RMutation, segmentId: DocIdSchema, expectedRevision: Revision })
export const BorrarSegmentoOutputSchema = z.object({ ok: Ok })

/** Cuántos clientes entran por canal y por qué se quedan fuera. Sin contactos. */
export const PrevisualizarSegmentoInputSchema = z.strictObject({ ...Rid, rule: SegmentRuleSchema, channel: z.enum(CAMPAIGN_CHANNELS) })
export const PrevisualizarSegmentoOutputSchema = z.object({
  audience: Count, recipients: Count, excluded: ExclusionCounts,
  sample: z.array(z.object({ customerId: CustomerIdSchema, name: z.string() })).max(20),
})

export const GuardarCampanaInputSchema = z.strictObject({ ...RMutation, campaignId: DocIdSchema.nullable(), expectedRevision: Revision.nullable(), campaign: CampaignInputSchema })
export const GuardarCampanaOutputSchema = z.object({ campaignId: DocIdSchema, revision: Revision })
/** Simulación: audiencia, exclusiones y vista del mensaje como le llegaría a un cliente de muestra. */
export const SimularCampanaInputSchema = z.strictObject({ ...Rid, campaignId: DocIdSchema })
export const SimularCampanaOutputSchema = z.object({
  audience: Count, recipients: Count, excluded: ExclusionCounts,
  preview: z.object({ subject: z.string().nullable(), body: z.string() }),
  /** Primer momento de envío dentro de la ventana permitida. */
  firstSendAt: MillisSchema,
})
/** Solo el propietario (`campanas.lanzar`). `at` null = en cuanto se abra la ventana de envío. */
export const LanzarCampanaInputSchema = z.strictObject({ ...RMutation, campaignId: DocIdSchema, expectedRevision: Revision, at: MillisSchema.nullable() })
export const LanzarCampanaOutputSchema = z.object({ revision: Revision, status: z.enum(CAMPAIGN_STATUSES), scheduledAt: MillisSchema })
/** Cancela una programada o la parte aún en cola de una que se está enviando. */
export const CancelarCampanaInputSchema = z.strictObject({ ...RMutation, campaignId: DocIdSchema, expectedRevision: Revision, reason: Reason })
export const CancelarCampanaOutputSchema = z.object({ revision: Revision, cancelledMessages: Count })
export const InformeCampanaInputSchema = z.strictObject({ ...Rid, campaignId: DocIdSchema })
export const InformeCampanaOutputSchema = z.object({
  status: z.enum(CAMPAIGN_STATUSES),
  audience: Count, queued: Count, sent: Count, captured: Count, notConfigured: Count, failed: Count, cancelled: Count, excluded: ExclusionCounts,
  /** Bajas que llegaron desde los mensajes de esta campaña. */
  unsubscribed: Count,
  /** Reservas con `llc` de esta campaña, sus comensales, presentados y ventas cobradas. */
  reservations: Count, covers: Count, seated: Count, salesCents: Count,
})

/** Pública: baja desde el enlace del mensaje. Responde igual exista o no el token. */
export const DarseDeBajaInputSchema = z.strictObject({ slug: SlugSchema, token: LinkTokenSchema, website: z.string().max(0).default("") })
export const DarseDeBajaOutputSchema = z.object({ ok: Ok })

export const InformeOrigenInputSchema = z.strictObject({ ...Rid, ...Period, locationIds: z.array(DocIdSchema).max(50).nullable() }).refine(periodOk, "El periodo está al revés.")
export const InformeOrigenOutputSchema = z.object({
  rows: z.array(z.object({
    channel: OriginChannelSchema, campaignId: DocIdSchema.nullable(), adId: z.string().nullable(),
    reservations: Count, covers: Count, seated: Count, noShows: Count, cancelled: Count, salesCents: Count,
  })),
  /** Reservas sin origen guardado (anteriores a la fase 5). */
  withoutOrigin: Count,
})

export const CALLABLES_FASE5_MARKETING = {
  guardarConfiguracionMarketing: "guardarConfiguracionMarketing",
  guardarSegmento: "guardarSegmento",
  borrarSegmento: "borrarSegmento",
  previsualizarSegmento: "previsualizarSegmento",
  guardarCampana: "guardarCampana",
  simularCampana: "simularCampana",
  lanzarCampana: "lanzarCampana",
  cancelarCampana: "cancelarCampana",
  informeCampana: "informeCampana",
  darseDeBaja: "darseDeBaja",
  informeOrigen: "informeOrigen",
} as const

export const CALLABLE_SCHEMAS_FASE5_MARKETING = {
  guardarConfiguracionMarketing: { input: GuardarConfiguracionMarketingInputSchema, output: GuardarConfiguracionMarketingOutputSchema },
  guardarSegmento: { input: GuardarSegmentoInputSchema, output: GuardarSegmentoOutputSchema },
  borrarSegmento: { input: BorrarSegmentoInputSchema, output: BorrarSegmentoOutputSchema },
  previsualizarSegmento: { input: PrevisualizarSegmentoInputSchema, output: PrevisualizarSegmentoOutputSchema },
  guardarCampana: { input: GuardarCampanaInputSchema, output: GuardarCampanaOutputSchema },
  simularCampana: { input: SimularCampanaInputSchema, output: SimularCampanaOutputSchema },
  lanzarCampana: { input: LanzarCampanaInputSchema, output: LanzarCampanaOutputSchema },
  cancelarCampana: { input: CancelarCampanaInputSchema, output: CancelarCampanaOutputSchema },
  informeCampana: { input: InformeCampanaInputSchema, output: InformeCampanaOutputSchema },
  darseDeBaja: { input: DarseDeBajaInputSchema, output: DarseDeBajaOutputSchema },
  informeOrigen: { input: InformeOrigenInputSchema, output: InformeOrigenOutputSchema },
} as const satisfies Record<keyof typeof CALLABLES_FASE5_MARKETING, { input: z.ZodType; output: z.ZodType }>

/** `darseDeBaja` es pública y no exige módulo: darse de baja funciona siempre. */
export const FASE5_MARKETING_ACCESS: Record<keyof typeof CALLABLES_FASE5_MARKETING, { permission: Fase5Permission; modules: readonly Module[] }> = {
  guardarConfiguracionMarketing: { permission: "campanas.gestionar", modules: ["marketing"] },
  guardarSegmento: { permission: "campanas.gestionar", modules: ["marketing"] },
  borrarSegmento: { permission: "campanas.gestionar", modules: ["marketing"] },
  previsualizarSegmento: { permission: "campanas.gestionar", modules: ["marketing"] },
  guardarCampana: { permission: "campanas.gestionar", modules: ["marketing"] },
  simularCampana: { permission: "campanas.gestionar", modules: ["marketing"] },
  lanzarCampana: { permission: "campanas.lanzar", modules: ["marketing"] },
  cancelarCampana: { permission: "campanas.gestionar", modules: ["marketing"] },
  informeCampana: { permission: "campanas.gestionar", modules: ["marketing"] },
  darseDeBaja: { permission: "public", modules: [] },
  informeOrigen: { permission: "analisis.ver", modules: ["marketing"] },
}
