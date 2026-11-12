/**
 * Origen de cada reserva (fase 5): de qué canal, campaña o anuncio viene.
 *
 * Se decide **en la propia reserva** con lo que trae (utm, referente, enlace de campaña de Llenamos
 * y la fuente de la fase 1): último toque, sin cookies ni seguimiento entre visitas. No se guarda la
 * URL completa del referente ni el valor de los identificadores de clic de los anuncios, solo de qué
 * tipo eran. El servidor escribe `reservationOrigins/{reservationId}` en la misma transacción que la
 * reserva; el navegador solo envía `attribution`, que el servidor limpia con `normalizeAttribution`.
 */
import { z } from "zod"
import { DocIdSchema } from "../model"
import type { ReservationSource } from "../reservation-model"
import { TimestampSchema } from "../timestamp"

export const ORIGIN_CHANNELS = [
  "google_search", "google_maps", "google_ads", "instagram", "facebook", "meta_ads", "tiktok", "tiktok_ads",
  "email", "whatsapp", "campaign", "own_website", "referral", "direct",
  "phone", "walk_in", "import", "waitlist", "other",
] as const
export type OriginChannel = (typeof ORIGIN_CHANNELS)[number]
export const OriginChannelSchema = z.enum(ORIGIN_CHANNELS)

export const ORIGIN_CHANNEL_LABEL: Record<OriginChannel, string> = {
  google_search: "Google (búsqueda)", google_maps: "Google Maps", google_ads: "Anuncios de Google",
  instagram: "Instagram", facebook: "Facebook", meta_ads: "Anuncios de Meta", tiktok: "TikTok", tiktok_ads: "Anuncios de TikTok",
  email: "Correo", whatsapp: "WhatsApp", campaign: "Campaña de Llenamos", own_website: "Web del restaurante",
  referral: "Otra web", direct: "Directo", phone: "Teléfono", walk_in: "Sin reserva", import: "Importada",
  waitlist: "Lista de espera", other: "Otro",
}

export const CLICK_ID_KINDS = ["gclid", "gbraid", "wbraid", "fbclid", "ttclid", "msclkid"] as const
const Param = z.string().trim().max(100).transform((v) => v.replace(/[^\p{L}\p{N}_.\- ]/gu, "").slice(0, 80)).nullable().default(null)

/** Lo que manda la web pública o el widget al reservar (todo opcional). */
export const ReservationAttributionInputSchema = z.strictObject({
  utmSource: Param, utmMedium: Param, utmCampaign: Param, utmContent: Param, utmTerm: Param,
  /** `utm_id` o `ad_id` del enlace del anuncio. */
  adId: Param,
  /** Id de campaña de Llenamos (`llc` en el enlace). */
  campaignId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).nullable().default(null),
  /** Solo el nombre de los parámetros de clic presentes, nunca su valor. */
  clickIds: z.array(z.enum(CLICK_ID_KINDS)).max(6).default([]),
  /** URL del referente: el servidor solo conserva el dominio. */
  referrer: z.string().max(2000).nullable().default(null),
  /** Dominio de la página que contiene el widget (`window.location.hostname` del padre). */
  embedHost: z.string().max(253).nullable().default(null),
  landingPath: z.string().max(300).nullable().default(null),
})
export type ReservationAttributionInput = z.output<typeof ReservationAttributionInputSchema>

/** `locations/{lid}/reservationOrigins/{reservationId}`: solo servidor, sin datos personales. */
export const ReservationOriginSchema = z.object({
  channel: OriginChannelSchema,
  paid: z.boolean(),
  source: z.string().nullable(), medium: z.string().nullable(), campaign: z.string().nullable(),
  content: z.string().nullable(), term: z.string().nullable(), adId: z.string().nullable(),
  campaignId: DocIdSchema.nullable(),
  clickIds: z.array(z.enum(CLICK_ID_KINDS)),
  referrerHost: z.string().nullable(),
  embedHost: z.string().nullable(),
  reservationSource: z.string(),
  /** Copia para informes sin leer la reserva: día de servicio local y comensales. */
  date: z.string(),
  partySize: z.number().int().min(1),
  createdAt: TimestampSchema,
})
export type ReservationOrigin = z.infer<typeof ReservationOriginSchema>

/** Dominio en minúsculas sin `www.` de una URL, o null si no es una URL http(s). Sin `URL` (core no usa DOM). */
export function hostOf(url: string | null): string | null {
  if (!url) return null
  const m = /^https?:\/\/(?:[^/?#@]*@)?([^/?#:]+)(?::\d+)?(?:[/?#]|$)/i.exec(url.trim())
  if (!m?.[1]) return null
  const host = m[1].toLowerCase().replace(/^www\./, "")
  return /^[a-z0-9.-]+$/.test(host) ? host : null
}

/** Ruta y parámetros de una URL (sin `URL`). */
function splitUrl(url: string): { path: string; params: Map<string, string> } {
  const sinAncla = url.split("#")[0] ?? ""
  const [antes, query = ""] = sinAncla.split("?", 2) as [string, string?]
  const path = antes.replace(/^https?:\/\/[^/]*/i, "") || "/"
  const params = new Map<string, string>()
  for (const part of query.split("&")) {
    if (!part) continue
    const [k, v = ""] = part.split("=", 2) as [string, string?]
    const decode = (x: string) => { try { return decodeURIComponent(x.replace(/\+/g, " ")) } catch { return x } }
    const key = decode(k)
    if (!params.has(key)) params.set(key, decode(v))
  }
  return { path, params }
}

const PAID_MEDIUMS = ["cpc", "ppc", "paid", "paidsocial", "paid_social", "paid-social", "ads", "ad", "display", "cpm"]
const has = (host: string | null, ...names: string[]) => host !== null && names.some((n) => host === n || host.endsWith(`.${n}`) || host.startsWith(`${n}.`))
const isGoogle = (v: string | null) => v !== null && /(^|\.)google\.[a-z.]+$/.test(v)

export interface OriginInput {
  reservationSource: ReservationSource
  attribution: ReservationAttributionInput | null
  /** Dominio de la web pública de Llenamos, para no contarla como referente. */
  ownHosts: readonly string[]
  /** Dominios propios del restaurante (su web), si se conocen. */
  restaurantHosts?: readonly string[]
}

/** Canal y datos limpios de una reserva. Puro y determinista. */
export function classifyOrigin(input: OriginInput): Omit<ReservationOrigin, "date" | "partySize" | "createdAt"> {
  const a = input.attribution
  const referrerHost = (() => {
    const h = hostOf(a?.referrer ?? null)
    return h !== null && input.ownHosts.includes(h) ? null : h
  })()
  const embedHost = a?.embedHost ? a.embedHost.toLowerCase().replace(/^www\./, "").slice(0, 253) : null
  const base = {
    source: a?.utmSource?.toLowerCase() || null, medium: a?.utmMedium?.toLowerCase() || null, campaign: a?.utmCampaign || null,
    content: a?.utmContent || null, term: a?.utmTerm || null, adId: a?.adId || null, campaignId: a?.campaignId ?? null,
    clickIds: [...new Set(a?.clickIds ?? [])], referrerHost, embedHost, reservationSource: input.reservationSource,
  }
  const out = (channel: OriginChannel, paid = false) => ({ ...base, channel, paid })
  // Lo que apunta el personal manda: no hay navegador del cliente detrás.
  if (input.reservationSource === "phone") return out("phone")
  if (input.reservationSource === "walk_in") return out("walk_in")
  if (input.reservationSource === "import") return out("import")
  if (input.reservationSource === "waitlist" && !a) return out("waitlist")
  if (base.campaignId) return out("campaign")
  const src = base.source
  const medium = base.medium
  const paid = (medium !== null && PAID_MEDIUMS.includes(medium)) || base.clickIds.length > 0
  const clicks = new Set(base.clickIds)
  if (clicks.has("gclid") || clicks.has("gbraid") || clicks.has("wbraid") || (paid && (src === "google" || src === "adwords"))) return out("google_ads", true)
  if (clicks.has("fbclid") && paid) return out("meta_ads", true)
  if (paid && (src === "facebook" || src === "instagram" || src === "meta" || src === "fb" || src === "ig")) return out("meta_ads", true)
  if (clicks.has("ttclid") || (paid && src === "tiktok")) return out("tiktok_ads", true)
  if (medium === "email" || src === "newsletter") return out("email")
  if (medium === "whatsapp" || src === "whatsapp") return out("whatsapp")
  if (src === "instagram" || src === "ig" || has(referrerHost, "instagram.com", "l.instagram.com")) return out("instagram")
  if (src === "facebook" || src === "fb" || clicks.has("fbclid") || has(referrerHost, "facebook.com", "l.facebook.com", "m.facebook.com")) return out("facebook")
  if (src === "tiktok" || has(referrerHost, "tiktok.com")) return out("tiktok")
  if (src === "google_maps" || src === "gmb" || src === "google_business" || (src === "google" && medium === "maps") || has(referrerHost, "maps.google.com") || (referrerHost !== null && /(^|\.)google\.[a-z.]+$/.test(referrerHost) && a?.referrer?.includes("/maps") === true)) return out("google_maps")
  if (src === "google" || isGoogle(referrerHost)) return out("google_search")
  if (paid) return out("other", true)
  if (src !== null) return out("other")
  const restaurantHosts = (input.restaurantHosts ?? []).map((h) => h.toLowerCase().replace(/^www\./, ""))
  if (input.reservationSource === "widget" || (embedHost !== null && restaurantHosts.includes(embedHost))) return out("own_website")
  if (referrerHost !== null && restaurantHosts.includes(referrerHost)) return out("own_website")
  if (referrerHost !== null) return out("referral")
  if (input.reservationSource === "waitlist") return out("waitlist")
  return out("direct")
}

/**
 * Enlace a la web de reservas para una campaña: lleva `llc` (lo lee Llenamos) y los utm estándar
 * para que la propia analítica del restaurante también lo vea.
 */
export function campaignLink(publicBaseUrl: string, slug: string, campaignId: string, channel: "email" | "whatsapp"): string {
  const base = publicBaseUrl.replace(/\/+$/, "")
  const id = encodeURIComponent(campaignId)
  return `${base}/r/${encodeURIComponent(slug)}?utm_source=llenamos&utm_medium=${channel}&utm_campaign=${id}&llc=${id}`
}

/** Lo que la web lee de su propia URL y del referente para mandarlo al reservar. */
export function attributionFromUrl(pageUrl: string, referrer: string | null, embedHost: string | null = null): ReservationAttributionInput {
  const { path, params } = splitUrl(pageUrl)
  const q = (k: string) => params.get(k) ?? null
  const llc = q("llc")
  return ReservationAttributionInputSchema.parse({
    utmSource: q("utm_source"), utmMedium: q("utm_medium"), utmCampaign: q("utm_campaign"), utmContent: q("utm_content"), utmTerm: q("utm_term"),
    adId: q("utm_id") ?? q("ad_id"),
    campaignId: llc !== null && /^[A-Za-z0-9_-]{1,64}$/.test(llc) ? llc : null,
    clickIds: CLICK_ID_KINDS.filter((k) => params.has(k)),
    referrer, embedHost, landingPath: path.slice(0, 300),
  })
}

export interface OriginReportRow {
  channel: OriginChannel
  campaignId: string | null
  adId: string | null
  reservations: number
  covers: number
  seated: number
  noShows: number
  cancelled: number
  /** Ventas cobradas de las mesas que vienen de esas reservas (IVA incluido). */
  salesCents: number
}

/** Informe de origen: reservas, comensales, presentados y ventas por canal, campaña y anuncio. */
export function originReport(rows: readonly {
  origin: Pick<ReservationOrigin, "channel" | "campaignId" | "adId" | "partySize">
  status: "pending" | "confirmed" | "seated" | "finished" | "cancelled" | "no_show"
  salesCents: number
}[]): OriginReportRow[] {
  const map = new Map<string, OriginReportRow>()
  for (const r of rows) {
    const key = `${r.origin.channel}|${r.origin.campaignId ?? ""}|${r.origin.adId ?? ""}`
    const row = map.get(key) ?? { channel: r.origin.channel, campaignId: r.origin.campaignId, adId: r.origin.adId, reservations: 0, covers: 0, seated: 0, noShows: 0, cancelled: 0, salesCents: 0 }
    row.reservations += 1
    row.covers += r.origin.partySize
    if (r.status === "seated" || r.status === "finished") row.seated += 1
    if (r.status === "no_show") row.noShows += 1
    if (r.status === "cancelled") row.cancelled += 1
    row.salesCents += r.salesCents
    map.set(key, row)
  }
  return [...map.values()].sort((a, b) => b.reservations - a.reservations || a.channel.localeCompare(b.channel) || (a.campaignId ?? "").localeCompare(b.campaignId ?? "") || (a.adId ?? "").localeCompare(b.adId ?? ""))
}

export function reservationOriginForWrite<H>(v: ReservationOrigin, convert: (ms: number) => H) {
  return { ...v, createdAt: convert(v.createdAt) }
}
