import { AmountCentsSchema, type CashMovement, type Payment } from "./modelo"
import { allocateCents, sumCents } from "./cuenta"

/** Caja física: las propinas en efectivo entran hasta pagar su reparto mediante movimiento. */
export function cashReconciliation(openingCents: number, payments: readonly Payment[], movements: readonly CashMovement[], countedCents: number) {
  AmountCentsSchema.parse(openingCents)
  AmountCentsSchema.parse(countedCents)
  const cash = payments.filter((p) => p.method === "cash" && p.status === "succeeded")
  const expectedCents = sumCents([openingCents,
    ...cash.map((p) => (p.kind === "charge" ? 1 : -1) * sumCents([p.amountCents, p.tipCents])),
    ...movements.map((m) => (m.kind === "in" ? 1 : -1) * m.amountCents),
  ])
  return { expectedCents, countedCents, differenceCents: sumCents([countedCents, -expectedCents]) }
}
/**
 * Reparto por minutos enteros y uid estable. Desde la fase 4 los minutos se proponen con
 * `tipHoursForWindow` (horas fichadas dentro de la caja) y el encargado los aprueba o corrige;
 * `repartirPropinas` sigue aceptando los minutos que se le envían.
 */
export function distributeTips(totalCents: number, hours: readonly { uid: string; minutes: number }[]) {
  if (new Set(hours.map((h) => h.uid)).size !== hours.length || hours.some((h) => !h.uid || !Number.isSafeInteger(h.minutes) || h.minutes < 0)) throw new Error("Horas de reparto no válidas.")
  const sorted = [...hours].sort((a, b) => a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0)
  const amounts = allocateCents(totalCents, sorted.map((h) => h.minutes))
  return sorted.map((h, i) => ({ ...h, amountCents: amounts[i]! }))
}
