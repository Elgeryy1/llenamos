import { InvoiceSchema, type Invoice, type InvoiceIdentity } from "./fiscal-modelo"
import { BillLineSchema, AmountCentsSchema, type BillLine, type BillPart, type Payment } from "./modelo"
import { sumCents, vatBreakdown } from "./cuenta"

/** El IVA se calcula por documento. Dos facturas separadas pueden redondear distinto que una. */
export function invoiceTotals(lines: Invoice["lines"]) {
  const taxes = vatBreakdown(lines).map(({ taxRate, baseCents, taxCents }) => ({
    taxRate: taxRate as BillLine["taxRate"], baseCents, taxCents, tax: "01" as const, regimeKey: "01" as const, qualification: "S1" as const,
  }))
  return { taxes, taxCents: sumCents(taxes.map((t) => t.taxCents)), totalCents: sumCents(lines.map((l) => l.grossCents)) }
}
/** Una participación por importe tiene cantidad 1; conserva descripción y fuente original. */
export function invoiceLinesForPart(lines: readonly BillLine[], part: Pick<BillPart, "allocations" | "totalCents">): Invoice["lines"] {
  lines.forEach((l) => BillLineSchema.parse(l))
  if (new Set(part.allocations.map((a) => a.lineId)).size !== part.allocations.length) throw new Error("Hay asignaciones repetidas.")
  const result = part.allocations.map((a) => {
    const l = lines.find((l) => l.lineId === a.lineId)
    AmountCentsSchema.parse(a.amountCents)
    if (!l || a.amountCents > l.grossCents) throw new Error("La parte no coincide con sus líneas.")
    const whole = a.amountCents === l.grossCents
    const description = l.quantity > 1 ? `${l.quantity} x ${l.name}` : l.name
    return { description: (whole ? description : `Parte de ${description}`).slice(0, 160), quantity: 1,
      unitPriceCents: a.amountCents, discountCents: 0, grossCents: a.amountCents, taxRate: l.taxRate, sourceLineId: l.lineId }
  })
  if (sumCents(result.map((l) => l.grossCents)) !== part.totalCents) throw new Error("El total de la parte no coincide.")
  return result
}
export function invoiceIdentity(invoice: Invoice): InvoiceIdentity {
  return { issuerNif: invoice.issuer.nif, number: invoice.number, issueDate: invoice.issueDate }
}
export function rectifyInvoice(original: Invoice, input: {
  type: "R1" | "R2" | "R3" | "R4" | "R5"; mode: "I" | "S"; reason: string;
  reductions: { lineIndex: number; amountCents: number }[];
  seriesId: string; sequence: number; number: string; issueDate: string;
}): Invoice {
  InvoiceSchema.parse(original)
  if (original.type.startsWith("R")) throw new Error("La corrección de una rectificativa requiere revisión del proveedor.")
  if (new Set(input.reductions.map((r) => r.lineIndex)).size !== input.reductions.length || !input.reductions.length) throw new Error("Hay líneas repetidas o falta la reducción.")
  for (const r of input.reductions) {
    const line = original.lines[r.lineIndex]
    if (!Number.isInteger(r.lineIndex) || !line || r.amountCents <= 0 || r.amountCents > line.grossCents || !Number.isSafeInteger(r.amountCents)) throw new Error("Reducción fuera del importe original.")
  }
  const lines = original.lines.flatMap((l, i) => {
    const amount = input.reductions.find((r) => r.lineIndex === i)?.amountCents ?? 0
    const grossCents = input.mode === "I" ? -amount : l.grossCents - amount
    if (input.mode === "I" && amount === 0) return []
    return [{ ...l, quantity: 1, unitPriceCents: grossCents, discountCents: 0, grossCents }]
  })
  const totals = invoiceTotals(lines)
  return InvoiceSchema.parse({ ...original, ...totals, lines, type: input.type, qualifiedSimplified: false,
    seriesId: input.seriesId, sequence: input.sequence, number: input.number, issueDate: input.issueDate,
    correction: { mode: input.mode, reason: input.reason, invoices: [invoiceIdentity(original)],
      correctedBaseCents: input.mode === "S" ? sumCents(original.taxes.map((t) => t.baseCents)) : null,
      correctedTaxCents: input.mode === "S" ? original.taxCents : null }, replacedInvoices: [] })
}
export function checkRefund(original: Payment, refunds: readonly Payment[], amountCents: number, tipCents: number): void {
  ;[amountCents, tipCents].forEach((v) => AmountCentsSchema.parse(v))
  if (original.kind !== "charge" || original.status !== "succeeded" || (amountCents === 0 && tipCents === 0)) throw new Error("El cobro no permite esta devolución.")
  // Incluye las devoluciones pendientes para no reservar dos veces el mismo saldo.
  const active = refunds.filter((r) => r.status === "pending" || r.status === "succeeded")
  if (sumCents([amountCents, ...active.map((r) => r.amountCents)]) > original.amountCents || sumCents([tipCents, ...active.map((r) => r.tipCents)]) > original.tipCents) throw new Error("La devolución supera lo cobrado.")
}
