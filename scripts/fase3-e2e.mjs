// Recorrido integrado de la fila 5. Solo se sustituye el transporte externo de Checkout.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHmac, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import * as core from '../packages/core/src/index.ts'
import '../functions/src/index.ts'
import { db } from '../functions/src/shared.ts'
import { startPayment } from '../functions/src/fase3-mobile/service.ts'
import { cashReconciliation } from '../packages/core/src/index.ts'
if (process.env.GCLOUD_PROJECT !== 'demo-llenamos' || process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8100' || process.env.FIREBASE_AUTH_EMULATOR_HOST !== '127.0.0.1:9106') throw new Error('Usa únicamente los emuladores de la fila 5.')
const require = createRequire(import.meta.url)
let playwright
try { playwright = require('playwright') } catch { playwright = require('/srv/LogiQD/llenamos/.claude/pw/node_modules/playwright') }
const origin = 'http://localhost:3015', functionUrl = 'http://127.0.0.1:5016/demo-llenamos/europe-west1'
const out = 'docs/diseno/capturas/fase3', scope = { restaurantId: 'demo-lumbre', locationId: 'centro' }
const local = db.doc('restaurants/demo-lumbre/locations/centro'), root = local.parent.parent
const evidence = [], errors = [], captures = [], tcp = [], temporary = await mkdtemp('/tmp/fase3-e2e-')
const mutation = () => ({ ...scope, requestId: randomUUID() })
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(work, message) { const start = Date.now(); while (Date.now() - start < 45000) { const r = await work(); if (r) return r; await sleep(200) } throw new Error(message) }
function scrub(v) { if (Array.isArray(v)) return v.map(scrub); if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !/token|path|url|payload|hash/i.test(k)).map(([k, value]) => [k, scrub(value)])); return v }
const browser = await playwright.chromium.launch({ executablePath: '/home/gery/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome', headless: true, args: ['--no-sandbox'] })
const fake = createServer({ allowHalfOpen: true }, socket => { const chunks = []; socket.on('data', b => chunks.push(b)); socket.on('end', () => { tcp.push(Buffer.concat(chunks)); socket.end() }) })
let page, ownerToken, waiterToken, bridgeConfig, bridgeId = `fase3-${Date.now()}`, originalModules
async function context(email, viewport = { width: 1440, height: 900 }) {
  const c = await browser.newContext({ viewport, deviceScaleFactor: 2 })
  await c.route('**/*', route => ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort())
  const p = await c.newPage(); p.setDefaultTimeout(45000); p.on('pageerror', e => errors.push(e.message))
  if (email) {
    await p.goto(`${origin}/entrar`)
    // Durante la hidratación puede haber un formulario provisional desactivado; se usa el activo.
    await p.locator('input[name="email"]:not([disabled])').fill(email)
    await p.locator('input[type="password"]:not([disabled])').fill('Llenamos2026!')
    await p.getByRole('button', { name: 'Entrar', exact: true }).click(); await p.waitForURL('**/panel')
  }
  return p
}
async function auth(email) {
  return page.evaluate(async email => (await fetch('http://127.0.0.1:9106/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'Llenamos2026!', returnSecureToken: true }) }).then(r => r.json())).idToken, email)
}
async function call(name, data, bearer = ownerToken, expected) {
  const r = await page.evaluate(async ({ name, data, bearer, functionUrl }) => {
    const response = await fetch(`${functionUrl}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify({ data }) })
    return { status: response.status, body: await response.json() }
  }, { name, data, bearer, functionUrl })
  evidence.push({ operation: name, http: r.status, response: scrub(r.body) })
  if (expected) { assert.equal(r.body.error?.status, expected); return r.body.error }
  assert.ok(!r.body.error, `${name}: ${JSON.stringify(r.body)}`)
  return r.body.result
}
async function capture(name, p = page) {
  await p.evaluate(() => scrollTo(0, 0))
  await p.mouse.move(1, 1)
  assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Desbordamiento en ${name}`)
  await p.screenshot({ path: `${out}/${name}.png`, fullPage: true, style: 'nextjs-portal { display: none !important; }' })
  captures.push(name); console.log(`Captura ${name}`)
}
async function select(label, option, p = page) { await p.getByRole('combobox', { name: label, exact: true }).click(); await p.getByRole('option', { name: option, exact: true }).click() }
async function uiCall(name, action) {
  const response = page.waitForResponse(r => r.url() === `${functionUrl}/${name}` && r.request().method() === 'POST')
  await action(); const r = await response, body = await r.json()
  const input = r.request().postDataJSON().data
  evidence.push({ operation: name, via: 'formulario', http: r.status(), response: scrub(body) })
  assert.ok(!body.error, `${name}: ${JSON.stringify(body)}`)
  return { input, result: body.result }
}
async function drain() {
  // El proceso real del puente reclama y confirma un trabajo por ciclo.
  await until(async () => {
    const pending = await local.collection('printRequests').where('status', 'in', ['queued', 'not_configured']).get()
    return pending.empty
  }, 'Las peticiones de impresión no se procesaron.')
  for (let i = 0; i < 60; i++) {
    const pending = await local.collection('printJobs').where('bridgeId', '==', bridgeId).where('status', '==', 'queued').get()
    if (pending.empty) return
    await new Promise((resolve, reject) => { const p = spawn(process.execPath, ['tools/print-bridge/bridge.mjs', `${temporary}/puente.json`, '--once'], { stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; p.stdout.on('data', b => { output += b }); p.stderr.on('data', b => { output += b }); p.on('exit', code => code === 0 ? resolve() : reject(new Error(output))) })
  }
  throw new Error('La cola no se vació.')
}
try {
  await mkdir(out, { recursive: true })
  // El segundo loopback comparte solo el número de puerto de nuestra fila, sin tocar Tasks.
  await new Promise((resolve, reject) => { fake.once('error', reject); fake.listen(9515, '127.0.0.2', resolve) })
  page = await context('propietario@lumbre.test'); ownerToken = await auth('propietario@lumbre.test'); waiterToken = await auth('camarero@lumbre.test')
  originalModules = (await root.get()).get('activeModules')
  const cashSessionId = (await local.collection('registerLocks').doc('principal').get()).get('cashSessionId')
  assert.ok(cashSessionId, 'Ejecuta pnpm seed:caja.')
  const tableId = `fase3-${Date.now()}`, tableLabel = `F3 ${String(Date.now()).slice(-5)}`
  const template = (await local.collection('tables').doc('sala-1').get()).data()
  await local.collection('tables').doc(tableId).set({ ...template, name: tableLabel, seats: 4, joinableWith: [], updatedBy: 'lumbre-propietario' })
  const settings = (await local.collection('settings').doc('floor').get()).data(); settings.selfOrder.enabled = true
  await call('guardarConfiguracionSala', { ...scope, settings })
  const pos = (await local.collection('settings').doc('pos').get()).data()
  await call('guardarConfiguracionCaja', { ...mutation(), settings: { ...core.PosSettingsSchema.parse(pos), mobilePayments: true } })
  for (const old of (await local.collection('printers').get()).docs) if (old.get('bridgeId').startsWith('fase3-')) await call('guardarImpresora', { ...mutation(), printerId: old.id, printer: { ...core.PrinterSchema.parse(old.data()), active: false } })
  const bridge = await call('vincularPuente', { ...mutation(), bridgeId })
  const printer = await call('guardarImpresora', { ...mutation(), printerId: null, printer: { name: 'Caja y cocina de prueba TCP', bridgeId, paperMm: 80, columns: 48, stationIds: ['cocina', 'barra', 'postres'], tickets: true, drawer: true, active: true } })
  bridgeConfig = { ...scope, bridgeId, token: bridge.token, functionsUrl: functionUrl, printers: { [printer.printerId]: { host: '127.0.0.2', port: 9515 } }, journalDir: './diario' }
  await mkdir(`${temporary}/diario`); await writeFile(`${temporary}/puente.json`, JSON.stringify(bridgeConfig), { mode: 0o600 })
  // Teléfono nuevo en cada ejecución: el gasto del cliente no se arrastra entre repeticiones.
  const phone = `+346${String(Date.now()).slice(-8)}`
  const time = core.horaLocal(Date.now(), 'Europe/Madrid')
  const reservation = await call('crearReserva', { ...scope, date: time.fecha, time: time.hora, partySize: 3, guestName: 'Recorrido integrado F3', phone: phone.slice(3), source: 'walk_in', tableIds: [tableId] })
  await call('cambiarEstadoReserva', { ...scope, reservationId: reservation.reservationId, status: 'seated' })
  const session = await until(async () => (await local.collection('tableSessions').where('reservationId', '==', reservation.reservationId).get()).docs[0], 'La reserva no abrió sesión.')
  await page.goto(`${origin}/panel/comandero?s=${session.id}`)
  await page.getByRole('button', { name: 'Añadir Patatas bravas', exact: true }).waitFor()
  await capture('01-reserva-sentada')
  for (const name of ['Patatas bravas', 'Hamburguesa Lumbre', 'Agua mineral']) await page.getByRole('button', { name: `Añadir ${name}`, exact: true }).click()
  await select('Salida de los platos', 'Retener la comida')
  await page.getByRole('button', { name: /^Revisar total/ }).click()
  const order = await uiCall('enviarPedido', () => page.getByRole('button', { name: 'Enviar pedido', exact: true }).click())
  await page.getByRole('button', { name: 'Marchar todo', exact: true }).waitFor(); await capture('02-pedido-retenido')
  await uiCall('marcharPase', () => page.getByRole('button', { name: 'Marchar todo', exact: true }).click())
  await drain()
  const kitchen = await context('cocina@lumbre.test', { width: 1180, height: 820 }); await kitchen.goto(`${origin}/panel/cocina`)
  const ticket = kitchen.getByRole('article', { name: `Comanda ${tableLabel}`, exact: true }); await ticket.waitFor(); await capture('03-cocina-marchada', kitchen)
  await ticket.getByRole('button', { name: 'Seleccionar pendientes' }).click()
  await ticket.getByRole('button', { name: /^Empezar / }).click()
  await ticket.getByRole('button', { name: /^Dejar listos / }).click()
  await ticket.getByText('Listo para recoger', { exact: true }).first().waitFor()
  await capture('04-cocina-lista', kitchen)
  await call('cambiarEstadoLineas', { ...scope, lineIds: order.result.lineIds, status: 'served' })
  await call('cambiarEstadoMesa', { ...scope, sessionId: session.id, status: 'bill_requested' })
  await page.goto(`${origin}/panel/caja`)
  await page.getByRole('button', { name: new RegExp(`${tableLabel}.*Recorrido integrado F3`) }).click()
  await page.getByRole('button', { name: 'Confirmar ajuste con motivo' }).waitFor()
  const account = await call('abrirCuenta', { ...mutation(), target: { kind: 'session', id: session.id } })
  await page.getByLabel('Importe del ajuste (€)', { exact: true }).fill('0,50'); await page.getByLabel('Motivo del ajuste', { exact: true }).fill('Invitación de cortesía en la prueba local')
  await uiCall('ajustarCuenta', () => page.getByRole('button', { name: 'Confirmar ajuste con motivo' }).click())
  await select('Tipo de ajuste', 'Anulación de consumo')
  await page.getByLabel('Importe del ajuste (€)', { exact: true }).fill('0,25'); await page.getByLabel('Motivo del ajuste', { exact: true }).fill('Corrección de consumo en la prueba local')
  await uiCall('ajustarCuenta', () => page.getByRole('button', { name: 'Confirmar ajuste con motivo' }).click())
  await capture('05-invitacion-y-anulacion')
  await page.getByRole('button', { name: 'Dividir', exact: true }).click(); await page.getByLabel('Número de partes', { exact: true }).fill('3')
  await uiCall('dividirCuenta', () => page.getByRole('button', { name: 'Guardar reparto en el servidor' }).click()); await capture('06-partes-iguales')
  await select('Cómo dividir la cuenta', 'Por platos completos')
  await select('1 × Hamburguesa Lumbre', 'Parte 2'); await select('1 × Agua mineral', 'Parte 3')
  const split = await uiCall('dividirCuenta', () => page.getByRole('button', { name: 'Guardar reparto en el servidor' }).click()); await capture('07-reparto-por-platos')
  const locked = await uiCall('prepararCobro', () => page.getByRole('button', { name: 'Preparar cobro y bloquear consumo' }).click())
  await call('cambiarEstadoMesa', { ...scope, sessionId: session.id, status: 'closed' }, ownerToken, 'FAILED_PRECONDITION')
  await page.getByRole('button', { name: 'Cobrar', exact: true }).click()
  const [p1, p2, p3] = split.result.parts
  await select('Parte a cobrar', `${p1.label} · pendiente ${new Intl.NumberFormat('es', { style: 'currency', currency: 'EUR' }).format(p1.totalCents / 100)}`)
  await page.getByLabel('Propina voluntaria (€)', { exact: true }).fill('0,50'); await page.getByLabel('Efectivo entregado (€)', { exact: true }).fill('10,00')
  const paid = await uiCall('registrarCobro', () => page.getByRole('button', { name: /^Registrar [\d,]+\s*€/ }).click())
  await until(async () => (await local.collection('billParts').doc(p1.id).get()).get('invoiceId'), 'No se emitió el ticket del efectivo.')
  assert.equal(paid.result.changeCents, 1000 - p1.totalCents - 50)
  assert.deepEqual(await call('registrarCobro', paid.input), paid.result)
  await drain(); await capture('08-efectivo-cambio-propina')
  await page.getByRole('button', { name: 'Facturar', exact: true }).click()
  await select('Parte a facturar', p2.label); await select('Documento', 'Factura completa con datos del cliente')
  await page.getByLabel('Nombre o razón social', { exact: true }).fill('Cliente de prueba F3'); await page.getByLabel('Domicilio fiscal', { exact: true }).fill('Dirección inventada para la prueba'); await page.getByLabel('NIF', { exact: true }).fill('89890001K')
  const full = await uiCall('emitirFactura', () => page.getByRole('button', { name: 'Emitir documento de prueba' }).click()); await capture('09-factura-completa')
  const ownerPage = page
  page = await context('camarero@lumbre.test')
  await page.goto(`${origin}/panel/caja`); await page.getByLabel('Referencia de la caja abierta', { exact: true }).fill(cashSessionId)
  await page.getByRole('button', { name: new RegExp(`${tableLabel}.*Recorrido integrado F3`) }).click()
  await page.getByRole('button', { name: 'Cobrar', exact: true }).click()
  await select('Parte a cobrar', `${p2.label} · pendiente ${new Intl.NumberFormat('es', { style: 'currency', currency: 'EUR' }).format(p2.totalCents / 100)}`)
  await select('Forma de pago', 'Tarjeta con datáfono externo'); await page.getByLabel('Referencia del datáfono', { exact: true }).fill('DATÁFONO DE PRUEBA F3')
  const card = await uiCall('registrarCobro', () => page.getByRole('button', { name: /^Registrar [\d,]+\s*€/ }).click()); await capture('10-tarjeta-externa')
  page = ownerPage
  await page.getByRole('button', { name: 'Cobrar', exact: true }).click()
  await select('Parte para el enlace móvil', `${p3.label} · ${new Intl.NumberFormat('es', { style: 'currency', currency: 'EUR' }).format(p3.totalCents / 100)} pendiente`)
  const linked = await uiCall('crearEnlaceCobro', () => page.getByRole('button', { name: 'Crear enlace privado de pago' }).click())
  const qr = await call('regenerarQrMesa', { ...scope, tableIds: [tableId] })
  const mobile = await context(null, { width: 390, height: 844 })
  await mobile.goto(`${origin}/m/taberna-lumbre/centro/${tableId}?t=${qr.tokens[0].token}`)
  await mobile.getByRole('link', { name: 'Consultar la cuenta preparada' }).waitFor(); await capture('11-mesa-enlace-cuenta', mobile)
  await mobile.getByRole('link', { name: 'Consultar la cuenta preparada' }).click(); await mobile.getByRole('heading', { name: '¿Qué parte vas a pagar?' }).waitFor(); await capture('12-partes-en-el-movil', mobile)
  await mobile.goto(origin + linked.result.path)
  await mobile.getByText('El pago móvil no está configurado.', { exact: false }).waitFor()
  assert.ok(await mobile.getByRole('button', { name: 'Continuar al pago' }).isDisabled())
  await mobile.getByRole('button', { name: '5 %', exact: true }).click(); await mobile.getByLabel('Quiero el recibo digital.', { exact: false }).check(); await mobile.getByLabel('Correo para el recibo', { exact: false }).fill('cliente-f3@example.test')
  await capture('13-propina-consentimiento-sin-claves', mobile)
  const publicLink = { slug: 'taberna-lumbre', locationId: 'centro', checkoutId: linked.result.checkoutId, token: linked.result.token }
  // Transporte externo de ejemplo, sin ninguna llamada de red a Stripe ni otra escritura de saldo.
  let stripeSession
  const transport = async (_url, init) => {
    const body = init.body
    stripeSession = { id: `cs_test_fase3_${Date.now()}`, url: 'https://checkout.stripe.com/c/pay/cs_test_local', status: 'open', payment_status: 'unpaid', currency: 'eur', livemode: false, amount_total: p3.totalCents + Math.round(p3.totalCents * .05), expires_at: Math.floor(Date.now() / 1000) + 1800,
      metadata: Object.fromEntries(['restaurantId', 'locationId', 'checkoutId', 'amountCents', 'tipCents'].map(k => [k, body.get(`metadata[${k}]`)])) }
    return new Response(JSON.stringify(stripeSession), { status: 200 })
  }
  const env = { ...process.env, FUNCTIONS_EMULATOR: 'true', PUBLIC_APP_URL: origin, STRIPE_SECRET_KEY: 'sk_test_solo_transporte_local_inyectado', STRIPE_MOBILE_WEBHOOK_SECRET: 'mobile_local_example', STRIPE_MOBILE_MODE: 'single' }
  const start = await startPayment({ ...publicLink, requestId: randomUUID(), tipCents: Math.round(p3.totalCents * .05), acceptDigitalReceipt: true, email: 'cliente-f3@example.test' }, env, transport)
  assert.equal(start.status, 'ready')
  await call('registrarCobro', { ...mutation(), billId: account.billId, expectedRevision: locked.result.revision, partId: p3.id, cashSessionId, method: 'cash', amountCents: p3.totalCents, tenderedCents: p3.totalCents }, ownerToken, 'FAILED_PRECONDITION')
  const seconds = Math.floor(Date.now() / 1000), raw = JSON.stringify({ id: `evt_fase3_${Date.now()}`, type: 'checkout.session.completed', created: seconds, data: { object: { ...stripeSession, status: 'complete', payment_status: 'paid' } } })
  const sign = t => `t=${t},v1=${createHmac('sha256', 'mobile_local_example').update(`${t}.${raw}`).digest('hex')}`
  for (const [name, signature, status] of [['mala', `t=${seconds},v1=${'0'.repeat(64)}`, 400], ['caducada', sign(seconds - 301), 400], ['buena', sign(seconds), 200], ['repetida', sign(seconds), 200]]) {
    const r = await mobile.request.post(`${functionUrl}/stripeCuentaWebhook`, { data: raw, headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature } }); assert.equal(r.status(), status); evidence.push({ operation: 'stripeCuentaWebhook', signature: name, http: r.status() })
  }
  await mobile.reload(); await mobile.getByText('Pago confirmado', { exact: true }).waitFor(); await capture('14-pago-movil-confirmado', mobile)
  await mobile.getByRole('link', { name: 'Ver recibo privado' }).click(); await mobile.getByText('Proveedor de prueba: no válido para Hacienda.', { exact: true }).waitFor(); await capture('15-recibo-privado', mobile)
  const response = await mobile.request.get(mobile.url()); assert.equal(response.headers()['referrer-policy'], 'no-referrer'); assert.equal(response.headers()['x-robots-tag'], 'noindex, nofollow'); assert.match(response.headers()['cache-control'], /no-store/)
  const payments = await local.collection('payments').where('billId', '==', account.billId).get()
  assert.equal(payments.size, 3);
  assert.equal(payments.docs.find(d => d.id === card.result.paymentId).get('by'), 'lumbre-camarero')
  assert.equal(payments.docs.filter(d => d.get('method') === 'stripe').length, 1)
  assert.equal((await local.collection('bills').doc(account.billId).get()).get('status'), 'settled')
  await call('rectificarFactura', { ...mutation(), invoiceId: full.result.invoiceId, type: 'R4', mode: 'I', reason: 'Rectificación de prueba local', reductions: [{ lineIndex: 0, amountCents: 100 }] }, waiterToken, 'PERMISSION_DENIED')
  await call('cerrarCaja', { ...mutation(), cashSessionId, countedCents: 0, reason: null }, waiterToken, 'PERMISSION_DENIED')
  const waiter = await context('camarero@lumbre.test'); await waiter.goto(`${origin}/panel/caja`); await waiter.getByRole('button', { name: 'Caja y arqueo', exact: true }).click(); await waiter.getByText('La apertura, el arqueo y el cierre los hace', { exact: false }).waitFor(); await capture('16-permisos-camarero', waiter)
  // El camarero ya ha cobrado mediante su backend permitido; se valida en el mismo libro con tarjeta idempotente.
  assert.deepEqual(await call('registrarCobro', card.input, waiterToken), card.result)
  await page.getByRole('button', { name: 'Historial', exact: true }).click(); await page.getByRole('button', { name: new RegExp(full.result.number.replaceAll('/', '\\/')) }).click()
  await page.getByRole('button', { name: 'Correcciones', exact: true }).click(); await page.getByLabel(/^Reducir /).first().fill('1,00'); await page.getByLabel('Motivo de rectificación', { exact: true }).fill('Corrección comercial documentada en prueba local')
  const correction = await uiCall('rectificarFactura', () => page.getByRole('button', { name: 'Emitir rectificativa de prueba' }).click())
  await page.getByRole('button', { name: new RegExp(correction.result.number.replaceAll('/', '\\/')) }).click(); await page.getByRole('button', { name: 'Detalle', exact: true }).click(); await capture('17-rectificativa')
  await call('devolverCobro', { ...mutation(), paymentId: card.result.paymentId, amountCents: 100, reason: 'Devolución de la rectificativa de prueba' })
  await drain()
  await call('cambiarEstadoMesa', { ...scope, sessionId: session.id, status: 'closed' })
  // El gasto del cliente cuenta al cerrar la mesa y una sola vez, aunque se cobre por partes.
  await until(async () => (await root.collection('customers').doc(core.customerIdFor(scope.restaurantId, phone)).get()).get('spentCents') === 2250, 'El gasto de consumo se ha duplicado o no se ha registrado.')
  await page.goto(`${origin}/panel/comandero?s=${session.id}`); await page.getByRole('combobox', { name: 'Mesa del pedido' }).filter({ hasText: 'Cerrada' }).waitFor(); await capture('18-servicio-cerrado')
  await page.goto(`${origin}/panel/impresoras`); await page.getByText('Caja y cocina de prueba TCP', { exact: true }).first().waitFor(); await capture('19-impresion-confirmada')
  const jobs = await local.collection('printJobs').where('printerId', '==', printer.printerId).get(); assert.ok(jobs.size >= 6)
  for (const job of jobs.docs) { assert.equal(job.get('status'), 'printed'); assert.ok(tcp.some(b => b.equals(Buffer.from(job.get('payloadBase64'), 'base64')))); if (job.get('kind') === 'invoice') assert.match(job.get('document.fiscal.warning'), /no válido para Hacienda/) }
  assert.equal(jobs.docs.filter(d => d.get('kind') === 'drawer').length, 1)
  const count = tcp.length; await drain(); assert.equal(tcp.length, count)
  await page.goto(`${origin}/panel/caja`); await page.getByRole('button', { name: 'Caja y arqueo', exact: true }).click()
  const cash = core.CashSessionSchema.parse((await local.collection('cashSessions').doc(cashSessionId).get()).data())
  const ledger = (await local.collection('payments').where('cashSessionId', '==', cashSessionId).get()).docs.map(d => core.PaymentSchema.parse(d.data()))
  const moves = (await local.collection('cashMovements').where('cashSessionId', '==', cashSessionId).get()).docs.map(d => core.CashMovementSchema.parse(d.data()))
  const expected = cashReconciliation(cash.openingCents, ledger, moves, 0).expectedCents
  await page.getByLabel('Efectivo contado (€)', { exact: true }).fill(core.fiscalDecimal(expected).replace('.', ',')); await page.getByLabel('He contado', { exact: false }).check()
  const closed = await uiCall('cerrarCaja', () => page.getByRole('button', { name: 'Confirmar arqueo y cerrar caja' }).click()); assert.equal(closed.result.cashSession.differenceCents, 0)
  await capture('20-arqueo-sin-diferencia')
  await page.setViewportSize({ width: 390, height: 844 }); await capture('21-arqueo-movil')
  await root.update({ plan: 'sala', activeModules: originalModules.filter(m => m !== 'pos') })
  await page.reload(); await page.getByText('El módulo Caja no está activo', { exact: true }).waitFor(); assert.equal(await page.getByRole('link', { name: 'Caja', exact: true }).count(), 0); assert.equal(await page.getByRole('link', { name: 'Impresoras', exact: true }).count(), 0)
  await call('abrirCuenta', { ...mutation(), target: { kind: 'session', id: session.id } }, ownerToken, 'FAILED_PRECONDITION'); await capture('22-plan-sin-caja')
  assert.deepEqual(errors, [])
  await writeFile(`${out}/recorrido.json`, JSON.stringify({ project: 'demo-llenamos', scale: 2, captures, browserErrors: errors, tcpJobs: count, cashExpectedCents: expected, differenceCents: 0, evidence }, null, 2) + '\n')
  console.log(`Recorrido correcto: ${captures.length} capturas, ${count} trabajos TCP, diferencia cero.`)
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: '/tmp/fase3-ultimo-error.png', fullPage: true }); console.error((await page.locator('body').innerText()).slice(-9000)) }
  throw error
} finally {
  if (originalModules) await root.update({ plan: 'completo', activeModules: originalModules })
  await browser.close(); await new Promise(r => fake.close(r)); await rm(temporary, { recursive: true, force: true }); await db.terminate()
}
