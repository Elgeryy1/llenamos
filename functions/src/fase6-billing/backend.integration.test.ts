import { createHmac, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'
import type { CallableRequest } from 'firebase-functions/v2/https'
import * as core from '@llenamos/core'
import { auth, db } from '../shared'
import * as api from './index'
import { saveOnboarding, completeOnboarding, legacyCreate } from './onboarding'
import { billingAction, viewSubscription } from './billing'
import { assertPlatformCapacity, hash, refreshPlatformAccess } from './context'
import { handleBillingEvent } from './webhook'
import { processSubscriptions } from './process'
import { stripeBillingProvider, type BillingProvider } from './provider'
import { invoiceFixture, eventFixture, subscriptionFixture } from './fixtures'
import { cambiarPlan, consultarDisponibilidad } from '../reservations'
import { abrirMesa, enviarPedido } from '../fase2'

const enabled = process.env.TEST_FIREBASE_EMULATORS === '1' && process.env.GCLOUD_PROJECT === 'demo-llenamos' && /^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '') && /^127\.0\.0\.1:\d+$/.test(process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '')
const req = (uid: string, data: unknown, logiqd = false) => ({ auth: { uid, token: { logiqd } }, data }) as unknown as CallableRequest<unknown>
const users: string[] = [], roots: string[] = [], onboardings: string[] = [], plans: string[] = []
const requestId = () => randomUUID()
async function user() { const u = await auth.createUser({ email: `billing-${randomUUID()}@test.es`, displayName: 'Propietaria local', password: 'Llenamos2026!' }); users.push(u.uid); return u.uid }
async function draft(uid: string, slug = `local-${randomUUID()}`, custom?: core.PlanDefinition) {
  const settings = core.defaultReservationSettings()
  const shifts = [{ name: 'Servicio', from: '00:00', lastEntry: '23:45' }]
  settings.week = { mon: shifts, tue: shifts, wed: shifts, thu: shifts, fri: shifts, sat: shifts, sun: shifts }
  settings.publicBooking = true
  settings.minNoticeMinutes = 0
  const d: core.OnboardingDraft = { name: 'Restaurante local', slug, location: { name: 'Principal', address: 'Calle de prueba 4', city: 'Barcelona', phone: '' }, settings, planId: custom?.id ?? 'sala', planVersion: custom?.version ?? 1, acceptedTermsVersion: 'alta-provisional-v1', floor: { areaName: 'Comedor', tableCount: 4, seats: 4 }, menu: [{ name: 'Patatas', priceCents: 650 }] }
  const result = await saveOnboarding(uid, { requestId: requestId(), onboardingId: null, expectedRevision: null, step: 'review', draft: d })
  onboardings.push(result.onboardingId)
  return { input: { requestId: requestId(), onboardingId: result.onboardingId, expectedRevision: result.onboarding.revision }, draft: d }
}
async function create(custom?: core.PlanDefinition) {
  const uid = await user(), saved = await draft(uid, undefined, custom), result = await completeOnboarding(uid, saved.input)
  roots.push(result.restaurantId)
  return { uid, saved, ...result, subRef: db.doc(`restaurants/${result.restaurantId}/platform/subscription`) }
}
async function pricePlan(limits?: Partial<core.PlanLimits>) {
  const key = randomUUID().replaceAll('-','')
  const p = core.PlanDefinitionSchema.parse({ ...core.provisionalPlanCatalog()[1]!, id: `plan_${key}`, stripeMonthlyPriceId: `price_${key}`, stripeAnnualPriceId: `price_year_${key}`, limits: { ...core.provisionalPlanCatalog()[1]!.limits, ...limits } })
  await db.doc(`platformPlans/${p.id}/versions/1`).set(p); plans.push(p.id)
  return p
}
function provider(extra: Partial<BillingProvider> = {}): BillingProvider {
  return { configured: true, start: vi.fn(async () => ({ id: 'cs_fixture', url: 'https://checkout.stripe.com/fixture' })), portal: vi.fn(async () => ({ url: 'https://billing.stripe.com/fixture' })), cancel: vi.fn(async () => ({ endsAt: Date.now()+10000 })), current: vi.fn(async () => { throw new Error('Falta respuesta inyectada') }), ...extra }
}
async function bound() {
  const p = await pricePlan(), c = await create(p)
  await c.subRef.update({ stripeCustomerId: `cus_${c.restaurantId}`, stripeSubscriptionId: `sub_${c.restaurantId}` })
  const end = Math.floor((Date.now()+30*86400000)/1000)*1000
  return { ...c, p, end, invoice: (paid = true, invoiceId = 'in_fixture') => invoiceFixture({ customer: `cus_${c.restaurantId}`, subscription: `sub_${c.restaurantId}`, price: p.stripeMonthlyPriceId!, amount: p.monthlyCents, end, paid, invoiceId }) }
}

describe.skipIf(!enabled)('Alta y Billing con Auth, Firestore y Functions de fila 4', { timeout: 60000 }, () => {
  afterAll(async () => {
    for (const rid of roots) { const root = await db.doc(`restaurants/${rid}`).get(); if (root.exists) await db.doc(`restaurantSlugs/${root.get('slug')}`).delete(); await db.recursiveDelete(db.doc(`restaurants/${rid}`)); await db.doc(`publicRestaurants/${root.get('slug')}`).delete(); await db.doc(`publicMenus/${core.publicMenuId(rid,'principal')}`).delete() }
    for (const id of onboardings) await db.doc(`onboardings/${id}`).delete()
    for (const uid of users) { await db.doc(`onboardingKeys/${hash(['owner',uid])}`).delete(); await db.doc(`users/${uid}`).delete(); await auth.deleteUser(uid) }
    for (const id of plans) await db.recursiveDelete(db.doc(`platformPlans/${id}`))
  }, 60000)
  it('aprovisiona una sola vez, incluso con dos envíos y una respuesta perdida; el servicio admite reservas y comandas', async () => {
    const uid = await user(), saved = await draft(uid)
    const [a,b] = await Promise.all([completeOnboarding(uid,saved.input),completeOnboarding(uid,saved.input)])
    roots.push(a.restaurantId)
    expect(a).toEqual(b)
    const rid = a.restaurantId, path = `restaurants/${rid}/locations/principal`
    expect((await db.collection('restaurants').where('slug','==',saved.draft.slug).get()).size).toBe(1)
    expect((await db.doc(`restaurantSlugs/${saved.draft.slug}`).get()).get('restaurantId')).toBe(rid)
    expect((await db.doc(`${path}/stations/cocina`).get()).data()).toMatchObject({ name:'Cocina',kind:'kitchen' })
    expect((await db.collection(`${path}/tables`).get()).size).toBe(4)
    const dish = core.MenuItemSchema.parse((await db.doc(`${path}/menuItems/plato_1`).get()).data())
    expect(dish).toMatchObject({ priceCents:650,allergensReviewed:false,selfOrder:false })
    await expect.poll(async () => (await db.doc(`publicRestaurants/${saved.draft.slug}`).get()).get('bookingEnabled'), { timeout:30000 }).toBe(true)
    const day = core.horaLocal(Date.now()+86400000,'Europe/Madrid').fecha
    const availability = await consultarDisponibilidad.run(req(uid,{ slug:saved.draft.slug,locationId:'principal',date:day,partySize:2 }))
    expect(availability).toBeDefined()
    const opened = await abrirMesa.run(req(uid,{ restaurantId:rid,locationId:'principal',tableIds:['mesa_1'],guests:2 })) as core.CallableOutput<'abrirMesa'>
    const order = await enviarPedido.run(req(uid,{ restaurantId:rid,locationId:'principal',sessionId:opened.sessionId,lines:[{ kind:'item',itemId:'plato_1',quantity:2 }] }))
    expect(order).toMatchObject({ status:'sent' })
    expect(core.CompletarAltaOutputSchema.parse(a).entitlements.serviceEnabled).toBe(true)
  })
  it('reserva un slug transaccionalmente entre dos titulares y revierte el alta perdedora', async () => {
    const slug = `race-${randomUUID()}`, a = await user(), b = await user()
    const [da,dbb] = await Promise.all([draft(a,slug),draft(b,slug)])
    const outcomes = await Promise.allSettled([completeOnboarding(a,da.input),completeOnboarding(b,dbb.input)])
    expect(outcomes.filter(r => r.status==='fulfilled')).toHaveLength(1)
    for (const r of outcomes) if (r.status==='fulfilled') roots.push(r.value.restaurantId); else expect(r.reason).toMatchObject({ code:'already-exists' })
    expect((await db.collection('restaurants').where('slug','==',slug).get()).size).toBe(1)
    expect((await db.doc(`onboardingKeys/${hash(['owner',outcomes[0]!.status==='fulfilled' ? b : a])}`).get()).exists).toBe(false)
  })
  it('no concede dos pruebas a la misma cuenta y la entrada vieja usa la misma barrera', async () => {
    const c = await create(), second = await draft(c.uid)
    await expect(completeOnboarding(c.uid,second.input)).rejects.toMatchObject({ code:'failed-precondition' })
    await expect(legacyCreate(c.uid,'Otro restaurante','Otro local')).rejects.toMatchObject({ code:'failed-precondition' })
    expect((await db.doc(`restaurantSlugs/${second.draft.slug}`).get()).exists).toBe(false)
  })
  it('protege autor, revisión y huella de las peticiones de borrador', async () => {
    const uid = await user(), saved = await draft(uid), other = await user()
    await expect(saveOnboarding(other,{ requestId:requestId(),onboardingId:saved.input.onboardingId,expectedRevision:1,step:'review',draft:{} })).rejects.toMatchObject({ code:'permission-denied' })
    await expect(saveOnboarding(uid,{ requestId:requestId(),onboardingId:saved.input.onboardingId,expectedRevision:9,step:'review',draft:{} })).rejects.toMatchObject({ code:'aborted' })
    const input = { requestId:requestId(),onboardingId:saved.input.onboardingId,expectedRevision:1,step:'review' as const,draft:{ name:'Nombre nuevo' } }
    expect(await saveOnboarding(uid,input)).toEqual(await saveOnboarding(uid,input))
    await expect(saveOnboarding(uid,{ ...input,draft:{ name:'Nombre distinto' } })).rejects.toMatchObject({ code:'already-exists' })
  })
  it('reserva la última plaza de cuota ante dos altas concurrentes', async () => {
    const c = await create(await pricePlan({ members:2 }))
    const results = await Promise.allSettled([1,2].map(async () => db.runTransaction(async tx => { const capacity = await assertPlatformCapacity(tx,c.restaurantId,'members',1,Date.now()); capacity.commit() })))
    expect(results.filter(r => r.status==='fulfilled')).toHaveLength(1)
    expect((await db.doc(`restaurants/${c.restaurantId}/platform/usage`).get()).get('members')).toBe(2)
    expect(results.find(r => r.status==='rejected')).toMatchObject({ reason:{ code:'resource-exhausted' } })
  })
  it('suspende exactamente al vencer y conserva la vía administrativa; el trabajador es repetible', async () => {
    const c = await create(), ends = c.subscription.trialEndsAt!
    await db.runTransaction(async tx => { const a = await refreshPlatformAccess(tx,c.restaurantId,ends-1); expect(a!.entitlements.serviceEnabled).toBe(true); a!.commit() })
    await processSubscriptions(ends)
    const state = await viewSubscription(c.uid,c.restaurantId)
    expect(state.subscription.status).toBe('suspended'); expect(state.entitlements.activeModules).toEqual([])
    await processSubscriptions(ends+1)
    expect((await db.doc(`restaurants/${c.restaurantId}`).get()).get('activeModules')).toEqual([])
    await expect(api.verSuscripcion.run(req('ajeno',{ restaurantId:c.restaurantId }))).rejects.toMatchObject({ code:'permission-denied' })
  })
  it('sin claves no llama a red, no cobra ni altera la prueba, incluso si hay variables ficticias', async () => {
    const c = await create(), spy = vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('No debe haber red'))
    try {
      expect(stripeBillingProvider().configured).toBe(false)
      const base = { restaurantId:c.restaurantId,requestId:requestId(),expectedRevision:1 }
      const response = await billingAction(c.uid,'iniciarSuscripcion',{ ...base,planId:'sala',planVersion:1,interval:'month' })
      expect(response).toMatchObject({ status:'not_configured',message:expect.stringContaining('No se ha realizado ningún cargo') })
      await billingAction(c.uid,'abrirPortalFacturacion',{ restaurantId:c.restaurantId,requestId:requestId() })
      await billingAction(c.uid,'cancelarSuscripcion',{ ...base,requestId:requestId(),reason:'Prueba local' })
      expect(spy).not.toHaveBeenCalled(); expect((await c.subRef.get()).get('status')).toBe('trialing')
    } finally { spy.mockRestore() }
  })
  it('reserva una intención antes de HTTP y recupera el resultado con la misma clave', async () => {
    const p = await pricePlan(), c = await create(p), keys: string[] = []
    const start = vi.fn(async (d: Parameters<BillingProvider['start']>[0]) => { keys.push(d.key); if (keys.length===1) throw new Error('Respuesta perdida'); return { id:'cs_fixture',url:'https://checkout.stripe.com/fixture' } })
    const fake = provider({ start }), input = { restaurantId:c.restaurantId,requestId:requestId(),expectedRevision:1,planId:p.id,planVersion:1,interval:'month' as const }
    await expect(billingAction(c.uid,'iniciarSuscripcion',input,fake)).rejects.toThrow('Respuesta perdida')
    await expect(billingAction(c.uid,'iniciarSuscripcion',{ ...input,requestId:requestId() },fake)).rejects.toMatchObject({ code:'failed-precondition' })
    const result = await billingAction(c.uid,'iniciarSuscripcion',input,fake)
    expect(result).toMatchObject({ status:'ready' }); expect(keys[0]).toBe(keys[1])
    expect(await billingAction(c.uid,'iniciarSuscripcion',input,fake)).toEqual(result); expect(start).toHaveBeenCalledTimes(2)
    expect((await c.subRef.get()).get('status')).toBe('trialing')
    const intentId = keys[0]!
    await handleBillingEvent(eventFixture(`evt_${requestId()}`,'checkout.session.completed',{ id:'cs_fixture',mode:'subscription',customer:`cus_${c.restaurantId}`,subscription:`sub_${c.restaurantId}`,metadata:{ restaurantId:c.restaurantId,intentId } }))
    expect((await c.subRef.get()).get('status')).toBe('trialing')
    expect((await c.subRef.get()).get('stripeCustomerId')).toBe(`cus_${c.restaurantId}`)
  })
  it('verifica factura, deduplica entrega concurrente y rechaza importes, divisas e identidades ajenas', async () => {
    const c = await bound(), event = eventFixture(`evt_${requestId()}`,'invoice.paid',c.invoice())
    const results = await Promise.all([handleBillingEvent(event),handleBillingEvent(event)])
    expect(results.map(r => r.status).sort()).toEqual(['applied','duplicate'])
    expect((await viewSubscription(c.uid,c.restaurantId)).subscription.status).toBe('active')
    const logs = await db.collection(`restaurants/${c.restaurantId}/activity`).where('changeId','==',`billing_${hash(event.id)}`).get()
    expect(logs.size).toBe(1)
    for (const patch of [{ amount_paid:c.p.monthlyCents-1 },{ currency:'usd' },{ customer:'cus_ajeno' },{ status:'open' }]) {
      await expect(handleBillingEvent(eventFixture(`evt_${requestId()}`,'invoice.paid',{ ...c.invoice(),...patch },event.created+1))).rejects.toBeDefined()
    }
    expect((await c.subRef.get()).get('revision')).toBe(2)
  })
  it('reconcilia eventos antiguos consultando el proveedor sin sobrescribir el pago vigente', async () => {
    const c = await bound(), created = Math.floor(Date.now()/1000)
    await handleBillingEvent(eventFixture(`evt_${requestId()}`,'invoice.paid',c.invoice(),created))
    const old = eventFixture(`evt_${requestId()}`,'invoice.payment_failed',c.invoice(false),created-10)
    await expect(handleBillingEvent(old)).rejects.toMatchObject({ code:'unavailable' })
    const current = vi.fn(async () => subscriptionFixture(`cus_${c.restaurantId}`,`sub_${c.restaurantId}`,c.p.stripeMonthlyPriceId!,'active',c.invoice()))
    await handleBillingEvent(old,provider({ current }))
    expect(current).toHaveBeenCalledOnce(); expect((await c.subRef.get()).get('status')).toBe('active')
  })
  it('el impago tiene siete días de gracia que no se prolongan y la baja nunca revive por factura tardía', async () => {
    const c = await bound(), created = Math.floor(Date.now()/1000), now = Date.now()
    await handleBillingEvent(eventFixture(`evt_${requestId()}`,'invoice.payment_failed',c.invoice(false),created),undefined,now)
    const grace = core.SubscriptionSchema.parse((await c.subRef.get()).data()).graceEndsAt
    await handleBillingEvent(eventFixture(`evt_${requestId()}`,'invoice.payment_failed',c.invoice(false),created+1),undefined,now+1000)
    expect(core.SubscriptionSchema.parse((await c.subRef.get()).data()).graceEndsAt).toBe(grace)
    await db.runTransaction(async tx => { const access = await refreshPlatformAccess(tx,c.restaurantId,grace!); access!.commit() })
    expect((await c.subRef.get()).get('status')).toBe('suspended')
    await handleBillingEvent(eventFixture(`evt_${requestId()}`,'customer.subscription.deleted',subscriptionFixture(`cus_${c.restaurantId}`,`sub_${c.restaurantId}`,c.p.stripeMonthlyPriceId!,'canceled'),created+2))
    await expect(handleBillingEvent(eventFixture(`evt_${requestId()}`,'invoice.paid',c.invoice(),created+3))).rejects.toMatchObject({ code:'failed-precondition' })
  })
  it('programa la baja sin perder el periodo y restringe una bajada con excesos', async () => {
    const c = await bound(), now = Math.floor(Date.now()/1000)
    await handleBillingEvent(eventFixture(`evt_${requestId()}`,'invoice.paid',c.invoice(),now))
    const response = await billingAction(c.uid,'cancelarSuscripcion',{ restaurantId:c.restaurantId,requestId:requestId(),expectedRevision:2,reason:'Cierre de temporada' },provider({ cancel:async () => ({ endsAt:c.end }) }))
    expect(response).toMatchObject({ status:'scheduled',endsAt:c.end })
    expect((await viewSubscription(c.uid,c.restaurantId)).entitlements.serviceEnabled).toBe(true)
    await db.runTransaction(async tx => { const a = await refreshPlatformAccess(tx,c.restaurantId,c.end); a!.commit() })
    expect((await c.subRef.get()).get('status')).toBe('cancelled')
    const d = await create(), lower = await pricePlan({ members:0 })
    await expect(billingAction(d.uid,'iniciarSuscripcion',{ restaurantId:d.restaurantId,requestId:requestId(),expectedRevision:1,planId:lower.id,planVersion:1,interval:'month' },provider())).rejects.toMatchObject({ code:'failed-precondition' })
  })
  it('un cambio de portal con exceso suspende acceso sin borrar recursos', async () => {
    const c = await bound(), low = await pricePlan({ members:0 })
    const invoice = invoiceFixture({ customer:`cus_${c.restaurantId}`,subscription:`sub_${c.restaurantId}`,price:low.stripeMonthlyPriceId!,amount:low.monthlyCents,end:c.end })
    expect(await handleBillingEvent(eventFixture(`evt_${requestId()}`,'invoice.paid',invoice))).toMatchObject({ status:'blocked_overage' })
    expect((await c.subRef.get()).get('status')).toBe('suspended')
    expect((await db.doc(`restaurants/${c.restaurantId}/members/${c.uid}`).get()).exists).toBe(true)
  })
  it('mantiene versiones inmutables, exige claim y cierra el cambio de plan antiguo en migrados', async () => {
    const c = await create(), plan = await pricePlan()
    const input = { requestId:requestId(),plan:{ ...plan,monthlyCents:1 } }
    await expect(api.guardarPlanPlataforma.run(req(c.uid,input))).rejects.toMatchObject({ code:'permission-denied' })
    await expect(api.guardarPlanPlataforma.run(req(c.uid,input,true))).rejects.toMatchObject({ code:'failed-precondition' })
    await expect(cambiarPlan.run(req(c.uid,{ restaurantId:c.restaurantId,plan:'completo' },true))).rejects.toMatchObject({ code:'failed-precondition' })
    const result = await api.cambiarExcepcionesPlataforma.run(req(c.uid,{ restaurantId:c.restaurantId,requestId:requestId(),expectedRevision:1,moduleOverrides:{ pos:true },reason:'Prueba de caja' },true))
    expect(result.entitlements.activeModules).toContain('pos')
  })
  it('el endpoint HTTP comprueba los bytes originales, firma, edad y repetición con cargas ficticias', async () => {
    const c = await bound(), event = eventFixture(`evt_${requestId()}`,'invoice.paid',c.invoice())
    const raw = JSON.stringify(event), timestamp = Math.floor(Date.now()/1000)
    const sign = (t: number, body = raw) => `t=${t},v1=${createHmac('sha256','whsec_solo_fixtures_locales').update(`${t}.${body}`).digest('hex')}`
    const send = (signature: string, body = raw) => fetch(`http://127.0.0.1:${process.env.FUNCTIONS_PORT ?? '5015'}/demo-llenamos/europe-west1/stripeBillingWebhook`,{ method:'POST',headers:{ 'content-type':'application/json','stripe-signature':signature },body })
    expect((await send(sign(timestamp), `${raw} `)).status).toBe(401)
    expect((await send(sign(timestamp-600))).status).toBe(401)
    expect((await send(sign(timestamp+600))).status).toBe(401)
    expect((await send(sign(timestamp))).status).toBe(200)
    expect((await send(sign(timestamp))).status).toBe(200)
    expect((await c.subRef.get()).get('revision')).toBe(2)
  })
})
