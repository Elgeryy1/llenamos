import { z } from "zod"
import { sha256Hex } from "../sha256"
import { assertCents } from "../money"
import {
  FiscalRecordInputSchema, FiscalHashSchema, FiscalDateSchema, InvoiceSeriesSchema, InvoiceIdentitySchema,
  type FiscalRecordInput, type InvoiceIdentity, type InvoiceSeries, type FiscalSubmission,
} from "./fiscal-modelo"

export const FISCAL_TEST_WARNING = "no válido para Hacienda"
export const VERIFACTU_LEGEND = "VERI*FACTU"
export const FISCAL_QR_LAYOUT = { sizeMm: 35, quietZoneMm: 6, minimumQuietZoneMm: 2, correction: "M", label: "QR tributario" } as const
const NS = "https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroInformacion.xsd"

/** Usa exactamente dos decimales, sin locale, agrupación ni coma flotante. */
export function fiscalDecimal(cents: number): string {
  assertCents(cents)
  const n = BigInt(cents), abs = n < BigInt(0) ? -n : n
  if (abs > BigInt(99_999_999_999_999)) throw new Error("Importe fuera del formato fiscal 12.2.")
  return `${n < BigInt(0) ? "-" : ""}${abs / BigInt(100)}.${String(abs % BigInt(100)).padStart(2, "0")}`
}
export function fiscalIdentity(v: FiscalRecordInput): InvoiceIdentity {
  return v.kind === "alta" ? { issuerNif: v.invoice.issuer.nif, number: v.invoice.number, issueDate: v.invoice.issueDate } : v.invoice
}
/** Cadena oficial. No se aplica URL encoding ni escape XML antes del SHA-256 UTF-8. */
export function verifactuHashInput(raw: FiscalRecordInput): string {
  const v = FiscalRecordInputSchema.parse(raw), id = fiscalIdentity(v)
  const fields: [string, string][] = v.kind === "alta" ? [
    ["IDEmisorFactura", id.issuerNif], ["NumSerieFactura", id.number], ["FechaExpedicionFactura", id.issueDate],
    ["TipoFactura", v.invoice.type], ["CuotaTotal", fiscalDecimal(v.invoice.taxCents)], ["ImporteTotal", fiscalDecimal(v.invoice.totalCents)],
  ] : [["IDEmisorFacturaAnulada", id.issuerNif], ["NumSerieFacturaAnulada", id.number], ["FechaExpedicionFacturaAnulada", id.issueDate]]
  fields.push(["Huella", v.previous?.hash ?? ""], ["FechaHoraHusoGenRegistro", v.generatedAt])
  return fields.map(([k, value]) => `${k}=${value.trim()}`).join("&")
}
export function verifactuHash(v: FiscalRecordInput): string { return sha256Hex(verifactuHashInput(v)).toUpperCase() }

export function verifactuQrUrl(id: InvoiceIdentity, totalCents: number, environment: "test" | "production" = "test"): string {
  id = InvoiceIdentitySchema.parse(id)
  const origin = environment === "test" ? "https://prewww2.aeat.es" : "https://www2.agenciatributaria.gob.es"
  const values = [["nif", id.issuerNif], ["numserie", id.number], ["fecha", id.issueDate], ["importe", fiscalDecimal(totalCents)]]
  return `${origin}/wlpl/TIKE-CONT/ValidarQR?${values.map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&")}`
}
function dateKey(s: string): string { return s.split("-").reverse().join("") }
/** El llamante guarda contador, factura y registro en la MISMA transacción. No reserva rangos. */
export function nextInvoiceNumber(raw: InvoiceSeries, type: string, issueDate: string) {
  const series = InvoiceSeriesSchema.parse(raw)
  FiscalDateSchema.parse(issueDate)
  if (!series.active || (series.kind === "rectifying") !== type.startsWith("R")) throw new Error("Serie inactiva o de otro tipo de factura.")
  if (Number(issueDate.slice(6)) !== series.year || (series.lastIssueDate && dateKey(issueDate) < dateKey(series.lastIssueDate))) throw new Error("La fecha rompe el orden de la serie.")
  const sequence = assertCents(series.lastSequence + 1)
  const number = `${series.prefix}/${String(sequence).padStart(6, "0")}`
  if (number.length > 60) throw new Error("Número de factura demasiado largo.")
  return { number, sequence, series: { ...series, lastSequence: sequence, lastIssueDate: issueDate } }
}
function xmlText(v: string): string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(v)) throw new Error("Carácter no permitido en XML.")
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;")
}
const tag = (name: string, value: string) => `<${name}>${xmlText(value)}</${name}>`
const block = (name: string, content: string) => `<${name}>${content}</${name}>`
const yes = (v: boolean) => v ? "S" : "N"
const identityXml = (id: InvoiceIdentity, cancelled = false) =>
  tag(cancelled ? "IDEmisorFacturaAnulada" : "IDEmisorFactura", id.issuerNif) + tag(cancelled ? "NumSerieFacturaAnulada" : "NumSerieFactura", id.number) + tag(cancelled ? "FechaExpedicionFacturaAnulada" : "FechaExpedicionFactura", id.issueDate)
const referenceXml = (id: InvoiceIdentity) => identityXml(id)
/** XML de un registro individual para conservación/exportación. No es el sobre SOAP de envío. */
export function verifactuRecordXml(raw: FiscalRecordInput): string {
  const v = FiscalRecordInputSchema.parse(raw), id = fiscalIdentity(v)
  let content = tag("IDVersion", v.version) + block("IDFactura", identityXml(id, v.kind === "anulacion"))
  if (v.kind === "alta") {
    const i = v.invoice
    content += tag("NombreRazonEmisor", i.issuer.name)
    if (v.subsanacion) content += tag("Subsanacion", "S")
    if (v.previousRejection) content += tag("RechazoPrevio", "S")
    content += tag("TipoFactura", i.type)
    if (i.correction) {
      content += tag("TipoRectificativa", i.correction.mode)
      content += block("FacturasRectificadas", i.correction.invoices.map((r) => block("IDFacturaRectificada", referenceXml(r))).join(""))
    }
    if (i.replacedInvoices.length) content += block("FacturasSustituidas", i.replacedInvoices.map((r) => block("IDFacturaSustituida", referenceXml(r))).join(""))
    if (i.correction?.mode === "S") content += block("ImporteRectificacion", tag("BaseRectificada", fiscalDecimal(i.correction.correctedBaseCents!)) + tag("CuotaRectificada", fiscalDecimal(i.correction.correctedTaxCents!)))
    content += tag("FechaOperacion", i.operationDate) + tag("DescripcionOperacion", i.description)
    if (i.qualifiedSimplified) content += tag("FacturaSimplificadaArt7273", "S")
    if (i.recipient) {
      const r = i.recipient, identity = r.identity
      content += block("Destinatarios", block("IDDestinatario", tag("NombreRazon", r.name) + (identity.kind === "nif" ? tag("NIF", identity.nif) : block("IDOtro", tag("CodigoPais", identity.country) + tag("IDType", identity.idType) + tag("ID", identity.id)))))
    }
    content += block("Desglose", i.taxes.map((t) => block("DetalleDesglose", tag("Impuesto", t.tax) + tag("ClaveRegimen", t.regimeKey) + tag("CalificacionOperacion", t.qualification) + tag("TipoImpositivo", String(t.taxRate)) + tag("BaseImponibleOimporteNoSujeto", fiscalDecimal(t.baseCents)) + tag("CuotaRepercutida", fiscalDecimal(t.taxCents)))).join(""))
    content += tag("CuotaTotal", fiscalDecimal(i.taxCents)) + tag("ImporteTotal", fiscalDecimal(i.totalCents))
  } else {
    if (v.noPreviousRecord) content += tag("SinRegistroPrevio", "S")
    if (v.previousRejection) content += tag("RechazoPrevio", "S")
  }
  content += block("Encadenamiento", v.previous ? block("RegistroAnterior", identityXml(v.previous) + tag("Huella", v.previous.hash)) : tag("PrimerRegistro", "S"))
  const s = v.system
  content += block("SistemaInformatico", tag("NombreRazon", s.producerName) + tag("NIF", s.producerNif) + tag("NombreSistemaInformatico", s.name) + tag("IdSistemaInformatico", s.id) + tag("Version", s.version) + tag("NumeroInstalacion", s.installation) + tag("TipoUsoPosibleSoloVerifactu", yes(s.onlyVerifactu)) + tag("TipoUsoPosibleMultiOT", yes(s.multiTaxpayer)) + tag("IndicadorMultiplesOT", yes(s.multipleTaxpayers)))
  content += tag("FechaHoraHusoGenRegistro", v.generatedAt) + tag("TipoHuella", "01") + tag("Huella", verifactuHash(v))
  const root = v.kind === "alta" ? "RegistroAlta" : "RegistroAnulacion"
  return `<?xml version="1.0" encoding="UTF-8"?><${root} xmlns="${NS}">${content}</${root}>`
}
export const FiscalStoredRecordSchema = z.object({
  input: FiscalRecordInputSchema, hash: FiscalHashSchema, canonical: z.string(), xml: z.string(),
  /** Control adicional local del documento completo; no sustituye la huella oficial. */
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
})
export type FiscalStoredRecord = z.infer<typeof FiscalStoredRecordSchema>
export function prepareFiscalRecord(raw: FiscalRecordInput): FiscalStoredRecord {
  const input = FiscalRecordInputSchema.parse(raw)
  return { input, hash: verifactuHash(input), canonical: verifactuHashInput(input), xml: verifactuRecordXml(input), snapshotHash: sha256Hex(JSON.stringify(input)) }
}
/** Comprueba cadena completa desde el génesis; el backend contrasta también la cabeza guardada. */
export function verifyFiscalChain(records: readonly FiscalStoredRecord[]): boolean {
  try {
    const seen = new Set<string>()
    for (let i = 0; i < records.length; i++) {
      const r = FiscalStoredRecordSchema.parse(records[i]), rebuilt = prepareFiscalRecord(r.input)
      if (seen.has(r.input.recordId) || r.hash !== rebuilt.hash || r.canonical !== rebuilt.canonical || r.xml !== rebuilt.xml || r.snapshotHash !== rebuilt.snapshotHash || r.input.chainSequence !== i + 1) return false
      seen.add(r.input.recordId)
      const prev = records[i - 1]
      if (!prev) { if (r.input.previous !== null) return false }
      else {
        const p = r.input.previous, id = fiscalIdentity(prev.input)
        if (!p || p.recordId !== prev.input.recordId || p.hash !== prev.hash || p.number !== id.number || p.issueDate !== id.issueDate || p.issuerNif !== id.issuerNif || r.input.chainId !== prev.input.chainId || r.input.system.installation !== prev.input.system.installation || Date.parse(r.input.generatedAt) < Date.parse(prev.input.generatedAt)) return false
      }
    }
    return true
  } catch { return false }
}
export type FiscalRegime = "verifactu" | "ticketbai_araba" | "ticketbai_bizkaia" | "ticketbai_gipuzkoa"
/** La cadena de firma TicketBAI es distinta del hash VERI*FACTU. La completa el proveedor foral. */
export interface FiscalPreparation {
  regime: FiscalRegime
  record: FiscalRecordInput
  ticketbaiPrevious: { number: string; issueDate: string; signatureValue: string } | null
}
export interface FiscalArtifact {
  regime: FiscalRegime
  record: FiscalStoredRecord
  xml: string
  qrUrl: string | null
  legend: string | null
  warning: string | null
  validForTaxAuthority: boolean
  ticketbai: { identifier: string; signatureValue: string; qrUrl: string; softwareLicense: string } | null
}
export interface FiscalProvider {
  readonly id: string
  readonly regimes: readonly FiscalRegime[]
  /** Determinista y sin red. El envío sucede después del commit por outbox. */
  prepare(input: FiscalPreparation): FiscalArtifact
  submit(artifact: FiscalArtifact, idempotencyKey: string): Promise<FiscalSubmission>
}
/** Proveedor local: no recibe fetch, claves ni certificados y no transmite nada. */
export function createTestFiscalProvider(): FiscalProvider {
  return {
    id: "local_test", regimes: ["verifactu"],
    prepare({ regime, record }) {
      if (regime !== "verifactu") throw new Error("TicketBAI a confirmar con el proveedor. No se puede emitir en esta modalidad.")
      const stored = prepareFiscalRecord(record)
      return { regime, record: stored, xml: stored.xml,
        qrUrl: stored.input.kind === "alta" ? verifactuQrUrl(fiscalIdentity(stored.input), stored.input.invoice.totalCents, "test") : null,
        legend: stored.input.kind === "alta" ? VERIFACTU_LEGEND : null, warning: FISCAL_TEST_WARNING,
        validForTaxAuthority: false, ticketbai: null }
    },
    async submit() { return { status: "not_configured", provider: "local_test", externalId: null, csv: null, errorCode: null, message: FISCAL_TEST_WARNING, retryAfterSeconds: null } },
  }
}
