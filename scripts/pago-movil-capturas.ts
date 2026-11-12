/** Navegador real, sin interceptar datos ni respuestas de las funciones. */
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
const require = createRequire(import.meta.url)
let playwright
try { playwright = require('playwright') } catch { playwright = require('/srv/LogiQD/llenamos/.claude/pw/node_modules/playwright') }
async function main() {
  const links = JSON.parse(readFileSync('/tmp/pago-movil-links.json', 'utf8'))
  const browser = await playwright.chromium.launch({ headless: true, executablePath: '/home/gery/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome', args: ['--no-sandbox'] })
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
  const page = await context.newPage(), failures: string[] = []
  page.on('pageerror', (e: Error) => failures.push(e.message))
  // Ninguna pantalla de esta prueba puede contactar con proveedores externos.
  await context.route('**/*', (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => {
    const u = new URL(route.request().url())
    return ['localhost', '127.0.0.1'].includes(u.hostname) ? route.continue() : route.abort()
  })
  const assert = (ok: boolean, message: string) => { if (!ok) throw new Error(message) }
  const capture = async (name: string) => {
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Desbordamiento horizontal en ${name}`)
    await page.mouse.move(1, 1)
    await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' })
    await page.screenshot({ path: `docs/diseno/capturas/pago-movil/${name}.png`, fullPage: true })
  }
  await page.goto('http://localhost:3015/entrar')
  await page.getByLabel('Correo', { exact: true }).fill('propietario@lumbre.test')
  await page.getByLabel('Contraseña', { exact: true }).fill('Llenamos2026!')
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
  await page.waitForURL('**/panel', { timeout: 30000 })
  await page.goto(`http://localhost:3015${links.payment}`)
  await page.getByText('El pago móvil no está configurado.', { exact: false }).waitFor()
  assert(await page.getByRole('button', { name: 'Continuar al pago' }).isDisabled(), 'Un pago sin clave debe estar deshabilitado.')
  await capture('cuenta-movil')
  await page.getByRole('button', { name: '5 %', exact: true }).click()
  await page.getByLabel('Quiero el recibo digital.', { exact: false }).check()
  await page.getByLabel('Correo para el recibo', { exact: false }).fill('cliente@example.test')
  await capture('propina-y-recibo-movil')
  await page.getByRole('radio', { name: 'Català' }).click()
  await page.getByText('Deixem propina?').waitFor()
  await capture('cuenta-catalan-movil')
  await page.getByRole('radio', { name: 'English' }).click()
  await page.getByText('Leave a tip?').waitFor()
  await capture('cuenta-ingles-movil')
  await page.goto(`http://localhost:3015${links.table}&lang=es`)
  await page.getByRole('heading', { name: '¿Qué parte vas a pagar?' }).waitFor()
  await page.getByText('Parte 1', { exact: true }).waitFor()
  await capture('partes-movil')
  await page.goto(`http://localhost:3015${links.receipt}&lang=es`)
  await page.getByText('Proveedor de prueba: no válido para Hacienda.').waitFor()
  await page.getByText('Correo guardado en modo local. No se ha enviado.').waitFor()
  await capture('recibo-movil')
  await page.getByRole('img', { name: 'QR tributario', exact: true }).screenshot({ path: '/tmp/pago-qr-real.png' })
  const body = await page.locator('body').innerText()
  assert(!/private-line|private-series|bill-mobile|part-1|cliente@example/.test(body), 'El recibo no debe mostrar datos internos o de otras personas.')
  await page.setViewportSize({ width: 1440, height: 900 })
  await capture('recibo-escritorio')
  await page.goto(`http://localhost:3015${links.payment}&lang=es`)
  await page.getByText('El pago móvil no está configurado.', { exact: false }).waitFor()
  await capture('cuenta-escritorio')
  await page.goto(`http://localhost:3015${links.payment.replace(/t=[^&]+/, 't=' + 'x'.repeat(43))}`)
  await page.getByText('No se puede consultar este enlace.', { exact: false }).waitFor()
  await page.setViewportSize({ width: 390, height: 844 })
  await capture('enlace-invalido-movil')
  assert(failures.length === 0, failures.join('\n'))
  writeFileSync('/tmp/pago-browser-result.json', JSON.stringify({ ok: true, pageErrors: failures, screenshots: 9, scale: 2, login: 'propietario@lumbre.test' }, null, 2))
  await browser.close()
  console.log('Navegador correcto: cuenta, propina, consentimiento, tres idiomas, partes, recibo, privacidad y enlace inválido. Capturas a 2x.')
}
void main().catch(e => { console.error(e); process.exit(1) })
