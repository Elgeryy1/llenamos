// Recorrido real con Chromium, la web y los emuladores de la fila 5.
const assert = require('node:assert/strict')
const path = require('node:path')
const { chromium } = require('playwright')
const base = 'http://localhost:3015'
const errors = []
const checked = []
const testRun = Date.now().toString(36)
const xlsx = path.resolve('tests/fixtures/reservas-ejemplo.xlsx')
const { initializeApp } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')
assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8100')
initializeApp({ projectId: 'demo-llenamos' })
const db = getFirestore()
const main = (p) => p.locator('main')
async function foto(p, name, fullPage = false) {
  console.log(`Captura: ${name}`)
  await p.addStyleTag({ content: 'nextjs-portal { display: none; }' })
  await p.evaluate(() => document.fonts.ready)
  await p.waitForTimeout(300)
  assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}: la página no desborda`)
  await p.screenshot({ path: path.join(__dirname, `${name}.png`), fullPage, animations: 'disabled' })
}
async function goto(p, route) {
  await p.goto(`${base}/panel/${route}`)
  await main(p).getByRole('heading', { level: 1 }).or(main(p).getByText(/^Tu rol no puede ver/)).waitFor()
}
async function login(browser, role, viewport, touch = false) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, hasTouch: touch, isMobile: viewport.width < 600, timezoneId: 'Europe/Madrid' })
  const p = await context.newPage()
  p.setDefaultTimeout(20_000)
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(`${base}/entrar`)
  const email = role === 'propietario' ? 'propietario' : role === 'encargado' ? 'encargada' : 'camarero'
  await p.getByRole('button', { name: `Entrar como ${role} con ${email}@lumbre.test`, exact: true }).click()
  await p.waitForURL('**/panel')
  return { context, p }
}
async function clientes(p) {
  await goto(p, 'clientes')
  await main(p).getByRole('heading', { name: /clientes con su historia/ }).waitFor()
}
async function abrirAna(p) {
  await p.getByRole('searchbox', { name: 'Buscar cliente' }).fill('Ana Garcia')
  const opener = main(p).getByLabel('Abrir la ficha de Ana García', { exact: true })
  await opener.filter({ visible: true }).click()
  await p.getByRole('dialog', { name: 'Ana García', exact: true }).waitFor()
}
async function editar(p, role) {
  console.log(`Comprobando ficha: ${role}`)
  await clientes(p)
  await abrirAna(p)
  const dialog = p.getByRole('dialog', { name: 'Ana García', exact: true })
  const previous = { notes: await dialog.getByLabel('Notas', { exact: true }).inputValue(), allergies: await dialog.getByLabel('Alergias', { exact: true }).inputValue(), tags: await dialog.getByLabel('Etiquetas', { exact: true }).inputValue() }
  await dialog.getByLabel('Etiquetas', { exact: true }).fill('x'.repeat(31))
  await dialog.getByRole('button', { name: 'Guardar ficha', exact: true }).click()
  await dialog.getByText('Cada etiqueta, como mucho 30 caracteres.').waitFor()
  await dialog.getByLabel('Etiquetas', { exact: true }).fill('habitual, ventana')
  await dialog.getByLabel('Alergias', { exact: true }).fill('Frutos secos')
  await dialog.getByLabel('Notas', { exact: true }).fill(`Prefiere la ventana. Comprobado por ${role}.`)
  await dialog.getByRole('button', { name: 'Guardar ficha', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  const customer = (await db.collection('restaurants/demo-lumbre/customers').where('phone', '==', '+34600000000').get()).docs[0]
  const uid = role === 'encargado' ? 'lumbre-encargada' : `lumbre-${role}`
  assert.equal(customer.get('updatedBy'), uid)
  assert.deepEqual(customer.get('tags'), ['habitual', 'ventana'])
  assert.equal(customer.get('notes'), `Prefiere la ventana. Comprobado por ${role}.`)
  await abrirAna(p)
  assert.equal(await dialog.getByLabel('Notas', { exact: true }).inputValue(), `Prefiere la ventana. Comprobado por ${role}.`)
  await dialog.getByLabel('Notas', { exact: true }).fill(previous.notes)
  await dialog.getByLabel('Alergias', { exact: true }).fill(previous.allergies)
  await dialog.getByLabel('Etiquetas', { exact: true }).fill(previous.tags)
  await dialog.getByRole('button', { name: 'Guardar ficha', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  checked.push(`${role}: editar y volver a leer notas, alergias y etiquetas, validación y updatedBy`)
}
async function lista(p) {
  await goto(p, 'lista-espera')
  await main(p).getByText('Eva Martín', { exact: true }).waitFor()
  await main(p).getByText('Núria Vidal', { exact: true }).waitFor()
}
async function preview(p) {
  await p.getByLabel('Archivo de reservas (Excel o CSV)', { exact: true }).setInputFiles(xlsx)
  await main(p).getByText('Ana García', { exact: true }).filter({ visible: true }).waitFor()
}
async function importar(p, role) {
  console.log(`Comprobando importación: ${role}`)
  await goto(p, 'importar')
  const date = new Date(Date.now() + 7 * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' })
  const csv = `Nombre,Teléfono,Fecha,Hora,Personas\nPrueba ${role} ${testRun},+34698765432,${date},13:30,2\nFila a corregir,+34698765433,${date},13:30,0`
  await p.getByLabel('Archivo de reservas (Excel o CSV)', { exact: true }).setInputFiles({ name: 'comprobacion.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
  await main(p).getByText(`Prueba ${role} ${testRun}`, { exact: true }).filter({ visible: true }).waitFor()
  await p.getByRole('checkbox', { name: 'Ver solo las filas con errores' }).check()
  assert.equal(await main(p).getByText(`Prueba ${role} ${testRun}`, { exact: true }).filter({ visible: true }).count(), 0)
  await p.getByRole('checkbox', { name: 'Ver solo las filas con errores' }).uncheck()
  await p.getByRole('button', { name: 'Comprobar mesas y horas', exact: true }).click()
  await main(p).getByText('Hay sitio', { exact: true }).filter({ visible: true }).waitFor()
  await p.getByRole('button', { name: 'Importar 1 reserva', exact: true }).click()
  await main(p).getByRole('heading', { name: '1 reserva ya está aquí' }).waitFor()
  assert.ok(await p.getByRole('button', { name: 'Importar 0 reservas', exact: true }).isDisabled())
  const results = await db.collection('restaurants/demo-lumbre/locations/centro/reservations').where('guestName', '==', `Prueba ${role} ${testRun}`).get()
  assert.equal(results.size, 1)
  assert.equal(results.docs[0].get('source'), 'import')
  checked.push(`${role}: filtro de errores, comprobación de disponibilidad e importación real de una reserva sin repetir las creadas`)
}
async function run() {
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {})
  try {
    const { context, p } = await login(browser, 'propietario', { width: 1440, height: 900 })
    await editar(p, 'propietario')
    await clientes(p)
    await foto(p, 'clientes-escritorio')
    await p.getByRole('button', { name: 'Visitas, ordenar ascendente' }).click()
    assert.equal(await p.getByRole('columnheader', { name: /Visitas/ }).getAttribute('aria-sort'), 'descending')
    await p.getByRole('searchbox', { name: 'Buscar cliente' }).fill('+34600000000')
    await main(p).getByLabel('Abrir la ficha de Ana García', { exact: true }).filter({ visible: true }).waitFor()
    await main(p).getByLabel('Abrir la ficha de Ana García', { exact: true }).filter({ visible: true }).focus()
    await p.keyboard.press('Enter')
    await p.getByRole('dialog', { name: 'Ana García', exact: true }).waitFor()
    await p.getByRole('dialog').getByText('Ficha de cliente', { exact: true }).click()
    await p.getByRole('dialog').evaluate((el) => { el.scrollTop = 0 })
    await foto(p, 'ficha-escritorio')
    await p.keyboard.press('Escape')
    await p.getByRole('dialog').waitFor({ state: 'hidden' })
    checked.push('Clientes: ordenación por visitas, teléfono completo y apertura con Intro')
    await lista(p)
    await foto(p, 'lista-espera-escritorio')
    await p.getByRole('button', { name: 'Día siguiente', exact: true }).click()
    await main(p).getByText(/Nadie en la lista de espera/).waitFor()
    await foto(p, 'lista-espera-vacia')
    await p.getByRole('button', { name: 'Hoy', exact: true }).click()
    await main(p).getByText('Eva Martín', { exact: true }).waitFor()
    checked.push('Lista de espera: grupos por estado, oferta con plazo, día siguiente vacío y vuelta a hoy')
    await goto(p, 'importar')
    await foto(p, 'importar-escritorio')
    await preview(p)
    await foto(p, 'importar-xlsx-escritorio', true)
    await importar(p, 'propietario')
    await foto(p, 'importar-resultado-escritorio', true)
    await goto(p, 'muestra')
    await p.locator('#m-clientes').scrollIntoViewIfNeeded()
    await foto(p, 'muestra')
    await context.close()

    for (const role of ['encargado', 'camarero']) {
      const { context, p } = await login(browser, role, { width: 1440, height: 900 })
      await editar(p, role)
      await lista(p)
      if (role === 'encargado') await importar(p, role)
      else {
        await goto(p, 'importar')
        await main(p).getByText(/Tu rol no puede ver/).waitFor()
        assert.equal(await p.getByLabel('Archivo de reservas (Excel o CSV)').count(), 0)
        checked.push('Camarero: acceso a clientes y lista de espera, importación denegada también por URL directa')
      }
      await context.close()
    }

    for (const [name, viewport] of [['movil', { width: 390, height: 844 }], ['tableta', { width: 1180, height: 820 }]]) {
      const { context, p } = await login(browser, 'propietario', viewport, true)
      await clientes(p)
      await foto(p, `clientes-${name}`)
      if (name === 'movil') {
        const showMore = main(p).getByRole('button', { name: 'Ver más clientes', exact: true })
        await showMore.click()
        assert.ok(await main(p).getByRole('button', { name: /^Abrir la ficha/ }).count() > 25)
      }
      await abrirAna(p)
      await p.getByRole('dialog').getByText('Ficha de cliente', { exact: true }).click()
      await p.getByRole('dialog').evaluate((el) => { el.scrollTop = 0 })
      await foto(p, `ficha-${name}`)
      const dialog = p.getByRole('dialog', { name: 'Ana García', exact: true })
      assert.ok((await dialog.getByRole('button', { name: 'Guardar ficha' }).boundingBox()).height >= 48)
      assert.ok(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth))
      await dialog.getByRole('button', { name: 'Cerrar', exact: true }).click()
      await lista(p)
      await foto(p, `lista-espera-${name}`, true)
      await goto(p, 'importar')
      await foto(p, `importar-${name}`)
      await preview(p)
      await foto(p, `importar-xlsx-${name}`, true)
      if (name === 'movil') {
        const sizes = await main(p).locator('button:visible:not([role="checkbox"]), [data-slot="button"]:visible:not([role="checkbox"]), [data-slot="input-group"]:visible').evaluateAll((els) => els.map((el) => ({ text: el.getAttribute('aria-label') || el.textContent, height: el.getBoundingClientRect().height })).filter((x) => x.height < 44))
        assert.deepEqual(sizes, [], 'Controles táctiles de al menos 44 px')
        assert.ok((await p.locator('label[for="solo-errores"]').boundingBox()).height >= 44, 'La etiqueta amplía el área táctil de la casilla')
      }
      checked.push(`${name}: clientes, ficha, espera e importar a 2x, sin desbordes; ficha y controles táctiles verificados`)
      await context.close()
    }
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ checked, errors }, null, 2))
  } finally { await browser.close() }
}
run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
