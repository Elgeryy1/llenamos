import { type Transaction, type DocumentData } from 'firebase-admin/firestore'
import * as core from '@llenamos/core'
import { HttpsError } from 'firebase-functions/v2/https'
import { fail, local, type Scope } from './context'
import { qrMatrix } from './qr'

export type KitchenBatch = { orderId: string; firedAt: number; stationId: string; course: string | null; sessionId: string | null; takeawayId: string | null }
export function sameBatch(l: core.OrderLine, b: KitchenBatch) {
  return l.orderId === b.orderId && l.firedAt === b.firedAt && l.stationId === b.stationId && l.course === b.course && l.sessionId === b.sessionId && l.takeawayId === b.takeawayId && l.kind !== 'menu'
}
const courseName = (v: string | null) => ({ starters: 'Entrantes', first: 'Primeros', second: 'Segundos', dessert: 'Postres', drinks: 'Bebidas' })[v ?? ''] ?? v ?? 'Sin pase'
export async function documentFor(tx: Transaction, s: Scope, kind: core.PrintRequest['kind'], sourceId: string, printer: core.Printer, copy: number, batch?: KitchenBatch): Promise<core.PrintDocument | null> {
  const ref = local(s)
  const read = async (name: string, id: string) => {
    const snap = await tx.get(ref.collection(name).doc(id))
    if (!snap.exists) throw new HttpsError('not-found', 'No se encuentra el origen de la impresión en este local.')
    return snap.data()!
  }
  if (kind === 'drawer') {
    if (!printer.drawer || !printer.tickets) fail('El cajón debe estar habilitado en la impresora de caja.')
    const payment = core.PaymentSchema.parse(await read('payments', sourceId))
    if (payment.status !== 'succeeded' || payment.method !== 'cash' || payment.kind !== 'charge') fail('El cajón requiere un cobro en efectivo confirmado de este local.')
    if (copy) fail('No se pueden crear copias de una apertura del cajón.')
    return null
  }
  if (kind === 'invoice') {
    if (!printer.tickets) fail('Esta impresora no está asignada a la caja.')
    const raw = await read('invoices', sourceId), invoice = core.InvoiceSchema.parse(raw)
    if (typeof raw.recordId !== 'string') fail('La factura no tiene su registro fiscal original.')
    const record = await tx.get(ref.parent.parent!.collection('fiscalRecords').doc(raw.recordId))
    const fiscal = record.data() as DocumentData | undefined
    if (!fiscal || fiscal.locationId !== s.locationId || fiscal.invoiceId !== sourceId) fail('No se encuentra el artefacto fiscal original de esta factura.')
    const a = fiscal!.artifact ?? fiscal!
    if (typeof a.qrUrl !== 'string') fail('Falta el QR fiscal original. No se ha generado un ticket.')
    return core.invoicePrintDocument(invoice, { qrUrl: a.qrUrl, legend: a.legend ?? null, warning: a.validForTaxAuthority === true ? a.warning ?? null : core.FISCAL_TEST_WARNING }, copy > 0)
  }
  if (kind === 'prebill') {
    if (!printer.tickets) fail('Esta impresora no está asignada a la caja.')
    const bill = core.BillSchema.parse(await read('bills', sourceId))
    const lines = core.netBillLines(bill.lines, bill.adjustments)
    return core.prebillPrintDocument([...(copy ? ['Copia'] : []), ...lines.map(l => `${l.quantity} x ${l.name}  ${core.fiscalDecimal(l.grossCents)} EUR`), `Total ${core.fiscalDecimal(bill.totalCents)} EUR`])
  }
  const [order, snap] = await Promise.all([read('orders', sourceId), tx.get(ref.collection('orderLines').where('orderId', '==', sourceId))])
  core.OrderSchema.parse(order)
  const lines = snap.docs.map(d => core.OrderLineSchema.parse(d.data())).filter(l => l.kind !== 'menu' && l.firedAt !== null && l.status !== 'cancelled' && printer.stationIds.includes(l.stationId ?? '') && (!batch || sameBatch(l, batch)))
  if (!lines.length) fail('No hay platos marchados para las estaciones de esta impresora.')
  const stationNames = await Promise.all([...new Set(lines.map(l => l.stationId!))].map(async id => (await read('stations', id)).name as string))
  const timezone = (await tx.get(ref.parent.parent!)).get('timezone') ?? 'Europe/Madrid'
  const doc = core.kitchenPrintDocument({ label: lines[0]!.label, orderId: sourceId, station: stationNames.join(', '), time: new Intl.DateTimeFormat('es-ES', { timeZone: timezone, hour: '2-digit', minute: '2-digit' }).format(lines[0]!.firedAt!), lines: lines.map(l => ({ quantity: l.quantity, name: [l.name.es, l.variant?.name.es, ...l.modifiers.map(m => m.name.es)].filter(Boolean).join(' · '), course: courseName(l.course), notes: l.notes })) })
  if (copy) doc.lines.unshift({ text: 'Copia', bold: true, align: 'left' })
  return doc
}
export function encode(document: core.PrintDocument | null, printer: core.Printer) {
  return document ? core.encodeEscPos(document, printer, qrMatrix) : core.drawerPulse()
}
export function testDocument() { return core.prebillPrintDocument(['Prueba de impresora', 'Llenamos · impresión local', 'Papel térmico y acentos: á é í ó ú ñ €', 'No es una venta. No abre el cajón.']) }
