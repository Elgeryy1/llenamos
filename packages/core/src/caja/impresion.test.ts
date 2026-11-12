import { describe, expect, it, vi } from "vitest"
import { encodeEscPos, prebillPrintDocument, kitchenPrintDocument, invoicePrintDocument, drawerPulse, createTestFiscalProvider } from "../index"
import { testFiscalRecord, testInvoice } from "./datos-prueba"

describe("ESC/POS", () => {
  it("imprime comanda con notas y quita órdenes de control introducidas en texto", () => {
    const doc = kitchenPrintDocument({ label: "S3", orderId: "o1", station: "Cocina", time: "13:00", lines: [{ quantity: 2, name: "Café\u001bp\u0000", course: "Postres", notes: "Sin azúcar" }] })
    const bytes = [...encodeEscPos(doc, { paperMm: 58, columns: 32 })]
    expect(bytes.slice(0, 5)).toEqual([27, 64, 27, 116, 19])
    expect(bytes).toContain(130) // é en CP858.
    expect(bytes.join(",")).not.toContain("27,112,0")
    expect(bytes.slice(-4)).toEqual([29, 86, 66, 0])
  })
  it("la precuenta se identifica y no abre cajón", () => {
    const doc = prebillPrintDocument(["Total 11,00 EUR"])
    expect(doc.fiscal).toBeNull()
    expect(doc.lines.some((l) => l.text === "No es una factura")).toBe(true)
    expect([...drawerPulse()]).toEqual([27, 112, 0, 50, 100])
  })
  it("exige QR M, coloca el fiscal antes del contenido y mantiene aviso y copia", () => {
    const artifact = createTestFiscalProvider().prepare({ regime: "verifactu", record: testFiscalRecord(), ticketbaiPrevious: null })
    const doc = invoicePrintDocument(testInvoice(), { qrUrl: artifact.qrUrl!, legend: artifact.legend, warning: artifact.warning }, true)
    // Matriz sintética para comprobar geometría, no representa un QR escaneable.
    const qr = vi.fn(() => Array.from({ length: 53 }, () => Array.from({ length: 53 }, () => true)))
    const bytes = [...encodeEscPos(doc, { paperMm: 80, columns: 48 }, qr)]
    expect(qr).toHaveBeenCalledWith(artifact.qrUrl, "M")
    expect(doc.lines[0]?.text).toBe("Copia")
    expect(bytes.join(",")).toContain("29,118,48,0")
    expect(() => encodeEscPos(doc, { paperMm: 58, columns: 32 })).toThrow("codificador QR")
    expect(() => encodeEscPos(doc, { paperMm: 80, columns: 48 }, () => [[true]])).toThrow()
    expect(() => encodeEscPos({ ...doc, fiscal: null }, { paperMm: 80, columns: 48 })).toThrow()
  })
  it("perfiles de 58 y 80 mm conservan los campos largos mediante saltos", () => {
    const doc = prebillPrintDocument(["A".repeat(100)])
    for (const profile of [{ paperMm: 58 as const, columns: 32 as const }, { paperMm: 80 as const, columns: 48 as const }]) {
      const bytes = [...encodeEscPos(doc, profile)]
      expect(bytes.filter((b) => b === 65)).toHaveLength(100)
    }
  })
})
