import { describe, expect, it } from "vitest"
import {
  createTestFiscalProvider, FiscalRecordInputSchema, prepareFiscalRecord, verifactuHash,
  verifactuHashInput, verifactuRecordXml, verifyFiscalChain, verifactuQrUrl, fiscalDecimal,
  nextInvoiceNumber, fiscalIdentity, FiscalDateTimeSchema, rectifyInvoice, type FiscalRecordInput,
} from "../index"
import { testFiscalRecord } from "./datos-prueba"

// Vectores de AEAT, especificación 0.1.2, páginas 10 a 12. Sus cifras son ilustrativas.
function aeatVector() {
  const r = testFiscalRecord()
  r.invoice = { ...r.invoice, number: "12345678/G33", taxCents: 1235, totalCents: 12345,
    lines: [{ ...r.invoice.lines[0]!, grossCents: 12345, unitPriceCents: 12345 }],
    taxes: [{ ...r.invoice.taxes[0]!, baseCents: 11110, taxCents: 1235 }] }
  return r
}
describe("huella oficial VERI*FACTU", () => {
  it("coincide con los tres vectores oficiales de alta, alta encadenada y anulación", () => {
    const first = aeatVector()
    const h1 = verifactuHash(first)
    expect(h1).toBe("3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60")
    expect(verifactuHashInput(first)).toBe("IDEmisorFactura=89890001K&NumSerieFactura=12345678/G33&FechaExpedicionFactura=01-01-2024&TipoFactura=F1&CuotaTotal=12.35&ImporteTotal=123.45&Huella=&FechaHoraHusoGenRegistro=2024-01-01T19:20:30+01:00")
    const second = { ...first, recordId: "r2", chainSequence: 2, generatedAt: "2024-01-01T19:20:35+01:00", invoice: { ...first.invoice, number: "12345679/G34" }, previous: { ...fiscalIdentity(first), recordId: "r1", hash: h1 } }
    const h2 = verifactuHash(second)
    expect(h2).toBe("F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97")
    const third: FiscalRecordInput = { recordId: "r3", chainId: first.chainId, chainSequence: 3, version: "1.0", system: first.system,
      kind: "anulacion", invoice: fiscalIdentity(second), generatedAt: "2024-01-01T19:20:40+01:00", reason: "Alta por error", noPreviousRecord: false, previousRejection: false,
      previous: { ...fiscalIdentity(second), recordId: "r2", hash: h2 } }
    expect(verifactuHash(third)).toBe("177547C0D57AC74748561D054A9CEC14B4C4EA23D1BEFD6F2E69E3A388F90C68")
    expect(verifyFiscalChain([first, second, third].map(prepareFiscalRecord))).toBe(true)
    expect(verifactuRecordXml(third)).toContain("<IDEmisorFacturaAnulada>89890001K</IDEmisorFacturaAnulada>")
    expect(verifactuRecordXml(third)).not.toContain("<TipoFactura>")
  })
  it("detecta omisiones, reordenación, saltos, alteraciones y cambios fuera de la huella oficial", () => {
    const first = prepareFiscalRecord(testFiscalRecord())
    const second = prepareFiscalRecord({ ...first.input, recordId: "r2", chainSequence: 2, previous: { ...fiscalIdentity(first.input), recordId: "r1", hash: first.hash } })
    expect(verifyFiscalChain([first, second])).toBe(true)
    expect(verifyFiscalChain([second])).toBe(false)
    expect(verifyFiscalChain([second, first])).toBe(false)
    expect(verifyFiscalChain([first, first])).toBe(false)
    expect(verifyFiscalChain([first, { ...second, hash: "A".repeat(64) }])).toBe(false)
    const changed = testFiscalRecord()
    changed.invoice.issuer.name = "Otra razón social"
    // El hash oficial cubre un subconjunto. El control local adicional cubre la instantánea.
    expect(verifactuHash(changed)).toBe(first.hash)
    expect(verifyFiscalChain([{ ...first, input: changed }])).toBe(false)
    expect(verifyFiscalChain([{ ...first, xml: first.xml.replace("Prueba", "Otro") }])).toBe(false)
  })
  it("rechaza otra cadena, obligado, secuencia o instante anterior", () => {
    const r = testFiscalRecord(), first = prepareFiscalRecord(r)
    const next = { ...r, recordId: "r2", chainSequence: 2, previous: { ...fiscalIdentity(r), recordId: "r1", hash: first.hash } }
    expect(verifyFiscalChain([first, prepareFiscalRecord({ ...next, chainId: "otra" })])).toBe(false)
    expect(verifyFiscalChain([first, prepareFiscalRecord({ ...next, chainSequence: 3 })])).toBe(false)
    expect(verifyFiscalChain([first, prepareFiscalRecord({ ...next, generatedAt: "2024-01-01T19:20:29+01:00" })])).toBe(false)
    expect(FiscalRecordInputSchema.safeParse({ ...next, previous: { ...next.previous, issuerNif: "A00000000" } }).success).toBe(false)
    expect(FiscalDateTimeSchema.safeParse("2024-02-30T19:20:30+01:00").success).toBe(false)
    expect(FiscalDateTimeSchema.safeParse("2024-01-01T25:00:00+01:00").success).toBe(false)
    expect(FiscalDateTimeSchema.safeParse("2024-01-01T19:00:00Z").success).toBe(false)
  })
  it("exporta XML escapado con cabecera, sistema, encadenamiento y campos obligatorios", () => {
    const r = testFiscalRecord()
    r.invoice.issuer.name = "Café & <Prueba>"
    const xml = verifactuRecordXml(r)
    expect(xml).toContain("Café &amp; &lt;Prueba&gt;")
    expect(xml).toContain("<IDVersion>1.0</IDVersion>")
    expect(xml).toContain("<PrimerRegistro>S</PrimerRegistro>")
    expect(xml).toContain("<TipoHuella>01</TipoHuella>")
    expect(xml).toContain("<SistemaInformatico>")
    expect(xml).toContain("<CalificacionOperacion>S1</CalificacionOperacion>")
    expect(xml).toContain("<CuotaTotal>1.00</CuotaTotal><ImporteTotal>11.00</ImporteTotal>")
    expect(xml).not.toContain("undefined")
    expect(xml).not.toContain("null")
  })
  it("incluye NIF en referencias de rectificativas y facturas sustituidas, como exige XSD", () => {
    const r = testFiscalRecord()
    const corrected = rectifyInvoice(r.invoice, { type: "R4", mode: "S", reason: "Reducción", reductions: [{ lineIndex: 0, amountCents: 550 }], seriesId: "rect", sequence: 1, number: "R/000001", issueDate: "02-01-2024" })
    const xml = verifactuRecordXml({ ...r, invoice: corrected })
    expect(xml).toContain("<IDFacturaRectificada><IDEmisorFactura>89890001K</IDEmisorFactura><NumSerieFactura>TEST/000001</NumSerieFactura>")
    const replacement = verifactuRecordXml({ ...r, invoice: { ...r.invoice, type: "F3", replacedInvoices: [fiscalIdentity(r)] } })
    expect(replacement).toContain("<IDFacturaSustituida><IDEmisorFactura>89890001K</IDEmisorFactura>")
  })
  it("forma QR de pruebas o producción con cuatro parámetros y URL encoding", () => {
    const identity = { issuerNif: "89890001K", number: "Serie & A/1", issueDate: "01-01-2024" }
    expect(verifactuQrUrl(identity, 12345)).toBe("https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?nif=89890001K&numserie=Serie%20%26%20A%2F1&fecha=01-01-2024&importe=123.45")
    expect(verifactuQrUrl(identity, -100, "production")).toContain("https://www2.agenciatributaria.gob.es/")
    expect(verifactuQrUrl(identity, -100)).toContain("importe=-1.00")
    expect(fiscalDecimal(1)).toBe("0.01")
    expect(fiscalDecimal(-1)).toBe("-0.01")
    expect(() => fiscalDecimal(1.5)).toThrow()
    expect(() => fiscalDecimal(100_000_000_000_000)).toThrow()
  })
  it("asigna correlativos sin mutar el contador ni reutilizar números anulados", () => {
    const series = { prefix: "TEST/2024", kind: "ordinary" as const, year: 2024, lastSequence: 0, lastIssueDate: null, active: true }
    const a = nextInvoiceNumber(series, "F2", "01-01-2024")
    const b = nextInvoiceNumber(a.series, "F1", "02-01-2024")
    expect(a.number).toBe("TEST/2024/000001")
    expect(b.sequence).toBe(2)
    expect(series.lastSequence).toBe(0)
    expect(() => nextInvoiceNumber(b.series, "F2", "01-01-2024")).toThrow()
    expect(() => nextInvoiceNumber(series, "R4", "01-01-2024")).toThrow()
    expect(() => nextInvoiceNumber(series, "F2", "01-01-2025")).toThrow()
    expect(() => nextInvoiceNumber({ ...series, active: false }, "F2", "01-01-2024")).toThrow()
  })
  it("el proveedor local calcula y nunca finge un envío ni TicketBAI", async () => {
    const provider = createTestFiscalProvider()
    const artifact = provider.prepare({ regime: "verifactu", record: testFiscalRecord(), ticketbaiPrevious: null })
    expect(artifact.validForTaxAuthority).toBe(false)
    expect(artifact.warning).toBe("no válido para Hacienda")
    expect(artifact.legend).toBe("VERI*FACTU")
    expect(artifact.qrUrl).toContain("prewww2.aeat.es")
    expect(await provider.submit(artifact, "r1")).toMatchObject({ status: "not_configured", externalId: null, csv: null })
    expect(() => provider.prepare({ regime: "ticketbai_araba", record: testFiscalRecord(), ticketbaiPrevious: null })).toThrow("a confirmar con el proveedor")
  })
})
