import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'
import * as core from '@llenamos/core'
import { db } from '../shared'
import { processMessage } from '../messages/process'
import { connectCajaServices, type CajaServices } from './backend'
import { chooseTablePart, createLink, startPayment, viewCheckout, viewTableParts } from './service'
import { createReceipt, viewReceipt } from './receipts'
import { ingestWebhook, reconcileMobile } from './worker'
import { fixtureTableToken, fixtureToken, seedMobileFixture } from './fixtures'
import type { Session } from './stripe'

const enabled = process.env.TEST_FIREBASE_EMULATORS === '1' && process.env.GCLOUD_PROJECT === 'demo-llenamos' &&
  /^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '') && /^127\.0\.0\.1:\d+$/.test(process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '')
describe.skipIf(!enabled)('Pago móvil con Firestore real y proveedor Stripe inyectado, sin banco', { timeout: 30000 }, () => {
  let rid = '', path = ''
  const lid = 'centro', roots: string[] = []
  const ref = () => db.doc(`${path}/mobileCheckouts/checkout-mobile`)
  const link = { slug: rid, locationId: lid, checkoutId: 'checkout-mobile', token: fixtureToken }
  const table = { slug: rid, locationId: lid, tableId: 'table-mobile', token: fixtureTableToken }
  const input = { ...link, requestId: 'intent-one', tipCents: 130, email: 'cliente@example.test', acceptDigitalReceipt: true, language: 'ca' as const }
  const env = { STRIPE_SECRET_KEY: 'sk_test_not_a_real_key', STRIPE_MOBILE_WEBHOOK_SECRET: 'mobile_local_example', STRIPE_MOBILE_MODE: 'single',
    PUBLIC_APP_URL: 'http://localhost:3015', FUNCTIONS_EMULATOR: 'true', GCLOUD_PROJECT: 'demo-llenamos' }
  const session = (extra: Partial<Session> = {}): Session => ({ id: 'cs_test_mobile', url: 'https://checkout.stripe.com/c/pay/cs_test_mobile',
    status: 'open', payment_status: 'unpaid', amount_total: 2730, currency: 'eur', livemode: false, expires_at: Math.floor(Date.now() / 1000) + 1800,
    metadata: { restaurantId: rid, locationId: lid, checkoutId: link.checkoutId, amountCents: '2600', tipCents: '130' }, ...extra })
  const event = (s = session({ status: 'complete', payment_status: 'paid' }), id = 'evt_test_one', account?: string, created = Math.floor(Date.now() / 1000), type = 'checkout.session.completed') =>
    Buffer.from(JSON.stringify({ id, type, created, ...(account ? { account } : {}), data: { object: s } }))
  const sign = (raw: Buffer, seconds = Math.floor(Date.now() / 1000)) => `t=${seconds},v1=${createHmac('sha256', env.STRIPE_MOBILE_WEBHOOK_SECRET).update(`${seconds}.`).update(raw).digest('hex')}`
  const post = (raw: Buffer) => ingestWebhook(raw, sign(raw), env)
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(session())))
  // El backend de caja está en otra rama: se verifica su puerto, sin copiar su libro.
  const confirm = vi.fn<CajaServices['confirmExternalPayment']>(async () => ({ paymentId: 'payment-from-backend', dueCents: 0 }))
  const issue = vi.fn<CajaServices['issuePartInvoice']>(async () => { throw new Error('Configuración fiscal pendiente') })
  const request = { auth: { uid: 'owner-mobile' } } as never
  beforeAll(() => { process.env.FUNCTIONS_EMULATOR = 'true'; connectCajaServices({ confirmExternalPayment: confirm, issuePartInvoice: issue }) })
  beforeEach(async () => {
    rid = `mobile-${Date.now()}-${roots.length}`; roots.push(rid); path = `restaurants/${rid}/locations/${lid}`
    link.slug = rid; table.slug = rid; input.slug = rid
    await seedMobileFixture(rid)
    confirm.mockClear(); issue.mockClear(); issue.mockRejectedValue(new Error('Configuración fiscal pendiente'))
    fetcher.mockReset(); fetcher.mockImplementation(async (_url, init) => {
      const body = new URLSearchParams(String(init?.body ?? ''))
      const checkoutId = body.get('metadata[checkoutId]') ?? link.checkoutId
      return new Response(JSON.stringify(session({ metadata: { ...session().metadata, checkoutId } })))
    })
  }, 30000)
  afterAll(async () => { for (const id of roots) await db.recursiveDelete(db.doc(`restaurants/${id}`)) }, 60000)

  it('sin clave ni transporte no cobra ni reserva saldo; la página recibe pagos deshabilitados', async () => {
    expect(await startPayment(input, { ...env, STRIPE_SECRET_KEY: '' }, fetcher)).toMatchObject({ status: 'not_configured' })
    expect(await startPayment(input, env)).toMatchObject({ status: 'not_configured' })
    expect((await viewCheckout(link, env)).paymentsEnabled).toBe(false)
    expect(fetcher).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled()
    expect((await db.collection(`${path}/paymentReservations`).get()).empty).toBe(true)
  })
  it('valida permisos, local, revisión e idempotencia del enlace creado por personal', async () => {
    const d = { restaurantId: rid, locationId: lid, billId: 'bill-mobile', partId: 'part-1', expectedRevision: 1, requestId: 'staff-one' }
    const first = await createLink(d, request)
    expect(await createLink(d, request)).toEqual(first)
    expect(first.token).not.toBe(fixtureTableToken)
    await expect(createLink({ ...d, partId: 'part-2' }, request)).rejects.toMatchObject({ code: 'already-exists' })
    await expect(createLink({ ...d, expectedRevision: 2, requestId: 'stale' }, request)).rejects.toMatchObject({ code: 'failed-precondition' })
    await db.doc(`restaurants/${rid}/members/owner-mobile`).update({ role: 'kitchen' })
    await expect(createLink({ ...d, requestId: 'denied' }, request)).rejects.toMatchObject({ code: 'permission-denied' })
  })
  it('el QR elige únicamente partes de su mesa bloqueada, sin exponer recibos', async () => {
    const parts = await viewTableParts(table)
    expect(parts.parts).toHaveLength(2)
    expect(JSON.stringify(parts)).not.toMatch(/tokenHash|receipt|customerId/)
    const d = { ...table, partId: 'part-2', billId: parts.billId, expectedRevision: parts.revision, requestId: 'choose-one' }
    expect(await chooseTablePart(d)).toEqual(await chooseTablePart(d))
    await expect(viewTableParts({ ...table, tableId: 'another-table' })).rejects.toMatchObject({ code: 'permission-denied' })
    await db.doc(`${path}/tableTokens/table-mobile`).update({ tokenHash: null })
    await expect(chooseTablePart(d)).rejects.toMatchObject({ code: 'permission-denied' })
  })
  it('recalcula importe en servidor, separa propina y no entrega el token a Stripe', async () => {
    const response = await startPayment(input, env, fetcher)
    expect(response.status).toBe('ready')
    const body = String(fetcher.mock.calls[0]![1]!.body)
    expect(body).toContain('unit_amount%5D=2600'); expect(body).toContain('unit_amount%5D=130')
    expect(body).not.toContain(fixtureToken); expect(body).not.toContain('cliente%40')
    expect((await db.doc(`${path}/paymentReservations/part-1`).get()).get('amountCents')).toBe(2600)
    expect(await startPayment(input, env, fetcher)).toEqual(response)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await expect(startPayment({ ...input, tipCents: 10 }, env, fetcher)).rejects.toMatchObject({ code: 'failed-precondition' })
  })
  it('el saldo reservado impide dos enlaces concurrentes incluso al vencer el reloj local', async () => {
    const another = await createLink({ restaurantId: rid, locationId: lid, billId: 'bill-mobile', partId: 'part-1', expectedRevision: 1, requestId: 'second' }, request)
    const results = await Promise.allSettled([startPayment(input, env, fetcher), startPayment({ ...input, checkoutId: another.checkoutId, token: another.token }, env, fetcher)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1)
    await db.doc(`${path}/paymentReservations/part-1`).update({ expiresAt: Timestamp.fromMillis(1) })
    const winner = (await db.doc(`${path}/paymentReservations/part-1`).get()).get('checkoutId')
    const loser = winner === link.checkoutId ? { ...input, checkoutId: another.checkoutId, token: another.token } : input
    await expect(startPayment(loser, env, fetcher)).rejects.toMatchObject({ code: 'failed-precondition' })
  })
  it('firma buena, mala, vencida, evento repetido y cobro confirmado aunque falle la factura', async () => {
    await startPayment(input, env, fetcher)
    const raw = event()
    expect(await ingestWebhook(raw, 't=1,v1=wrong', env)).toBe(400)
    expect(await ingestWebhook(raw, sign(raw, Math.floor(Date.now() / 1000) - 301), env)).toBe(400)
    expect(await post(raw)).toBe(200)
    expect(await post(raw)).toBe(200)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ externalId: 'cs_test_mobile', amountCents: 2600, tipCents: 130, currency: 'EUR' }))
    expect((await ref().get()).data()).toMatchObject({ status: 'paid', invoicePending: true })
    expect((await db.collection(`${path}/payments`).get()).empty).toBe(true) // Solo caja escribe el libro.
  })
  it.each([
    ['importe', { amount_total: 1 }], ['moneda', { currency: 'usd' }], ['sesión', { id: 'cs_other' }], ['modo', { livemode: true }],
  ])('retiene para revisión un evento con %s incorrecto', async (_, changes) => {
    await startPayment(input, env, fetcher)
    await post(event(session({ status: 'complete', payment_status: 'paid', ...changes })))
    expect(confirm).not.toHaveBeenCalled()
    expect((await ref().get()).get('status')).toBe('reconciliation_required')
    expect((await db.doc(`${path}/paymentReservations/part-1`).get()).exists).toBe(true)
    expect((await db.collection(`${path}/mobileIncidents`).get()).size).toBe(1)
  })
  it('conserva un pago tardío para revisión sin reabrir ni volver a cobrar', async () => {
    await startPayment(input, env, fetcher)
    await ref().update({ expiresAt: Timestamp.fromMillis(Date.now() - 10000) })
    await post(event())
    expect(confirm).not.toHaveBeenCalled(); expect((await ref().get()).get('status')).toBe('reconciliation_required')
  })
  it('el evento completado sin fondos espera al éxito asíncrono', async () => {
    await startPayment(input, env, fetcher)
    await post(event(session({ status: 'complete', payment_status: 'unpaid' })))
    expect(confirm).not.toHaveBeenCalled()
    await post(event(session({ status: 'complete', payment_status: 'paid' }), 'evt_async', undefined, undefined, 'checkout.session.async_payment_succeeded'))
    expect(confirm).toHaveBeenCalledTimes(1)
  })
  it('la reconciliación solo libera una reserva tras confirmar expiración externa', async () => {
    await startPayment(input, env, fetcher)
    await ref().update({ expiresAt: Timestamp.fromMillis(Date.now() - 10000) })
    fetcher.mockImplementation(async () => new Response(JSON.stringify(session({ status: 'expired' }))))
    await reconcileMobile(env, fetcher, 100, path)
    expect((await ref().get()).get('status')).toBe('expired')
    expect((await db.doc(`${path}/paymentReservations/part-1`).get()).exists).toBe(false)
  })
  it('recupera un timeout de creación con idéntica clave y cuerpo, sin otro cobro', async () => {
    fetcher.mockRejectedValueOnce(new Error('timeout'))
    await expect(startPayment(input, env, fetcher)).rejects.toThrow('timeout')
    expect((await db.doc(`${path}/paymentReservations/part-1`).get()).exists).toBe(true)
    await reconcileMobile(env, fetcher, 100, path)
    const posts = fetcher.mock.calls.filter(c => c[1]?.method === 'POST')
    expect(posts).toHaveLength(2)
    expect(posts[0]![1]!.body!.toString()).toBe(posts[1]![1]!.body!.toString())
    expect(posts[0]![1]!.headers).toEqual(posts[1]![1]!.headers)
    expect((await ref().get()).get('stripeSessionId')).toBe('cs_test_mobile')
  })
  it('Connect usa cuenta fijada por restaurante y rechaza eventos de otra cuenta', async () => {
    const connectEnv = { ...env, STRIPE_MOBILE_MODE: 'connect', STRIPE_CONNECTED_ACCOUNTS: JSON.stringify({ [rid]: 'acct_restaurant' }) }
    await startPayment(input, connectEnv, fetcher)
    expect(fetcher.mock.calls[0]![1]!.headers).toMatchObject({ 'Stripe-Account': 'acct_restaurant' })
    await ingestWebhook(event(undefined, 'evt_wrong_account', 'acct_other'), sign(event(undefined, 'evt_wrong_account', 'acct_other')), connectEnv)
    expect(confirm).not.toHaveBeenCalled(); expect((await ref().get()).get('status')).toBe('reconciliation_required')
  })
  it('rechaza tokens ajenos, precios del cliente y correo sin consentimiento', async () => {
    await expect(viewCheckout({ ...link, token: 'x'.repeat(43) })).rejects.toMatchObject({ code: 'permission-denied' })
    await expect(startPayment({ ...input, amountCents: 1 }, env, fetcher)).rejects.toMatchObject({ code: 'invalid-argument' })
    await expect(startPayment({ ...input, acceptDigitalReceipt: false }, env, fetcher)).rejects.toMatchObject({ code: 'failed-precondition' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  async function invoice() {
    const lines = [{ description: 'Parte del consumo de prueba', quantity: 1, unitPriceCents: 2600, discountCents: 0, grossCents: 2600, taxRate: 10 as const, sourceLineId: 'private-line' }]
    const v = core.InvoiceSchema.parse({ billId: 'bill-mobile', partId: 'part-1', issuer: { name: 'Emisor de prueba', nif: '89890001K', address: 'Dirección de prueba' }, recipient: null,
      seriesId: 'private-series', sequence: 1, number: 'TEST/000001', issueDate: '09-11-2026', operationDate: '09-11-2026', type: 'F2', qualifiedSimplified: false,
      description: 'Prueba local', lines, ...core.invoiceTotals(lines), correction: null, replacedInvoices: [] })
    await db.doc(`${path}/invoices/invoice-mobile`).set({ ...v, recordId: 'record-mobile', privateNotes: 'secreto' })
    await db.doc(`restaurants/${rid}/fiscalRecords/record-mobile`).set({ validForTaxAuthority: false, qrUrl: core.verifactuQrUrl({ issuerNif: v.issuer.nif, number: v.number, issueDate: v.issueDate }, v.totalCents), legend: 'VERI*FACTU', warning: 'no válido para Hacienda' })
    return v
  }
  it('recibo privado con factura filtrada, cola real y captura local sin envío', async () => {
    await invoice()
    const d = { restaurantId: rid, locationId: lid, requestId: 'receipt-one', invoiceId: 'invoice-mobile', email: 'cliente@example.test', acceptDigitalReceipt: true }
    const result = await createReceipt(d, request)
    expect(await createReceipt(d, request)).toEqual(result)
    const receiptLink = { slug: rid, locationId: lid, receiptId: result.receiptId, token: result.token }
    let receipt = await viewReceipt(receiptLink)
    expect(JSON.stringify(receipt)).not.toMatch(/private-line|bill-mobile|part-1|private-series|secreto|cliente@example/)
    expect(receipt.warning).toContain('no válido para Hacienda')
    const messages = await db.collection(`restaurants/${rid}/messages`).where('template', '==', 'digital_receipt').get()
    expect(messages.size).toBe(1)
    await processMessage(messages.docs[0]!.ref)
    await expect.poll(async () => (await viewReceipt(receiptLink)).delivery, { timeout: 10000 }).toBe('captured')
    expect((await messages.docs[0]!.ref.get()).get('rendered.body')).toContain(result.path)
    await expect(viewReceipt({ ...receiptLink, token: fixtureTableToken })).rejects.toMatchObject({ code: 'permission-denied' })
    await db.doc(`${path}/digitalReceipts/${result.receiptId}`).update({ expiresAt: Timestamp.fromMillis(1) })
    await expect(viewReceipt(receiptLink)).rejects.toMatchObject({ code: 'failed-precondition' })
  })
  it('sin consentimiento ofrece papel y no encola correo', async () => {
    await invoice()
    const result = await createReceipt({ restaurantId: rid, locationId: lid, requestId: 'paper-one', invoiceId: 'invoice-mobile', email: null, acceptDigitalReceipt: false }, request)
    expect(result.delivery).toBe('none')
    expect((await db.collection(`restaurants/${rid}/messages`).get()).empty).toBe(true)
  })
  it('la factura fallida se reintenta tras el cobro sin confirmar otro pago', async () => {
    await invoice()
    await startPayment(input, env, fetcher)
    await post(event())
    expect((await ref().get()).get('invoicePending')).toBe(true)
    issue.mockResolvedValue({ invoiceId: 'invoice-mobile', recordId: 'record-mobile', number: 'TEST/000001', fiscalStatus: 'not_configured', warning: 'no válido para Hacienda' })
    await reconcileMobile(env, fetcher, 100, path)
    expect((await ref().get()).data()).toMatchObject({ status: 'paid', invoicePending: false, invoiceId: 'invoice-mobile' })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect((await db.collection(`${path}/digitalReceipts`).get()).size).toBe(1)
  })
})
