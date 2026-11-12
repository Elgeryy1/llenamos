import { randomUUID, createHmac } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import type { CallableRequest } from 'firebase-functions/v2/https'
import * as core from '@llenamos/core'
import * as entry from '../index'
import { execute } from './index'
import { demoPosSettings } from './seed'
import { db } from '../shared'
import { createLink, startPayment, viewCheckout } from '../fase3-mobile/service'
import { ingestWebhook } from '../fase3-mobile/worker'
import { viewReceipt } from '../fase3-mobile/receipts'
import { processRequest } from '../fase3-print/queue'
import { chainKey } from './fiscal'

const enabled = process.env.TEST_FIREBASE_EMULATORS === '1' && process.env.GCLOUD_PROJECT === 'demo-llenamos' && !!process.env.FIRESTORE_EMULATOR_HOST
describe.skipIf(!enabled)('Integración de las tres piezas con el único libro de caja', () => {
  const restaurantId = `integracion-${randomUUID()}`, locationId = 'centro', scope = { restaurantId, locationId }
  const root = db.doc(`restaurants/${restaurantId}`), local = root.collection('locations').doc(locationId)
  const settings = { ...demoPosSettings(), system: { ...demoPosSettings().system, installation: restaurantId }, mobilePayments: true }
  const request = (data: unknown) => ({ data, auth: { uid: 'owner', token: {} } }) as unknown as CallableRequest<unknown>
  const mutation = () => ({ ...scope, requestId: randomUUID() })
  afterAll(async () => {
    // Borrado acotado de esta fixture: no depende del BulkWriter ni limpia demos ajenas.
    const refs = [root]
    for (let i = 0; i < refs.length; i++) for (const collection of await refs[i]!.listCollections()) {
      refs.push(...(await collection.get()).docs.map(d => d.ref))
    }
    for (let i = 0; i < refs.length; i += 200) { const batch = db.batch(); for (const ref of refs.slice(i, i + 200)) batch.delete(ref); await batch.commit() }
     await db.doc(`fiscalInstallations/${chainKey(settings)}`).delete(); await db.doc(`publicMenus/${core.publicMenuId(restaurantId, locationId)}`).delete() }, 60000)
  it('exporta el contrato completo, cobra el webhook firmado una vez y produce recibo e impresión fiscales originales', async () => {
    for (const name of Object.keys(core.CALLABLES_FASE3)) expect(entry).toHaveProperty(name)
    await root.set({ name: 'Integración local', slug: restaurantId, brandColor: '#f0a35e', timezone: 'Europe/Madrid', plan: 'completo', activeModules: ['floor', 'kitchen', 'pos'] })
    await local.set({ name: 'Centro', slug: 'centro' })
    await root.collection('members').doc('owner').set({ uid: 'owner', displayName: 'Propietaria', email: 'owner@example.test', role: 'owner', active: true, locationIds: [] })
    await local.collection('tables').doc('mesa').set({ name: 'Mesa integración', areaId: 'sala', seats: 4, enabled: true, joinableWith: [], shape: 'rect', x: 10, y: 10, w: 10, h: 10 })
    const menu = core.demoMenu()
    await local.collection('settings').doc('floor').set(menu.settings)
    for (const [key, rows] of Object.entries({ menuCategories: menu.categories, menuItems: menu.items, stations: menu.stations })) {
      for (const [id, value] of Object.entries(rows)) await local.collection(key).doc(id).set(value)
    }
    await execute('guardarConfiguracionCaja', { ...mutation(), settings }, request(null))
    await execute('abrirCaja', { ...mutation(), registerId: 'principal', openingCents: 0 }, request(null))
    const opened = await entry.abrirMesa.run(request({ ...scope, tableIds: ['mesa'], guests: 2 })) as core.CallableOutput<'abrirMesa'>
    await entry.enviarPedido.run(request({ ...scope, sessionId: opened.sessionId, lines: [{ kind: 'item', itemId: 'bravas', quantity: 1 }] }))
    const account = await execute('abrirCuenta', { ...mutation(), target: { kind: 'session', id: opened.sessionId } }, request(null))
    const locked = await execute('prepararCobro', { ...mutation(), billId: account.billId, expectedRevision: account.bill.revision }, request(null))
    const current = await execute('verCuenta', { ...scope, billId: account.billId }, request(null)), part = current.parts[0]!
    const link = await createLink({ ...mutation(), billId: account.billId, partId: part.id, expectedRevision: locked.revision }, request(null))
    const publicLink = { slug: restaurantId, locationId, checkoutId: link.checkoutId, token: link.token }
    const env = { GCLOUD_PROJECT: 'demo-llenamos', FUNCTIONS_EMULATOR: 'true', PUBLIC_APP_URL: 'http://localhost:3015', STRIPE_SECRET_KEY: 'sk_test_ficticia_solo_transporte_inyectado', STRIPE_MOBILE_WEBHOOK_SECRET: 'secreto-publico-de-prueba', STRIPE_MOBILE_MODE: 'single' }
    let session: Record<string, unknown> = {}
    const transport: typeof fetch = async (_url, init) => {
      const b = init!.body as URLSearchParams
      session = { id: 'cs_test_integracion', url: 'https://checkout.stripe.com/c/pay/cs_test_integracion', status: 'open', payment_status: 'unpaid', amount_total: part.totalCents + 50, currency: 'eur', livemode: false, expires_at: Math.floor(Date.now() / 1000) + 1800,
        metadata: Object.fromEntries(['restaurantId', 'locationId', 'checkoutId', 'amountCents', 'tipCents'].map(k => [k, b.get(`metadata[${k}]`)])) }
      return new Response(JSON.stringify(session), { status: 200 })
    }
    expect(await startPayment({ ...publicLink, requestId: 'iniciar', tipCents: 50, acceptDigitalReceipt: true }, env, transport)).toHaveProperty('status', 'ready')
    const seconds = Math.floor(Date.now() / 1000)
    const body = Buffer.from(JSON.stringify({ id: 'evt_integracion', type: 'checkout.session.completed', created: seconds, data: { object: { ...session, status: 'complete', payment_status: 'paid' } } }))
    const signature = `t=${seconds},v1=${createHmac('sha256', env.STRIPE_MOBILE_WEBHOOK_SECRET).update(`${seconds}.${body}`).digest('hex')}`
    expect(await ingestWebhook(body, signature, env)).toBe(200)
    expect(await ingestWebhook(body, signature, env)).toBe(200)
    expect((await local.collection('payments').get()).size).toBe(1)
    expect((await local.collection('paymentReservations').get()).empty).toBe(true)
    expect((await local.collection('invoices').get()).size).toBe(1)
    const checkout = await viewCheckout(publicLink, env)
    expect(checkout.status).toBe('paid'); expect(checkout.invoicePending).toBe(false); expect(checkout.receiptPath).toBeTruthy()
    const receiptPath = new URL(checkout.receiptPath!, 'http://localhost:3015')
    const receipt = await viewReceipt({ slug: restaurantId, locationId, receiptId: receiptPath.pathname.split('/').at(-1), token: receiptPath.searchParams.get('t') })
    expect(receipt.warning).toContain('no válido para Hacienda'); expect(receipt.invoice.totalCents).toBe(part.totalCents)
    const bridgeToken = await entry.vincularPuente.run(request({ ...mutation(), bridgeId: 'local' })) as core.CallableOutput<'vincularPuente'>
    expect(bridgeToken.token).toHaveLength(43)
    await entry.guardarImpresora.run(request({ ...mutation(), printerId: null, printer: { name: 'Caja', bridgeId: 'local', paperMm: 80, columns: 48, stationIds: [], tickets: true, drawer: true, active: true } }))
    const requests = await local.collection('printRequests').where('kind', '==', 'invoice').get()
    for (const r of requests.docs) { await processRequest(scope, r.id); await processRequest(scope, r.id) }
    const jobs = await local.collection('printJobs').where('kind', '==', 'invoice').get()
    expect(jobs.size).toBe(1)
    expect(jobs.docs[0]!.get('document.fiscal.warning')).toContain('no válido para Hacienda')
  }, 60000)
})
