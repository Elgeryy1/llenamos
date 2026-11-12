import { Timestamp, type DocumentReference } from 'firebase-admin/firestore'
import type { CallableRequest } from 'firebase-functions/v2/https'
import * as core from '@llenamos/core'
import { db, parse } from '../shared'
import { enqueueMessage } from '../messages/enqueue'
import { appOrigin, type Env } from './stripe'
import { checkToken, fail, fresh, hash, meta, resolveSlug, scope, token } from './support'

/** Solo esta función crea enlaces y mensajes; no emite ni altera facturas. */
export async function receiptForInvoice(d: core.CallableParsedInput<'crearReciboDigital'>, request?: CallableRequest<unknown>, language: core.Language = 'es', env: Env = process.env, system = false) {
  if (!request && !system) fail('La creación del recibo requiere autorización.')
  if (d.email && !d.acceptDigitalReceipt) fail('No se envía correo sin consentimiento.')
  const origin = appOrigin(env)
  return db.runTransaction(async tx => {
    const c = await scope(tx, d.restaurantId, d.locationId, request, false, system && !request)
    const ref = c.local.collection('mobileRequests').doc(hash(['receipt', c.uid, d.requestId]))
    const previous = await tx.get(ref)
    if (previous.exists) {
      if (previous.get('fingerprint') !== hash(d)) fail('Esta solicitud de recibo ya tiene otro contenido.')
      if (previous.get('expiresAt').toMillis() <= Date.now()) fail('El recibo ha caducado. Solicita uno nuevo.')
      return core.CrearReciboDigitalOutputSchema.parse(previous.get('result'))
    }
    const inv = await tx.get(c.local.collection('invoices').doc(d.invoiceId))
    if (!inv.exists) fail('La factura todavía no está disponible.')
    const invoice = core.InvoiceSchema.parse(inv.data())
    // Las llamadas de sistema proceden exclusivamente del worker de un checkout cobrado.
    const id = hash(['receipt', d.invoiceId, d.requestId]), secret = token(), expiresAt = Date.now() + 30 * 86400000
    const path = `/recibo/${c.restaurant.slug}/${c.lid}/${id}?t=${secret}`
    const delivery = d.acceptDigitalReceipt && d.email ? 'queued' as const : 'none' as const
    const messageId = delivery === 'queued' ? hash(['digital_receipt', d.invoiceId, d.email, d.requestId]) : null
    const oldMessage = messageId ? await tx.get(c.root.collection('messages').doc(messageId)) : null
    const value = core.DigitalReceiptSchema.parse({ invoiceId: d.invoiceId, tokenHash: core.sha256Hex(secret), expiresAt,
      email: d.email, consentAt: d.acceptDigitalReceipt ? Date.now() : null, delivery })
    if (messageId && !oldMessage?.exists) enqueueMessage(tx, c.rid, { channel: 'email', to: d.email!, template: 'digital_receipt', language,
      data: { restaurantName: c.restaurant.name, reference: invoice.number, totalCents: invoice.totalCents, manageUrl: origin + path },
      reservationId: null, waitlistId: null, sendAt: Date.now() }, messageId)
    tx.create(c.local.collection('digitalReceipts').doc(id), { ...core.digitalReceiptForWrite(value, Timestamp.fromMillis),
      messageId, acceptedDigital: d.acceptDigitalReceipt, ...fresh(c.uid) })
    const actualDelivery = oldMessage?.exists ? oldMessage.get('status') : delivery
    const result = { receiptId: id, token: secret, path, delivery: ['captured', 'not_configured'].includes(actualDelivery) ? actualDelivery : delivery }
    tx.create(ref, { fingerprint: hash(d), result, expiresAt: Timestamp.fromMillis(expiresAt), ...fresh(c.uid) })
    return core.CrearReciboDigitalOutputSchema.parse(result)
  })
}
export async function createReceipt(data: unknown, request: CallableRequest<unknown>) {
  return receiptForInvoice(parse(core.CrearReciboDigitalInputSchema, data), request)
}
export async function viewReceipt(data: unknown) {
  const d = parse(core.VerReciboDigitalInputSchema, data), rid = await resolveSlug(d.slug)
  return db.runTransaction(async tx => {
    const c = await scope(tx, rid, d.locationId, undefined, false)
    const receipt = await tx.get(c.local.collection('digitalReceipts').doc(d.receiptId))
    checkToken(receipt.get('tokenHash'), d.token)
    const r = core.DigitalReceiptSchema.parse(receipt.data())
    if (r.expiresAt <= Date.now()) fail('Este recibo ha caducado. Pide al restaurante otro enlace.')
    const invoice = await tx.get(c.local.collection('invoices').doc(r.invoiceId))
    const value = core.InvoiceSchema.parse(invoice.data())
    const record = invoice.get('recordId') ? await tx.get(c.root.collection('fiscalRecords').doc(invoice.get('recordId'))) : null
    const artifact = record?.get('artifact') ?? record?.data() ?? invoice.get('artifact') ?? {}
    const message = receipt.get('messageId') ? await tx.get(c.root.collection('messages').doc(receipt.get('messageId'))) : null
    const delivery = message?.get('status') ?? r.delivery
    if (delivery !== r.delivery && ['captured', 'sent', 'not_configured', 'failed'].includes(delivery)) tx.update(receipt.ref, { delivery, ...meta() })
    // La lista explícita del esquema elimina ids internos, líneas fuente y cualquier campo añadido por backend.
    const result = core.VerReciboDigitalOutputSchema.parse({ invoice: value, qrUrl: artifact.qrUrl ?? null,
      legend: artifact.legend ?? null, warning: artifact.validForTaxAuthority === true ? artifact.warning ?? null : 'Proveedor de prueba: no válido para Hacienda.' })
    return { ...result, restaurantName: c.restaurant.name, locationName: c.location.name, brandColor: c.restaurant.brandColor,
      delivery, acceptedDigital: receipt.get('acceptedDigital') === true }
  })
}
export async function syncReceiptDelivery(checkoutRef: DocumentReference) {
  const checkout = await checkoutRef.get()
  if (!checkout.get('receiptId')) return
  const r = await checkoutRef.parent.parent!.collection('digitalReceipts').doc(checkout.get('receiptId')).get()
  if (!r.get('messageId')) return
  const root = checkoutRef.parent.parent!.parent.parent!
  const m = await root.collection('messages').doc(r.get('messageId')).get()
  const delivery = m.get('status')
  if (['queued', 'captured', 'sent', 'failed', 'not_configured'].includes(delivery)) {
    await r.ref.update({ delivery, ...meta() })
    await checkoutRef.update({ delivery, needsReconciliation: delivery === 'queued' || checkout.get('invoicePending') === true, ...meta() })
  }
}
