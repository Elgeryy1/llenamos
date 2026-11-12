// Capturas reales. No se interceptan peticiones ni se inyectan datos de fase 2.
const assert = require('node:assert/strict')
const path = require('node:path')
const { createRequire } = require('node:module')
const requireTools = createRequire(
  path.resolve(
    process.env.PLAYWRIGHT_DIR || '/tmp/carta-tools',
    'package.json',
  ),
)
const { chromium } = requireTools('playwright')
const base = 'http://localhost:3015'
const token = 'a'.repeat(43) // Enlace de ejemplo para comprobar que falta la callable, no representa una mesa autenticada.
const directory = __dirname
async function photo(page, name) {
  await page.addStyleTag({ content: 'nextjs-portal { display: none; }' })
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({
    path: path.join(directory, name + '.png'),
    animations: 'disabled',
  })
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    'Desbordamiento horizontal',
  )
}
;(async () => {
  const browser = await chromium.launch({
    executablePath:
      process.env.CHROMIUM_PATH ||
      '/home/gery/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell',
    args: ['--no-sandbox'],
  })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    locale: 'es-ES',
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  try {
    await page.goto(base + '/entrar')
    await page.getByRole('button', { name: /Entrar como propietario/ }).click()
    await page.waitForURL('**/panel')
    await page.goto(base + '/panel/carta')
    await page
      .getByRole('heading', { name: 'Una carta a punto para el servicio' })
      .waitFor()
    await page.getByText(/El servidor aún no permite leer/).waitFor()
    await photo(page, 'carta-escritorio')
    await page.getByRole('button', { name: 'Nueva categoría' }).click()
    const form = page.locator('form')
    await form
      .getByRole('textbox', { name: 'Castellano', exact: true })
      .first()
      .fill('Para compartir')
    await form.getByRole('button', { name: 'Guardar cambios' }).click()
    await page
      .getByText('Falta el servidor de esta función: guardarCategoriaCarta.', {
        exact: true,
      })
      .waitFor()
    await photo(page, 'editor-servidor-pendiente')
    await page.getByRole('button', { name: 'Cerrar editor' }).click()
    await page.getByRole('button', { name: 'Nuevo plato', exact: true }).click()
    const itemForm = page.locator('form')
    await itemForm
      .getByRole('textbox', { name: 'Castellano', exact: true })
      .first()
      .fill('Croquetas de la casa')
    await itemForm
      .getByRole('textbox', { name: 'Catalán', exact: true })
      .first()
      .fill('Croquetes de la casa')
    await itemForm
      .getByRole('textbox', { name: 'Inglés', exact: true })
      .first()
      .fill('House croquettes')
    await itemForm
      .getByRole('heading', { name: 'Crear plato', exact: true })
      .scrollIntoViewIfNeeded()
    await photo(page, 'editor-plato-borrador')
    await page.goto(base + '/panel/configuracion-sala')
    await page
      .getByRole('heading', { name: 'El servicio, a tu manera' })
      .waitFor()
    await page.getByText(/Valores iniciales sin confirmar/).waitFor()
    await photo(page, 'configuracion-escritorio')
    await page.setViewportSize({ width: 1180, height: 820 })
    await page
      .getByRole('heading', { name: 'QR y etiquetas NFC de las mesas' })
      .scrollIntoViewIfNeeded()
    await page
      .getByRole('checkbox', { name: 'S1 · 2 plazas', exact: true })
      .check()
    await page
      .getByRole('checkbox', { name: /Entiendo que los códigos/ })
      .scrollIntoViewIfNeeded()
    await photo(page, 'qr-tableta')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(base + '/panel/carta')
    await page
      .getByRole('heading', { name: 'Una carta a punto para el servicio' })
      .waitFor()
    await page.getByText(/El servidor aún no permite leer/).waitFor()
    await photo(page, 'carta-movil')
    await page.goto(base + '/m/taberna-lumbre/centro/S1?t=' + token)
    await page
      .getByText('Falta el servidor de esta función: verMesaPublica.', {
        exact: true,
      })
      .waitFor()
    await photo(page, 'mesa-movil')
    await page.goto(base + '/r/taberna-lumbre/carta?local=centro')
    await page
      .getByText('No se puede consultar la carta.', { exact: false })
      .waitFor()
    await photo(page, 'carta-publica-movil')
    await page.goto(base + '/r/taberna-lumbre/para-llevar?local=centro')
    await page
      .getByText('Falta el servidor de esta función: consultarRecogida.', {
        exact: true,
      })
      .waitFor()
    await photo(page, 'para-llevar-movil')
    await page.goto(base + '/r/taberna-lumbre/para-llevar/ABC234?t=' + token)
    await page
      .getByText('Falta el servidor de esta función: verParaLlevarPublico.', {
        exact: true,
      })
      .waitFor()
    await photo(page, 'seguimiento-movil')
    await page.goto(
      base + '/r/taberna-lumbre/para-llevar/ABC234?t=' + token + '&lang=en',
    )
    await page
      .getByText('The server for this function is missing', { exact: true })
      .waitFor()
    await photo(page, 'seguimiento-movil-en')
    await page.setViewportSize({ width: 1180, height: 820 })
    await page.goto(base + '/r/taberna-lumbre/para-llevar?local=centro&lang=ca')
    await page
      .getByText('Falta el servidor de esta función: consultarRecogida.', {
        exact: true,
      })
      .waitFor()
    await photo(page, 'para-llevar-tableta-ca')
    assert.deepEqual(errors, [], 'Errores de página')
    console.log(
      'Capturas reales a 2x guardadas. Sin errores de página ni desbordamientos.',
    )
  } catch (error) {
    await page.screenshot({ path: '/tmp/carta-captura-error.png' })
    console.log(await page.locator('body').innerText())
    throw error
  } finally {
    await browser.close()
  }
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
