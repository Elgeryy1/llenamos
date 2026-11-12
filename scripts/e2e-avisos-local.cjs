/* Avisos del agente 4 con claves de prueba y captura local. Nunca contacta con un proveedor. */
const fs = require('node:fs')
const path = require('node:path')
const { createECDH, randomBytes, randomUUID, createHash } = require('node:crypto')
let playwright
try { playwright = require('playwright') } catch { playwright = require('/srv/LogiQD/llenamos/.claude/pw/node_modules/playwright') }
process.env.GCLOUD_PROJECT = 'demo-llenamos'
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8099'
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9105'
for (const line of fs.readFileSync('functions/.env.local', 'utf8').split('\n')) {
  const match = /^(VAPID_[A-Z_]+)=(.*)$/.exec(line)
  if (match) process.env[match[1]] = match[2]
}
require('tsx/cjs')
const { processPush } = require('../functions/src/fase2/push-process.ts')
const { db } = require('../functions/src/shared.ts')
const { Timestamp } = require('firebase-admin/firestore')
const scope = { restaurantId: 'demo-lumbre', locationId: 'centro' }
const base = 'restaurants/demo-lumbre/locations/centro'
const out = path.resolve(process.env.CAPTURAS_DIR || 'docs/diseno/capturas/completar-cocina')
const check = (ok, message) => { if (!ok) throw new Error(message) }
async function main() {
  const auth = await fetch('http://127.0.0.1:9105/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'camarero@lumbre.test', password: 'Llenamos2026!', returnSecureToken: true }) }).then(r => r.json())
  check(auth.idToken, 'No se pudo entrar en la demo')
  async function call(name, data) {
    const result = await fetch(`http://127.0.0.1:5015/demo-llenamos/europe-west1/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.idToken}` }, body: JSON.stringify({ data: { ...scope, ...data } }) }).then(r => r.json())
    check(!result.error, JSON.stringify(result.error)); return result.result
  }
  const config = await call('configuracionPush', {})
  check(config.configured && config.localCapture, 'Genera antes functions/.env.local y reinicia los emuladores')
  const key = createECDH('prime256v1'); key.generateKeys()
  const subscription = { endpoint: `https://fcm.googleapis.com/fcm/send/local-${randomUUID()}`, keys: { p256dh: key.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }
  await call('guardarSuscripcionPush', { enabled: true, subscription })
  const { taskId } = await call('crearTarea', { note: 'Prueba local del aviso con retraso' })
  const task = db.doc(`${base}/floorTasks/${taskId}`)
  const deliveryId = createHash('sha256').update(subscription.endpoint).digest('hex')
  const deliveries = db.collection(`${base}/pushDeliveries`)
  // El transporte inyectado hace fallar la prueba si el procesador intenta salir a Internet.
  const transport = async () => { throw new Error('Un envío local no debe usar transporte') }
  await processPush(scope.restaurantId, scope.locationId, { transport })
  check((await deliveries.where('taskId', '==', taskId).get()).empty, 'Avisó antes del retraso')
  await task.update({ dueAt: Timestamp.fromMillis(Date.now() - 60000) })
  await Promise.all([processPush(scope.restaurantId, scope.locationId, { transport }), processPush(scope.restaurantId, scope.locationId, { transport })])
  const captures = await deliveries.where('taskId', '==', taskId).where('subscriptionId', '==', deliveryId).get()
  check(captures.size === 1 && captures.docs[0].get('status') === 'captured', 'No deduplicó la captura')
  const payload = captures.docs[0].get('payload')
  const browser = await playwright.chromium.launch({ executablePath: '/home/gery/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome', headless: true, args: ['--no-sandbox'] })
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['notifications'] })
    await context.route('**/*', route => ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort())
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    let registrationId
    cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => { for (const r of registrations) if (r.scopeURL === 'http://localhost:3014/panel/') registrationId = r.registrationId })
    await cdp.send('ServiceWorker.enable')
    await page.goto('http://localhost:3014/entrar')
    await page.getByRole('button', { name: /con camarero@lumbre.test$/ }).click()
    await page.waitForURL(/\/panel/)
    await page.locator('summary').filter({ hasText: 'Avisos al móvil' }).click()
    await page.getByRole('button', { name: 'Probar permiso en local', exact: true }).click()
    await page.getByText(/Permiso concedido y trabajador registrado/).waitFor()
    check(registrationId, 'No hay trabajador activo registrado en Chromium')
    await page.goto(`http://localhost:3014${payload.url}`)
    await page.locator('summary').filter({ hasText: 'Avisos al móvil' }).click()
    await page.getByRole('button', { name: 'Probar permiso en local', exact: true }).click()
    await page.getByText(/Permiso concedido y trabajador registrado/).waitFor()
    // CDP entrega un evento sintético al trabajador real; no es entrega de un proveedor.
    await cdp.send('ServiceWorker.deliverPushMessage', { origin: 'http://localhost:3014', registrationId, data: JSON.stringify(payload) })
    await page.waitForFunction(async tag => { const r = await navigator.serviceWorker.getRegistration('/panel/'); return (await r.getNotifications({ tag })).length === 1 }, payload.tag)
    await page.screenshot({ path: path.join(out, 'movil-avisos-captura-local.png'), fullPage: true, style: 'nextjs-portal { display: none !important; }' })
    await page.getByRole('button', { name: 'Voy yo', exact: true }).click()
    await page.getByText('Vas tú. Los siguientes avisos de esta tarea quedan silenciados.').waitFor()
    await page.waitForFunction(async tag => { const r = await navigator.serviceWorker.getRegistration('/panel/'); return (await r.getNotifications({ tag })).length === 0 }, payload.tag)
    check((await processPush(scope.restaurantId, scope.locationId, { transport })).captured === 0, 'Volvió a avisar tras coger la tarea')
    await page.screenshot({ path: path.join(out, 'movil-aviso-silenciado.png'), fullPage: true, style: 'nextjs-portal { display: none !important; }' })
    fs.writeFileSync(path.join(out, 'avisos-local.json'), JSON.stringify({ taskId, captured: captures.size, beforeDue: 0, afterClaim: 0, worker: '/sw-avisos.js', syntheticPushEvent: true, realProvider: false, realMobile: false }, null, 2) + '\n')
    console.log('Avisos locales: permiso, trabajador, evento sintético, deduplicación y silencio comprobados')
  } finally {
    await browser.close()
    await call('guardarSuscripcionPush', { enabled: false, subscription })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => db.terminate())
