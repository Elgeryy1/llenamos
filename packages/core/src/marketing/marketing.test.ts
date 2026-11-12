import { describe, expect, it } from "vitest"
import {
  attributionFromUrl, campaignLink, canCampaignTransition, classifyOrigin, CrearReservaPublicaInputSchema, frequencyAllows, hostOf,
  isUnsubscribeReply, matchesSegment, nextSendTime, originReport, planCampaignAudience, ReservationAttributionInputSchema, SegmentRuleSchema,
  type AudienceCandidate, type Consent, type ReservationAttributionInput, type SegmentRule,
} from "../index"

const own = ["llenamos.logiqd.me"]
const attr = (over: Partial<ReservationAttributionInput>) => ReservationAttributionInputSchema.parse(over)

describe("origen de la reserva", () => {
  it("lo que apunta el personal manda sobre cualquier utm", () => {
    expect(classifyOrigin({ reservationSource: "phone", attribution: attr({ utmSource: "google" }), ownHosts: own }).channel).toBe("phone")
    expect(classifyOrigin({ reservationSource: "walk_in", attribution: null, ownHosts: own }).channel).toBe("walk_in")
    expect(classifyOrigin({ reservationSource: "import", attribution: null, ownHosts: own }).channel).toBe("import")
  })
  it("campaña de Llenamos, anuncios, redes y buscadores", () => {
    const c = (a: Partial<ReservationAttributionInput>, source: "web" | "widget" = "web") => classifyOrigin({ reservationSource: source, attribution: attr(a), ownHosts: own, restaurantHosts: ["tabernalumbre.es"] })
    expect(c({ campaignId: "cmp1", utmSource: "llenamos" })).toMatchObject({ channel: "campaign", campaignId: "cmp1" })
    expect(c({ clickIds: ["gclid"] })).toMatchObject({ channel: "google_ads", paid: true })
    expect(c({ utmSource: "instagram", utmMedium: "paid_social", adId: "ad-77" })).toMatchObject({ channel: "meta_ads", paid: true, adId: "ad-77" })
    expect(c({ utmSource: "tiktok", utmMedium: "cpc" })).toMatchObject({ channel: "tiktok_ads" })
    expect(c({ referrer: "https://l.instagram.com/?u=x" })).toMatchObject({ channel: "instagram", referrerHost: "l.instagram.com" })
    expect(c({ referrer: "https://www.google.com/maps/place/x" })).toMatchObject({ channel: "google_maps" })
    expect(c({ utmSource: "gmb" })).toMatchObject({ channel: "google_maps" })
    expect(c({ referrer: "https://www.google.es/" })).toMatchObject({ channel: "google_search", referrerHost: "google.es" })
    expect(c({ utmMedium: "email" })).toMatchObject({ channel: "email" })
    expect(c({ embedHost: "www.tabernalumbre.es" }, "widget")).toMatchObject({ channel: "own_website", embedHost: "tabernalumbre.es" })
    expect(c({ referrer: "https://blog.ejemplo.com/mejores-tabernas" })).toMatchObject({ channel: "referral" })
    expect(c({ referrer: "https://llenamos.logiqd.me/r/lumbre" })).toMatchObject({ channel: "direct", referrerHost: null })
    expect(c({})).toMatchObject({ channel: "direct", paid: false })
  })
  it("no guarda la URL del referente ni el valor de los clics", () => {
    const o = classifyOrigin({ reservationSource: "web", attribution: attr({ referrer: "https://user:pw@www.Ejemplo.com:8080/ruta?email=ana@x.es", clickIds: ["fbclid", "fbclid"] }), ownHosts: own })
    expect(o.referrerHost).toBe("ejemplo.com")
    expect(o.clickIds).toEqual(["fbclid"])
    expect(JSON.stringify(o)).not.toContain("ana@x.es")
    expect(hostOf("javascript:alert(1)")).toBeNull()
    expect(ReservationAttributionInputSchema.safeParse({ clickIds: ["gclid"], gclid: "abc" }).success).toBe(false)
    expect(ReservationAttributionInputSchema.parse({ utmCampaign: "otoño <script>" }).utmCampaign).toBe("otoño script")
  })
  it("el enlace de campaña se lee igual al volver", () => {
    const link = campaignLink("https://llenamos.logiqd.me/", "lumbre", "cmp1", "whatsapp")
    expect(link).toBe("https://llenamos.logiqd.me/r/lumbre?utm_source=llenamos&utm_medium=whatsapp&utm_campaign=cmp1&llc=cmp1")
    const back = attributionFromUrl(`${link}&gclid=zzz#reservar`, null)
    expect(back).toMatchObject({ campaignId: "cmp1", utmMedium: "whatsapp", clickIds: ["gclid"], landingPath: "/r/lumbre" })
    expect(classifyOrigin({ reservationSource: "web", attribution: back, ownHosts: own }).channel).toBe("campaign")
  })
  it("la reserva pública acepta el origen y el permiso como campos opcionales", () => {
    const base = { slug: "lumbre", locationId: "centro", date: "2026-11-20", time: "21:00", partySize: 2, guestName: "Ana", phone: "600111222", language: "es", acceptPolicy: true }
    expect(CrearReservaPublicaInputSchema.safeParse(base).success).toBe(true)
    const full = CrearReservaPublicaInputSchema.parse({ ...base, attribution: { utmSource: "instagram" }, marketingOptIn: { whatsapp: true, policyVersion: "2026.1" } })
    expect(full.marketingOptIn).toEqual({ email: false, whatsapp: true, policyVersion: "2026.1" })
    expect(CrearReservaPublicaInputSchema.safeParse({ ...base, attribution: { channel: "google_ads" } }).success).toBe(false)
  })
  it("informe por canal, campaña y anuncio", () => {
    const rows = originReport([
      { origin: { channel: "instagram", campaignId: null, adId: null, partySize: 2 }, status: "finished", salesCents: 6000 },
      { origin: { channel: "instagram", campaignId: null, adId: null, partySize: 4 }, status: "no_show", salesCents: 0 },
      { origin: { channel: "campaign", campaignId: "cmp1", adId: null, partySize: 3 }, status: "seated", salesCents: 0 },
    ])
    expect(rows[0]).toEqual({ channel: "instagram", campaignId: null, adId: null, reservations: 2, covers: 6, seated: 1, noShows: 1, cancelled: 0, salesCents: 6000 })
    expect(rows[1]).toMatchObject({ channel: "campaign", campaignId: "cmp1", seated: 1 })
  })
})

/* Segmentos y campañas ---------------------------------------------------------------- */

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 10, 10)
const rule = (over: Partial<SegmentRule> = {}): SegmentRule => SegmentRuleSchema.parse({
  minVisits: null, maxVisits: null, lastVisitAtLeastDaysAgo: null, lastVisitAtMostDaysAgo: null, includeNeverVisited: false,
  maxNoShows: null, minSpentCents: null, tagsAny: [], tagsNone: [], languages: [], minPoints: null, ...over,
})
const cust = (id: string, over: Partial<AudienceCandidate> = {}): AudienceCandidate => ({
  customerId: id, visits: 3, noShows: 0, lastVisitAt: NOW - 60 * DAY, spentCents: 12000, tags: [], language: "es", points: null,
  phone: `+3460000000${id.slice(-1)}`, email: `${id}@correo.test`, suppressed: false, ...over,
})
const consent = (customerId: string, purpose: Consent["purpose"], status: Consent["status"], at: number): Consent => ({ customerId, purpose, status, policyVersion: "2026.1", at, source: "public", evidenceId: "ev" })
const settings = { maxPer30Days: 2, minHoursBetween: 72 }

describe("segmentos", () => {
  it("«te echamos de menos»: vinieron alguna vez y no desde hace 45 días", () => {
    const r = rule({ minVisits: 1, lastVisitAtLeastDaysAgo: 45 })
    expect(matchesSegment(cust("c1"), r, NOW)).toBe(true)
    expect(matchesSegment(cust("c1", { lastVisitAt: NOW - 10 * DAY }), r, NOW)).toBe(false)
    expect(matchesSegment(cust("c1", { lastVisitAt: null, visits: 0 }), r, NOW)).toBe(false)
  })
  it("etiquetas, idioma, no presentados, gasto y puntos", () => {
    expect(matchesSegment(cust("c1", { tags: ["VIP"] }), rule({ tagsAny: ["vip"] }), NOW)).toBe(true)
    expect(matchesSegment(cust("c1", { tags: ["vip"] }), rule({ tagsNone: ["VIP"] }), NOW)).toBe(false)
    expect(matchesSegment(cust("c1", { language: "ca" }), rule({ languages: ["es"] }), NOW)).toBe(false)
    expect(matchesSegment(cust("c1", { noShows: 2 }), rule({ maxNoShows: 1 }), NOW)).toBe(false)
    expect(matchesSegment(cust("c1"), rule({ minSpentCents: 20000 }), NOW)).toBe(false)
    expect(matchesSegment(cust("c1", { points: 50 }), rule({ minPoints: 100 }), NOW)).toBe(false)
    expect(SegmentRuleSchema.safeParse({ ...rule(), minVisits: 5, maxVisits: 2 }).success).toBe(false)
  })
})

describe("campañas solo a quien dio permiso", () => {
  const candidates = [
    cust("c1"),
    cust("c2"),
    cust("c3"),
    cust("c4", { email: null }),
    cust("c5", { suppressed: true }),
    cust("c6", { email: "c1@correo.test" }),
    cust("c7"),
  ]
  const consents = [
    consent("c1", "marketing_email", "granted", NOW - 30 * DAY),
    consent("c2", "marketing_email", "granted", NOW - 30 * DAY),
    consent("c2", "marketing_email", "withdrawn", NOW - DAY), // se dio de baja
    consent("c3", "marketing_whatsapp", "granted", NOW - DAY), // permiso de otro canal
    consent("c4", "marketing_email", "granted", NOW - DAY),
    consent("c5", "marketing_email", "granted", NOW - DAY),
    consent("c6", "marketing_email", "granted", NOW - DAY),
    consent("c7", "marketing_email", "granted", NOW - DAY),
  ]
  const log = new Map([["c7", [{ at: NOW - 24 * 3_600_000, campaignId: "antes" }]]])
  it("excluye por motivo y nunca envía sin consentimiento, con baja, suprimido, repetido o sobre el límite", () => {
    const plan = planCampaignAudience({ candidates, rule: rule(), channel: "email", consents, sendLog: log, settings, now: NOW })
    expect(plan.recipients.map((r) => r.customerId)).toEqual(["c1"])
    expect(Object.fromEntries(plan.excluded.map((e) => [e.customerId, e.reason]))).toEqual({
      c2: "withdrawn", c3: "no_consent", c4: "no_contact", c5: "suppressed", c6: "duplicate_contact", c7: "frequency",
    })
    expect(plan.counts).toMatchObject({ audience: 7, recipients: 1, withdrawn: 1, no_consent: 1, no_contact: 1, suppressed: 1, duplicate_contact: 1, frequency: 1 })
  })
  it("el permiso de WhatsApp no sirve para correo y al revés", () => {
    const plan = planCampaignAudience({ candidates, rule: rule(), channel: "whatsapp", consents, sendLog: new Map(), settings, now: NOW })
    expect(plan.recipients.map((r) => r.customerId)).toEqual(["c3"])
    expect(plan.recipients[0]?.to).toBe("+34600000003")
  })
  it("un permiso con fecha futura o empatado con una baja no vale", () => {
    const tie = [consent("c1", "marketing_email", "granted", NOW - DAY), consent("c1", "marketing_email", "withdrawn", NOW - DAY)]
    expect(planCampaignAudience({ candidates: [cust("c1")], rule: rule(), channel: "email", consents: tie, sendLog: new Map(), settings, now: NOW }).recipients).toEqual([])
    const future = [consent("c1", "marketing_email", "granted", NOW + DAY)]
    expect(planCampaignAudience({ candidates: [cust("c1")], rule: rule(), channel: "email", consents: future, sendLog: new Map(), settings, now: NOW }).counts.no_consent).toBe(1)
  })
  it("límite de frecuencia: por número en 30 días y por horas entre mensajes", () => {
    expect(frequencyAllows([], NOW, settings)).toBe(true)
    expect(frequencyAllows([{ at: NOW - 100 * 3_600_000, campaignId: "a" }], NOW, settings)).toBe(true)
    expect(frequencyAllows([{ at: NOW - 10 * 3_600_000, campaignId: "a" }], NOW, settings)).toBe(false)
    expect(frequencyAllows([{ at: NOW - 20 * DAY, campaignId: "a" }, { at: NOW - 10 * DAY, campaignId: "b" }], NOW, settings)).toBe(false)
    expect(frequencyAllows([{ at: NOW - 31 * DAY, campaignId: "a" }, { at: NOW - 10 * DAY, campaignId: "b" }], NOW, settings)).toBe(true)
  })
  it("fuera de la ventana de envío se espera a la siguiente", () => {
    const w = { from: "10:00", to: "21:00" }
    const night = Date.UTC(2026, 10, 10, 22) // 23:00 en Madrid
    expect(nextSendTime(night, "Europe/Madrid", w)).toBe(Date.UTC(2026, 10, 11, 9))
    const early = Date.UTC(2026, 10, 10, 6) // 07:00
    expect(nextSendTime(early, "Europe/Madrid", w)).toBe(Date.UTC(2026, 10, 10, 9))
    const ok = Date.UTC(2026, 10, 10, 12)
    expect(nextSendTime(ok, "Europe/Madrid", w)).toBe(ok)
  })
  it("estados de la campaña y bajas por respuesta", () => {
    expect(canCampaignTransition("draft", "scheduled")).toBe(true)
    expect(canCampaignTransition("sent", "draft")).toBe(false)
    expect(canCampaignTransition("sending", "draft")).toBe(false)
    expect(canCampaignTransition("scheduled", "draft")).toBe(true)
    expect(isUnsubscribeReply(" BAJA. ")).toBe(true)
    expect(isUnsubscribeReply("Stop")).toBe(true)
    expect(isUnsubscribeReply("no puedo ir")).toBe(false)
  })
})
