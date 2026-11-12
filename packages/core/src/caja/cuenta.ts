/** Cálculos exactos con BigInt. Se usa el constructor para admitir el target de Next. */
import { assertCents, splitEvenly } from "../money"
import { localize } from "../carta/textos"
import { lineDisplayName } from "../carta/pedido"
import type { OrderLineWithId } from "../sala/modelo"
import { AmountCentsSchema, BillAdjustmentSchema, BillLineSchema, type BillAdjustment, type BillLine, type BillPart, type BillStatus } from "./modelo"

export function sumCents(values: readonly number[]): number {
  return assertCents(Number(values.reduce((s, v) => s + BigInt(assertCents(v)), BigInt(0))))
}
/** Redondeo simétrico al más cercano; medio céntimo se aleja de cero. */
export function roundRatio(numerator: bigint, denominator: bigint): number {
  if (denominator <= BigInt(0)) throw new Error("Divisor no válido.")
  const sign = numerator < BigInt(0) ? -BigInt(1) : BigInt(1)
  const n = numerator * sign
  return assertCents(Number(sign * ((n + denominator / BigInt(2)) / denominator)))
}
/** Reparto por restos mayores. Empates: orden de entrada, fijado y persistido por servidor. */
export function allocateCents(total: number, weights: readonly number[]): number[] {
  AmountCentsSchema.parse(total)
  if (!weights.length) throw new Error("Faltan partes.")
  weights.forEach((w) => AmountCentsSchema.parse(w))
  const sum = weights.reduce((s, v) => s + BigInt(v), BigInt(0))
  if (sum === BigInt(0)) {
    if (total !== 0) throw new Error("Faltan pesos para repartir.")
    return weights.map(() => 0)
  }
  const rows = weights.map((w, i) => ({ i, value: Number(BigInt(total) * BigInt(w) / sum), rest: BigInt(total) * BigInt(w) % sum }))
  let remaining = total - sumCents(rows.map((r) => r.value))
  const priority = [...rows].sort((a, b) => a.rest === b.rest ? a.i - b.i : a.rest > b.rest ? -1 : 1)
  for (const row of priority) { if (remaining-- <= 0) break; row.value++ }
  return rows.map((r) => r.value)
}

/** Nunca deduce IVA de la carta actual. Las líneas antiguas exigen migración explícita. */
export function billLinesFromOrderLines(lines: readonly OrderLineWithId[]): BillLine[] {
  if (new Set(lines.map((l) => l.id)).size !== lines.length) throw new Error("Hay líneas repetidas.")
  if (lines.some((l) => l.status === "pending")) throw new Error("Hay pedidos por aceptar.")
  return lines.filter((l) => l.status !== "cancelled").map((l) => {
    if (l.taxRate == null) throw new Error(`Falta confirmar el IVA histórico de ${l.id}.`)
    return BillLineSchema.parse({ lineId: l.id, parentLineId: l.parentLineId, name: [lineDisplayName(l, "es"), ...l.modifiers.map((m) => localize(m.name, "es"))].join(", ").slice(0, 160),
      quantity: l.quantity, grossCents: l.totalCents, taxRate: l.taxRate, guest: l.guest })
  })
}
export function netBillLines(lines: readonly BillLine[], adjustments: readonly BillAdjustment[]): BillLine[] {
  lines.forEach((l) => BillLineSchema.parse(l))
  if (new Set(lines.map((l) => l.lineId)).size !== lines.length) throw new Error("Hay líneas repetidas.")
  if (new Set(adjustments.map((a) => a.id)).size !== adjustments.length) throw new Error("Hay ajustes repetidos.")
  for (const a of adjustments) {
    BillAdjustmentSchema.parse(a)
    if (!lines.some((l) => l.lineId === a.lineId)) throw new Error("El ajuste no pertenece a esta cuenta.")
  }
  for (const l of lines) {
    if (l.parentLineId !== null && !lines.some((p) => p.lineId === l.parentLineId && p.parentLineId === null)) throw new Error("Falta el padre del componente de menú.")
  }
  return lines.map((l) => {
    const reduction = sumCents(adjustments.filter((a) => a.lineId === l.lineId).map((a) => a.amountCents))
    if (reduction > l.grossCents) throw new Error("No se puede descontar más que el importe de la línea.")
    return { ...l, grossCents: l.grossCents - reduction }
  })
}
export interface VatTotal { taxRate: number; grossCents: number; baseCents: number; taxCents: number }
/** Se redondea una vez por tipo y documento, no por unidad ni por línea. */
export function vatBreakdown(lines: readonly Pick<BillLine, "grossCents" | "taxRate">[]): VatTotal[] {
  const groups = new Map<number, number[]>()
  for (const l of lines) (groups.get(l.taxRate) ?? (groups.set(l.taxRate, []), groups.get(l.taxRate)!)).push(assertCents(l.grossCents))
  return [...groups].sort(([a], [b]) => a - b).map(([taxRate, values]) => {
    if (![0, 4, 10, 21].includes(taxRate)) throw new Error("Tipo de IVA no admitido.")
    const grossCents = sumCents(values)
    const baseCents = roundRatio(BigInt(grossCents) * BigInt(100), BigInt(100 + taxRate))
    return { taxRate, grossCents, baseCents, taxCents: grossCents - baseCents }
  })
}
export type SplitSpec = { kind: "equal"; parts: number } | { kind: "amount"; amountsCents: number[] } | { kind: "dishes"; lineIds: string[][] }
export type PartPlan = Pick<BillPart, "allocations" | "totalCents">
/** Produce una matriz conservativa: suma de filas y columnas exacta. */
export function splitBill(lines: readonly BillLine[], spec: SplitSpec): PartPlan[] {
  if (!lines.length) throw new Error("La cuenta no tiene líneas.")
  const total = sumCents(lines.map((l) => l.grossCents))
  const check = netBillLines(lines, [])
  if (spec.kind === "dishes") {
    const flat = spec.lineIds.flat()
    if (!spec.lineIds.length || spec.lineIds.some((g) => !g.length) || new Set(flat).size !== flat.length) throw new Error("Reparto de platos no válido.")
    const mains = check.filter((l) => l.parentLineId === null).map((l) => l.lineId)
    if (flat.length !== mains.length || !flat.every((id) => mains.includes(id))) throw new Error("Reparte todos los platos principales una sola vez.")
    return spec.lineIds.map((ids) => {
      const allocations = check.filter((l) => ids.includes(l.lineId) || (l.parentLineId !== null && ids.includes(l.parentLineId))).map((l) => ({ lineId: l.lineId, amountCents: l.grossCents }))
      return { allocations, totalCents: sumCents(allocations.map((a) => a.amountCents)) }
    })
  }
  if (spec.kind === "equal" && (!Number.isInteger(spec.parts) || spec.parts < 1 || spec.parts > 200)) throw new Error("Número de partes no válido.")
  const amounts = spec.kind === "equal" ? splitEvenly(total, spec.parts) : spec.amountsCents
  if (!amounts.length || amounts.length > 200 || amounts.some((n) => !AmountCentsSchema.safeParse(n).success) || sumCents(amounts) !== total) throw new Error("Los importes no suman la cuenta.")
  const remaining = [...amounts]
  const result: PartPlan[] = amounts.map((n) => ({ totalCents: n, allocations: [] }))
  for (const line of check) {
    const parts = allocateCents(line.grossCents, remaining)
    parts.forEach((n, i) => { result[i]!.allocations.push({ lineId: line.lineId, amountCents: n }); remaining[i] = remaining[i]! - n })
  }
  return result
}
export const BILL_TRANSITIONS: Record<BillStatus, readonly BillStatus[]> = {
  open: ["locked", "cancelled"], locked: ["open", "settled"], settled: [], cancelled: [],
}
export function checkBillTransition(from: BillStatus, to: BillStatus, paidCents: number, pendingPayments: number, dueCents: number): void {
  if (!BILL_TRANSITIONS[from].includes(to)) throw new Error("Cambio de cuenta no permitido.")
  if ((to === "open" || to === "cancelled") && (paidCents !== 0 || pendingPayments !== 0)) throw new Error("La cuenta ya tiene cobros o pagos en curso.")
  if (to === "settled" && (dueCents !== 0 || pendingPayments !== 0)) throw new Error("Falta completar el cobro.")
}
/** Se pasa el total ya cobrado, nunca el entregado con cambio ni las propinas. */
export function paymentBalance(totalCents: number, charges: number[], refunds: number[]) {
  AmountCentsSchema.parse(totalCents)
  ;[...charges, ...refunds].forEach((n) => AmountCentsSchema.parse(n))
  const paidCents = sumCents(charges), refundedCents = sumCents(refunds)
  if (refundedCents > paidCents || paidCents > totalCents) throw new Error("Cobros o devoluciones fuera del saldo.")
  return { paidCents, refundedCents, dueCents: totalCents - paidCents }
}
export function cashChange(amountCents: number, tipCents: number, tenderedCents: number): number {
  ;[amountCents, tipCents, tenderedCents].forEach((n) => AmountCentsSchema.parse(n))
  const change = tenderedCents - sumCents([amountCents, tipCents])
  if (change < 0) throw new Error("El efectivo entregado no cubre el cobro y la propina.")
  return change
}

/** Cobro parcial contra saldo menos reservas de pago concurrentes. */
export function checkCharge(totalCents: number, paidCents: number, reservedCents: number, amountCents: number): void {
  ;[totalCents, paidCents, reservedCents, amountCents].forEach((n) => AmountCentsSchema.parse(n))
  if (amountCents === 0 || sumCents([paidCents, reservedCents, amountCents]) > totalCents) throw new Error("El importe supera el saldo disponible.")
}
