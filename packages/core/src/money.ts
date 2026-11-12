/**
 * Dinero.
 *
 * Todo importe es un número entero de céntimos. Nunca decimales: 0,1 + 0,2 no da
 * 0,3 en coma flotante, y en una caja eso acaba siendo un descuadre.
 */

export type Cents = number

export function assertCents(value: number): Cents {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Importe no válido: ${value}. Debe ser un entero de céntimos.`)
  }
  return value
}

const formatters = new Map<string, Intl.NumberFormat>()

/** 1234 → "12,34 €" */
export function formatMoney(cents: Cents, currency = "EUR", locale = "es-ES"): string {
  const key = `${locale}:${currency}`
  let f = formatters.get(key)
  if (!f) {
    f = new Intl.NumberFormat(locale, { style: "currency", currency })
    formatters.set(key, f)
  }
  return f.format(cents / 100)
}

/**
 * Lee un importe escrito por una persona ("12", "12,5", "12.50", "1.234,56 €")
 * y devuelve céntimos. Devuelve null si no se entiende.
 */
export function parseMoney(input: string): Cents | null {
  const clean = input.replace(/[€\s]/g, "")
  if (!clean) return null
  let normalized = clean
  if (clean.includes(",")) {
    // Formato español: el punto separa miles y la coma los decimales.
    normalized = clean.replace(/\./g, "").replace(",", ".")
  }
  if (!/^-?\d+(\.\d{1,2})?$/.test(normalized)) return null
  const [whole = "0", frac = ""] = normalized.replace("-", "").split(".")
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"))
  return normalized.startsWith("-") ? -cents : cents
}

/**
 * Reparte un importe en n partes que suman exactamente el total.
 * Los céntimos sobrantes van a las primeras partes: 1000 / 3 → [334, 333, 333].
 */
export function splitEvenly(total: Cents, parts: number): Cents[] {
  if (!Number.isInteger(parts) || parts < 1) throw new Error("Número de partes no válido.")
  const base = Math.trunc(total / parts)
  const rest = total - base * parts
  return Array.from({ length: parts }, (_, i) => base + (i < Math.abs(rest) ? Math.sign(rest) : 0))
}
