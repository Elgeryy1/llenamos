import { describe, expect, it } from "vitest"
import {
  allocateCents, billLinesFromOrderLines, netBillLines, splitBill, sumCents, vatBreakdown, roundRatio,
  cashChange, cashReconciliation, distributeTips, paymentBalance, checkBillTransition, checkRefund, checkCharge,
  invoiceLinesForPart, invoiceTotals, rectifyInvoice, InvoiceSchema, BillSchema, billForWrite,
  PaymentSchema, paymentForWrite, CashSessionSchema, cashSessionForWrite, nextItemVersion,
  nextDailyMenuVersion, demoMenu, planOrderLines, priceOrder, OrderLinesInputSchema,
  type Payment, type BillAdjustment, type Bill,
} from "../index"
import { linea } from "../sala/datos-prueba"
import { testBillLines, testInvoice } from "./datos-prueba"

const adjustment = (changes: Partial<BillAdjustment> = {}): BillAdjustment => ({ id: "a1", lineId: "vino", kind: "invitation", amountCents: 101, reason: "Invitación de la casa", at: 1000, by: "encargada", ...changes })
const payment = (changes: Partial<Payment> = {}): Payment => ({ billId: "b1", partId: "p1", cashSessionId: "c1", kind: "charge", originalPaymentId: null, method: "cash", status: "succeeded", amountCents: 1000, tipCents: 100, tenderedCents: 2000, changeCents: 900, externalId: null, requestId: "req1", reason: null, at: 1000, by: "camarero", ...changes })

describe("cuenta y partes", () => {
  it("suma menú y suplementos una vez, y descuenta invitaciones con motivo", () => {
    const net = netBillLines(testBillLines(), [adjustment()])
    expect(sumCents(net.map((l) => l.grossCents))).toBe(2350)
    expect(() => netBillLines(testBillLines(), [adjustment({ amountCents: 502 })])).toThrow()
    expect(() => netBillLines(testBillLines(), [adjustment({ reason: " " })])).toThrow()
    expect(() => netBillLines(testBillLines(), [adjustment(), adjustment()])).toThrow()
    expect(() => netBillLines(testBillLines(), [adjustment({ lineId: "ajena" })])).toThrow()
  })
  it("divide por platos moviendo el menú entero", () => {
    const parts = splitBill(testBillLines(), { kind: "dishes", lineIds: [["menu"], ["vino"]] })
    expect(parts.map((p) => p.totalCents)).toEqual([1950, 501])
    expect(parts[0]?.allocations.map((a) => a.lineId)).toEqual(["menu", "extra"])
    for (const ids of [[["menu"], ["extra", "vino"]], [["menu"]], [["menu"], ["menu", "vino"]]]) expect(() => splitBill(testBillLines(), { kind: "dishes", lineIds: ids })).toThrow()
    expect(() => splitBill(testBillLines().slice(1), { kind: "dishes", lineIds: [["vino"]] })).toThrow()
  })
  it("partes iguales e importes conservan cada fila y columna hasta el último céntimo", () => {
    for (let total = 0; total < 200; total++) for (let n = 1; n <= 9; n++) {
      const lines = [{ ...testBillLines()[0]!, grossCents: total }, { ...testBillLines()[2]!, grossCents: total + 1 }]
      const parts = splitBill(lines, { kind: "equal", parts: n })
      expect(sumCents(parts.map((p) => p.totalCents))).toBe(total * 2 + 1)
      for (const part of parts) expect(sumCents(part.allocations.map((a) => a.amountCents))).toBe(part.totalCents)
      lines.forEach((l) => expect(sumCents(parts.flatMap((p) => p.allocations.filter((a) => a.lineId === l.lineId).map((a) => a.amountCents)))).toBe(l.grossCents))
    }
    expect(splitBill(testBillLines(), { kind: "amount", amountsCents: [1, 0, 2450] }).map((p) => p.totalCents)).toEqual([1, 0, 2450])
    expect(() => splitBill(testBillLines(), { kind: "amount", amountsCents: [100] })).toThrow()
    expect(() => splitBill(testBillLines(), { kind: "equal", parts: 0 })).toThrow()
  })
  it("rechaza dinero inseguro y mantiene los productos intermedios exactos", () => {
    expect(allocateCents(Number.MAX_SAFE_INTEGER, [1, 1])).toEqual([4503599627370496, 4503599627370495])
    expect(() => sumCents([Number.MAX_SAFE_INTEGER, 1])).toThrow()
    expect(() => allocateCents(1.5, [1])).toThrow()
    expect(() => allocateCents(1, [0, 0])).toThrow()
    expect(allocateCents(0, [0, 0])).toEqual([0, 0])
    expect(roundRatio(-BigInt(5), BigInt(2))).toBe(-3)
  })
  it("calcula IVA incluido agrupando por tipo y redondeando una sola vez", () => {
    expect(vatBreakdown([{ grossCents: 1100, taxRate: 10 }, { grossCents: 121, taxRate: 21 }, { grossCents: 104, taxRate: 4 }, { grossCents: 7, taxRate: 0 }])).toEqual([
      { taxRate: 0, grossCents: 7, baseCents: 7, taxCents: 0 }, { taxRate: 4, grossCents: 104, baseCents: 100, taxCents: 4 },
      { taxRate: 10, grossCents: 1100, baseCents: 1000, taxCents: 100 }, { taxRate: 21, grossCents: 121, baseCents: 100, taxCents: 21 },
    ])
    expect(vatBreakdown([{ grossCents: -1100, taxRate: 10 }])[0]).toMatchObject({ baseCents: -1000, taxCents: -100 })
    expect(vatBreakdown([{ grossCents: 3, taxRate: 21 }, { grossCents: 3, taxRate: 21 }])[0]?.taxCents).toBe(1)
  })
  it("no cobra pendientes, anulados ni líneas sin IVA histórico", () => {
    expect(billLinesFromOrderLines([{ ...linea({ taxRate: 10 }), id: "l1" }, { ...linea({ status: "cancelled" }), id: "l2" }])).toHaveLength(1)
    expect(() => billLinesFromOrderLines([{ ...linea({ status: "pending", taxRate: 10 }), id: "l1" }])).toThrow("por aceptar")
    expect(() => billLinesFromOrderLines([{ ...linea(), id: "l1" }])).toThrow("IVA histórico")
  })
  it("congela IVA de platos y menú en los borradores y versiona cambios de IVA", () => {
    const d = demoMenu(), raw = [{ kind: "item", itemId: "bravas", quantity: 1 }, { kind: "menu", dailyMenuId: "mediodia", quantity: 1, selections: [{ sectionId: "primeros", itemId: "sopa" }, { sectionId: "segundos", itemId: "pollo" }, { sectionId: "postres", itemId: "crema" }] }]
    const priced = priceOrder(OrderLinesInputSchema.parse(raw), d, { channel: "staff", now: Date.UTC(2026, 10, 9, 12, 30), timezone: "Europe/Madrid" })
    expect(priced.ok).toBe(true)
    const drafts = planOrderLines(priced.lines, d.items, d.stations, d.settings, d.dailyMenus)
    expect(drafts.every((l) => l.taxRate === 10)).toBe(true)
    expect(nextItemVersion(d.items.bravas!, { ...d.items.bravas!, taxRate: 21 })).toBe(d.items.bravas!.version + 1)
    expect(nextDailyMenuVersion(d.dailyMenus.mediodia!, { ...d.dailyMenus.mediodia!, taxRate: 21 })).toBe(d.dailyMenus.mediodia!.version + 1)
  })
})

describe("cobros, devoluciones y caja", () => {
  it("distingue entrega, cambio, propina y consumo", () => {
    expect(cashChange(1000, 100, 2000)).toBe(900)
    expect(() => cashChange(1000, 100, 1099)).toThrow()
    expect(paymentBalance(1500, [1000, 500], [500])).toEqual({ paidCents: 1500, refundedCents: 500, dueCents: 0 })
    expect(() => paymentBalance(1000, [1001], [])).toThrow()
    expect(() => paymentBalance(1000, [500], [501])).toThrow()
    expect(() => checkBillTransition("locked", "settled", 500, 0, 500)).toThrow()
    expect(() => checkBillTransition("locked", "open", 500, 0, 500)).toThrow()
    expect(() => checkBillTransition("locked", "open", 0, 1, 1000)).toThrow()
    expect(() => checkBillTransition("settled", "open", 1000, 0, 0)).toThrow()
    expect(() => checkBillTransition("locked", "settled", 1000, 0, 0)).not.toThrow()
  })
  it("reserva también los reembolsos pendientes y limita su propina", () => {
    const refund = payment({ kind: "refund", originalPaymentId: "p1", amountCents: 600, tipCents: 50, status: "pending", reason: "Devolución" })
    expect(() => checkRefund(payment(), [refund], 401, 0)).toThrow()
    expect(() => checkRefund(payment(), [refund], 400, 51)).toThrow()
    expect(() => checkRefund(payment(), [refund], 400, 50)).not.toThrow()
    expect(() => checkRefund(payment(), [], 0, 100)).not.toThrow()
    expect(() => checkCharge(1000, 300, 500, 201)).toThrow()
    expect(() => checkCharge(1000, 300, 500, 200)).not.toThrow()
    expect(() => checkRefund(payment({ status: "pending" }), [], 1, 0)).toThrow()
  })
  it("arquea solo efectivo confirmado con propinas y movimientos", () => {
    const result = cashReconciliation(10_000, [payment(), payment({ method: "card" }), payment({ status: "pending" }), payment({ kind: "refund", amountCents: 200, tipCents: 0 })], [{ cashSessionId: "c1", kind: "out", amountCents: 300, reason: "Compra", at: 1000, by: "u1", requestId: "m1" }], 10_500)
    expect(result).toEqual({ expectedCents: 10_600, countedCents: 10_500, differenceCents: -100 })
  })
  it("reparte propinas por minutos y desempata por uid sin perder céntimos", () => {
    const hours = [{ uid: "b", minutes: 60 }, { uid: "a", minutes: 60 }, { uid: "c", minutes: 0 }]
    expect(distributeTips(101, hours).map((s) => [s.uid, s.amountCents])).toEqual([["a", 51], ["b", 50], ["c", 0]])
    expect(distributeTips(101, hours.reverse()).map((s) => s.amountCents)).toEqual([51, 50, 0])
    expect(() => distributeTips(1, [{ uid: "a", minutes: 0 }])).toThrow()
    expect(() => distributeTips(1, [{ uid: "a", minutes: 1 }, { uid: "a", minutes: 2 }])).toThrow()
  })
})

describe("facturas y documentos", () => {
  it("factura una parte desde sus importes, sin aceptar precios", () => {
    const part = splitBill(testBillLines(), { kind: "amount", amountsCents: [100, 2351] })[0]!
    const lines = invoiceLinesForPart(testBillLines(), part)
    expect(invoiceTotals(lines).totalCents).toBe(100)
    expect(lines[0]?.description).toContain("Parte de")
    expect(() => invoiceLinesForPart(testBillLines(), { ...part, totalCents: 101 })).toThrow()
  })
  it("rectifica por diferencias negativas o sustitución y conserva el original", () => {
    const original = testInvoice()
    const input = { type: "R4" as const, mode: "I" as const, reason: "Devolución parcial", reductions: [{ lineIndex: 0, amountCents: 550 }], seriesId: "rect", sequence: 1, number: "R/000001", issueDate: "02-01-2024" }
    const difference = rectifyInvoice(original, input)
    expect(difference).toMatchObject({ totalCents: -550, taxCents: -50, correction: { mode: "I", correctedBaseCents: null } })
    const replacement = rectifyInvoice(original, { ...input, mode: "S" })
    expect(replacement).toMatchObject({ totalCents: 550, correction: { correctedBaseCents: 1000, correctedTaxCents: 100 } })
    expect(original.totalCents).toBe(1100)
    expect(() => rectifyInvoice(original, { ...input, reductions: [{ lineIndex: 0, amountCents: 1101 }] })).toThrow()
  })
  it("exige destinatario, referencias, totales coherentes y límite de simplificada", () => {
    const i = testInvoice()
    expect(InvoiceSchema.safeParse({ ...i, recipient: null }).success).toBe(false)
    expect(InvoiceSchema.safeParse({ ...i, totalCents: 999 }).success).toBe(false)
    expect(InvoiceSchema.safeParse({ ...i, type: "R4" }).success).toBe(false)
    expect(InvoiceSchema.safeParse({ ...i, type: "F3" }).success).toBe(false)
    expect(InvoiceSchema.safeParse({ ...i, type: "F2", recipient: null }).success).toBe(true)
    expect(InvoiceSchema.safeParse({ ...i, type: "F2", recipient: null, totalCents: 300001 }).success).toBe(false)
    expect(InvoiceSchema.safeParse({ ...i, issueDate: "31-02-2024" }).success).toBe(false)
  })
  it("adapta Timestamp sin cambiar fechas fiscales ni dejar ms en documentos", () => {
    const bill: Bill = { target: { kind: "session", id: "s1" }, customerId: null, status: "open", revision: 1, lines: testBillLines(), adjustments: [adjustment()], totalCents: 2350, paidCents: 0, refundedCents: 0, openedAt: 1000, lockedAt: null, settledAt: null }
    const convert = (ms: number) => ({ seconds: ms / 1000, nanoseconds: 0 })
    expect(BillSchema.parse(billForWrite(bill, convert))).toEqual(bill)
    expect(PaymentSchema.parse(paymentForWrite(payment(), convert))).toEqual(payment())
    expect(PaymentSchema.safeParse(payment({ changeCents: 0 })).success).toBe(false)
    const cash = { registerId: "r1", status: "open" as const, openingCents: 1000, openedAt: 1000, openedBy: "u1", closedAt: null, closedBy: null, countedCents: null, expectedCents: null, differenceCents: null, closeReason: null }
    expect(CashSessionSchema.parse(cashSessionForWrite(cash, convert))).toEqual(cash)
  })
})
