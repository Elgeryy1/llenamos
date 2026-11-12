/** Ejemplos locales. El NIF de los vectores es el publicado por AEAT, no un negocio real. */
import type { BillLine } from "./modelo"
import { invoiceTotals } from "./facturas"
import type { FiscalRecordInput, Invoice } from "./fiscal-modelo"
export function testBillLines(): BillLine[] {
  return [
    { lineId: "menu", parentLineId: null, name: "Menú", quantity: 1, grossCents: 1550, taxRate: 10, guest: 1 },
    { lineId: "extra", parentLineId: "menu", name: "Suplemento", quantity: 1, grossCents: 400, taxRate: 10, guest: 1 },
    { lineId: "vino", parentLineId: null, name: "Vino", quantity: 1, grossCents: 501, taxRate: 21, guest: 2 },
  ]
}
export function testInvoice(): Invoice {
  const lines: Invoice["lines"] = [{ description: "Comida", quantity: 1, unitPriceCents: 1100, discountCents: 0, grossCents: 1100, taxRate: 10, sourceLineId: "l1" }]
  return { billId: "b1", partId: "p1", issuer: { name: "Prueba", nif: "89890001K", address: "Dirección de prueba" },
    recipient: { name: "Receptor de prueba", address: "Otra dirección", identity: { kind: "nif", nif: "89890001K" } },
    seriesId: "s1", sequence: 1, number: "TEST/000001", issueDate: "01-01-2024", operationDate: "01-01-2024",
    type: "F1", qualifiedSimplified: false, description: "Restauración de prueba", lines, ...invoiceTotals(lines), correction: null, replacedInvoices: [] }
}
export function testFiscalRecord(): Extract<FiscalRecordInput, { kind: "alta" }> {
  return { recordId: "r1", chainId: "chain1", chainSequence: 1, version: "1.0", kind: "alta", invoice: testInvoice(),
    generatedAt: "2024-01-01T19:20:30+01:00", previous: null, subsanacion: false, previousRejection: false, correctionOfRecordId: null,
    system: { producerName: "Desarrollo de prueba", producerNif: "89890001K", name: "Llenamos local", id: "LL", version: "test", installation: "demo", onlyVerifactu: true, multiTaxpayer: true, multipleTaxpayers: false } }
}
