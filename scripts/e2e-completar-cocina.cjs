/* Recorrido real del agente 4. Solo proyecto demo y puertos locales de su fila. */
const fs = require('node:fs')
const path = require('node:path')
let playwright
try { playwright = require('playwright') } catch { playwright = require('/srv/LogiQD/llenamos/.claude/pw/node_modules/playwright') }
const { initializeApp } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')
process.env.GCLOUD_PROJECT = 'demo-llenamos'
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8099'
const db = getFirestore(initializeApp({ projectId: 'demo-llenamos' }))
const scope = { restaurantId: 'demo-lumbre', locationId: 'centro' }
const base = 'restaurants/demo-lumbre/locations/centro'
const out = path.resolve(process.env.CAPTURAS_DIR || 'docs/diseno/capturas/completar-cocina')
fs.mkdirSync(out, { recursive: true })
const item = (itemId, quantity = 1) => ({ kind: 'item', itemId, quantity })
const check = (condition, message) => { if (!condition) throw new Error(message) }
async function auth(email) {
  const response = await fetch('http://127.0.0.1:9105/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'Llenamos2026!', returnSecureToken: true }) })
  const data = await response.json(); check(data.idToken, JSON.stringify(data)); return data.idToken
}
async function call(name, data, token) {
  const response = await fetch(`http://127.0.0.1:5015/demo-llenamos/europe-west1/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ data }) })
  const result = await response.json(); check(!result.error, `${name}: ${JSON.stringify(result)}`); return result.result
}
async function login(browser, email, viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2 })
  const page = await context.newPage()
  page.on('pageerror', error => console.error('Navegador:', error.message))
  await page.goto('http://localhost:3014/entrar')
  await page.getByRole('button', { name: new RegExp(`con ${email.replaceAll('.', '\\.')}$`) }).click()
  await page.waitForURL(/\/panel/)
  return { context, page }
}
async function capture(page, filename) { await page.screenshot({ path: path.join(out, filename), fullPage: true }); console.log('Captura:', filename) }
async function main() {
  const previousSessions = (await db.collection(`${base}/tableSessions`).get()).docs.filter(d => d.get('tableIds').some(id => id.startsWith('cocina-e2e-')))
  const previousTakes = (await db.collection(`${base}/takeaways`).get()).docs.filter(d => d.get('guestName') === 'Ana Recogida')
  const sessionIds = new Set(previousSessions.map(d => d.id)), takeawayIds = new Set(previousTakes.map(d => d.id))
  for (const collection of ['orders', 'orderLines', 'floorTasks']) {
    for (const doc of (await db.collection(`${base}/${collection}`).get()).docs) if (sessionIds.has(doc.get('sessionId')) || takeawayIds.has(doc.get('takeawayId'))) await doc.ref.delete()
  }
  for (const doc of [...previousSessions, ...previousTakes]) await doc.ref.delete()
  await db.doc(`${base}/menuItems/bravas`).update({ portions: null, soldOut: false })
  const token = await auth('propietario@lumbre.test')
  const settings = (await db.doc(`${base}/settings/floor`).get()).data()
  settings.selfOrder.enabled = true
  await call('guardarConfiguracionSala', { ...scope, settings }, token)
  const session = []
  for (let i = 1; i <= 4; i++) {
    const template = (await db.doc(`${base}/tables/sala-${i}`).get()).data()
    await db.doc(`${base}/tables/cocina-e2e-${i}`).set({ ...template, name: `C${i}` })
    const existing = (await db.collection(`${base}/tableSessions`).get()).docs.find(d => ['open', 'bill_requested'].includes(d.get('status')) && d.get('tableIds').includes(`cocina-e2e-${i}`))
    session.push(existing ? { sessionId: existing.id } : await call('abrirMesa', { ...scope, tableIds: [`cocina-e2e-${i}`], guests: 2 }, token))
  }
  const sent = await call('enviarPedido', { ...scope, sessionId: session[0].sessionId, fire: 'all', note: 'Sin frutos secos en todo el pedido. Confirmar antes de servir.', lines: [item('bravas'), { ...item('croquetas'), variantId: 'racion' }, item('agua')] }, token)
  await call('enviarPedido', { ...scope, sessionId: session[1].sessionId, note: 'Los segundos esperan a que sala los marche.', lines: [item('bravas'), item('hamburguesa')] }, token)
  const qr = await call('regenerarQrMesa', { ...scope, tableIds: ['cocina-e2e-3'] }, token)
  const qrOrder = await call('pedirDesdeMesa', { slug: 'taberna-lumbre', locationId: 'centro', tableId: 'cocina-e2e-3', token: qr.tokens[0].token, sessionId: session[2].sessionId, note: 'Pedido QR. Servir todo al salir.', language: 'es', expectedTotalCents: 2050, lines: [item('bravas'), item('hamburguesa')] })
  const approved = await call('decidirPedido', { ...scope, orderId: qrOrder.orderId, decision: 'accept' }, token)
  check(approved.fired === 2 && approved.held === 0, 'QR no salió completo')
  const date = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
  const take = await call('crearParaLlevar', { ...scope, date, time: '13:15', guestName: 'Ana Recogida', phone: '600000000', source: 'phone', notes: 'Salsa aparte. Entregar a Ana.', lines: [item('bravas'), { ...item('croquetas'), variantId: 'media' }] }, token)
  await call('cambiarEstadoMesa', { ...scope, sessionId: session[1].sessionId, status: 'bill_requested' }, token)
  const task = (await db.collection(`${base}/floorTasks`).where('purpose', '==', 'fire_course').get()).docs.find(d => d.get('sessionId') === session[1].sessionId)
  check(task && task.get('status') === 'open', 'No hay tarea de marcha tras pedir cuenta')
  const taskUrl = `http://localhost:3014/panel/avisos?restaurant=demo-lumbre&local=centro&task=${task.id}`
  const browser = await playwright.chromium.launch({ executablePath: '/home/gery/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome', headless: true, args: ['--no-sandbox'] })
  try {
    const kitchen = await login(browser, 'cocina@lumbre.test', { width: 1180, height: 820 })
    await kitchen.page.goto('http://localhost:3014/panel/cocina')
    await kitchen.page.waitForTimeout(2500)
    console.log('Cocina:', (await kitchen.page.locator('body').innerText()).slice(0,4500))
    await kitchen.page.screenshot({path:'/tmp/cocina4-inicial.png',fullPage:true})
    await kitchen.page.getByRole('article', { name: 'Comanda C1', exact: true }).waitFor()
    await kitchen.page.getByText('Nota del pedido: Sin frutos secos en todo el pedido. Confirmar antes de servir.').waitFor()
    const columns = await kitchen.page.locator('article').evaluateAll(els => [...new Set(els.map(e => Math.round(e.getBoundingClientRect().left)))].length)
    check(columns >= 2, 'No hay varios tickets en rejilla en tableta')
    await capture(kitchen.page, 'cocina-tableta.png')
    await kitchen.page.getByRole('button', { name: 'En espera', exact: true }).click()
    await kitchen.page.getByRole('article', { name: 'Comanda C2', exact: true }).waitFor()
    check(await kitchen.page.getByRole('article', { name: 'Comanda C1', exact: true }).count() === 0, 'El filtro de espera muestra un ticket sin retenidos')
    await capture(kitchen.page, 'pases-en-espera.png')
    await kitchen.page.getByRole('button', { name: 'Todos', exact: true }).click()
    await kitchen.page.setViewportSize({ width: 390, height: 844 })
    await capture(kitchen.page, 'cocina-movil.png')
    await kitchen.page.setViewportSize({ width: 1440, height: 900 })
    await capture(kitchen.page, 'cocina-escritorio.png')
    const ticket = kitchen.page.getByRole('article', { name: 'Comanda C1', exact: true })
    await ticket.getByRole('button', { name: 'Seleccionar pendientes' }).click()
    await ticket.getByRole('button', { name: 'Empezar 2', exact: true }).click()
    await ticket.getByText('Preparando', { exact: true }).first().waitFor()
    await capture(kitchen.page, 'seleccion-ticket.png')
    await ticket.getByRole('button', { name: 'Dejar listos 2', exact: true }).click()
    await ticket.getByText('Listo para recoger', { exact: true }).first().waitFor()
    const kitchenLines = await db.collection(`${base}/orderLines`).where('orderId', '==', sent.orderId).get()
    check(kitchenLines.docs.filter(d => d.get('stationKind') === 'kitchen').every(d => d.get('status') === 'ready'), 'El lote no quedó listo')
    check(kitchenLines.docs.find(d => d.get('stationKind') === 'bar').get('status') === 'fired', 'El lote afectó a barra')
    // Intercepta solo el diálogo del navegador para inspeccionar el documento real preparado para imprimir.
    await kitchen.page.evaluate(() => { window.__printCalled = 0; HTMLIFrameElement.prototype.__framePrint = true })
    await kitchen.page.addInitScript(() => { window.print = () => { window.parent.__printCalled = (window.parent.__printCalled || 0) + 1 } })
    // Se instala la comprobación en el nuevo contexto de impresión antes de pulsar.
    const cdp = await kitchen.context.newCDPSession(kitchen.page)
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.print = () => { window.parent.__printCalled = (window.parent.__printCalled || 0) + 1 }' })
    await ticket.getByRole('button', { name: 'Imprimir ticket' }).click()
    await kitchen.page.waitForFunction(() => document.querySelector('iframe[title="Impresión del ticket de cocina"]')?.contentDocument?.body.textContent.includes('Sin frutos secos'))
    const printed = kitchen.page.frames().find(f => f !== kitchen.page.mainFrame() && f.url() === 'about:blank')
    check(printed, 'No se preparó el documento de impresión')
    await kitchen.page.locator('iframe[title="Impresión del ticket de cocina"]').evaluate(el => { el.style.cssText = 'position:fixed;left:0;top:0;width:750px;height:900px;z-index:9999;background:white;border:0' })
    await printed.locator('body').screenshot({ path: path.join(out, 'impresion-ticket.png') })
    await kitchen.page.locator('iframe[title="Impresión del ticket de cocina"]').evaluate(el => el.remove())
    const takeawayTicket = kitchen.page.getByRole('article').filter({ hasText: 'Ana Recogida' })
    await takeawayTicket.getByText(`Recogida 13:15 · ${take.reference} · Ana Recogida`).waitFor()
    await takeawayTicket.screenshot({ path: path.join(out, 'ticket-recogida.png') })
    await kitchen.page.getByText('Agotados', { exact: true }).click()
    const portions = kitchen.page.getByRole('textbox', { name: 'Raciones de Total de Patatas bravas', exact: true })
    await portions.fill('1')
    await kitchen.page.getByRole('button', { name: 'Guardar recuento de Total de Patatas bravas', exact: true }).click()
    await kitchen.page.getByText('1 raciones', { exact: true }).waitFor()
    const last = await Promise.all([1, 2].map(() => call('enviarPedido', { ...scope, sessionId: session[3].sessionId, lines: [item('bravas')] }, token)))
    check(last.map(r => r.status).sort().join(',') === 'rejected,sent', 'Se vendió dos veces la última ración')
    await kitchen.page.getByText('0 raciones', { exact: true }).waitFor()
    await capture(kitchen.page, 'raciones-agotadas.png')
    const bar = await login(browser, 'barra@lumbre.test', { width: 1180, height: 820 })
    await bar.page.goto('http://localhost:3014/panel/barra')
    await bar.page.getByText('Nota del pedido: Sin frutos secos en todo el pedido. Confirmar antes de servir.').waitFor()
    await capture(bar.page, 'barra-nota.png')
    const waiter = await login(browser, 'camarero@lumbre.test', { width: 390, height: 844 })
    await waiter.page.goto(taskUrl)
    await waiter.page.getByRole('heading', { name: /C2 · tarea/i }).waitFor()
    await waiter.page.getByText('Sin responsable', { exact: true }).waitFor()
    await capture(waiter.page, 'movil-tarea-retenida.png')
    await waiter.page.getByRole('button', { name: 'Voy yo', exact: true }).click()
    await waiter.page.getByText('Vas tú. Los siguientes avisos de esta tarea quedan silenciados.').waitFor()
    await waiter.page.locator('summary').filter({ hasText: 'Avisos al móvil' }).click()
    const push = await call('configuracionPush', scope, token)
    await waiter.page.getByText(push.configured ? 'Emuladores locales: los avisos se guardan sin enviarlos a ningún servicio externo.' : 'Sin claves VAPID válidas no se envía nada al móvil.').waitFor()
    await capture(waiter.page, push.configured ? 'movil-avisos-configurados.png' : 'movil-avisos-sin-claves.png')
    fs.writeFileSync(path.join(out, 'recorrido.json'), JSON.stringify({ columns, orderId: sent.orderId, takeaway: take.reference, taskId: task.id, tested: ['notas en dos estaciones', 'QR sale completo', 'retenidos con tarea al pedir cuenta', 'lote de estación', 'impresión', 'recogida', 'última ración concurrente', 'aviso sin claves', 'coger tarea desde enlace'] }, null, 2) + '\n')
    console.log('Recorrido completado con emuladores reales')
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => db.terminate())
