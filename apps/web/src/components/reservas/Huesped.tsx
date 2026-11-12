"use client"

import { RESERVATION_SOURCE_LABEL, type ReservationWithId } from "@llenamos/core"
import {
  BrowserIcon,
  CakeIcon,
  ClockCountdownIcon,
  CoinsIcon,
  FileArrowUpIcon,
  GlobeSimpleIcon,
  NoteIcon,
  PersonSimpleWalkIcon,
  PhoneIcon,
  StarIcon,
  TranslateIcon,
  WarningCircleIcon,
  type Icon,
} from "@phosphor-icons/react"
import type { ReactNode } from "react"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { cn } from "@/lib/cn"
import type { CustomerDoc } from "@/lib/data/reservas"
import { initials } from "@/lib/panel/equipo"
import { euros } from "@/lib/reservas/formato"

/*
 * Piezas del cliente en las filas del servicio (propuesta B «Sala cálida»): avatar con
 * iniciales, etiquetas ricas (alergia, habitual, cumpleaños, idioma, señal, nota) y de
 * dónde viene la reserva. Solo presentación: se leen la reserva y su ficha de cliente.
 */

/** Tonos tostados para el fondo del avatar: se elige uno fijo por nombre. */
const AVATAR_TONES = [
  "bg-[#3a2c1e] text-[#f3c99a]",
  "bg-[#2c3324] text-[#bfd9a8]",
  "bg-[#3b2724] text-[#f0b3a8]",
  "bg-[#283131] text-[#a9d2cc]",
  "bg-[#35301d] text-[#e6d38f]",
  "bg-[#302838] text-[#cdb8e6]",
] as const

function toneFor(name: string) {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return AVATAR_TONES[h % AVATAR_TONES.length]!
}

export type AvatarRing = "none" | "seated" | "late" | "muted"

/** Avatar del cliente con sus iniciales. El aro repite el estado (sentada, tarde). */
export function GuestAvatar({ name, size = "md", ring = "none", className }: { name: string; size?: "sm" | "md" | "lg"; ring?: AvatarRing; className?: string }) {
  return (
    <Avatar
      aria-hidden
      className={cn(
        size === "lg" ? "size-12" : size === "sm" ? "size-7" : "size-9",
        "ring-2 ring-offset-2 ring-offset-card",
        ring === "seated" ? "ring-success/70" : ring === "late" ? "ring-warning/80" : "ring-transparent",
        ring === "muted" && "opacity-60",
        className,
      )}
    >
      <AvatarFallback className={cn("font-semibold tracking-tight", size === "lg" ? "text-base" : size === "sm" ? "text-[10px]" : "text-xs", toneFor(name))}>
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  )
}

const SOURCE_ICON: Record<ReservationWithId["source"], Icon> = {
  web: GlobeSimpleIcon,
  widget: BrowserIcon,
  phone: PhoneIcon,
  walk_in: PersonSimpleWalkIcon,
  import: FileArrowUpIcon,
  waitlist: ClockCountdownIcon,
}

/** De dónde viene la reserva: icono y palabra («web», «teléfono»). */
export function SourceLabel({ source, className }: { source: ReservationWithId["source"]; className?: string }) {
  const I = SOURCE_ICON[source]
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs text-muted-foreground", className)}>
      <I aria-hidden className="size-3.5" />
      {source === "walk_in" ? "sin reserva" : RESERVATION_SOURCE_LABEL[source]}
    </span>
  )
}

type BadgeTone = "alergia" | "habitual" | "fiesta" | "aviso" | "neutro"

interface GuestBadge {
  key: string
  tone: BadgeTone
  icon: Icon
  label: string
  /** Texto completo para lectores de pantalla y el título. */
  title?: string
}

const LANGUAGE_SHORT = { es: "ES", ca: "CA", en: "EN" } as const
const LANGUAGE_LONG = { es: "castellano", ca: "catalán", en: "inglés" } as const

const ALLERGY_HINT = /alerg|cel[ií]ac|intoler|sin gluten|vegan/i
const BIRTHDAY_HINT = /cumple|aniversari/i

/**
 * Etiquetas de una reserva y su cliente, de más a menos importante para la sala:
 * alergia, habitual, cumpleaños, idioma, señal y nota.
 */
export function guestBadges(r: ReservationWithId, customer?: CustomerDoc | null): GuestBadge[] {
  const out: GuestBadge[] = []
  const notes = `${r.guestNotes} ${r.notes}`
  const allergy = customer?.allergies || (ALLERGY_HINT.test(r.guestNotes) ? r.guestNotes : "")
  if (allergy) out.push({ key: "alergia", tone: "alergia", icon: WarningCircleIcon, label: allergy.length > 22 ? "Alergia" : allergy, title: `Alergia: ${allergy}` })
  const regular = customer?.tags.some((t) => t.toLowerCase() === "habitual") || /habitual/i.test(r.notes)
  if (regular) out.push({ key: "habitual", tone: "habitual", icon: StarIcon, label: customer && customer.visits > 1 ? `Habitual · ${customer.visits}` : "Habitual", title: customer ? `Cliente habitual, ${customer.visits} visitas` : "Cliente habitual" })
  if (BIRTHDAY_HINT.test(notes)) out.push({ key: "fiesta", tone: "fiesta", icon: CakeIcon, label: "Cumpleaños" })
  if (r.language !== "es") out.push({ key: "idioma", tone: "neutro", icon: TranslateIcon, label: LANGUAGE_SHORT[r.language], title: `Habla ${LANGUAGE_LONG[r.language]}` })
  const d = r.deposit
  if (d.status === "paid") out.push({ key: "senal", tone: "neutro", icon: CoinsIcon, label: `Señal ${euros(d.amountCents)}` })
  else if (d.status === "required" || d.status === "failed") out.push({ key: "senal", tone: "aviso", icon: CoinsIcon, label: `Señal sin pagar ${euros(d.amountCents)}` })
  else if (d.status === "not_configured") out.push({ key: "senal", tone: "aviso", icon: CoinsIcon, label: "Señal sin pagos" })
  const otherNote = r.guestNotes && !ALLERGY_HINT.test(r.guestNotes) && !BIRTHDAY_HINT.test(r.guestNotes)
  if (otherNote) out.push({ key: "nota", tone: "neutro", icon: NoteIcon, label: r.guestNotes.length > 26 ? "Nota del cliente" : r.guestNotes, title: `Nota del cliente: ${r.guestNotes}` })
  return out
}

const BADGE_TONE: Record<BadgeTone, string> = {
  alergia: "bg-destructive/14 text-[#f4ada4] ring-destructive/25",
  habitual: "bg-success/12 text-[#acd8b8] ring-success/20",
  fiesta: "bg-[#e6c27a]/12 text-[#ecd09a] ring-[#e6c27a]/20",
  aviso: "bg-warning/14 text-warning ring-warning/25",
  neutro: "bg-foreground/[0.06] text-soft-foreground ring-foreground/10",
}

/** Etiqueta con icono (alto 20, radio 6): un punto más rica que `Tag` para las filas del servicio. */
export function GuestBadgeChip({ badge, className }: { badge: GuestBadge; className?: string }) {
  const I = badge.icon
  return (
    <span
      data-tone={badge.tone}
      title={badge.title ?? badge.label}
      className={cn("inline-flex h-5 max-w-48 items-center gap-1 rounded-md px-1.5 text-[11.5px] font-medium ring-1 ring-inset", BADGE_TONE[badge.tone], className)}
    >
      <I aria-hidden weight="bold" className="size-3 shrink-0" />
      <span className="truncate">{badge.label}</span>
      {badge.title && badge.title !== badge.label ? <span className="sr-only">: {badge.title}</span> : null}
    </span>
  )
}

export function GuestBadges({ reservation, customer, max, className }: { reservation: ReservationWithId; customer?: CustomerDoc | null; max?: number; className?: string }): ReactNode {
  const all = guestBadges(reservation, customer)
  if (all.length === 0) return null
  const shown = max ? all.slice(0, max) : all
  const rest = all.length - shown.length
  return (
    <span className={cn("flex flex-wrap items-center gap-1", className)}>
      {shown.map((b) => (
        <GuestBadgeChip key={b.key} badge={b} />
      ))}
      {rest > 0 ? <span className="cifra text-[11px] text-muted-foreground">+{rest}</span> : null}
    </span>
  )
}
