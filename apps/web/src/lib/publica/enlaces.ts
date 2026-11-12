/**
 * Enlaces de la web pública. Las rutas son las del contrato:
 * - reservar: `/r/{slug}` (también es el enlace corto para Instagram y Google Maps)
 * - gestionar: `/r/{slug}/reserva/{referencia}?t={token}` (lo genera también R1 en los mensajes)
 * - oferta de lista de espera: `/r/{slug}/lista-espera/{waitlistId}?t={token}` (R2)
 * - widget: `/widget/{slug}`
 */
import type { Language, PublicLocation } from "@llenamos/core"

function withLang(path: string, lang?: Language | null, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams(extra)
  if (lang) params.set("lang", lang)
  const query = params.toString()
  return query ? `${path}?${query}` : path
}

export function bookingHref(slug: string, lang?: Language | null): string {
  return withLang(`/r/${encodeURIComponent(slug)}`, lang)
}

export function widgetHref(slug: string, lang?: Language | null): string {
  return withLang(`/widget/${encodeURIComponent(slug)}`, lang)
}

export function manageHref(slug: string, reference: string, token: string, lang?: Language | null, isNew = false): string {
  return withLang(`/r/${encodeURIComponent(slug)}/reserva/${encodeURIComponent(reference)}`, lang, {
    t: token,
    ...(isNew ? { nueva: "1" } : {}),
  })
}

/** Búsqueda del local en el mapa (Google Maps abre la app en el móvil). */
export function mapsHref(location: Pick<PublicLocation, "name" | "address" | "city">, restaurantName: string): string | null {
  const parts = [location.address, location.city].map((p) => p.trim()).filter(Boolean)
  if (parts.length === 0) return null
  const query = [restaurantName, ...parts].join(", ")
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`
}

/* Calendario ------------------------------------------------------------------ */

function icsDate(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")
}

/** Escapa un texto para iCalendar (RFC 5545). */
function icsText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n")
}

export interface CalendarEvent {
  uid: string
  title: string
  description: string
  location: string
  startAt: number
  durationMinutes: number
  url: string
  now?: number
}

/** Archivo .ics de la reserva, para «Añadir al calendario» sin depender de ningún servicio. */
export function calendarFile(event: CalendarEvent): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//LogiQD//Llenamos//ES",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${event.uid}@llenamos`,
    `DTSTAMP:${icsDate(event.now ?? event.startAt)}`,
    `DTSTART:${icsDate(event.startAt)}`,
    `DTEND:${icsDate(event.startAt + event.durationMinutes * 60_000)}`,
    `SUMMARY:${icsText(event.title)}`,
    `DESCRIPTION:${icsText(`${event.description}\n${event.url}`)}`,
    ...(event.location ? [`LOCATION:${icsText(event.location)}`] : []),
    `URL:${event.url}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ]
  return `${lines.join("\r\n")}\r\n`
}
