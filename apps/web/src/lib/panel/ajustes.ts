/**
 * Ajustes del restaurante que se pueden cambiar desde el panel. Según el
 * contrato, owner y manager solo pueden escribir name, brandColor, locale y updatedAt.
 */
import { RestaurantSchema, type Restaurant } from "@llenamos/core"
import { z } from "zod"

export const AjustesSchema = z.object({
  name: z.string().trim().min(2, "Escribe al menos 2 letras.").max(80, "Como mucho 80 letras."),
  brandColor: RestaurantSchema.shape.brandColor,
  locale: RestaurantSchema.shape.locale,
})

export type Ajustes = z.infer<typeof AjustesSchema>

export function ajustesFrom(r: Pick<Restaurant, "name" | "brandColor" | "locale">): Ajustes {
  return { name: r.name, brandColor: r.brandColor.toLowerCase(), locale: r.locale }
}

/** Campos que han cambiado respecto a lo guardado (para no escribir lo que no cambia). */
export function changedFields(saved: Ajustes, draft: Ajustes): Partial<Ajustes> {
  const out: Partial<Ajustes> = {}
  if (draft.name.trim() !== saved.name) out.name = draft.name.trim()
  if (draft.brandColor.toLowerCase() !== saved.brandColor.toLowerCase()) out.brandColor = draft.brandColor.toLowerCase()
  if (draft.locale !== saved.locale) out.locale = draft.locale
  return out
}

/** Acepta «f0a35e», «#F0A35E» o «#f0a» y devuelve «#f0a35e»; null si no es un color. */
export function normalizeHex(input: string): string | null {
  const raw = input.trim().replace(/^#/, "").toLowerCase()
  if (/^[0-9a-f]{6}$/.test(raw)) return `#${raw}`
  if (/^[0-9a-f]{3}$/.test(raw)) return `#${raw.split("").map((c) => c + c).join("")}`
  return null
}

/** ¿Se lee bien texto oscuro encima de este color? Sirve para la vista previa. */
export function isLightColor(hex: string): boolean {
  const n = normalizeHex(hex)
  if (!n) return true
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(n.slice(i, i + 2), 16) / 255) as [number, number, number]
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  return luminance > 0.4
}
