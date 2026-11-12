/**
 * Enlace público de reservas y código del widget (`/panel/compartir`).
 *
 * Rutas del contrato (las hace la web pública, R5):
 * - `/r/{slug}`: página de reservas con la marca del restaurante. Es también el
 *   enlace de la bio de Instagram y del botón «Reservar» de Google Maps.
 * - `/widget/{slug}`: la misma reserva en formato compacto, para un iframe.
 * - `/widget.js`: script que el restaurante pega en su web; lee `data-llenamos-slug`
 *   y abre la reserva en un iframe o en una ventana.
 */
import { PublicRestaurantSchema, SlugSchema, type PublicRestaurant } from "@llenamos/core"
import { DataShapeError } from "@/lib/data/parse"

/** Origen de la web: `NEXT_PUBLIC_SITE_URL` si está puesto, si no el del navegador. */
export function siteOrigin(envUrl: string | undefined, browserOrigin: string): string {
  const raw = (envUrl ?? "").trim() || browserOrigin
  return raw.replace(/\/+$/, "")
}

export function bookingUrl(origin: string, slug: string): string {
  return `${origin}/r/${encodeURIComponent(slug)}`
}

export function widgetFrameUrl(origin: string, slug: string): string {
  return `${origin}/widget/${encodeURIComponent(slug)}`
}

/** Escapa un valor para ponerlo dentro de un atributo HTML entre comillas dobles. */
function attr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** Script para pegar en la web del restaurante: añade el botón y abre la reserva. */
export function widgetScriptSnippet(origin: string, slug: string): string {
  SlugSchema.parse(slug)
  return `<script src="${attr(origin)}/widget.js" data-llenamos-slug="${attr(slug)}" async></script>`
}

/** Alternativa sin script: la reserva incrustada en un iframe. */
export function widgetIframeSnippet(origin: string, slug: string, restaurantName: string): string {
  SlugSchema.parse(slug)
  return [
    `<iframe src="${attr(widgetFrameUrl(origin, slug))}"`,
    `  title="${attr(`Reservar en ${restaurantName}`)}"`,
    `  style="width:100%;max-width:420px;height:640px;border:0;border-radius:12px"`,
    `  loading="lazy"></iframe>`,
  ].join("\n")
}

/** Lee `publicRestaurants/{slug}`. null si aún no existe (el servidor lo crea al sincronizar). */
export function parsePublicRestaurant(slug: string, data: unknown): PublicRestaurant | null {
  if (data === undefined) return null
  const r = PublicRestaurantSchema.safeParse(data)
  if (!r.success) {
    throw new DataShapeError(`publicRestaurants/${slug}`, [...new Set(r.error.issues.map((i) => i.path.join(".") || "documento"))])
  }
  return r.data
}

export type BookingState =
  | { kind: "open" }
  | { kind: "missing" }
  | { kind: "module_off" }
  | { kind: "public_booking_off" }

/** ¿Acepta reservas la página pública ahora mismo? Y si no, por qué. */
export function bookingState(pub: PublicRestaurant | null): BookingState {
  if (!pub) return { kind: "missing" }
  if (pub.bookingEnabled) return { kind: "open" }
  if (pub.bookingDisabledReason === "module_off") return { kind: "module_off" }
  return { kind: "public_booking_off" }
}

export const BOOKING_STATE_TEXT: Record<BookingState["kind"], string> = {
  open: "Tu página acepta reservas ahora mismo.",
  missing: "La página pública aún no está publicada. Aparece en cuanto se guarda la configuración de reservas.",
  module_off: "La página no acepta reservas porque el módulo de reservas no está activo en tu plan.",
  public_booking_off: "La página no acepta reservas porque las reservas por la web están apagadas en Horarios y reservas.",
}
