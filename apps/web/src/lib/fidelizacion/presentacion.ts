import { PromotionInputSchema, type PromotionInput } from "@llenamos/core"

export const euros = (cents: number) => new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(cents / 100)
export function centimos(texto: string): number {
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(texto.trim())) throw new Error("Escribe un importe con un máximo de dos decimales.")
  const [entero, decimal = ""] = texto.trim().replace(",", ".").split(".")
  const valor = Number(entero) * 100 + Number(decimal.padEnd(2, "0"))
  if (!Number.isSafeInteger(valor)) throw new Error("El importe es demasiado grande.")
  return valor
}
export const textoImporte = (valor: number) => (valor / 100).toFixed(2).replace(".", ",")
export const ESTADOS = { draft: "Borrador", active: "Activa", paused: "En pausa", archived: "Archivada" }
export const MOVIMIENTOS: Record<string, string> = { earn: "Puntos ganados", redeem: "Canje de premio", redeem_reversal: "Canje anulado", earn_reversal: "Devolución de cuenta", adjust: "Ajuste de puntos", expire: "Puntos caducados" }
export const DIAS = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"]
export function nuevaPromocion(): PromotionInput {
  return PromotionInputSchema.parse({ description: "", discount: { kind: "percent", bp: 1000 }, scope: { kind: "bill" }, locationIds: [], channels: ["dine_in"], validFrom: null, validTo: null, weekdays: [], timeWindows: [], minSpendCents: 0, maxDiscountCents: null, usageLimit: null, perCustomerLimit: null, code: null, stacking: "exclusive", priority: 0, name: "Nueva promoción" })
}
