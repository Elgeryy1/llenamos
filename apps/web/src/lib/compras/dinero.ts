/** Dinero de compras: céntimos enteros, sin IVA. Nada de decimales flotantes al leer lo que escribe la persona. */

const EUR = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" })

/** «12,50 €» (con espacio fino no separable, como pinta Intl). */
export function euros(cents: number): string {
  return EUR.format(cents / 100)
}

/** Lee «12,5», «12.50» o «12» y devuelve céntimos, o null si no es un importe válido (más de dos decimales, negativo, texto). */
export function parseEuros(text: string): number | null {
  const m = /^\s*(\d{1,7})(?:[.,](\d{1,2}))?\s*(?:€)?\s*$/.exec(text)
  if (!m) return null
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0")
}

/** Para rellenar un campo de importe: 1250 pasa a «12,50». */
export function eurosParaCampo(cents: number): string {
  return `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, "0")}`
}

/** Variación entre dos precios en puntos básicos: 310 pasa a «+3,1 %»; sin decimales sobrantes. */
export function variacionTexto(changeBp: number): string {
  const signo = changeBp > 0 ? "+" : changeBp < 0 ? "-" : ""
  const abs = Math.abs(changeBp)
  const entero = Math.floor(abs / 100)
  const resto = abs % 100
  const decimales = resto === 0 ? "" : `,${String(resto).padStart(2, "0").replace(/0$/, "")}`
  return `${signo}${entero}${decimales} %`
}

/** Cambio en puntos básicos entre un precio anterior y uno nuevo, redondeado al más cercano (solo para avisar antes de enviar). */
export function cambioBp(previousCents: number, newCents: number): number {
  if (previousCents <= 0) return newCents > 0 ? 10_000 : 0
  const num = BigInt(newCents - previousCents) * BigInt(10_000)
  const den = BigInt(previousCents)
  const half = den / BigInt(2)
  const q = num >= BigInt(0) ? (num + half) / den : -((-num + half) / den)
  return Number(q)
}
