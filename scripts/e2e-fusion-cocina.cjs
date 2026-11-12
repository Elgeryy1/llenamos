/* Comprueba la navegación fusionada con emuladores de la fila 4. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
let chromium
try { ({ chromium } = require('playwright')) } catch { ({ chromium } = require('/srv/LogiQD/llenamos/.claude/pw/node_modules/playwright')) }
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8099'
const { initializeApp } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')
const db = getFirestore(initializeApp({ projectId: 'demo-llenamos' }))
const out = path.resolve('docs/diseno/capturas/fusion-cocina')
async function main() {
  fs.mkdirSync(out, { recursive: true })
  const restaurant = db.doc('restaurants/demo-lumbre')
  const originalModules = (await restaurant.get()).get('activeModules')
  const browser = await chromium.launch({ executablePath: '/home/gery/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome', args: ['--no-sandbox'] })
  try {
    // Solo se habilita pos en la demo local para comprobar su entrada de menú.
    await restaurant.update({ activeModules: [...new Set([...originalModules, 'pos'])] })
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('http://localhost:3014/entrar')
    await page.getByRole('button', { name: /con propietario@lumbre.test$/ }).click()
    await page.waitForURL(/\/panel/)
    for (const name of ['Comandas', 'Caja', 'Disponibilidad']) await page.getByRole('link', { name, exact: true }).waitFor()
    for (const [route, name] of [['comandas', 'menu-comandas.png'], ['disponibilidad', 'menu-disponibilidad.png'], ['caja', 'menu-caja.png']]) {
      await page.getByRole('link', { name: ({ comandas: 'Comandas', disponibilidad: 'Disponibilidad', caja: 'Caja' })[route], exact: true }).click()
      await page.waitForURL(`**/panel/${route}`)
      await page.getByRole('heading', { name: ({ comandas: 'Todas las comandas del local', disponibilidad: 'Las raciones que quedan', caja: 'La caja del servicio' })[route], exact: true }).waitFor()
      if (route === 'comandas') await page.getByRole('heading', { name: /^\d+ comandas$/ }).waitFor()
      if (route === 'disponibilidad') await page.getByRole('textbox', { name: 'Raciones de Total de Patatas bravas', exact: true }).waitFor()
      await page.screenshot({ path: path.join(out, name), fullPage: true, style: 'nextjs-portal { display: none !important; }' })
    }
    assert.deepEqual(errors, [])
    console.log('Comandas, Disponibilidad y Caja conviven en el menú y abren sus páginas sin errores de navegador.')
  } finally {
    await browser.close()
    await restaurant.update({ activeModules: originalModules })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => db.terminate())
