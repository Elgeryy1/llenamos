// Capturas reales de la fila 4. No se intercepta ninguna respuesta ni se inyectan pedidos.
const assert = require('node:assert/strict')
const path = require('node:path')
const { chromium } = require('playwright')
const origin = 'http://localhost:3014'
const failures = []

async function login(context, account) {
  const page = await context.newPage()
  page.on('pageerror', (error) => failures.push(error.message))
  await page.goto(`${origin}/entrar`)
  await page.getByLabel('Correo', { exact: true }).fill(`${account}@lumbre.test`)
  await page.getByLabel('Contraseña', { exact: true }).fill('Llenamos2026!')
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
  await page.waitForURL('**/panel')
  return page
}

async function capture(page, route, filename) {
  await page.goto(`${origin}/panel/${route}`)
  await page.getByText('No se puede abrir la estación', { exact: true }).waitFor()
  await page.getByText(/falta el servidor de esta función/).waitFor()
  assert.equal(await page.locator('select').count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Listo', exact: true }).count(), 0)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'La página cabe sin desplazamiento horizontal')
  await page.addStyleTag({ content: 'nextjs-portal { display: none; }' })
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: path.join(__dirname, `${filename}.png`), animations: 'disabled' })
  await page.getByRole('button', { name: 'Volver a comprobar', exact: true }).click()
  await page.getByText(/falta el servidor de esta función/).waitFor()
}

async function main() {
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {})
  try {
    for (const [size, viewport, touch] of [['escritorio', { width: 1440, height: 900 }, false], ['tableta', { width: 1180, height: 820 }, true], ['movil', { width: 390, height: 844 }, true]]) {
      for (const account of ['cocina', 'barra']) {
        const context = await browser.newContext({ viewport, deviceScaleFactor: 2, hasTouch: touch, timezoneId: 'Europe/Madrid' })
        const page = await login(context, account)
        await capture(page, account, `${account}-${size}`)
        // Acceso cruzado: la pantalla no abre listeners de la otra estación.
        await page.goto(`${origin}/panel/${account === 'cocina' ? 'barra' : 'cocina'}`)
        await page.getByText('No tienes acceso a esta estación', { exact: true }).waitFor()
        await context.close()
      }
    }
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
    const page = await login(context, 'propietario')
    await page.goto(`${origin}/panel/cocina`)
    await page.getByText(/falta el servidor de esta función/).waitFor()
    await page.goto(`${origin}/panel/barra`)
    await page.getByText(/falta el servidor de esta función/).waitFor()
    assert.deepEqual(failures, [], 'Sin errores de ejecución en el navegador')
    console.log('6 capturas a 2x. Roles propios, acceso cruzado, propietario, reintento y ancho comprobados. Sin datos ni respuestas simulados.')
  } finally { await browser.close() }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
