import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as core from '@llenamos/core'
import { withIdentity } from '../../database.js'
import { integrationVault } from '../../platform/integrations.js'
import { apiServer } from '../../server.js'
import { buildHandlers, createWorker } from '../../worker/index.js'
import { testDatabase } from '../../worker/harness.js'
import { MODULES } from '../index.js'
import { registerBillSource } from '../caja/source.js'
import { setPublicAppOrigin, setUnsubscribeLimits } from '../campanas/config.js'
import { clearBillHooks, emitBillSettled, onBillSettled } from './ganchos.js'
import { connectClientesModules } from './conexion.js'
import { withTenant } from '../../worker/tenant.js'
import { setClock } from '../fidelizacion/ports.js'
import { registerLoyaltyHooks } from '../fidelizacion/trabajos.js'

const enabled = process.env.TEST_POSTGRES_API === '1' && !!process.env.TEST_POSTGRES_URL
const vault = integrationVault(Buffer.alloc(32, 9))
const ALL = ['reservations', 'floor', 'kitchen', 'pos', 'repite', 'staff', 'inventory', 'loyalty', 'marketing', 'analytics']
const cid = (n: number) => n.toString(16).padStart(20, '0')
const req = () => randomUUID()
const LINES: core.BillLine[] = [
  { lineId: 'menu', parentLineId: null, name: 'Menú', quantity: 1, grossCents: 1550, taxRate: 10, guest: 1 },
  { lineId: 'extra', parentLineId: 'menu', name: 'Suplemento', quantity: 1, grossCents: 400, taxRate: 10, guest: 1 },
  { lineId: 'vino', parentLineId: null, name: 'Vino', quantity: 1, grossCents: 501, taxRate: 21, guest: 2 },
]
const TOTAL = 2451

/** Reserva → ficha de marketing → campaña → worker real; y cobro → puntos, sello y devolución, con PostgreSQL y los roles reales de API y worker. */
describe.skipIf(!enabled)('Clientes: reservas, campañas, fidelización, Repite, análisis y privacidad de punta a punta', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>, token: (uid: string) => import('../../auth.js').IdentityToken, server: ReturnType<typeof apiServer>, base: string
  const provider: Array<{ url: string; body: any }> = []
  const stub = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    provider.push({ url: String(url), body: JSON.parse(String(init!.body)) })
    return new Response(JSON.stringify({ id: `re_${provider.length}` }), { status: 200 })
  }) as unknown as typeof fetch
  let firstCustomer = ''
  const campaignMails = () => provider.filter(p => JSON.stringify(p.body).includes('/baja/'))
  const consumption = new Map<string, { customerId: string | null }>()
  const call = async (name: string, uid: string | null, data: unknown) => {
    const response = await fetch(`${base}/v1/operations/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(uid ? { Authorization: `Bearer ${uid}` } : {}) }, body: JSON.stringify({ data }) })
    return { status: response.status, body: await response.json() as any }
  }
  const ok = async (name: string, uid: string, data: unknown) => { const r = await call(name, uid, data); expect(r.status, JSON.stringify(r.body)).toBe(200); return r.body.result }
  const member = <T>(rid: string, uid: string, fn: Parameters<typeof withIdentity<T>>[3]) => withIdentity(db.app, token(uid), rid, fn)
  const drain = async () => {
    for (let i = 0; i < 30; i++) {
      const worker = createWorker({ pool: db.worker, fetch: stub, log: e => { if (process.env.DEBUGW) console.log(JSON.stringify(e)) }, openCredentials: (rid, cipher) => vault.open(rid, cipher), handlers: buildHandlers(MODULES) })
      if (!(await worker.runOnce())) return
    }
  }
  const sealCredentials = (rid: string) => db.admin.query('INSERT INTO llenamos.integration_secrets(restaurant_id,ciphertext) VALUES($1,$2) ON CONFLICT(restaurant_id) DO UPDATE SET ciphertext=EXCLUDED.ciphertext',
    [rid, vault.seal(rid, { email: { apiKey: 'key-a', from: 'casa@example.test' } })])
  const dueNow = () => db.admin.query("UPDATE llenamos.jobs SET scheduled_at=now()-interval '1 minute' WHERE status='pending'; UPDATE llenamos.marketing_campaigns SET scheduled_at=now()-interval '1 minute' WHERE status='scheduled'")

  const wednesday = (() => { const d = new Date(Date.now() + 6 * 86_400_000); while (d.getUTCDay() !== 3) d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10) })()
  const phone = (n: number) => `+346000${String(n).padStart(5, '0')}`
  const attribution = { utmSource: 'instagram', utmMedium: 'social', utmCampaign: 'vermu', utmContent: null, utmTerm: null, adId: null, campaignId: null, clickIds: [], referrer: null, embedHost: null, landingPath: null }
  /** Una reserva PÚBLICA de verdad (módulo de reservas de V3): ficha, permiso y origen los espejan los disparadores de 016, sin ningún gancho. */
  async function createReservation(n: number, opts: { optIn?: boolean; time?: string } = {}) {
    const out = await call('crearReservaPublica', null, { slug: 'a', locationId: 'a-main', date: wednesday, time: opts.time ?? '13:00', partySize: 2, guestName: `Ana ${n}`, phone: phone(n), email: `ana${n}@example.test`, language: 'es',
      guestNotes: '', acceptPolicy: true, source: 'web', website: '', attribution, ...(opts.optIn === false ? {} : { marketingOptIn: { email: true, whatsapp: false, policyVersion: 'v1' } }) })
    expect(out.status, JSON.stringify(out.body)).toBe(200)
    const reservationId = (await db.admin.query('SELECT id FROM llenamos.reservations WHERE restaurant_id=$1 AND reference=$2', ['a', out.body.result.reference])).rows[0].id as string
    return { customerId: core.customerIdFor('a', phone(n)), reservationId, link: { slug: 'a', reference: out.body.result.reference as string, token: out.body.result.manageToken as string, website: '' } }
  }

  beforeAll(async () => {
    process.env.PUBLIC_APP_URL = 'https://app.example.test'
    setPublicAppOrigin('https://app.example.test')
    db = await testDatabase('clientes')
    token = await db.seed(['a', 'b'], [['a', 'owner-a', 'owner'], ['a', 'wai', 'waiter'], ['a', 'lim', 'manager'], ['b', 'owner-b', 'owner']])
    await db.admin.query("UPDATE llenamos.restaurants SET plan='completo',active_modules=$1,is_demo=true", [ALL])
    await db.admin.query("UPDATE llenamos.memberships SET location_ids=ARRAY['a-main'] WHERE uid='lim'")
    for (const [rid, id] of [['a', 'a-main'], ['a', 'a-terraza'], ['b', 'b-main']]) await db.admin.query('INSERT INTO llenamos.locations(restaurant_id,id,name,slug) VALUES($1,$2,$2,$2)', [rid, id])
    registerBillSource({ load: async (_c, scope, target) => ({ customerId: consumption.get(`${scope.restaurantId}:${target.id}`)?.customerId ?? null, lines: LINES, cancelled: false }) })
    connectClientesModules()
    server = apiServer(db.app, async value => token(value), () => undefined)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const tables = ['T1', 'T2', 'T3'].map((name, i) => ({ id: `a-${name}`, name, areaId: 'sala', seats: 4, shape: 'rect', x: 5 + i * 20, y: 5, w: 10, h: 10, joinableWith: [], enabled: true }))
    await ok('guardarPlano', 'owner-a', { restaurantId: 'a', locationId: 'a-main', createAreas: [{ id: 'sala', name: 'Sala', sortOrder: 0 }], createTables: tables })
    await ok('guardarConfiguracionReservas', 'owner-a', { restaurantId: 'a', locationId: 'a-main', settings: { ...core.defaultReservationSettings('Europe/Madrid'), publicBooking: true, autoConfirm: true, minNoticeMinutes: 0, maxAdvanceDays: 700 } })
  }, 90_000)
  afterAll(async () => {
    setClock(null); setPublicAppOrigin(undefined); setUnsubscribeLimits(null); registerBillSource(null)
    server?.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await db?.close()
  })

  it('reserva → ficha y permiso de marketing → campaña con audiencia → mensaje not_configured por el worker real; con proveedor sale y la baja funciona', async () => {
    const r1 = await createReservation(1)
    firstCustomer = r1.customerId
    // V3 no llamó a ningún gancho: los disparadores espejan ficha, permiso y origen.
    const card = (await db.admin.query('SELECT name,email,phone,language,redacted FROM llenamos.customer_marketing WHERE restaurant_id=$1 AND customer_id=$2', ['a', r1.customerId])).rows[0]
    expect(card).toMatchObject({ name: 'Ana 1', email: 'ana1@example.test', phone: phone(1), language: 'es', redacted: false })
    const consent = (await db.admin.query('SELECT status,purpose,source,evidence_id FROM llenamos.marketing_consents WHERE restaurant_id=$1 AND id=$2', ['a', `reservation.${r1.reservationId}.email`])).rows[0]
    expect(consent).toEqual({ status: 'granted', purpose: 'marketing_email', source: 'public', evidence_id: r1.reservationId })
    const origin = (await db.admin.query("SELECT channel,paid,source,medium,campaign,service_date::text AS day,party_size,final_status FROM llenamos.reservation_origins WHERE restaurant_id='a' AND reservation_id=$1", [r1.reservationId])).rows[0]
    expect(origin).toMatchObject({ channel: core.classifyOrigin({ reservationSource: 'web', attribution, ownHosts: ['app.example.test'] }).channel, source: 'instagram', medium: 'social', campaign: 'vermu', day: wednesday, party_size: 2, final_status: 'confirmed' })
    // Sentar la reserva actualiza el origen y deja un trabajo para el sello y los eventos.
    await member('a', 'owner-a', client => client.query("UPDATE llenamos.reservations SET status='seated' WHERE restaurant_id='a' AND id=$1", [r1.reservationId]))
    expect((await db.admin.query("SELECT final_status FROM llenamos.reservation_origins WHERE reservation_id=$1", [r1.reservationId])).rows[0].final_status).toBe('seated')
    expect((await db.admin.query("SELECT count(*)::int AS n FROM llenamos.jobs WHERE restaurant_id='a' AND kind='clientes.reserva_cambiada'")).rows[0].n).toBe(1)
    // Quien no marcó la casilla no tiene permiso: no entra en la audiencia. Y cancelar desde el enlace público (sin identidad) actualiza su origen y encola el evento.
    const r2 = await createReservation(2, { optIn: false, time: '13:30' })
    expect((await call('gestionarReservaPublica', null, { ...r2.link, action: 'cancel', reason: 'Imprevisto' })).status).toBe(200)
    expect((await db.admin.query("SELECT final_status FROM llenamos.reservation_origins WHERE reservation_id=$1", [r2.reservationId])).rows[0].final_status).toBe('cancelled')
    expect((await db.admin.query("SELECT count(*)::int AS n FROM llenamos.jobs WHERE restaurant_id='a' AND kind='clientes.reserva_cambiada' AND payload->>'reservationId'=$1", [r2.reservationId])).rows[0].n).toBe(1)
    // El worker cambia el estado de otra reserva (otro contexto, sin identidad de miembro) y su origen también se actualiza.
    const r4 = await createReservation(4, { optIn: false, time: '14:00' })
    await withTenant(db.worker, 'a', client => client.query("UPDATE llenamos.reservations SET status='seated' WHERE restaurant_id='a' AND id=$1", [r4.reservationId]))
    expect((await db.admin.query("SELECT final_status FROM llenamos.reservation_origins WHERE reservation_id=$1", [r4.reservationId])).rows[0].final_status).toBe('seated')
    await db.admin.query("DELETE FROM llenamos.jobs WHERE kind='clientes.reserva_cambiada'")

    await ok('guardarConfiguracionMarketing', 'owner-a', { restaurantId: 'a', requestId: req(), settings: { maxPer30Days: 4, minHoursBetween: 24, sendWindow: { from: '00:00', to: '23:59' }, senderName: 'Casa' } })
    const segment = await ok('guardarSegmento', 'owner-a', { restaurantId: 'a', requestId: req(), segmentId: null, expectedRevision: null, segment: { name: 'Todos', rule: { minVisits: null, maxVisits: null, lastVisitAtLeastDaysAgo: null, lastVisitAtMostDaysAgo: null, includeNeverVisited: true, maxNoShows: null, minSpentCents: null, tagsAny: [], tagsNone: [], languages: [], minPoints: null } } })
    const make = (name: string) => ok('guardarCampana', 'owner-a', { restaurantId: 'a', requestId: req(), campaignId: null, expectedRevision: null, campaign: { name, segmentId: segment.segmentId, channel: 'email', content: { title: 'Noche', body: 'Ven a cenar', includeBookingLink: true }, locationId: null } })
    const c1 = await make('Vermú')
    await ok('lanzarCampana', 'owner-a', { restaurantId: 'a', requestId: req(), campaignId: c1.campaignId, expectedRevision: c1.revision, at: null })
    await dueNow()
    await drain()
    const report = await ok('informeCampana', 'owner-a', { restaurantId: 'a', campaignId: c1.campaignId })
    // Audiencia > 0 (la ficha con permiso), y sin proveedor configurado el worker deja el mensaje en not_configured, no enviado.
    expect(report).toMatchObject({ status: 'sent', sent: 0, notConfigured: 1, failed: 0 })
    expect(report.audience).toBeGreaterThan(0)
    expect(report.excluded.no_consent).toBe(2)
    expect((await db.admin.query("SELECT status FROM llenamos.message_deliveries WHERE restaurant_id='a' AND context->>'campaignId' IS NOT NULL")).rows).toEqual([{ status: 'not_configured' }])
    expect(campaignMails()).toHaveLength(0)
    // El outbox no lleva el token de baja ni el nombre en claro tras la entrega fallida por falta de proveedor: solo el nombre de pila de la ficha.
    expect((await db.admin.query("SELECT payload->'data'->>'unsubscribeUrl' AS url FROM llenamos.outbox WHERE kind='marketing.campaign_message'")).rows).toEqual([{ url: '' }])

    // Con proveedor configurado el mensaje sale por el proveedor con un enlace de baja nuevo.
    await sealCredentials('a')
    const r3 = await createReservation(3, { time: '20:00' })
    const c2 = await make('Cena')
    await ok('lanzarCampana', 'owner-a', { restaurantId: 'a', requestId: req(), campaignId: c2.campaignId, expectedRevision: c2.revision, at: null })
    await dueNow()
    await drain()
    const report2 = await ok('informeCampana', 'owner-a', { restaurantId: 'a', campaignId: c2.campaignId })
    // La ficha 1 ya recibió la anterior hace menos de 24 h (frecuencia): solo la 3 recibe esta.
    expect(report2).toMatchObject({ sent: 1, notConfigured: 0 })
    expect(report2.excluded.frequency).toBe(1)
    expect(campaignMails().length).toBe(1)
    const text = JSON.stringify(campaignMails().find(p => JSON.stringify(p.body).includes('ana3@example.test'))!.body)
    const link = /https:\/\/app\.example\.test\/baja\/a\?t=([A-Za-z0-9_-]{43})/.exec(text)
    expect(link).not.toBeNull()
    const tokenValue = link![1]!
    // Baja pública con ese enlace: retira el permiso y la siguiente campaña ya no le escribe.
    expect((await call('darseDeBaja', null, { slug: 'a', token: tokenValue, website: '' })).status).toBe(200)
    expect((await db.admin.query("SELECT status FROM llenamos.marketing_consents WHERE restaurant_id='a' AND customer_id=$1 AND id LIKE 'unsubscribe.%'", [r3.customerId])).rows).toEqual([{ status: 'withdrawn' }])
    const c3 = await make('Otra')
    await ok('lanzarCampana', 'owner-a', { restaurantId: 'a', requestId: req(), campaignId: c3.campaignId, expectedRevision: c3.revision, at: null })
    await dueNow()
    const before = campaignMails().length
    await drain()
    expect((await ok('informeCampana', 'owner-a', { restaurantId: 'a', campaignId: c3.campaignId })).excluded.withdrawn).toBe(1)
    expect(campaignMails().length - before).toBe(0)
  }, 60_000)

  it('cobro → puntos y sello sin abortar el cobro; canje y promoción sobre la cuenta de caja; devolución corrige los puntos', async () => {
    const customer = firstCustomer
    await ok('guardarConfiguracionFidelizacion', 'owner-a', { restaurantId: 'a', requestId: req(), settings: { enabled: true, pointsPerEuro: 1, minSpendCents: 0, expiryDays: 365, termsVersion: '1' } })
    const reward = await ok('guardarPremio', 'owner-a', { restaurantId: 'a', requestId: req(), rewardId: null, expectedRevision: null, reward: { name: 'Cinco euros', pointsCost: 10, kind: 'amount', valueCents: 500, itemId: null, active: true } })
    await ok('altaFidelizacion', 'wai', { restaurantId: 'a', requestId: req(), customerId: customer, acceptedTermsVersion: '1' })
    await ok('ajustarPuntos', 'owner-a', { restaurantId: 'a', requestId: req(), customerId: customer, points: 50, reason: 'Bienvenida' })
    await db.admin.query("INSERT INTO llenamos.repite_settings(restaurant_id,merchant_id,enabled,stamp_on,auto_create_card,updated_by) VALUES('a','demo-merchant',true,'paid',true,'x') ON CONFLICT(restaurant_id) DO UPDATE SET merchant_id='demo-merchant',enabled=true,stamp_on='paid',auto_create_card=true")
    const scope = { restaurantId: 'a', locationId: 'a-main' }
    const cash = await ok('abrirCaja', 'owner-a', { ...scope, requestId: req(), registerId: 'caja1', openingCents: 10000 })
    const openBill = async (name: string) => {
      consumption.set(`a:${name}`, { customerId: customer })
      const opened = await ok('abrirCuenta', 'owner-a', { ...scope, requestId: req(), target: { kind: 'session', id: name } })
      return opened.billId as string
    }
    const revisionOf = async (billId: string) => (await ok('verCuenta', 'owner-a', { ...scope, billId })).bill.revision as number
    const pay = async (billId: string) => {
      const prepared = await ok('prepararCobro', 'owner-a', { ...scope, requestId: req(), billId, expectedRevision: await revisionOf(billId) })
      const view = await ok('verCuenta', 'owner-a', { ...scope, billId })
      const part = view.parts[0]
      return call('registrarCobro', 'owner-a', { ...scope, requestId: req(), billId, expectedRevision: prepared.revision, partId: part.id, cashSessionId: cash.cashSessionId, method: 'cash', amountCents: part.totalCents, tipCents: 0, tenderedCents: part.totalCents })
    }

    // Canje: el premio descuenta 5 € de la cuenta de caja a través del puerto, y anularlo la deja como estaba.
    const billA = await openBill('mesa-a')
    const redeemed = await ok('canjearPuntos', 'owner-a', { ...scope, requestId: req(), customerId: customer, rewardId: reward.rewardId, billId: billA, expectedBillRevision: await revisionOf(billA) })
    expect(redeemed).toMatchObject({ status: 'applied', points: 10, discountCents: 500 })
    expect((await ok('verCuenta', 'owner-a', { ...scope, billId: billA })).bill.totalCents).toBe(TOTAL - 500)
    const undone = await ok('anularCanje', 'owner-a', { ...scope, requestId: req(), redemptionId: redeemed.redemptionId, expectedBillRevision: redeemed.billRevision, reason: 'Error de cobro' })
    expect(undone.available).toBe(50)
    expect((await ok('verCuenta', 'owner-a', { ...scope, billId: billA })).bill.totalCents).toBe(TOTAL)

    // Promoción: dos aplicaciones a la vez sobre la misma cuenta, solo una gana.
    const promo = await ok('guardarPromocion', 'owner-a', { restaurantId: 'a', requestId: req(), promotionId: null, expectedRevision: null, promotion: {
      name: 'Diez por ciento', description: '', discount: { kind: 'percent', bp: 1000 }, scope: { kind: 'bill' }, locationIds: ['a-main'], channels: ['dine_in'], validFrom: null, validTo: null,
      weekdays: [], timeWindows: [], minSpendCents: 0, maxDiscountCents: null, usageLimit: null, perCustomerLimit: null, code: null, stacking: 'with_loyalty', priority: 1 } })
    await ok('cambiarEstadoPromocion', 'owner-a', { restaurantId: 'a', requestId: req(), promotionId: promo.promotionId, expectedRevision: promo.revision, to: 'active' })
    const revA = await revisionOf(billA)
    const applyBody = () => ({ ...scope, requestId: req(), billId: billA, expectedBillRevision: revA, promotionId: promo.promotionId, code: null })
    const [one, two] = await Promise.all([call('aplicarPromocion', 'owner-a', applyBody()), call('aplicarPromocion', 'owner-a', applyBody())])
    expect([one.status, two.status].filter(status => status === 200)).toHaveLength(1)
    expect([one.status, two.status].find(status => status !== 200)).toBeGreaterThanOrEqual(409)
    expect((await db.admin.query("SELECT uses FROM llenamos.promotions WHERE restaurant_id='a'")).rows[0].uses).toBe(1)
    expect((await db.admin.query("SELECT count(*)::int AS n FROM llenamos.bill_promotions WHERE restaurant_id='a' AND status='applied'")).rows[0].n).toBe(1)
    await ok('quitarPromocion', 'owner-a', { ...scope, requestId: req(), billId: billA, expectedBillRevision: await revisionOf(billA), reason: 'Prueba' })

    // Cobro: puntos (floor(2451/100) = 24) y un sello en cola, en la misma transacción que el cobro.
    const paid = await pay(billA)
    expect(paid.status, JSON.stringify(paid.body)).toBe(200)
    const earn = (await db.admin.query("SELECT points FROM llenamos.loyalty_movements WHERE restaurant_id='a' AND kind='earn' AND bill_id=$1", [billA])).rows
    expect(earn).toEqual([{ points: 24 }])
    const stamp = (await db.admin.query("SELECT kind,status,trigger FROM llenamos.repite_queue WHERE restaurant_id='a'")).rows
    expect(stamp).toEqual([{ kind: 'add_stamp', status: 'queued', trigger: 'paid' }])
    // El worker procesa el sello: sin adaptador de Repite, queda not_configured (nunca se da por hecho).
    await dueNow(); await db.admin.query("UPDATE llenamos.repite_queue SET next_attempt_at_ms=0")
    await drain()
    expect((await db.admin.query("SELECT kind,status FROM llenamos.repite_queue WHERE restaurant_id='a' ORDER BY kind")).rows).toEqual([{ kind: 'add_stamp', status: 'not_configured' }, { kind: 'create_card', status: 'not_configured' }])

    // Devolución: corrige los puntos de esa cuenta.
    const paymentId = (await db.admin.query("SELECT id FROM llenamos.pos_payments WHERE restaurant_id='a' AND bill_id=$1 AND kind='charge'", [billA])).rows[0].id
    await ok('devolverCobro', 'owner-a', { ...scope, requestId: req(), paymentId, amountCents: TOTAL, tipCents: 0, reason: 'Cliente insatisfecho' })
    const reversal = (await db.admin.query("SELECT points FROM llenamos.loyalty_movements WHERE restaurant_id='a' AND kind='earn_reversal'")).rows
    expect(reversal).toEqual([{ points: -24 }])

    // Un gancho que falla NUNCA aborta el cobro: el que falla va el PRIMERO y es un error de SQL real (dentro de la transacción del cobro), y aun así
    // el cobro se confirma, los demás ganchos corren y el fallo queda registrado para reintentarlo desde el worker.
    clearBillHooks()
    onBillSettled({ name: 'prueba.falla', run: client => client.query('SELECT 1/0') })
    registerLoyaltyHooks()
    const billB = await openBill('mesa-b')
    const paidB = await pay(billB)
    expect(paidB.status, JSON.stringify(paidB.body)).toBe(200)
    expect((await db.admin.query("SELECT status,paid_cents FROM (SELECT status,(data->>'paidCents')::int AS paid_cents FROM llenamos.pos_bills WHERE restaurant_id='a' AND id=$1) b", [billB])).rows[0]).toEqual({ status: 'settled', paid_cents: TOTAL })
    expect((await db.admin.query("SELECT count(*)::int AS n FROM llenamos.pos_payments WHERE restaurant_id='a' AND bill_id=$1 AND status='succeeded'", [billB])).rows[0].n).toBe(1)
    expect((await db.admin.query("SELECT payload->>'hook' AS hook FROM llenamos.jobs WHERE restaurant_id='a' AND kind='ganchos.reintentar'")).rows).toEqual([{ hook: 'prueba.falla' }])
    expect((await db.admin.query("SELECT count(*)::int AS n FROM llenamos.loyalty_movements WHERE restaurant_id='a' AND kind='earn' AND bill_id=$1", [billB])).rows[0].n).toBe(1)
    expect((await db.admin.query("SELECT count(*)::int AS n FROM llenamos.repite_queue WHERE restaurant_id='a' AND kind='add_stamp' AND visit_key LIKE $1", [`%mesa-b%`])).rows[0].n).toBe(1)
    clearBillHooks(); registerLoyaltyHooks()

    // Un canje que cubre toda la cuenta la deja a 0 €: al saldarla el canje pasa a `settled` (aunque no haya puntos ni sello que dar).
    const full = await ok('guardarPremio', 'owner-a', { restaurantId: 'a', requestId: req(), rewardId: null, expectedRevision: null, reward: { name: 'Todo', pointsCost: 5, kind: 'amount', valueCents: TOTAL, itemId: null, active: true } })
    await ok('ajustarPuntos', 'owner-a', { restaurantId: 'a', requestId: req(), customerId: customer, points: 20, reason: 'Para el canje total' })
    const billC = await openBill('mesa-c')
    const total = await ok('canjearPuntos', 'owner-a', { ...scope, requestId: req(), customerId: customer, rewardId: full.rewardId, billId: billC, expectedBillRevision: await revisionOf(billC) })
    expect(total).toMatchObject({ status: 'applied', discountCents: TOTAL })
    const stampsBefore = Number((await db.admin.query("SELECT count(*) FROM llenamos.repite_queue WHERE restaurant_id='a'")).rows[0].count)
    await ok('prepararCobro', 'owner-a', { ...scope, requestId: req(), billId: billC, expectedRevision: await revisionOf(billC) })
    expect((await db.admin.query("SELECT status FROM llenamos.pos_bills WHERE id=$1", [billC])).rows[0].status).toBe('settled')
    expect((await db.admin.query("SELECT status FROM llenamos.loyalty_redemptions WHERE id=$1", [total.redemptionId])).rows[0].status).toBe('settled')
    expect(Number((await db.admin.query("SELECT count(*) FROM llenamos.repite_queue WHERE restaurant_id='a'")).rows[0].count)).toBe(stampsBefore)
    expect((await db.admin.query("SELECT count(*)::int AS n FROM llenamos.loyalty_movements WHERE kind='earn' AND bill_id=$1", [billC])).rows[0].n).toBe(0)

    // Una cuenta a 0 € no da puntos ni sello (el hook lo descarta aunque se le avise).
    const before = Number((await db.admin.query("SELECT count(*) FROM llenamos.repite_queue WHERE restaurant_id='a'")).rows[0].count)
    await member('a', 'owner-a', client => emitBillSettled(client, { restaurantId: 'a', locationId: 'a-main', billId: 'cero', customerId: customer, totalCents: 0, settledAt: Date.now(), targetKind: 'session', targetId: 'mesa-cero' }))
    expect(Number((await db.admin.query("SELECT count(*) FROM llenamos.repite_queue WHERE restaurant_id='a'")).rows[0].count)).toBe(before)
    expect((await db.admin.query("SELECT count(*)::int AS n FROM llenamos.loyalty_movements WHERE bill_id='cero'")).rows[0].n).toBe(0)
  }, 60_000)

  it('flujo real de borrado: tras borrar a una persona, cambiar una reserva suya anterior no genera sello ni eventos nuevos', async () => {
    const person = await createReservation(5, { time: '20:30' })
    expect((await db.admin.query('SELECT count(*)::int AS n FROM llenamos.customer_marketing WHERE customer_id=$1', [person.customerId])).rows[0].n).toBe(1)
    // Reservas no deja borrar con una reserva abierta: la de esta persona ya terminó.
    await db.admin.query("UPDATE llenamos.reservations SET status='finished' WHERE restaurant_id='a' AND id=$1", [person.reservationId])
    const asked = await call('solicitarPrivacidad', 'owner-a', { restaurantId: 'a', requestId: `privacy_real_${'0'.repeat(16)}`, customerId: person.customerId, kind: 'erase', reason: 'Petición de la persona' })
    expect(asked.status, JSON.stringify(asked.body)).toBe(200)
    await db.admin.query("INSERT INTO llenamos.privacy_evidence(id,restaurant_id,subject_id,method,expires_at,recorded_by) VALUES('ev-real','a',$1,'in_person',now()+interval '1 day','owner-a')", [person.customerId])
    expect((await call('verificarSolicitudPrivacidad', 'owner-a', { restaurantId: 'a', requestId: `privacy_real2_${'0'.repeat(15)}`, jobId: asked.body.result.jobId, evidenceId: 'ev-real' })).status).toBe(200)
    await drain()
    expect((await db.admin.query('SELECT status,error FROM llenamos.privacy_requests WHERE id::text=$1', [asked.body.result.jobId])).rows[0]).toEqual({ status: 'completed', error: null })
    await db.admin.query("DELETE FROM llenamos.jobs WHERE kind='clientes.reserva_cambiada'")
    // La reserva anterior (ya anonimizada por reservas, `privacy_redacted`) cambia de estado: el disparador encola y el worker no genera nada con el id viejo ni con el nuevo.
    await db.admin.query("UPDATE llenamos.reservations SET status='no_show' WHERE restaurant_id='a' AND id=$1", [person.reservationId])
    expect((await db.admin.query("SELECT count(*)::int AS n FROM llenamos.jobs WHERE kind='clientes.reserva_cambiada' AND payload->>'reservationId'=$1", [person.reservationId])).rows[0].n).toBe(1) // el disparador sí salta
    expect((await db.admin.query('SELECT privacy_redacted FROM llenamos.reservations WHERE id=$1', [person.reservationId])).rows[0].privacy_redacted).toBe(true)
    await dueNow(); await drain()
    expect((await db.admin.query("SELECT count(*)::int AS n FROM llenamos.automation_events WHERE id LIKE $1", [`%${person.reservationId}%`])).rows[0].n).toBe(0)
    expect((await db.admin.query("SELECT count(*)::int AS n FROM llenamos.automation_events WHERE subject=$1", [person.customerId])).rows[0].n).toBe(0)
    expect((await db.admin.query("SELECT count(*)::int AS n FROM llenamos.repite_queue WHERE customer_id=$1", [person.customerId])).rows[0].n).toBe(0)
    expect((await db.admin.query("SELECT count(*)::int AS n FROM llenamos.jobs WHERE kind='clientes.reserva_cambiada' AND status<>'done'")).rows[0].n).toBe(0)
  }, 60_000)
})
