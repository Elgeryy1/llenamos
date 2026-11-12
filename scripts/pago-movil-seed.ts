/** Factura y cuenta de prueba, visibles como tales. No registra cobros Stripe. */
import { writeFileSync } from 'node:fs'
import { Timestamp } from 'firebase-admin/firestore'
import * as core from '@llenamos/core'
import { db } from '../functions/src/shared'
import { seedMobileFixture, fixtureTableToken, fixtureToken } from '../functions/src/fase3-mobile/fixtures'
import { createReceipt } from '../functions/src/fase3-mobile/receipts'
import { processMessage } from '../functions/src/messages/process'

async function main() {
  // Este fixture jamás envía correo aunque la terminal tuviera credenciales heredadas.
  delete process.env.RESEND_API_KEY
  delete process.env.EMAIL_FROM
  const rid = 'pago-movil-demo', lid = 'centro'
  const { root, local } = await seedMobileFixture(rid, lid)
  await root.update({ name: 'Taberna Lumbre · prueba de pago móvil', slug: 'pago-movil-demo' })
  const lines = [{ description: 'Parte del consumo de prueba', quantity: 1, unitPriceCents: 2600, discountCents: 0, grossCents: 2600, taxRate: 10 as const, sourceLineId: 'private-line' }]
  const invoice = core.InvoiceSchema.parse({ billId: 'bill-mobile', partId: 'part-1', issuer: { name: 'Emisor ficticio de prueba', nif: '89890001K', address: 'Dirección de demostración' }, recipient: null,
    seriesId: 'TEST', sequence: 1, number: 'TEST/000001', issueDate: '09-11-2026', operationDate: '09-11-2026', type: 'F2', qualifiedSimplified: false,
    description: 'Prueba local sin validez fiscal', lines, ...core.invoiceTotals(lines), correction: null, replacedInvoices: [] })
  await local.collection('invoices').doc('invoice-mobile').set({ ...invoice, recordId: 'record-mobile', createdAt: Timestamp.now(), updatedAt: Timestamp.now(), updatedBy: null })
  await root.collection('fiscalRecords').doc('record-mobile').set({ validForTaxAuthority: false, warning: 'no válido para Hacienda',
    qrUrl: core.verifactuQrUrl({ issuerNif: invoice.issuer.nif, number: invoice.number, issueDate: invoice.issueDate }, invoice.totalCents), legend: 'VERI*FACTU' })
  const receipt = await createReceipt({ restaurantId: rid, locationId: lid, invoiceId: 'invoice-mobile', requestId: `demo-receipt-${Date.now()}`,
    email: 'cliente@example.test', acceptDigitalReceipt: true }, { auth: { uid: 'owner-mobile' } } as never)
  for (const message of (await root.collection('messages').where('status', '==', 'queued').get()).docs) await processMessage(message.ref)
  const links = { payment: `/p/${rid}/${lid}/checkout-mobile?t=${fixtureToken}`, table: `/p/${rid}/${lid}/mesa/table-mobile?t=${fixtureTableToken}`, receipt: receipt.path }
  writeFileSync('/tmp/pago-movil-links.json', JSON.stringify(links, null, 2))
  console.log('Datos de prueba preparados. Ningún cobro real. Enlaces locales en /tmp/pago-movil-links.json.')
}
void main().catch(e => { console.error(e); process.exitCode = 1 })
