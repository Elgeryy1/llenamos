/** ESC/POS puro. Perfil fijo CP858, 203 ppp y QR raster con codificador inyectado. */
import { z } from "zod"
import { fiscalDecimal, FISCAL_QR_LAYOUT, FISCAL_TEST_WARNING } from "./fiscal"
import { InvoiceSchema, type Invoice } from "./fiscal-modelo"
import { roundRatio } from "./cuenta"

export const PrintDocumentSchema = z.object({
  kind: z.enum(["kitchen", "invoice", "prebill"]),
  lines: z.array(z.object({ text: z.string().max(500), bold: z.boolean().default(false), align: z.enum(["left", "center", "right"]).default("left") })).max(2000),
  fiscal: z.object({ qrUrl: z.string().min(1).max(1000), legend: z.string().nullable(), warning: z.string().nullable() }).nullable(),
})
export type PrintDocument = z.infer<typeof PrintDocumentSchema>
/** El puente conserva el documento y el mismo payload para una reimpresión. */
export function invoicePrintDocument(raw: Invoice, fiscal: NonNullable<PrintDocument["fiscal"]>, copy = false): PrintDocument {
  const i = InvoiceSchema.parse(raw)
  const row = (text: string, bold = false): PrintDocument["lines"][number] => ({ text, bold, align: "left" })
  return { kind: "invoice", fiscal, lines: [
    ...(copy ? [row("Copia", true)] : []), row(i.type.startsWith("R") ? "Factura rectificativa" : i.type === "F2" || i.qualifiedSimplified ? "Factura simplificada" : "Factura completa", true),
    row(i.issuer.name), row(`NIF ${i.issuer.nif}`), row(i.issuer.address), row(`Número ${i.number}`, true),
    row(`Expedición ${i.issueDate}`), row(`Operación ${i.operationDate}`),
    ...(i.recipient ? [row(i.recipient.name), row(i.recipient.identity.kind === "nif" ? `NIF ${i.recipient.identity.nif}` : i.recipient.identity.id), row(i.recipient.address)] : []),
    row(i.description), ...i.lines.flatMap((l) => [row(`${l.quantity} x ${l.description}  ${fiscalDecimal(l.grossCents)} EUR`), ...(i.type !== "F2" && !i.qualifiedSimplified ? [row(`Unitario sin IVA ${fiscalDecimal(roundRatio(BigInt(l.unitPriceCents) * BigInt(100), BigInt(100 + l.taxRate)))} EUR`)] : [])]),
    ...i.lines.filter((l) => l.discountCents > 0).map((l) => row(`Descuento ${l.description}  ${fiscalDecimal(l.discountCents)} EUR`)),
    ...i.taxes.map((t) => row(`IVA ${t.taxRate}% Base ${fiscalDecimal(t.baseCents)} Cuota ${fiscalDecimal(t.taxCents)}`)),
    row(`Total ${fiscalDecimal(i.totalCents)} EUR`, true),
    ...(i.type === "F2" || i.qualifiedSimplified ? [row("IVA incluido")] : []),
    ...(i.correction ? [row(i.correction.reason), row(`Rectificación por ${i.correction.mode === "I" ? "diferencias" : "sustitución"}`), ...i.correction.invoices.map((v) => row(`Rectifica ${v.number} de ${v.issueDate}`)), ...(i.correction.mode === "S" ? [row(`Base rectificada ${fiscalDecimal(i.correction.correctedBaseCents!)} Cuota rectificada ${fiscalDecimal(i.correction.correctedTaxCents!)}`)] : [])] : []),
    ...i.replacedInvoices.map((v) => row(`Sustituye ${v.number} de ${v.issueDate}`)),
  ] }
}
export function kitchenPrintDocument(input: { label: string; orderId: string; station: string; time: string; lines: { quantity: number; name: string; course: string; notes: string }[] }): PrintDocument {
  return PrintDocumentSchema.parse({ kind: "kitchen", fiscal: null, lines: [
    { text: "Comanda", bold: true }, { text: input.label, bold: true }, { text: `${input.station} · ${input.time}` }, { text: input.orderId },
    ...input.lines.flatMap((l) => [{ text: `${l.course}: ${l.quantity} x ${l.name}`, bold: true }, ...(l.notes ? [{ text: l.notes }] : [])]),
  ] })
}
/** Una precuenta nunca tiene número fiscal, QR fiscal ni leyenda de envío. */
export function prebillPrintDocument(lines: string[]): PrintDocument {
  return PrintDocumentSchema.parse({ kind: "prebill", fiscal: null, lines: [{ text: "Precuenta", bold: true }, { text: "No es una factura" }, ...lines.map((text) => ({ text }))] })
}
export type QrEncoder = (text: string, correction: "M") => readonly (readonly boolean[])[]
const CP858: Record<string, number> = { "á": 160, "é": 130, "í": 161, "ó": 162, "ú": 163, "Á": 181, "É": 144, "Í": 214, "Ó": 224, "Ú": 233, "ñ": 164, "Ñ": 165, "ü": 129, "Ü": 154, "ç": 135, "Ç": 128, "€": 213, "¿": 168, "¡": 173, "·": 250, "º": 167, "ª": 166 }
function safeText(s: string): string { return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ") }
function encode(s: string): number[] {
  return [...safeText(s)].map((c) => {
    const n = c.charCodeAt(0)
    return n >= 32 && n <= 126 ? n : CP858[c] ?? 63
  })
}
/** QR M al principio, 30 a 40 mm, con zona blanca física y sin duplicar otro QR. */
function qrRaster(url: string, paperMm: 58 | 80, qr: QrEncoder): number[] {
  const matrix = qr(url, "M"), modules = matrix.length
  if (modules < 21 || modules > 177 || (modules - 21) % 4 !== 0 || matrix.some((r) => r.length !== modules || r.some((v) => typeof v !== "boolean"))) throw new Error("Matriz QR no válida.")
  const scale = Math.floor(FISCAL_QR_LAYOUT.sizeMm * 203 / 25.4 / modules)
  const sizeMm = modules * scale * 25.4 / 203
  if (scale < 1 || sizeMm < 30 || sizeMm > 40) throw new Error("El QR no cabe con el tamaño fiscal. Usa otro perfil de impresión.")
  const quiet = Math.ceil(Math.max(FISCAL_QR_LAYOUT.quietZoneMm * 203 / 25.4, 4 * scale))
  const dots = modules * scale + quiet * 2, width = Math.ceil(dots / 8)
  // Ancho imprimible habitual de 384 o 576 puntos; se valida con el hardware elegido.
  if (width * 8 > (paperMm === 58 ? 384 : 576)) throw new Error("El QR y su margen no caben en este papel.")
  const data: number[] = []
  for (let y = 0; y < dots; y++) for (let byte = 0; byte < width; byte++) {
    let value = 0
    for (let bit = 0; bit < 8; bit++) {
      const x = byte * 8 + bit, mx = Math.floor((x - quiet) / scale), my = Math.floor((y - quiet) / scale)
      if (mx >= 0 && mx < modules && my >= 0 && my < modules && matrix[my]?.[mx]) value |= 128 >> bit
    }
    data.push(value)
  }
  return [29, 118, 48, 0, width % 256, Math.floor(width / 256), dots % 256, Math.floor(dots / 256), ...data]
}
export function encodeEscPos(document: PrintDocument, profile: { paperMm: 58 | 80; columns: 32 | 48 }, qr?: QrEncoder): Uint8Array {
  const doc = PrintDocumentSchema.parse(document), bytes = [27, 64, 27, 116, 19]
  const line = (text: string, bold: boolean, align: "left" | "center" | "right") => {
    bytes.push(27, 69, bold ? 1 : 0, 27, 97, ["left", "center", "right"].indexOf(align))
    const chars = [...safeText(text)]
    if (!chars.length) bytes.push(10)
    for (let i = 0; i < chars.length; i += profile.columns) bytes.push(...encode(chars.slice(i, i + profile.columns).join("")), 10)
  }
  if (doc.kind === "invoice" && !doc.fiscal) throw new Error("La factura necesita su representación fiscal.")
  if (doc.kind !== "invoice" && doc.fiscal) throw new Error("Solo la factura lleva QR fiscal.")
  if (doc.fiscal) {
    if (!qr) throw new Error("Falta el codificador QR. No se puede imprimir una factura sin QR.")
    if (doc.fiscal.warning) line(doc.fiscal.warning, true, "center")
    bytes.push(27, 97, 1, ...qrRaster(doc.fiscal.qrUrl, profile.paperMm, qr), 10)
    line(FISCAL_QR_LAYOUT.label, false, "center")
    if (doc.fiscal.legend) line(doc.fiscal.legend, true, "center")
  }
  for (const l of doc.lines) line(l.text, l.bold, l.align)
  if (doc.fiscal?.warning === FISCAL_TEST_WARNING) line(FISCAL_TEST_WARNING, true, "center")
  bytes.push(27, 69, 0, 27, 97, 0, 10, 10, 10, 29, 86, 66, 0)
  return Uint8Array.from(bytes)
}
/** Solo en un trabajo separado, autorizado y deduplicado. Nunca al reimprimir. */
export function drawerPulse(): Uint8Array { return Uint8Array.from([27, 112, 0, 50, 100]) }
export const PRINT_TRANSITIONS = {
  queued: ["leased", "cancelled"], leased: ["printed", "failed", "uncertain"],
  failed: ["queued", "cancelled"], uncertain: [], printed: [], cancelled: [],
} as const
