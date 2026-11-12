"use client"

import { NoteIcon, StarIcon, TagIcon, TranslateIcon, WarningCircleIcon } from "@phosphor-icons/react"
import { GuestBadgeChip } from "@/components/reservas/Huesped"
import type { CustomerDoc } from "@/lib/data/reservas"
import { cn } from "@/lib/cn"

/** Las mismas etiquetas de las reservas, leyendo solo la ficha del cliente. */
export function CustomerBadges({ customer: c, className }: {
  customer: Pick<CustomerDoc, "allergies" | "tags" | "visits" | "language" | "notes">
  className?: string
}) {
  return (
    <span className={cn("flex min-w-0 flex-wrap gap-1", className)}>
      {c.allergies ? <GuestBadgeChip badge={{ key: "allergy", tone: "alergia", icon: WarningCircleIcon, label: c.allergies, title: `Alergia: ${c.allergies}` }} /> : null}
      {c.tags.map((tag) => {
        const regular = tag.toLowerCase() === "habitual"
        return <GuestBadgeChip key={tag} badge={{ key: tag, tone: regular ? "habitual" : "neutro", icon: regular ? StarIcon : TagIcon, label: regular ? (c.visits > 1 ? `Habitual · ${c.visits}` : "Habitual") : tag }} />
      })}
      {c.language !== "es" ? <GuestBadgeChip badge={{ key: "language", tone: "neutro", icon: TranslateIcon, label: c.language === "ca" ? "CA" : "EN", title: c.language === "ca" ? "Habla catalán" : "Habla inglés" }} /> : null}
      {c.notes ? <GuestBadgeChip badge={{ key: "notes", tone: "neutro", icon: NoteIcon, label: "Notas", title: c.notes }} /> : null}
    </span>
  )
}
