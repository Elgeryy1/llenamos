/**
 * Color de acento a partir del `brandColor` del restaurante, con contraste suficiente.
 *
 * - `accent`: el color tal cual, para fondos (botón principal, opción elegida).
 * - `accentInk`: el texto que va encima del acento, oscuro o claro según dé más contraste.
 * - `accentText`: el acento para texto y bordes sobre el fondo oscuro de la página. Si el
 *   color del restaurante es demasiado oscuro, se aclara hasta llegar a 4,5:1 (WCAG AA).
 */

export const CANVAS = "#131209"
export const INK = "#f4f1ea"
export const DARK_INK = "#1a1408"
export const DEFAULT_ACCENT = "#f0a35e"

type Rgb = [number, number, number]

function parseHex(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = Number.parseInt(m[1]!, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`
}

function channel(v: number): number {
  const s = v / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

export function luminance(hex: string): number {
  const rgb = parseHex(hex)
  if (!rgb) return 0
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
}

/** Contraste WCAG entre dos colores (de 1 a 21). */
export function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

function mix(a: Rgb, b: Rgb, amount: number): Rgb {
  return [a[0] + (b[0] - a[0]) * amount, a[1] + (b[1] - a[1]) * amount, a[2] + (b[2] - a[2]) * amount]
}

export interface BrandPalette {
  accent: string
  accentInk: string
  accentText: string
}

export function brandPalette(brandColor: string | null | undefined): BrandPalette {
  const rgb = parseHex(brandColor ?? "") ?? parseHex(DEFAULT_ACCENT)!
  let accent = toHex(rgb)
  const accentInk = contrast(accent, DARK_INK) >= contrast(accent, "#ffffff") ? DARK_INK : "#ffffff"
  // Un tono medio no llega a 4,5:1 ni con texto claro ni oscuro: se aclara (o se oscurece) el fondo.
  const towards = parseHex(accentInk === DARK_INK ? "#ffffff" : "#000000")!
  for (let step = 1; contrast(accent, accentInk) < 4.5 && step <= 20; step++) {
    accent = toHex(mix(rgb, towards, step / 20))
  }

  let accentText = accent
  const light = parseHex(INK)!
  for (let step = 1; contrast(accentText, CANVAS) < 4.5 && step <= 20; step++) {
    accentText = toHex(mix(rgb, light, step / 20))
  }
  return { accent, accentInk, accentText }
}

/** Variables CSS para el contenedor de la página pública: las propias de la marca (--brand…) y las de shadcn para la acción principal. */
export function brandStyle(brandColor: string | null | undefined): Record<string, string> {
  const p = brandPalette(brandColor)
  return {
    "--brand": p.accent,
    "--brand-ink": p.accentInk,
    "--brand-text": p.accentText,
    "--primary": p.accent,
    "--primary-foreground": p.accentInk,
    "--ring": p.accentText,
  }
}

/** Iniciales para el distintivo del restaurante: «Taberna Lumbre» → «TL». */
export function initials(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((w) => /^\p{L}/u.test(w) && !/^(de|del|la|el|los|las|y|i|the|of|and|l'|d')$/i.test(w))
  const letters = (words.length > 0 ? words : [name.trim()]).slice(0, 2).map((w) => w.charAt(0).toUpperCase())
  return letters.join("") || "·"
}
