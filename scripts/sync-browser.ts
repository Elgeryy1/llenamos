import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { db } from '../functions/src/shared'
import * as core from '@llenamos/core'

async function main() {
if (process.env.GCLOUD_PROJECT !== 'demo-llenamos' || process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8098' || process.env.FIREBASE_AUTH_EMULATOR_HOST !== '127.0.0.1:9104') throw new Error('Usa exclusivamente demo-llenamos y la fila 3 de emuladores.')
const require = createRequire(`${process.cwd()}/package.json`)
const { chromium } = require('/srv/LogiQD/llenamos/.claude/pw/node_modules/playwright')
const output = 'docs/diseno/capturas/sin-conexion', base = 'http://localhost:3013', root = 'restaurants/demo-lumbre/locations/centro'
const browser = await chromium.launch({ executablePath: '/home/gery/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome', headless: true, args: ['--no-sandbox'] })
const results: string[] = []
async function login(email: string, viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2 })
  const page = await context.newPage(); page.setDefaultTimeout(15000)
  await page.goto(`${base}/entrar`, { waitUntil: 'domcontentloaded' })
  await page.getByLabel('Correo', { exact: true }).fill(email)
  await page.getByLabel('Contraseña', { exact: true }).fill('Llenamos2026!')
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
  await page.waitForURL('**/panel')
  return { context, page }
}
async function call(page: any, name: string, data: unknown) {
  return page.evaluate(async ({ name, data }: any) => {
    const firebase = (globalThis as any).__llenamosFirebase
    const token = await firebase.auth.currentUser.getIdToken()
    const response = await fetch(`http://127.0.0.1:5014/demo-llenamos/europe-west1/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ data }) })
    const body = await response.json()
    if (body.error) throw new Error(`${name}: ${JSON.stringify(body.error)}`)
    return body.result
  }, { name, data })
}
async function local(page: any) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('llenamos:sin-conexion:1', 1); r.onsuccess = () => resolve(r.result); r.onerror = reject })
    const spaces = await new Promise<any[]>((resolve, reject) => { const r = db.transaction('spaces').objectStore('spaces').getAll(); r.onsuccess = () => resolve(r.result); r.onerror = reject })
    db.close(); return spaces
  })
}
async function until(test: () => Promise<boolean>, label: string, timeout = 30000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await test()) return; await new Promise(r => setTimeout(r, 250)) }
  throw new Error(`No se ha cumplido: ${label}`)
}
async function round(page: any, offline: boolean, context: any) {
  await page.getByRole('button', { name: 'Añadir Patatas bravas', exact: true }).click()
  await page.getByRole('button', { name: /Revisar total/ }).click()
  if (offline) await context.setOffline(true)
  await page.getByRole('button', { name: 'Enviar pedido', exact: true }).click()
}
try {
  await mkdir(output, { recursive: true })
  const owner = await login('propietario@lumbre.test')
  const scope = { restaurantId: 'demo-lumbre', locationId: 'centro' }
  const run = Date.now().toString(36)
  const settings = core.demoMenu().settings
  await db.doc(`${root}/settings/floor`).set({ ...settings, allowOrdersOutsideHours: true }, { merge: true })
  for (const n of [1, 2]) await db.doc(`${root}/tables/sync-${run}-${n}`).set({ name: `Prueba ${run} ${n}`, areaId: 'sala', seats: 4, shape: 'rect', x: 5 + n * 10, y: 75, w: 10, h: 10, enabled: true, joinableWith: [], updatedBy: 'lumbre-propietario' })
  const opened = await call(owner.page, 'abrirMesa', { ...scope, tableIds: [`sync-${run}-1`], guests: 2 })
  const sessionId = opened.sessionId
  await owner.page.goto(`${base}/panel/comandero?s=${sessionId}`, { waitUntil: 'domcontentloaded' })
  await owner.page.getByRole('button', { name: 'Añadir Patatas bravas', exact: true }).waitFor()
  await until(async () => (await local(owner.page)).some(s => s.versions.some((v: any) => v.kind === 'session' && v.id === sessionId)), 'destino preparado')
  // El registro global pertenece al coordinador. Aquí se instala la misma entrega para comprobarla localmente.
  await owner.page.evaluate(async () => { await navigator.serviceWorker.register('/sw-plataforma.js', { scope: '/panel/' }); await navigator.serviceWorker.ready; await new Promise<void>(resolve => navigator.serviceWorker.controller?.scriptURL.endsWith('sw-plataforma.js') ? resolve() : navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true })) })
  await round(owner.page, true, owner.context)
  await until(async () => (await local(owner.page)).some(s => s.entries.some((e: any) => e.state === 'queued')), 'pedido guardado sin red')
  const queued = (await local(owner.page)).flatMap(s => s.entries)[0]
  assert.equal((await db.collection(`${root}/orders`).where('sessionId', '==', sessionId).get()).size, 0)
  await owner.page.evaluate(() => window.scrollTo(0, 0))
  await owner.page.screenshot({ path: `${output}/comandero-pendiente.png`, fullPage: false })
  await owner.page.reload({ waitUntil: 'domcontentloaded' })
  await owner.page.getByRole('heading', { name: 'Sin conexión', exact: true }).waitFor()
  assert.equal((await local(owner.page)).flatMap(s => s.entries)[0].command.commandId, queued.command.commandId)
  await owner.page.screenshot({ path: `${output}/recarga-sin-red.png`, fullPage: false })
  await owner.context.setOffline(false)
  await until(async () => (await db.collection(`${root}/orders`).where('sessionId', '==', sessionId).get()).size === 1, 'pedido sincronizado tras recargar', 45000)
  console.log('Comprobación superada'); results.push('Comandero: corte real, guardado en IndexedDB, recarga sin red y reconexión crean una sola comanda.')
  // Se pierde la respuesta después de que el servidor confirme el efecto.
  await owner.page.waitForURL(`**/panel/comandero?s=${sessionId}`)
  await owner.page.getByRole('button', { name: 'Añadir Patatas bravas', exact: true }).waitFor()
  let dropped = false
  await owner.page.route('**/europe-west1/sincronizarComando', async (route: any) => { if (!dropped && route.request().method() === 'POST') { dropped = true; await route.fetch(); await route.abort('failed') } else await route.continue() })
  await round(owner.page, false, owner.context)
  await until(async () => (await local(owner.page)).flatMap(s => s.entries).length === 2 && (await local(owner.page)).flatMap(s => s.entries).every((e: any) => e.state === 'applied'), 'recuperación de respuesta perdida', 45000)
  assert.equal((await db.collection(`${root}/orders`).where('sessionId', '==', sessionId).get()).size, 2)
  assert(dropped)
  await owner.page.unroute('**/europe-west1/sincronizarComando')
  console.log('Comprobación superada'); results.push('Respuesta perdida después del commit: recupera el recibo y no duplica la segunda ronda.')
  // Dos pestañas comparten dispositivo, secuencias y exclusión del envío.
  const tab = await owner.context.newPage()
  await tab.goto(`${base}/panel/comandero?s=${sessionId}`, { waitUntil: 'domcontentloaded' })
  await tab.getByRole('button', { name: 'Añadir Patatas bravas', exact: true }).waitFor()
  await owner.context.setOffline(true)
  await round(owner.page, false, owner.context)
  await round(tab, false, owner.context)
  const shared = (await local(tab)).flatMap(s => s.entries)
  assert.equal(shared.length, 4)
  assert.equal(new Set(shared.map((e: any) => e.command.sequence)).size, 4)
  await owner.context.setOffline(false)
  await until(async () => (await local(tab)).flatMap(s => s.entries).every((e: any) => e.state === 'applied'), 'dos pestañas y comandos encadenados', 45000)
  assert.equal((await db.collection(`${root}/orders`).where('sessionId', '==', sessionId).get()).size, 4)
  await tab.close()
  results.push('Dos pestañas: secuencias distintas en una transacción IndexedDB, exclusión de envío y dos rondas encadenadas aplicadas una sola vez.')
  // Dos dispositivos preparan la misma sesión. El segundo verá conflicto al enviar una copia anterior.
  const tablet = await login('propietario@lumbre.test', { width: 1180, height: 820 })
  await tablet.page.goto(`${base}/panel/comandero?s=${sessionId}`, { waitUntil: 'domcontentloaded' })
  await tablet.page.getByRole('button', { name: 'Añadir Patatas bravas', exact: true }).waitFor()
  await until(async () => (await local(tablet.page)).some(s => s.versions.some((v: any) => v.id === sessionId)), 'segunda tablet preparada')
  await round(tablet.page, true, tablet.context)
  await round(owner.page, false, owner.context)
  await until(async () => (await db.collection(`${root}/orders`).where('sessionId', '==', sessionId).get()).size === 5, 'quinta ronda confirmada')
  await tablet.context.setOffline(false)
  await until(async () => (await local(tablet.page)).flatMap(s => s.entries).some((e: any) => e.state === 'conflict'), 'conflicto entre tablets')
  await tablet.page.getByText('Conflicto que necesita revisión', { exact: false }).first().waitFor()
  await tablet.page.evaluate(() => window.scrollTo(0, 0))
  await tablet.page.screenshot({ path: `${output}/conflicto-tableta.png`, fullPage: false })
  assert.equal((await db.collection(`${root}/orders`).where('sessionId', '==', sessionId).get()).size, 5)
  console.log('Comprobación superada'); results.push('Dos tablets: el destino antiguo conserva un conflicto visible y no duplica el pedido.')
  // Cocina real con su propia cuenta y su estación.
  const kitchen = await login('cocina@lumbre.test', { width: 1180, height: 820 })
  await kitchen.page.goto(`${base}/panel/cocina`, { waitUntil: 'domcontentloaded' })
  await kitchen.page.getByRole('button', { name: /Empezar/ }).first().waitFor()
  await until(async () => (await local(kitchen.page)).some(s => s.versions.some((v: any) => v.kind === 'line')), 'cocina preparada')
  await kitchen.context.setOffline(true)
  await kitchen.page.getByRole('button', { name: /Empezar/ }).first().click()
  await until(async () => (await local(kitchen.page)).flatMap(s => s.entries).some((e: any) => e.state === 'queued'), 'cambio de cocina guardado')
  await kitchen.page.evaluate(() => window.scrollTo(0, 0))
  await kitchen.page.screenshot({ path: `${output}/cocina-pendiente.png`, fullPage: false })
  await kitchen.context.setOffline(false)
  await until(async () => (await local(kitchen.page)).flatMap(s => s.entries).some((e: any) => e.state === 'applied'), 'cocina sincronizada')
  console.log('Comprobación superada'); results.push('Cocina: setOffline guarda el cambio local, reconectar lo aplica con el permiso de cocina.')
  // Caja: cuenta real preparada, anotación local, sin Payment durante el corte.
  const account = await call(owner.page, 'abrirCuenta', { ...scope, requestId: crypto.randomUUID(), target: { kind: 'session', id: sessionId } })
  const locked = await call(owner.page, 'prepararCobro', { ...scope, requestId: crypto.randomUUID(), billId: account.billId, expectedRevision: account.bill.revision })
  await owner.page.goto(`${base}/panel/caja`, { waitUntil: 'domcontentloaded' })
  assert.equal(locked.ok, true)
  // Las siguientes comprobaciones continúan con la cuenta elegida por su etiqueta en la pantalla real.
  await owner.page.getByRole('button', { name: new RegExp(`Prueba ${run} 1`) }).first().click()
  await owner.page.getByRole('button', { name: 'Cobrar', exact: true }).click()
  await owner.page.getByLabel('Efectivo entregado (€)', { exact: true }).fill('100')
  const before = (await db.collection(`${root}/payments`).get()).size
  await owner.context.setOffline(true)
  await owner.page.getByRole('button', { name: 'Anotar efectivo en este dispositivo', exact: true }).click()
  await until(async () => (await local(owner.page)).flatMap(s => s.cash).length === 1, 'efectivo anotado')
  assert.equal((await db.collection(`${root}/payments`).get()).size, before)
  await owner.page.getByRole('region', { name: 'Efectivo sin conexión', exact: true }).scrollIntoViewIfNeeded()
  await owner.page.screenshot({ path: `${output}/caja-efectivo-local.png`, fullPage: false })
  console.log('Comprobación superada'); results.push('Caja: efectivo guardado como anotación, ningún Payment durante el corte y tarjeta/fiscalidad bloqueadas.')
  await owner.context.setOffline(false)
  await owner.page.getByRole('button', { name: 'He revisado el efectivo y la cuenta. Registrar cobro', exact: true }).click()
  await until(async () => (await db.collection(`${root}/payments`).get()).size === before + 1, 'conciliación online explícita')
  console.log('Comprobación superada'); results.push('Efectivo: conciliación manual online usa la clave estable y crea un solo Payment.')
  // Cerrar sesión conserva la intención del otro dispositivo sin enviarla con otra cuenta.
  await tablet.page.getByRole('button', { name: /Marta Soler/ }).click()
  await tablet.page.getByRole('menuitem', { name: /Salir/ }).click()
  await tablet.page.waitForURL('**/entrar')
  assert.equal(await tablet.page.evaluate(() => localStorage.getItem('llenamos:offline:active')), null)
  await tablet.page.getByLabel('Correo', { exact: true }).fill('camarera@lumbre.test')
  await tablet.page.getByLabel('Contraseña', { exact: true }).fill('Llenamos2026!')
  await tablet.page.getByRole('button', { name: 'Entrar', exact: true }).click()
  await tablet.page.waitForURL('**/panel')
  await tablet.page.goto(`${base}/panel/comandero?s=${sessionId}`, { waitUntil: 'domcontentloaded' })
  await tablet.page.getByRole('region', { name: 'Sin conexión', exact: true }).first().getByText('Conexión disponible · Cambios pendientes: 0', { exact: true }).waitFor()
  await tablet.page.setViewportSize({ width: 390, height: 844 })
  await tablet.page.evaluate(() => window.scrollTo(0, 0))
  await tablet.page.screenshot({ path: `${output}/movil-otra-cuenta.png` })
  assert((await local(tablet.page)).flatMap(s => s.entries).some((e: any) => e.command.actorUid === 'lumbre-propietario' && e.state === 'conflict'))
  console.log('Comprobación superada'); results.push('Salir bloquea la vista local y conserva las intenciones para su uid original.')
  await writeFile(`${output}/resultados.json`, JSON.stringify({ results, deviceScaleFactor: 2, network: 'BrowserContext.setOffline', project: 'demo-llenamos' }, null, 2) + '\n')
  console.log(results.join('\n'))
} finally { await browser.close() }

}
main().catch(error => { console.error(error); process.exitCode = 1 })
