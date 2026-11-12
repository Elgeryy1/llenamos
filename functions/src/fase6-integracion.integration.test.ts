import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'
import type { CallableRequest, Request } from 'firebase-functions/v2/https'
import * as core from '@llenamos/core'
import { testFiscalRecord, testInvoice } from '../../packages/core/src/caja/datos-prueba'
import { auth, db } from './shared'
import { completeOnboarding, saveOnboarding } from './fase6-billing/onboarding'
import { billingAction, viewSubscription } from './fase6-billing/billing'
import { refreshPlatformAccess, hash } from './fase6-billing/context'
import { handleBillingEvent } from './fase6-billing/webhook'
import { processSubscriptions } from './fase6-billing/process'
import { eventFixture, invoiceFixture } from './fase6-billing/fixtures'
import type { BillingProvider } from './fase6-billing/provider'
import { execute as platform } from './fase6-api/service'
import { apiHandler } from './fase6-api/http'
import { processPlatformWebhooks } from './fase6-api/events'
import * as booking from './reservations'
import * as floor from './fase2'
import * as cash from './fase3'
import { fiscalClock } from './fase3/fiscal'
import { invitarMiembro } from './invitarMiembro'
import { execute as privacy } from './fase6-privacy'
import { processPrivacyJobs } from './fase6-privacy/worker'
import { execute as backup, processBackup, processDrill } from './fase6-backup'
import { rootOf } from './fase6-privacy/infra'

/**
 * Fase 6 de punta a punta, sin Stripe real ni red: alta con prueba gratis, reservas, sala y caja con webhooks
 * firmados que recibe un servidor local, API con clave, suscripción simulada (cambio de plan, impago y suspensión),
 * exportar y borrar un cliente y simulacro de restauración.
 */
const local = (host: string | undefined) => /^127\.0\.0\.1:\d+$/.test(host ?? '')
const enabled = process.env.TEST_FIREBASE_EMULATORS === '1' && process.env.GCLOUD_PROJECT === 'demo-llenamos' && local(process.env.FIRESTORE_EMULATOR_HOST) && local(process.env.FIREBASE_AUTH_EMULATOR_HOST)
const custody = !!process.env.PLATFORM_DATA_KEY_V1 && local(process.env.FIREBASE_STORAGE_EMULATOR_HOST)
const lid = 'principal'
const req = (uid: string, data: unknown = {}, logiqd = false) => ({ auth: { uid, token: { logiqd } }, data }) as unknown as CallableRequest<unknown>
const requestId = () => randomUUID()
const roots: string[] = [], users: string[] = [], plans: string[] = [], targets: string[] = []
let uid: string, rid: string, slug: string, receiver: Server, port: number
const received: { body: string; signature: string }[] = []
const cleanup: (() => Promise<unknown>)[] = []

const events = async (type?: string) => (await db.collection(`restaurants/${rid}/platformEvents`).get()).docs.map(d => d.data()).filter(e => !type || e.type === type)
async function pricePlan(extra: Partial<core.PlanLimits> = {}) {
  const key = randomUUID().replaceAll('-', '')
  const p = core.PlanDefinitionSchema.parse({ ...core.provisionalPlanCatalog()[2]!, id: `plan_${key}`, stripeMonthlyPriceId: `price_${key}`, stripeAnnualPriceId: `price_year_${key}`, limits: { ...core.provisionalPlanCatalog()[2]!.limits, ...extra } })
  await db.doc(`platformPlans/${p.id}/versions/1`).set(p); plans.push(p.id)
  return p
}
const fakeProvider = (): BillingProvider => ({ configured: true, start: vi.fn(async () => ({ id: 'cs_fixture', url: 'https://checkout.stripe.com/fixture' })), portal: vi.fn(async () => ({ url: 'https://billing.stripe.com/fixture' })), cancel: vi.fn(async () => ({ endsAt: Date.now() + 10_000 })), current: vi.fn(async () => { throw new Error('Sin respuesta inyectada') }) }) as BillingProvider
async function http(token: string, resource: string, restaurantId = rid, locationId = lid) {
  let status = 200, body: unknown
  const res = { set: () => res, status: (code: number) => { status = code; return res }, json: (value: unknown) => { body = value; return res } }
  await apiHandler({ method: 'GET', path: `/v1/restaurants/${restaurantId}/locations/${locationId}/${resource}`, query: {}, get: () => `Bearer ${token}` } as unknown as Request, res as unknown as Parameters<typeof apiHandler>[1])
  return { status, body: body as Record<string, unknown> }
}
/** Transporte local: solo el destino lógico del test sale al receptor del equipo, con la firma intacta. */
const transport = (url: string, body: string, signature: string) => new Promise<number>((resolve, reject) => {
  if (url !== 'https://93.184.216.34/eventos') return reject(new Error('Destino no permitido para el transporte local.'))
  const r = httpRequest(`http://127.0.0.1:${port}/eventos`, { method: 'POST', headers: { 'Llenamos-Signature': signature, 'Content-Type': 'application/json' }, timeout: 10_000 }, res => { res.resume(); resolve(res.statusCode ?? 500) })
  r.on('error', reject); r.end(body)
})

describe.skipIf(!enabled)('Fase 6 integrada de punta a punta', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    receiver = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', c => chunks.push(c)); request.on('end', () => { received.push({ body: Buffer.concat(chunks).toString('utf8'), signature: String(request.headers['llenamos-signature'] ?? '') }); response.writeHead(204).end() })
    })
    await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve))
    port = (receiver.address() as AddressInfo).port
  })
  afterAll(async () => {
    await new Promise<void>(resolve => receiver.close(() => resolve()))
    for (const fn of cleanup) await fn().catch(() => undefined)
    for (const id of roots) {
      const root = await db.doc(`restaurants/${id}`).get()
      await db.recursiveDelete(db.doc(`restaurants/${id}`)); await db.doc(`platformRestaurantUsage/${id}`).delete()
      if (root.exists) { await db.doc(`restaurantSlugs/${root.get('slug')}`).delete(); await db.doc(`publicRestaurants/${root.get('slug')}`).delete() }
    }
    for (const id of plans) await db.recursiveDelete(db.doc(`platformPlans/${id}`))
    for (const target of targets) if (target.startsWith('restoreSandbox/')) await db.recursiveDelete(db.doc(target))
    for (const u of users) { await db.doc(`onboardingKeys/${hash(['owner', u])}`).delete(); await db.doc(`users/${u}`).delete(); await auth.deleteUser(u).catch(() => undefined) }
  }, 60_000)

  it('alta de un restaurante nuevo con prueba gratis y contadores del plan', async () => {
    const user = await auth.createUser({ email: `e2e-${randomUUID()}@test.es`, displayName: 'Propietaria', password: 'Llenamos2026!' })
    uid = user.uid; users.push(uid); slug = `integra-${randomUUID().slice(0, 8)}`
    const settings = core.defaultReservationSettings()
    const shifts = [{ name: 'Servicio', from: '00:00', lastEntry: '23:45' }]
    settings.week = { mon: shifts, tue: shifts, wed: shifts, thu: shifts, fri: shifts, sat: shifts, sun: shifts }
    settings.publicBooking = true; settings.autoConfirm = true; settings.minNoticeMinutes = 0
    const draft: core.OnboardingDraft = { name: 'Restaurante integrado', slug, location: { name: 'Principal', address: 'Calle de prueba 4', city: 'Barcelona', phone: '' }, settings, planId: 'grupo', planVersion: 1, acceptedTermsVersion: 'alta-provisional-v1', floor: { areaName: 'Comedor', tableCount: 4, seats: 4 }, menu: [{ name: 'Bravas', priceCents: 650 }] } as core.OnboardingDraft
    const saved = await saveOnboarding(uid, { requestId: requestId(), onboardingId: null, expectedRevision: null, step: 'review', draft })
    const done = await completeOnboarding(uid, { requestId: requestId(), onboardingId: saved.onboardingId, expectedRevision: saved.onboarding.revision })
    rid = done.restaurantId; roots.push(rid)
    cleanup.push(async () => db.doc(`onboardings/${saved.onboardingId}`).delete())
    const state = await viewSubscription(uid, rid)
    expect(state.subscription.status).toBe('trialing')
    expect(state.entitlements).toMatchObject({ serviceEnabled: true, planId: 'grupo' })
    expect((await db.doc(`restaurants/${rid}/platform/usage`).get()).data()).toMatchObject({ locations: 1, members: 1 })
    // La caja del plan grupo necesita su configuración fiscal de prueba (proveedor no válido para Hacienda).
    const year = fiscalClock(Date.now(), 'Europe/Madrid').year, system = testFiscalRecord().system
    await db.doc(`restaurants/${rid}/locations/${lid}/settings/pos`).set({ issuer: testInvoice().issuer, system: { ...system, installation: rid }, providerId: 'local_test', fiscalRegime: 'verifactu', environment: 'test', ordinarySeriesId: `ordinary_${year}`, rectifyingSeriesId: `rectifying_${year}`, mobilePayments: false })
  })

  it('reserva, sala y caja dejan sus eventos en la misma transacción y sin duplicados con reintentos', async () => {
    const date = core.sumarDias(core.horaLocal(Date.now(), 'Europe/Madrid').fecha, 2)
    const created = await booking.crearReservaPublica.run(req('', { slug, locationId: lid, date, time: '13:00', partySize: 2, guestName: 'Ana Cliente', phone: '+34600000999', language: 'es', acceptPolicy: true })) as { reference: string; status: string }
    const reservationId = (await db.collection(`restaurants/${rid}/locations/${lid}/reservations`).where('reference', '==', created.reference).get()).docs[0]!.id
    expect(await events('reservation.created')).toHaveLength(1)
    // El mismo cambio de estado no se puede repetir y no deja un segundo evento.
    const change = { restaurantId: rid, locationId: lid, reservationId, status: 'cancelled' }
    await booking.cambiarEstadoReserva.run(req(uid, change))
    await expect(booking.cambiarEstadoReserva.run(req(uid, change))).rejects.toBeDefined()
    expect(await events('reservation.statusChanged')).toHaveLength(1)

    const opened = await floor.abrirMesa.run(req(uid, { restaurantId: rid, locationId: lid, tableIds: ['mesa_1'], guests: 2 })) as core.CallableOutput<'abrirMesa'>
    const order = { restaurantId: rid, locationId: lid, sessionId: opened.sessionId, requestId: requestId(), lines: [{ kind: 'item', itemId: 'plato_1', quantity: 2 }] }
    const placed = await floor.enviarPedido.run(req(uid, order)) as core.CallableOutput<'enviarPedido'>
    expect(placed).toMatchObject({ status: 'sent' })
    expect(await floor.enviarPedido.run(req(uid, order))).toEqual(placed)
    expect(await events('order.placed')).toHaveLength(1)

    // Caja: cuenta, cobro en efectivo y recuperación del mismo cobro por su requestId.
    const scope = { restaurantId: rid, locationId: lid }
    const call = <N extends (typeof cash.names)[number]>(name: N, d: unknown) => cash.execute(name, d, req(uid, d)) as Promise<core.CallableOutput<N>>
    const { cashSessionId } = await call('abrirCaja', { ...scope, requestId: requestId(), registerId: 'principal', openingCents: 10000 })
    const account = await call('abrirCuenta', { ...scope, requestId: requestId(), target: { kind: 'session', id: opened.sessionId } })
    const locked = await call('prepararCobro', { ...scope, requestId: requestId(), billId: account.billId, expectedRevision: account.bill.revision })
    const view = await call('verCuenta', { ...scope, billId: account.billId })
    const pay = { ...scope, requestId: requestId(), billId: account.billId, expectedRevision: locked.revision, partId: view.parts[0]!.id, cashSessionId, method: 'cash', amountCents: account.bill.totalCents, tipCents: 0, tenderedCents: account.bill.totalCents }
    const first = await call('registrarCobro', pay)
    expect(await call('registrarCobro', pay)).toEqual(first)
    expect(await events('payment.succeeded')).toHaveLength(1)
    // Todos los eventos nacen sin distribuir y no llevan contacto ni importes.
    const all = await events()
    expect(all.length).toBeGreaterThanOrEqual(4)
    expect(JSON.stringify(all)).not.toContain('Ana Cliente'); expect(JSON.stringify(all)).not.toContain('600000999')
  })

  it('un receptor local recibe cada evento una sola vez con firma válida y la API responde con clave', async () => {
    const hook = await platform('guardarWebhook', { restaurantId: rid, requestId: requestId(), endpointId: null, url: 'https://93.184.216.34/eventos', events: ['reservation.created', 'reservation.statusChanged', 'order.placed', 'payment.succeeded', 'subscription.changed'], locationIds: [lid], status: 'active' }, req(uid)) as core.CallableOutput<'guardarWebhook'>
    expect(hook.secret).toBeTruthy()
    for (let i = 0; i < 3; i++) await processPlatformWebhooks(rid, transport)
    const kinds = received.map(r => core.PlatformEventSchema.parse(JSON.parse(r.body)))
    expect(kinds.map(k => k.type).sort()).toEqual(['order.placed', 'payment.succeeded', 'reservation.created', 'reservation.statusChanged', 'subscription.changed'])
    expect(new Set(kinds.map(k => k.id)).size).toBe(kinds.length)
    for (const r of received) expect(core.verifyPlatformWebhook(hook.secret!, r.signature, r.body, Date.now())).toBe(true)
    expect(core.verifyPlatformWebhook(hook.secret!, received[0]!.signature, received[0]!.body + ' ', Date.now())).toBe(false)
    const count = received.length
    for (let i = 0; i < 2; i++) await processPlatformWebhooks(rid, transport)
    expect(received).toHaveLength(count)

    const key = await platform('crearClaveApi', { restaurantId: rid, requestId: requestId(), name: 'Aplicación', scopes: ['menu.read', 'orders.read'], locationIds: [lid], expiresAt: Date.now() + 86_400_000 }, req(uid)) as core.CallableOutput<'crearClaveApi'>
    const orders = await http(key.token, 'orders')
    expect(orders.status).toBe(200)
    expect(JSON.stringify(orders.body)).not.toContain('Ana Cliente')
    expect((await http(key.token, 'orders', 'otro-restaurante')).status).toBeGreaterThanOrEqual(400)
    expect((await http('token-inventado', 'orders')).status).toBe(401)
  })

  it('el límite de personas del plan se aplica y desactivar libera el hueco', async () => {
    const small = await pricePlan({ members: 2 })
    // Cambia al plan pequeño por el mismo camino que usa el portal de pago: contrato, factura pagada y límites nuevos.
    await db.doc(`restaurants/${rid}/platform/subscription`).update({ stripeCustomerId: `cus_${rid}`, stripeSubscriptionId: `sub_${rid}`, planId: small.id, planVersion: 1 })
    const end = Math.floor((Date.now() + 30 * 86_400_000) / 1000) * 1000
    const paid = invoiceFixture({ customer: `cus_${rid}`, subscription: `sub_${rid}`, price: small.stripeMonthlyPriceId!, amount: small.monthlyCents, end })
    expect(await handleBillingEvent(eventFixture(`evt_${requestId()}`, 'invoice.paid', paid))).toMatchObject({ status: 'applied' })
    const state = await viewSubscription(uid, rid)
    expect(state.subscription).toMatchObject({ status: 'active', planId: small.id }); expect(state.entitlements.limits.members).toBe(2)
    const invite = (email: string) => invitarMiembro.run(req(uid, { restaurantId: rid, email, displayName: 'Camarero', role: 'waiter', password: 'Llenamos2026!' }))
    const waiter = await invite(`camarero-${randomUUID()}@test.es`) as { uid: string }
    users.push(waiter.uid)
    await expect(invite(`otro-${randomUUID()}@test.es`)).rejects.toMatchObject({ code: 'resource-exhausted' })
    expect((await db.doc(`restaurants/${rid}/platform/usage`).get()).get('members')).toBe(2)
  })

  it('sin claves de Stripe no se cobra y se dice; con el proveedor simulado la suscripción cambia de plan', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No debe haber red'))
    try {
      const subscription = (await db.doc(`restaurants/${rid}/platform/subscription`).get()).data()!
      const base = { restaurantId: rid, requestId: requestId(), expectedRevision: subscription.revision, planId: 'grupo', planVersion: 1, interval: 'month' as const }
      expect(await billingAction(uid, 'iniciarSuscripcion', base)).toMatchObject({ status: 'not_configured', message: expect.stringContaining('No se ha realizado ningún cargo') })
      expect(spy).not.toHaveBeenCalled()
    } finally { spy.mockRestore() }
    const big = await pricePlan({ members: 50 })
    const current = (await db.doc(`restaurants/${rid}/platform/subscription`).get()).data()!
    expect(await billingAction(uid, 'iniciarSuscripcion', { restaurantId: rid, requestId: requestId(), expectedRevision: current.revision, planId: big.id, planVersion: 1, interval: 'month' }, fakeProvider())).toMatchObject({ status: 'ready' })
    await db.doc(`restaurants/${rid}/platform/subscription`).update({ planId: big.id, planVersion: 1 })
    const end = Math.floor((Date.now() + 30 * 86_400_000) / 1000) * 1000
    await handleBillingEvent(eventFixture(`evt_${requestId()}`, 'invoice.paid', invoiceFixture({ customer: `cus_${rid}`, subscription: `sub_${rid}`, price: big.stripeMonthlyPriceId!, amount: big.monthlyCents, end, invoiceId: 'in_cambio' }), Math.floor(Date.now() / 1000) + 1))
    expect((await viewSubscription(uid, rid)).entitlements.limits.members).toBe(50)
    expect((await events('subscription.changed')).length).toBeGreaterThanOrEqual(1)
    for (let i = 0; i < 3; i++) await processPlatformWebhooks(rid, transport)
    expect(received.some(r => core.PlatformEventSchema.parse(JSON.parse(r.body)).type === 'subscription.changed')).toBe(true)
  })

  it('el impago da siete días de gracia y después suspende reservas, sala, caja y altas, conservando la administración', async () => {
    const created = Math.floor(Date.now() / 1000) + 5, now = Date.now()
    await handleBillingEvent(eventFixture(`evt_${requestId()}`, 'invoice.payment_failed', invoiceFixtureFor(await currentPlan(), false), created), undefined, now)
    expect((await viewSubscription(uid, rid)).subscription.status).toBe('past_due')
    // Durante la gracia se sigue sirviendo.
    const date = core.sumarDias(core.horaLocal(Date.now(), 'Europe/Madrid').fecha, 3)
    const input = { slug, locationId: lid, date, time: '14:00', partySize: 2, guestName: 'Luis', phone: '+34600000111', language: 'es', acceptPolicy: true }
    await expect(booking.crearReservaPublica.run(req('', input))).resolves.toBeDefined()
    // Vencida la gracia, el acceso se corta en todas las operaciones.
    const grace = core.SubscriptionSchema.parse((await db.doc(`restaurants/${rid}/platform/subscription`).get()).data()).graceEndsAt!
    await db.runTransaction(async tx => { const access = await refreshPlatformAccess(tx, rid, grace); access!.commit() })
    await processSubscriptions(grace + 1)
    const root = (await db.doc(`restaurants/${rid}`).get()).data()!
    expect(root.activeModules).toEqual([])
    // Aunque la proyección fuera por detrás del reloj, la fecha de acceso ya vencida basta para cortar el servicio.
    await db.doc(`restaurants/${rid}`).update({ activeModules: ['reservations', 'floor', 'kitchen', 'pos'], accessValidUntil: Timestamp.fromMillis(Date.now() - 1000) })
    await expect(booking.crearReservaPublica.run(req('', { ...input, time: '15:00' }))).rejects.toMatchObject({ code: 'failed-precondition' })
    await expect(booking.crearReserva.run(req(uid, { restaurantId: rid, locationId: lid, date, time: '16:00', partySize: 2, guestName: 'Eva', phone: '+34600000222', source: 'phone' }))).rejects.toMatchObject({ code: 'failed-precondition' })
    await expect(floor.abrirMesa.run(req(uid, { restaurantId: rid, locationId: lid, tableIds: ['mesa_2'], guests: 2 }))).rejects.toMatchObject({ code: 'failed-precondition' })
    await expect(cash.execute('abrirCaja', { restaurantId: rid, locationId: lid, requestId: requestId(), registerId: 'principal', openingCents: 0 }, req(uid))).rejects.toMatchObject({ code: 'failed-precondition' })
    await expect(invitarMiembro.run(req(uid, { restaurantId: rid, email: `tarde-${randomUUID()}@test.es`, displayName: 'Tarde', role: 'waiter', password: 'Llenamos2026!' }))).rejects.toMatchObject({ code: 'failed-precondition' })
    expect((await http('token-inventado', 'orders')).status).toBe(401)
    // La administración sigue disponible: ver la suscripción y los datos.
    const state = await viewSubscription(uid, rid)
    expect(state.entitlements.serviceEnabled).toBe(false)
    expect((await db.doc(`restaurants/${rid}/members/${uid}`).get()).exists).toBe(true)
  })

  it.skipIf(!custody)('exporta y borra un cliente conservando lo fiscal, y el simulacro de restauración pasa', async () => {
    const cid = core.customerIdFor(rid, '+34600000999')
    await rootOf(rid).collection('privacyEvidence').doc('prueba').set({ customerId: cid, verified: true, method: 'in_person', expiresAt: Timestamp.fromMillis(Date.now() + 3_600_000) })
    const owner = req(uid)
    const ask = async (kind: 'export' | 'erase') => {
      const result = await privacy('solicitarPrivacidad', { restaurantId: rid, requestId: requestId(), customerId: cid, kind, reason: 'Solicitud de la persona' }, owner) as { jobId: string }
      await privacy('verificarSolicitudPrivacidad', { restaurantId: rid, requestId: requestId(), jobId: result.jobId, evidenceId: 'prueba' }, owner)
      await processPrivacyJobs(rid)
      return (await rootOf(rid).collection('privacyJobs').doc(result.jobId).get()).data()!
    }
    // La ficha del cliente la crea el disparador de reservas.
    await expect.poll(async () => (await rootOf(rid).collection('customers').doc(cid).get()).exists, { timeout: 40_000 }).toBe(true)
    expect(await ask('export')).toMatchObject({ status: 'completed' })
    expect(await ask('erase')).toMatchObject({ status: 'completed', error: null })
    expect((await rootOf(rid).collection('customers').doc(cid).get()).exists).toBe(false)
    // El disparador de reservas no vuelve a crear la ficha de quien se ha borrado.
    await new Promise(resolve => setTimeout(resolve, 3000))
    expect((await rootOf(rid).collection('customers').doc(cid).get()).exists).toBe(false)
    const reservations = await db.collectionGroup('reservations').where('customerId', '==', cid).get()
    for (const doc of reservations.docs) expect(JSON.stringify(doc.data())).not.toContain('Ana Cliente')
    // Los cobros y la factura (fiscal) siguen ahí.
    expect((await db.collection(`restaurants/${rid}/locations/${lid}/payments`).get()).size).toBeGreaterThanOrEqual(1)

    // Copia cifrada y simulacro de restauración aislado, medido.
    const internal = req('logiqd', {}, true)
    // Con el emulador de funciones los disparadores pueden seguir escribiendo un rato: la copia
    // exige una ventana estable y se reintenta, como pide su propio error.
    let made!: core.CallableOutput<'crearCopiaSeguridad'>
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 2000))
      made = await backup('crearCopiaSeguridad', { restaurantId: rid, requestId: requestId(), reason: 'Prueba de recuperación' }, internal) as core.CallableOutput<'crearCopiaSeguridad'>
      await processBackup(rid, made.backupId)
      if ((await rootOf(rid).collection('backups').doc(made.backupId).get()).get('status') === 'verified') break
    }
    expect((await rootOf(rid).collection('backups').doc(made.backupId).get()).get('status')).toBe('verified')
    const drill = await backup('simularRestauracion', { restaurantId: rid, requestId: requestId(), backupId: made.backupId }, internal) as core.CallableOutput<'simularRestauracion'>
    await processDrill(rid, drill.drillId)
    const data = (await rootOf(rid).collection('restoreDrills').doc(drill.drillId).get()).data()!
    targets.push(data.isolatedTarget)
    expect(data.status, data.error).toBe('passed')
    expect(Object.values(data.checks).every(Boolean)).toBe(true)
    expect(data.measuredRtoMs).toBeGreaterThanOrEqual(0); expect(data.measuredRpoMs).toBeGreaterThanOrEqual(0)
    // La copia no resucita al cliente borrado y el original sigue intacto.
    expect((await db.doc(`${data.isolatedTarget}/restaurants/${rid}/customers/${cid}`).get()).exists).toBe(false)
  })
})

// Utilidades de este archivo: plan vigente de la suscripción para componer una factura impagada.
async function currentPlan() {
  const planId = (await db.doc(`restaurants/${rid}/platform/subscription`).get()).get('planId') as string
  return core.PlanDefinitionSchema.parse((await db.doc(`platformPlans/${planId}/versions/1`).get()).data())
}
function invoiceFixtureFor(plan: core.PlanDefinition, paid: boolean) {
  return invoiceFixture({ customer: `cus_${rid}`, subscription: `sub_${rid}`, price: plan.stripeMonthlyPriceId!, amount: plan.monthlyCents, end: Math.floor((Date.now() + 30 * 86_400_000) / 1000) * 1000, paid, invoiceId: `in_${randomUUID().slice(0, 8)}` })
}
