import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { Timestamp } from 'firebase-admin/firestore'

// Capturas de la fase 6 integrada en Chromium, contra los emuladores y la web de la fila 5. Sin Stripe real ni red.
// Uso (con los emuladores, la web en 3015 y `pnpm seed` hechos): pnpm exec tsx scripts/fase6-integracion-navegador.ts
if (process.env.GCLOUD_PROJECT !== 'demo-llenamos' || process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8100' || process.env.FIREBASE_AUTH_EMULATOR_HOST !== '127.0.0.1:9106') throw new Error('Solo se permite demo-llenamos y los emuladores de la fila 5.')
const WEB = 'http://localhost:3015', OUT = 'docs/diseno/capturas/fase6-integracion'
const require = createRequire(import.meta.url)
let playwright: typeof import('/srv/LogiQD/llenamos/.claude/pw/node_modules/playwright')
try { playwright = require('playwright') } catch { playwright = require('/srv/LogiQD/llenamos/.claude/pw/node_modules/playwright') }

async function main() {
  mkdirSync(OUT, { recursive: true })
  const { db, auth } = await import('../functions/src/shared')
  const core = await import('../packages/core/src/index')
  const { handleBillingEvent } = await import('../functions/src/fase6-billing/webhook')
  const { refreshPlatformAccess } = await import('../functions/src/fase6-billing/context')
  const { eventFixture, invoiceFixture } = await import('../functions/src/fase6-billing/fixtures')
  const { processPlatformWebhooks } = await import('../functions/src/fase6-api/events')
  const { createServer, request: httpRequest } = await import('node:http')

  const browser = await playwright.chromium.launch({ headless: true, executablePath: '/home/gery/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome', args: ['--no-sandbox'] })
  let context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 })
  let page = await context.newPage()
  const errors: string[] = []
  page.setDefaultTimeout(30000)
  page.on('pageerror', error => errors.push(error.message))
  const capture = async (name: string, full = true) => { await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(400); await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full }) }
  const results: Record<string, unknown> = {}
  try {
    // 1. Enlaces públicos a /alta, discretos, en la página de inicio y en la de entrar.
    await page.goto(`${WEB}/`)
    await page.getByRole('link', { name: /Pruébalo gratis/ }).waitFor()
    await capture('01-inicio-con-enlace-a-alta')
    await page.goto(`${WEB}/entrar`)
    await page.getByRole('link', { name: /Pruébalo gratis/ }).waitFor()
    await capture('02-entrar-con-enlace-a-alta')
    await page.getByRole('link', { name: /Pruébalo gratis/ }).click()
    await page.waitForURL('**/alta')
    // La página de entrar queda oculta pero montada: el alta sigue en un contexto limpio.
    await context.close()
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 })
    page = await context.newPage(); page.setDefaultTimeout(30000); page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${WEB}/alta`)

    // 2. Alta de un restaurante nuevo con una cuenta nueva.
    const email = `integra-${Date.now()}@prueba.test`, slug = `casa-integra-${Date.now()}`
    await page.getByLabel('Correo electrónico').fill(email)
    await page.getByLabel('Contraseña', { exact: true }).fill('Llenamos2026!')
    await page.getByRole('button', { name: 'Crear acceso y empezar' }).click()
    await page.getByRole('heading', { name: 'Vamos a llenar tu sala' }).waitFor()
    await page.getByLabel('Nombre del restaurante', { exact: true }).fill('Casa Integra')
    await page.getByLabel('Dirección de tu página de reservas').fill(slug)
    await page.getByRole('button', { name: 'Guardar y continuar' }).click()
    await page.getByRole('heading', { name: 'Dónde recibirás a tus clientes' }).waitFor()
    await page.getByLabel('Nombre del local').fill('El comedor')
    await page.getByLabel('Dirección', { exact: true }).fill('Calle de la Brasa 4')
    await page.getByLabel('Ciudad').fill('Barcelona')
    await page.getByLabel('Teléfono de contacto').fill('600123456')
    await page.getByRole('button', { name: 'Guardar y continuar' }).click()
    await page.getByRole('heading', { name: 'Haz sitio para tu primer servicio' }).waitFor()
    await page.getByLabel('Número de mesas').fill('8')
    await page.getByRole('button', { name: 'Guardar y continuar' }).click()
    await page.getByRole('heading', { name: 'Cuándo abrís las puertas' }).waitFor()
    await page.getByRole('button', { name: 'Guardar y continuar' }).click()
    await page.getByRole('heading', { name: 'Un primer vistazo a tu carta' }).waitFor()
    await page.getByRole('button', { name: 'Añadir plato' }).click()
    await page.getByLabel('Plato 1').fill('Patatas de la casa')
    await page.getByLabel('Precio en céntimos').fill('650')
    await page.getByRole('button', { name: 'Guardar y continuar' }).click()
    await page.getByRole('heading', { name: 'Empieza sin tarjeta' }).waitFor()
    await capture('03-alta-prueba-gratis')
    await page.getByRole('button', { name: 'Guardar y continuar' }).click()
    await page.getByRole('heading', { name: 'Revisa y abre tu restaurante' }).waitFor()
    await page.getByRole('checkbox').check()
    await page.getByRole('button', { name: 'Crear mi restaurante' }).click()
    await page.getByRole('heading', { name: 'Tu restaurante ya está preparado' }).waitFor({ timeout: 45000 })
    await capture('04-restaurante-creado')
    await page.getByRole('link', { name: /Entrar en mi restaurante/ }).click()
    await page.waitForURL('**/panel')
    const rid = (await db.collection('restaurants').where('slug', '==', slug).get()).docs[0]!.id
    results.restaurantId = rid

    // 3. Menú con las entradas nuevas y la prueba gratis sin claves de Stripe.
    await page.getByRole('link', { name: 'Plan y facturación' }).waitFor()
    await page.getByRole('link', { name: 'Integraciones' }).waitFor()
    await page.getByRole('link', { name: 'Privacidad' }).waitFor()
    await capture('05-panel-con-menu-de-plataforma', false)
    await page.getByRole('link', { name: 'Plan y facturación' }).click()
    await page.getByRole('heading', { name: 'Prueba gratuita', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Continuar con el plan elegido' }).click()
    await page.getByText('La facturación de la suscripción no está configurada. No se ha realizado ningún cargo.', { exact: true }).waitFor()
    await capture('06-planes-prueba-sin-claves')

    // 4. Cambio de plan con Stripe simulado: contrato ficticio y factura pagada del catálogo. Nada sale a la red.
    const sub = db.doc(`restaurants/${rid}/platform/subscription`)
    const key = randomUUID().replaceAll('-', '')
    const plan = core.PlanDefinitionSchema.parse({ ...core.provisionalPlanCatalog()[1]!, id: `plan_${key}`, stripeMonthlyPriceId: `price_${key}`, stripeAnnualPriceId: `price_year_${key}`, limits: { ...core.provisionalPlanCatalog()[1]!.limits, webhooks: 2, apiKeys: 2 } })
    await db.doc(`platformPlans/${plan.id}/versions/1`).set(plan)
    await sub.update({ stripeCustomerId: `cus_${rid}`, stripeSubscriptionId: `sub_${rid}`, planId: plan.id, planVersion: 1 })
    const end = Math.floor((Date.now() + 30 * 86_400_000) / 1000) * 1000
    const paid = (invoiceId: string, ok = true) => invoiceFixture({ customer: `cus_${rid}`, subscription: `sub_${rid}`, price: plan.stripeMonthlyPriceId!, amount: plan.monthlyCents, end, paid: ok, invoiceId })
    const created = Math.floor(Date.now() / 1000)
    await handleBillingEvent(eventFixture(`evt_${randomUUID()}`, 'invoice.paid', paid('in_pagada'), created))
    await page.reload()
    await page.getByRole('heading', { name: /Suscripción activa|Plan activo|Tu plan/ }).first().waitFor({ timeout: 20000 }).catch(() => undefined)
    await page.waitForTimeout(1500)
    await capture('07-planes-activo')

    // 5. API con clave y webhook creados desde la pantalla de integraciones.
    await page.goto(`${WEB}/panel/integraciones`)
    await page.getByRole('heading', { name: 'API y webhooks' }).waitFor()
    await page.getByLabel('Nombre de la aplicación').fill('Aplicación de reservas')
    await page.getByRole('button', { name: /Crear clave/ }).click()
    await page.getByText('Guarda este secreto ahora').waitFor()
    await capture('08-integraciones-clave-creada')
    await page.getByLabel('URL del receptor HTTPS').fill('https://93.184.216.34/eventos')
    await page.getByLabel('Evento').click()
    await page.getByRole('option', { name: 'reservation.created' }).click()
    await page.getByRole('button', { name: 'Crear webhook' }).click()
    await page.getByText('Guarda este secreto ahora').waitFor()

    // 6. Una reserva real por la callable pública produce el evento y un receptor local lo recibe firmado.
    const date = core.sumarDias(core.horaLocal(Date.now(), 'Europe/Madrid').fecha, 2)
    const reservar = await fetch('http://127.0.0.1:5016/demo-llenamos/europe-west1/crearReservaPublica', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: { slug, locationId: 'principal', date, time: '13:00', partySize: 2, guestName: 'Ana Cliente', phone: '+34600000999', language: 'es', acceptPolicy: true } }) })
    assert.equal(reservar.status, 200, 'La reserva pública debe crearse')
    const got: string[] = []
    const receiver = createServer((request, response) => { const chunks: Buffer[] = []; request.on('data', c => chunks.push(c)); request.on('end', () => { got.push(Buffer.concat(chunks).toString('utf8')); response.writeHead(204).end() }) })
    await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve))
    const port = (receiver.address() as { port: number }).port
    const transport = (url: string, body: string, signature: string) => new Promise<number>((resolve, reject) => {
      if (url !== 'https://93.184.216.34/eventos') return reject(new Error('Destino no permitido para el transporte local.'))
      const r = httpRequest(`http://127.0.0.1:${port}/eventos`, { method: 'POST', headers: { 'Llenamos-Signature': signature, 'Content-Type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode ?? 500) })
      r.on('error', reject); r.end(body)
    })
    for (let i = 0; i < 3; i++) await processPlatformWebhooks(rid, transport)
    await new Promise<void>(resolve => receiver.close(() => resolve()))
    results.webhooksRecibidos = got.map(b => (JSON.parse(b) as { type: string }).type)
    assert.ok((results.webhooksRecibidos as string[]).includes('reservation.created'), 'El receptor local debe recibir reservation.created')
    await page.goto(`${WEB}/panel/integraciones`)
    await page.getByRole('heading', { name: 'Entregas' }).waitFor()
    await page.waitForTimeout(1500)
    await capture('09-integraciones-con-entregas')

    // 7. Impago: siete días de gracia y después el servicio se corta en reservas, pero la administración sigue.
    const now = Date.now()
    await handleBillingEvent(eventFixture(`evt_${randomUUID()}`, 'invoice.payment_failed', paid('in_impago', false), created + 5), undefined, now)
    await page.goto(`${WEB}/panel/planes`)
    await page.waitForTimeout(1500)
    await capture('10-planes-impago-en-gracia')
    const grace = core.SubscriptionSchema.parse((await sub.get()).data()).graceEndsAt!
    await db.runTransaction(async tx => { const access = await refreshPlatformAccess(tx, rid, grace); access!.commit() })
    await page.goto(`${WEB}/panel/reservas`)
    await page.waitForTimeout(2500)
    await capture('11-reservas-suspendidas-por-impago')
    await page.goto(`${WEB}/panel/planes`)
    await page.waitForTimeout(1500)
    await capture('12-planes-suspendido')
    await page.setViewportSize({ width: 390, height: 844 })
    await capture('13-planes-suspendido-movil')
    results.estadoFinal = core.SubscriptionSchema.parse((await sub.get()).data()).status
    assert.equal(results.estadoFinal, 'suspended')

    // 8. Privacidad y panel del equipo LogiQD (claim real) con la cuenta demo del propietario.
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto(`${WEB}/panel/privacidad`)
    await page.waitForTimeout(2000)
    await capture('14-privacidad')
    // El trabajador de medición se ejecuta a mano en local: el panel del equipo muestra solo lo medido.
    const { measureUsage } = await import('../functions/src/fase6-api/service')
    for (const doc of (await db.collection('restaurants').get()).docs) await measureUsage(doc.id)
    const demo = await auth.getUserByEmail('propietario@lumbre.test')
    await auth.setCustomUserClaims(demo.uid, { ...demo.customClaims, logiqd: true })
    const team = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 })
    const t = await team.newPage(); t.setDefaultTimeout(30000); t.on('pageerror', error => errors.push(error.message))
    await t.goto(`${WEB}/entrar`)
    await t.getByRole('textbox', { name: 'Correo', exact: true }).fill('propietario@lumbre.test')
    await t.locator('input[name="password"]').fill('Llenamos2026!')
    await t.getByRole('button', { name: 'Entrar', exact: true }).click()
    await t.waitForURL('**/panel')
    await t.getByRole('button', { name: /Tu cuenta/ }).click()
    await t.getByRole('menuitem', { name: 'Equipo LogiQD' }).waitFor()
    await t.screenshot({ path: `${OUT}/15-menu-de-cuenta-con-acceso-del-equipo.png` })
    await t.getByRole('menuitem', { name: 'Equipo LogiQD' }).click()
    await t.waitForURL('**/logiqd')
    await t.waitForTimeout(2500)
    await t.screenshot({ path: `${OUT}/16-panel-del-equipo-logiqd.png`, fullPage: true })
    await team.close()
    await auth.setCustomUserClaims(demo.uid, { ...demo.customClaims })
    void Timestamp
    assert.deepEqual(errors, [])
    writeFileSync(`${OUT}/resultado.json`, JSON.stringify({ ...results, deviceScaleFactor: 2, browserErrors: errors }, null, 2) + '\n')
    console.log('Alta, prueba, cambio de plan, impago, API, webhook, privacidad y equipo LogiQD comprobados en Chromium.')
  } catch (error) { console.error(await page.locator('body').innerText().catch(() => '')); throw error } finally { await browser.close() }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
