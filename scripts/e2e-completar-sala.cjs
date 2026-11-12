// Recorrido local del agente 1. Solo demo-llenamos y los puertos de su fila.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
let chromium
try { ({ chromium } = require('playwright')) } catch { ({ chromium } = require('/srv/LogiQD/llenamos/.claude/pw/node_modules/playwright')) }
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8096'
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9102'
const { initializeApp } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')
initializeApp({ projectId: 'demo-llenamos' })
const db = getFirestore()
const base = 'restaurants/demo-lumbre/locations/centro'
const scope = { restaurantId: 'demo-lumbre', locationId: 'centro' }
const out = path.resolve('docs/diseno/capturas/completar-sala')
fs.mkdirSync(out, { recursive: true })
let token
async function call(name, input, publicCall = false) {
  const response = await fetch(`http://127.0.0.1:5012/demo-llenamos/europe-west1/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(!publicCall ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ data: input }) })
  const body = await response.json()
  if (body.error) throw new Error(`${name}: ${body.error.message}`)
  return body.result
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function shot(page, name) {
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' })
  await page.screenshot({ path: path.join(out, name), fullPage: false })
}
async function main() {
  const login = await fetch('http://127.0.0.1:9102/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'propietario@lumbre.test', password: 'Llenamos2026!', returnSecureToken: true }) }).then(r => r.json())
  token = login.idToken
  assert(token)
  const initialSettings = (await db.doc(`${base}/settings/floor`).get()).data()
  await call('guardarConfiguracionSala', { ...scope, settings: { ...initialSettings, allowOrdersOutsideHours: true } })
  const browser = await chromium.launch({ executablePath: '/home/gery/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome', args: ['--no-sandbox'] })
  try {
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
    const page = await desktop.newPage()
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    await page.goto('http://localhost:3011/entrar')
    await page.getByLabel('Correo', { exact: true }).fill('propietario@lumbre.test')
    await page.getByLabel('Contraseña', { exact: true }).fill('Llenamos2026!')
    await page.getByRole('button', { name: 'Entrar', exact: true }).click()
    await page.waitForURL('**/panel')
    console.log('Entrada real completada')
    // Se sienta una reserva del seed para no ocupar una mesa reservada como visita nueva.
    const reservations = (await db.collection(`${base}/reservations`).get()).docs
    let reservation, session
    const existing = (await db.collection(`${base}/tableSessions`).get()).docs.find(s => ['open', 'bill_requested'].includes(s.get('status')))
    if (existing) {
      session = { sessionId: existing.id }
      reservation = reservations.find(r => r.id === existing.get('reservationId'))
    } else {
      for (const candidate of reservations.filter(r => ['confirmed', 'pending', 'seated'].includes(r.get('status')) && r.get('tableIds')?.length).sort((a,b) => Number(a.get('status') === 'seated') - Number(b.get('status') === 'seated'))) {
        try { session = await call('abrirMesa', { ...scope, tableIds: candidate.get('tableIds'), guests: candidate.get('partySize'), reservationId: candidate.id }); reservation = candidate; break } catch { /* Se busca una reserva cuyas mesas no solapen con el servicio actual. */ }
      }
    }
    assert(reservation && session, 'No hay una reserva que se pueda sentar ahora')
    const sid = session.sessionId
    const tableId = reservation.get('tableIds')[0]
    fs.writeFileSync('/tmp/llenamos-sala-e2e-session.json', JSON.stringify({ sid, tableId }))
    await page.goto(`http://localhost:3011/panel/comandero?s=${sid}`)
    await page.getByRole('button', { name: 'Añadir Patatas bravas', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Añadir Patatas bravas', exact: true }).click()
    await page.getByRole('button', { name: 'Añadir Patatas bravas', exact: true }).click()
    await page.getByRole('region', { name: 'Pedido sin enviar', exact: true }).getByText('2 × Patatas bravas', { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Añadir Sopa de galets', exact: true }).count(), 0)
    await page.getByRole('textbox', { name: /^Nota del envío/ }).fill('Primero las bravas, sin prisa con el resto')
    await page.reload()
    await page.getByRole('region', { name: 'Pedido sin enviar', exact: true }).getByText('2 × Patatas bravas', { exact: true }).waitFor()
    await sleep(1200)
    fs.writeFileSync('/tmp/llenamos-reload-body.txt', await page.locator('body').innerText())
    await page.screenshot({ path: '/tmp/llenamos-reload.png' })
    assert.equal(await page.getByRole('textbox', { name: /^Nota del envío/ }).inputValue(), 'Primero las bravas, sin prisa con el resto')
    await page.getByRole('link', { name: 'Plano de sala', exact: true }).click()
    await page.goto(`http://localhost:3011/panel/comandero?s=${sid}`)
    await page.getByRole('region', { name: 'Pedido sin enviar', exact: true }).getByText('2 × Patatas bravas', { exact: true }).waitFor()
    await page.getByRole('region', { name: 'Carta para pedir' }).evaluate(el => el.scrollIntoView({ block: 'start' }))
    await shot(page, '01-borrador-escritorio.png')
    await page.setViewportSize({ width: 1180, height: 820 })
    await shot(page, '02-borrador-tableta.png')
    await page.setViewportSize({ width: 1440, height: 900 })
    const ownerDrafts = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith('llenamos:comandero:'))))
    const waiterContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
    await waiterContext.addInitScript(values => { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value) }, ownerDrafts)
    const waiterPage = await waiterContext.newPage()
    await waiterPage.goto('http://localhost:3011/entrar')
    await waiterPage.getByLabel('Correo', { exact: true }).fill('camarero@lumbre.test')
    await waiterPage.getByLabel('Contraseña', { exact: true }).fill('Llenamos2026!')
    await waiterPage.getByRole('button', { name: 'Entrar', exact: true }).click()
    await waiterPage.waitForURL('**/panel')
    await waiterPage.goto(`http://localhost:3011/panel/comandero?s=${sid}`)
    await waiterPage.getByRole('button', { name: 'Añadir Agua mineral', exact: true }).waitFor()
    assert.equal(await waiterPage.getByRole('region', { name: 'Pedido sin enviar', exact: true }).getByText('2 × Patatas bravas', { exact: true }).count(), 0)
    await waiterPage.getByRole('button', { name: 'Añadir Agua mineral', exact: true }).click()
    await waiterPage.getByRole('button', { name: /Revisar pedido ·/ }).click()
    await shot(waiterPage, '13-comandero-movil.png')
    await waiterContext.close()
    // Cambiar precios y comensales obliga a revisar sin perder las líneas.
    await page.getByRole('button', { name: /Revisar total/ }).click()
    const bravasRef = db.doc(`${base}/menuItems/bravas`)
    const originalPrice = (await bravasRef.get()).data()
    await bravasRef.update({ priceCents: originalPrice.priceCents + 50, version: originalPrice.version + 1 })
    await page.getByRole('button', { name: /Revisar total/ }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Enviar pedido', exact: true }).isDisabled(), true)
    await shot(page, '11-revision-precio.png')
    await bravasRef.update({ priceCents: originalPrice.priceCents, version: originalPrice.version })
    await call('editarMesa', { ...scope, sessionId: sid, guests: (await db.doc(`${base}/tableSessions/${sid}`).get()).get('guests') === 1 ? 2 : 1 })
    await page.getByRole('button', { name: 'He revisado esta mesa', exact: true }).waitFor()
    await shot(page, '12-revision-destino.png')
    await page.getByRole('button', { name: 'He revisado esta mesa', exact: true }).click()
    await page.getByRole('button', { name: 'Revisar destino del borrador', exact: true }).click()
    // Se recibe la respuesta real del servidor y se descarta en el transporte.
    const ordersBefore = (await db.collection(`${base}/orders`).where("sessionId", "==", sid).get()).size
    let received
    const firstResponse = new Promise(resolve => { received = resolve })
    let firstInput, firstResult
    await page.route('**/enviarPedido', async route => {
      firstInput = route.request().postDataJSON().data
      const response = await route.fetch()
      firstResult = (await response.json()).result
      await route.abort('failed')
      received()
    }, { times: 1 })
    if (await page.getByRole('button', { name: /Revisar total/ }).count()) await page.getByRole('button', { name: /Revisar total/ }).click()
    await page.getByRole('button', { name: 'Enviar pedido', exact: true }).click()
    await page.getByRole('button', { name: 'Recuperar resultado del envío' }).waitFor({ timeout: 30000 })
    await firstResponse
    assert(firstResult?.orderId)
    await page.reload()
    await page.getByRole('button', { name: 'Recuperar resultado del envío' }).click()
    await page.getByText('Pedido confirmado por el servidor.', { exact: true }).waitFor()
    assert.equal((await db.collection(`${base}/orders`).where('sessionId', '==', sid).get()).size, ordersBefore + 1)
    assert.equal((await call('enviarPedido', firstInput)).orderId, firstResult.orderId)
    console.log('Borrador, recarga, cambio de vista y respuesta perdida comprobados')
    await page.getByRole('button', { name: 'Repetir última ronda' }).click()
    await page.getByRole('region', { name: 'Pedido sin enviar', exact: true }).getByText('2 × Patatas bravas', { exact: true }).first().waitFor()
    await page.getByRole('button', { name: 'Quitar línea 1', exact: true }).click()
    const qr = (await call('regenerarQrMesa', { ...scope, tableIds: [tableId] })).tokens[0]
    const publicContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
    const qrPage = await publicContext.newPage()
    await qrPage.goto(`http://localhost:3011${qr.path}`)
    await qrPage.getByRole('button', { name: 'Llamar al camarero', exact: true }).waitFor()
    await qrPage.getByRole('combobox', { name: 'Motivo de la llamada' }).click()
    await qrPage.getByRole('option', { name: 'Agua', exact: true }).click()
    await qrPage.getByLabel('Nota para el camarero').fill('Una jarra sin hielo, por favor')
    await qrPage.getByRole('button', { name: 'Llamar al camarero', exact: true }).click()
    await qrPage.getByText('Aviso enviado al personal', { exact: false }).waitFor()
    await shot(qrPage, '03-llamada-qr-movil.png')
    await qrPage.getByRole('combobox', { name: 'Motivo de la llamada' }).click()
    await qrPage.getByRole('option', { name: 'Servilletas', exact: true }).click()
    await qrPage.getByRole('button', { name: 'Llamar al camarero', exact: true }).click()
    const calls = (await db.collection(`${base}/floorTasks`).where('type', '==', 'call_waiter').get()).docs
    assert.equal(calls.filter(t => t.get('sessionId') === sid && ['open', 'claimed'].includes(t.get('status'))).length, 1)
    // Pedido QR real: se pierde la respuesta, se recarga y se recupera por la misma clave.
    const article = qrPage.locator('article').filter({ has: qrPage.getByRole('heading', { name: 'Agua mineral', exact: true }) })
    await article.getByRole('button', { name: 'Añadir', exact: true }).click()
    await qrPage.getByRole('button', { name: /Añadir ·/ }).click()
    await qrPage.getByRole('button', { name: /Revisar el total/ }).click()
    let qrReceived, qrResult, qrInput
    const qrResponse = new Promise(resolve => { qrReceived = resolve })
    await qrPage.route('**/m/api/pedirDesdeMesa', async route => {
      console.log('Solicitud QR interceptada')
      qrInput = route.request().postDataJSON().data
      const response = await route.fetch()
      qrResult = (await response.json()).result
      await route.abort('failed')
      qrReceived()
    }, { times: 1 })
    for (let attempt = 0; attempt < 3 && !qrInput; attempt++) {
      await qrPage.getByRole('button', { name: 'Enviar pedido', exact: true }).click()
      await Promise.race([qrResponse, sleep(21000)])
    }
    await Promise.race([qrResponse, sleep(60000).then(async () => { fs.writeFileSync('/tmp/llenamos-qr-fallo.txt', await qrPage.locator('body').innerText()); throw new Error('El envío QR no devolvió su respuesta a tiempo') })])
    assert(qrResult.orderId)
    await qrPage.reload()
    await qrPage.getByRole('button', { name: 'Recuperar resultado del envío', exact: true }).click()
    await qrPage.getByText(/un camarero lo confirmará/).waitFor()
    assert.equal((await call('pedirDesdeMesa', qrInput, true)).orderId, qrResult.orderId)
    await shot(qrPage, '10-qr-recuperado.png')
    console.log('QR con respuesta perdida y recuperación tras recargar comprobado')
    await page.goto('http://localhost:3011/panel/sala')
    await page.locator('span:visible').filter({ hasText: /^Llamada$/ }).first().waitFor()
    await shot(page, '04-sala-llamada.png')
    // Listos, variantes, extras y notas proceden de una comanda real.
    const round = await call('enviarPedido', { ...scope, sessionId: sid, requestId: crypto.randomUUID(), fire: 'all', lines: [{ kind: 'item', itemId: 'hamburguesa', quantity: 2, optionIds: ['queso'], notes: 'Una sin sal', guest: 2 }, { kind: 'item', itemId: 'croquetas', quantity: 1, variantId: 'racion', notes: 'Sin salsa' }] })
    await call('cambiarEstadoLineas', { ...scope, lineIds: round.lineIds, status: 'ready' })
    await page.getByText('2 × Hamburguesa Lumbre', { exact: true }).first().waitFor()
    const pickup = page.getByRole('listitem').filter({ hasText: 'recoger en el pase' }).filter({ hasText: 'Hamburguesa' }).first()
    await pickup.getByRole('button', { name: 'Voy yo', exact: true }).click()
    await pickup.getByText('Vas tú', { exact: true }).waitFor()
    const extra = await call('enviarPedido', { ...scope, sessionId: sid, lines: [{ kind: 'item', itemId: 'bravas', quantity: 1 }], fire: 'all' })
    await call('cambiarEstadoLineas', { ...scope, lineIds: extra.lineIds, status: 'ready' })
    await page.getByText(/Han llegado más platos a esta recogida/).first().waitFor()
    await pickup.scrollIntoViewIfNeeded()
    await shot(page, '05-recogida-detalle.png')
    await page.setViewportSize({ width: 390, height: 844 })
    await pickup.scrollIntoViewIfNeeded()
    await shot(page, '06-recogida-movil.png')
    await page.setViewportSize({ width: 1440, height: 900 })
    // Se limpia la llamada para dejar visible la siguiente prioridad del plano.
    for (const task of calls) if (task.get('sessionId') === sid && ['open', 'claimed'].includes(task.get('status'))) await call('cambiarEstadoTarea', { ...scope, taskId: task.id, action: 'done' })
    await call('cambiarEstadoMesa', { ...scope, sessionId: sid, status: 'bill_requested' })
    await page.goto('http://localhost:3011/panel/sala')
    await page.locator('span:visible').filter({ hasText: /^(Listo para servir|Listo)$/ }).first().waitFor()
    const table = await db.doc(`${base}/tables/${tableId}`).get()
    await page.getByRole('list', { name: /^Plano de / }).getByRole('button', { name: new RegExp(`^Mesa ${table.get('name')}[, .]`) }).click()
    await page.getByText('Pendiente de aprobación', { exact: true }).last().waitFor()
    await page.getByText('Cuenta pedida', { exact: true }).last().waitFor()
    await shot(page, '07-sala-listo.png')
    await page.goto('http://localhost:3011/panel/comandas')
    await page.getByRole('heading', { name: 'Todas las comandas del local' }).waitFor()
    await page.getByText(/comandas$/, { exact: false }).first().waitFor()
    await shot(page, '08-bandeja-comandas.png')
    const checkbox = page.getByRole('checkbox', { name: 'Permitir pedir en mesas abiertas fuera de horario' })
    await checkbox.click()
    await page.getByText('Política horaria guardada.', { exact: true }).waitFor()
    assert.equal((await db.doc(`${base}/settings/floor`).get()).get('allowOrdersOutsideHours'), false)
    await shot(page, '09-politica-horaria.png')
    await checkbox.click()
    await page.getByText('Política horaria guardada.', { exact: true }).waitFor()
    assert.deepEqual(errors, [])
    fs.writeFileSync(path.join(out, 'resultado.json'), JSON.stringify({ proyecto: 'demo-llenamos', sesion: sid, mesa: tableId, comandaRecuperada: firstResult.orderId, capturas: 13, erroresNavegador: errors }, null, 2) + '\n')
    console.log('Recorrido y trece capturas completados')
  } finally { await browser.close() }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
