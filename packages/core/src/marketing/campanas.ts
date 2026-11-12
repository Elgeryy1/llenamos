/**
 * Segmentos y campañas con permiso (fase 5).
 *
 * Una campaña solo se manda a quien tiene un consentimiento vigente para ese canal
 * (`marketing_email` o `marketing_whatsapp`, fase 6: `hasCurrentConsent`), nunca a quien lo retiró
 * o se dio de baja, ni a un cliente suprimido por privacidad. El servidor lo comprueba al preparar
 * la audiencia, al encolar (`assertMarketingConsent` en la transacción) y otra vez al enviar.
 * Además hay un límite de frecuencia por cliente y unas horas en que no se manda nada.
 */
import { z } from "zod"
import { DocIdSchema, LanguageSchema } from "../model"
import { hasCurrentConsent, type Consent } from "../plataforma/privacidad"
import { HoraSchema, horaAMinutos, horaLocal, instanteDeHoraLocal, sumarDias } from "../reservas/tiempo"
import { MillisSchema, TimestampSchema } from "../timestamp"

const DAY_MS = 86_400_000
const Revision = z.number().int().min(1)

/* Ajustes ---------------------------------------------------------------------- */

export const MarketingSettingsSchema = z.strictObject({
  /** Como mucho estos mensajes de marketing por cliente en 30 días, sumando canales. */
  maxPer30Days: z.number().int().min(1).max(8),
  /** Horas mínimas entre dos mensajes de marketing al mismo cliente. */
  minHoursBetween: z.number().int().min(24).max(720),
  /** Solo se envía entre estas horas locales; fuera, se espera a la siguiente ventana. */
  sendWindow: z.strictObject({ from: HoraSchema, to: HoraSchema }).refine((v) => horaAMinutos(v.from) < horaAMinutos(v.to), "La ventana debe empezar antes de acabar."),
  /** Nombre que firma los mensajes. */
  senderName: z.string().trim().min(1).max(60),
})
export type MarketingSettings = z.infer<typeof MarketingSettingsSchema>
export function defaultMarketingSettings(senderName: string): MarketingSettings {
  return { maxPer30Days: 2, minHoursBetween: 72, sendWindow: { from: "10:00", to: "21:00" }, senderName: senderName.slice(0, 60) || "Restaurante" }
}

/* Segmentos -------------------------------------------------------------------- */

/** Condiciones sobre la ficha de cliente: todas deben cumplirse. null = sin condición. */
export const SegmentRuleSchema = z.strictObject({
  minVisits: z.number().int().min(0).max(10_000).nullable(),
  maxVisits: z.number().int().min(0).max(10_000).nullable(),
  /** Última visita hace al menos N días («te echamos de menos»). */
  lastVisitAtLeastDaysAgo: z.number().int().min(1).max(3650).nullable(),
  /** Última visita hace como mucho N días (clientes recientes). */
  lastVisitAtMostDaysAgo: z.number().int().min(1).max(3650).nullable(),
  /** Incluir a quien nunca ha venido (sin `lastVisitAt`). */
  includeNeverVisited: z.boolean(),
  maxNoShows: z.number().int().min(0).max(1000).nullable(),
  minSpentCents: z.number().int().min(0).nullable(),
  tagsAny: z.array(z.string().trim().min(1).max(30)).max(20),
  tagsNone: z.array(z.string().trim().min(1).max(30)).max(20),
  languages: z.array(LanguageSchema).max(3),
  /** Puntos de fidelidad mínimos (módulo `loyalty`). */
  minPoints: z.number().int().min(0).nullable(),
}).superRefine((v, ctx) => {
  if (v.minVisits !== null && v.maxVisits !== null && v.minVisits > v.maxVisits) ctx.addIssue({ code: "custom", path: ["maxVisits"], message: "El máximo de visitas es menor que el mínimo." })
  if (v.lastVisitAtLeastDaysAgo !== null && v.lastVisitAtMostDaysAgo !== null && v.lastVisitAtLeastDaysAgo > v.lastVisitAtMostDaysAgo) ctx.addIssue({ code: "custom", path: ["lastVisitAtMostDaysAgo"], message: "Las dos condiciones de última visita no se pueden cumplir a la vez." })
})
export type SegmentRule = z.infer<typeof SegmentRuleSchema>

export const SegmentInputSchema = z.strictObject({ name: z.string().trim().min(1).max(80), rule: SegmentRuleSchema })
export const SegmentSchema = z.object({ name: z.string(), rule: SegmentRuleSchema, revision: Revision })
export type Segment = z.infer<typeof SegmentSchema>

export interface SegmentCustomer {
  customerId: string
  visits: number
  noShows: number
  lastVisitAt: number | null
  spentCents: number
  tags: readonly string[]
  language: "es" | "ca" | "en"
  points: number | null
  phone: string | null
  email: string | null
}

export function matchesSegment(c: SegmentCustomer, rule: SegmentRule, now: number): boolean {
  if (rule.minVisits !== null && c.visits < rule.minVisits) return false
  if (rule.maxVisits !== null && c.visits > rule.maxVisits) return false
  if (c.lastVisitAt === null) {
    if (!rule.includeNeverVisited) return false
  } else {
    const days = Math.floor((now - c.lastVisitAt) / DAY_MS)
    if (rule.lastVisitAtLeastDaysAgo !== null && days < rule.lastVisitAtLeastDaysAgo) return false
    if (rule.lastVisitAtMostDaysAgo !== null && days > rule.lastVisitAtMostDaysAgo) return false
  }
  if (rule.maxNoShows !== null && c.noShows > rule.maxNoShows) return false
  if (rule.minSpentCents !== null && c.spentCents < rule.minSpentCents) return false
  const tags = c.tags.map((t) => t.toLowerCase())
  if (rule.tagsAny.length > 0 && !rule.tagsAny.some((t) => tags.includes(t.toLowerCase()))) return false
  if (rule.tagsNone.some((t) => tags.includes(t.toLowerCase()))) return false
  if (rule.languages.length > 0 && !rule.languages.includes(c.language)) return false
  if (rule.minPoints !== null && (c.points ?? 0) < rule.minPoints) return false
  return true
}

/* Campañas --------------------------------------------------------------------- */

export const CAMPAIGN_CHANNELS = ["email", "whatsapp"] as const
export type CampaignChannel = (typeof CAMPAIGN_CHANNELS)[number]
export const CAMPAIGN_STATUSES = ["draft", "scheduled", "sending", "sent", "cancelled"] as const
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number]

export const CAMPAIGN_TRANSITIONS: Record<CampaignStatus, readonly CampaignStatus[]> = {
  draft: ["scheduled", "cancelled"],
  scheduled: ["draft", "sending", "cancelled"],
  sending: ["sent", "cancelled"],
  sent: [],
  cancelled: [],
}
export function canCampaignTransition(from: CampaignStatus, to: CampaignStatus): boolean {
  return CAMPAIGN_TRANSITIONS[from].includes(to)
}

export const purposeForChannel = (channel: CampaignChannel): Consent["purpose"] => (channel === "email" ? "marketing_email" : "marketing_whatsapp")

export const CampaignContentSchema = z.strictObject({
  title: z.string().trim().min(1).max(80),
  body: z.string().trim().min(1).max(1000),
  /** Con `true`, el mensaje lleva el enlace de reservas con `llc` para medir lo que trae. */
  includeBookingLink: z.boolean(),
})
export const CampaignInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  segmentId: DocIdSchema,
  channel: z.enum(CAMPAIGN_CHANNELS),
  content: CampaignContentSchema,
  /** Local cuyo enlace de reservas se usa; null = el primero del restaurante. */
  locationId: DocIdSchema.nullable(),
})
export const CampaignSchema = z.object({
  name: z.string(), segmentId: DocIdSchema, channel: z.enum(CAMPAIGN_CHANNELS),
  content: z.object({ title: z.string(), body: z.string(), includeBookingLink: z.boolean() }),
  locationId: DocIdSchema.nullable(),
  status: z.enum(CAMPAIGN_STATUSES),
  scheduledAt: TimestampSchema.nullable(),
  launchedBy: z.string().nullable(),
  /** Recuento al preparar la audiencia y al terminar (solo servidor). */
  stats: z.object({
    audience: z.number().int().min(0), queued: z.number().int().min(0), excluded: z.number().int().min(0),
    sent: z.number().int().min(0), failed: z.number().int().min(0), cancelled: z.number().int().min(0),
  }),
  /** Cursor del trabajador que prepara los mensajes por páginas. */
  cursor: z.string().nullable(),
  revision: Revision,
})
export type Campaign = z.infer<typeof CampaignSchema>

/** `campaigns/{cid}/recipients/{customerId}`: por qué entró o no cada cliente (sin contacto). */
export const CAMPAIGN_EXCLUSIONS = ["no_contact", "no_consent", "withdrawn", "suppressed", "frequency", "duplicate_contact"] as const
export type CampaignExclusion = (typeof CAMPAIGN_EXCLUSIONS)[number]
export const CAMPAIGN_EXCLUSION_LABEL: Record<CampaignExclusion, string> = {
  no_contact: "No tiene ese contacto",
  no_consent: "No ha dado permiso para ese canal",
  withdrawn: "Retiró el permiso o se dio de baja",
  suppressed: "Sus datos se borraron por privacidad",
  frequency: "Ya recibió bastantes mensajes estos días",
  duplicate_contact: "Ese contacto ya está en la campaña con otra ficha",
}
export const CampaignRecipientSchema = z.object({
  status: z.enum(["queued", "excluded", "sent", "failed", "cancelled"]),
  excludedReason: z.enum(CAMPAIGN_EXCLUSIONS).nullable(),
  messageId: DocIdSchema.nullable(),
  at: TimestampSchema,
})

/** Mensajes de marketing ya enviados o en cola a un cliente (`marketingSendLog/{customerId}`). */
export interface SendLogEntry { at: number; campaignId: string }

export function frequencyAllows(log: readonly SendLogEntry[], now: number, settings: Pick<MarketingSettings, "maxPer30Days" | "minHoursBetween">): boolean {
  const recent = log.filter((e) => e.at > now - 30 * DAY_MS && e.at <= now + 30 * DAY_MS)
  if (recent.length >= settings.maxPer30Days) return false
  return !recent.some((e) => Math.abs(now - e.at) < settings.minHoursBetween * 3_600_000)
}

/** Primer instante en que se puede enviar desde `at`: dentro de la ventana local de envío. */
export function nextSendTime(at: number, timezone: string, window: MarketingSettings["sendWindow"]): number {
  const { fecha, minutos } = horaLocal(at, timezone)
  const from = horaAMinutos(window.from)
  const to = horaAMinutos(window.to)
  if (minutos >= from && minutos < to) return at
  const day = minutos < from ? fecha : sumarDias(fecha, 1)
  const start = instanteDeHoraLocal(day, from, timezone)
  if (start === null) throw new Error("La hora de inicio no existe ese día.")
  return start
}

export interface AudienceCandidate extends SegmentCustomer {
  /** Suprimido por un borrado de privacidad (tombstone de la fase 6). */
  suppressed: boolean
}

export interface AudiencePlan {
  recipients: { customerId: string; to: string; language: "es" | "ca" | "en" }[]
  excluded: { customerId: string; reason: CampaignExclusion }[]
  counts: Record<CampaignExclusion, number> & { audience: number; recipients: number }
}

/**
 * Audiencia de una campaña: los clientes del segmento con contacto para el canal y consentimiento
 * vigente, sin bajas, sin suprimidos, sin contactos repetidos y dentro del límite de frecuencia. Lo
 * que no entra se cuenta por motivo. El servidor repite la comprobación al encolar y al enviar.
 */
export function planCampaignAudience(p: {
  candidates: readonly AudienceCandidate[]
  rule: SegmentRule
  channel: CampaignChannel
  consents: readonly Consent[]
  sendLog: ReadonlyMap<string, readonly SendLogEntry[]>
  settings: Pick<MarketingSettings, "maxPer30Days" | "minHoursBetween">
  now: number
}): AudiencePlan {
  const purpose = purposeForChannel(p.channel)
  const counts = { no_contact: 0, no_consent: 0, withdrawn: 0, suppressed: 0, frequency: 0, duplicate_contact: 0, audience: 0, recipients: 0 }
  const recipients: AudiencePlan["recipients"] = []
  const excluded: AudiencePlan["excluded"] = []
  const seen = new Set<string>()
  const ordered = [...p.candidates].sort((a, b) => a.customerId.localeCompare(b.customerId))
  for (const c of ordered) {
    if (!matchesSegment(c, p.rule, p.now)) continue
    counts.audience += 1
    const drop = (reason: CampaignExclusion) => { counts[reason] += 1; excluded.push({ customerId: c.customerId, reason }) }
    if (c.suppressed) { drop("suppressed"); continue }
    const to = p.channel === "email" ? c.email : c.phone
    if (!to) { drop("no_contact"); continue }
    if (!hasCurrentConsent(p.consents, c.customerId, purpose, p.now)) {
      // Con algún permiso vigente en el tiempo y sin consentimiento actual, lo último fue una baja.
      const everGranted = p.consents.some((e) => e.customerId === c.customerId && e.purpose === purpose && e.at <= p.now)
      drop(everGranted ? "withdrawn" : "no_consent")
      continue
    }
    const key = to.toLowerCase()
    if (seen.has(key)) { drop("duplicate_contact"); continue }
    if (!frequencyAllows(p.sendLog.get(c.customerId) ?? [], p.now, p.settings)) { drop("frequency"); continue }
    seen.add(key)
    recipients.push({ customerId: c.customerId, to, language: c.language })
  }
  counts.recipients = recipients.length
  return { recipients, excluded, counts }
}

/** Id determinista del mensaje de un cliente en una campaña: un reintento no lo duplica. */
export const campaignMessageId = (campaignId: string, customerId: string) => `campaign.${campaignId}.${customerId}`

/* Baja ------------------------------------------------------------------------- */

/**
 * `unsubscribeTokens/{sha256(token)}` (solo servidor). El token va solo en el enlace de baja
 * `/baja/{slug}?t=…` de cada mensaje. Darse de baja siempre funciona, también con el módulo
 * apagado, y escribe un `Consent` `withdrawn` con `source: "public"` y el mensaje como evidencia.
 */
export const UnsubscribeTokenSchema = z.object({
  customerId: DocIdSchema,
  purpose: z.enum(["marketing_email", "marketing_whatsapp"]),
  messageId: DocIdSchema,
  campaignId: DocIdSchema.nullable(),
  usedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
})
export type UnsubscribeToken = z.infer<typeof UnsubscribeTokenSchema>

/** Palabras que, respondidas por WhatsApp a un mensaje de marketing, dan de baja ese canal. */
export const UNSUBSCRIBE_WORDS = ["baja", "stop", "parar", "no mas", "no más", "unsubscribe", "prou"] as const
export function isUnsubscribeReply(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!¡¿?]/g, "").replace(/\s+/g, " ")
  return (UNSUBSCRIBE_WORDS as readonly string[]).includes(t)
}

/* Permiso al reservar ----------------------------------------------------------- */

/**
 * Casillas de la web pública, **desmarcadas por defecto**. Cada casilla marcada crea un `Consent`
 * `granted` con `source: "public"`, la versión de la política y la reserva como evidencia, en la
 * misma transacción que la reserva. Una casilla sin marcar no crea nada (ni retira lo anterior).
 */
export const PublicMarketingOptInSchema = z.strictObject({
  email: z.boolean().default(false),
  whatsapp: z.boolean().default(false),
  policyVersion: z.string().trim().min(1).max(80),
})
export type PublicMarketingOptIn = z.output<typeof PublicMarketingOptInSchema>

export function campaignForWrite<H>(v: Campaign, convert: (ms: number) => H) {
  return { ...v, scheduledAt: v.scheduledAt === null ? null : convert(v.scheduledAt) }
}
export const CampaignScheduleSchema = MillisSchema
