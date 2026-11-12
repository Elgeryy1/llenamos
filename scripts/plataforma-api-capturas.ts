/** Recorrido real con Firebase emulado. El socket evita ocupar un puerto ajeno ya abierto. */
import { request as httpRequest } from 'node:http'
import { mkdir } from 'node:fs/promises'
import type { BrowserContext, Page } from '/srv/LogiQD/llenamos/.claude/pw/node_modules/playwright'
const { chromium }: typeof import('/srv/LogiQD/llenamos/.claude/pw/node_modules/playwright') = require('/srv/LogiQD/llenamos/.claude/pw/node_modules/playwright')
const origin = process.env.PANEL_API_ORIGIN ?? 'http://localhost:3012', out = 'docs/diseno/capturas/panel-api'
async function proxy(context: BrowserContext) {
  if (!process.env.PANEL_API_SOCKET) return
  await context.route(`${origin}/**`, async route => {
    const request = route.request(), url = new URL(request.url())
    const result = await new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((resolve, reject) => {
      const headers = { ...request.headers(), host: '127.0.0.1:3012', 'accept-encoding': 'identity' }
      const req = httpRequest({ socketPath: process.env.PANEL_API_SOCKET, path: url.pathname + url.search, method: request.method(), headers }, res => {
        const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
          const responseHeaders: Record<string, string> = {}
          for (const [key, value] of Object.entries(res.headers)) if (value !== undefined && !['transfer-encoding', 'connection'].includes(key)) responseHeaders[key] = Array.isArray(value) ? value.join(', ') : value
          resolve({ status: res.statusCode ?? 500, headers: responseHeaders, body: Buffer.concat(chunks) })
        })
      }); req.on('error', reject); req.end(request.postDataBuffer())
    })
    await route.fulfill(result)
  })
}
async function login(page: Page, email: string) {
  await page.goto(`${origin}/entrar`)
  await page.getByLabel('Correo', { exact: true }).fill(email)
  await page.getByLabel('Contraseña', { exact: true }).fill('Llenamos2026!')
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
  await page.waitForURL(url => !url.pathname.startsWith('/entrar'))
}
async function main() {
  await mkdir(out, { recursive: true })
  const browser = await chromium.launch({ executablePath: '/home/gery/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome', args: ['--no-sandbox'] })
  try {
    const team = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 }); await proxy(team)
    const page = await team.newPage(); page.setDefaultTimeout(30_000)
    await login(page, 'equipo@logiqd.test')
    await page.goto(`${origin}/logiqd`)
    await page.getByRole('heading', { name: 'Restaurantes y continuidad' }).waitFor()
    await page.getByRole('button', { name: 'Revisar restaurante' }).first().waitFor()
    await page.screenshot({ path: `${out}/logiqd-escritorio.png`, fullPage: true })
    await page.getByRole('button', { name: 'Revisar restaurante' }).first().click()
    await page.getByLabel('Motivo del cambio o del soporte').fill('Comprobar la configuración de la integración local')
    await page.getByRole('button', { name: 'Abrir acceso de soporte' }).click()
    await page.getByText(/Acceso registrado hasta/).waitFor()
    await page.screenshot({ path: `${out}/soporte-escritorio.png`, fullPage: true })
    await team.close()
    const owner = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 }); await proxy(owner)
    const panel = await owner.newPage(); panel.setDefaultTimeout(30_000)
    await login(panel, 'propietario@lumbre.test')
    await panel.goto(`${origin}/panel/integraciones`)
    await panel.getByRole('heading', { name: 'API y webhooks' }).waitFor()
    await panel.getByLabel('Nombre de la aplicación').fill('Aplicación de prueba del restaurante')
    await panel.getByRole('button', { name: 'Crear clave', exact: true }).click()
    await panel.getByText('Guarda este secreto ahora', { exact: true }).waitFor()
    const secret = await panel.locator('code').filter({ hasText: /^[A-Za-z0-9_-]{43}$/ }).textContent()
    if (!secret) throw new Error('La clave no se ha mostrado una vez.')
    const apiUrl = 'http://127.0.0.1:5013/demo-llenamos/europe-west1/plataformaApi/v1/restaurants/demo-lumbre/locations/centro/menu'
    const response = await fetch(apiUrl, { headers: { Authorization: `Bearer ${secret}` } })
    if (response.status !== 200) throw new Error(`La ruta HTTP de carta devuelve ${response.status}: ${await response.text()}`)
    await panel.getByRole('button', { name: 'Ocultar', exact: true }).click()
    await panel.screenshot({ path: `${out}/integraciones-escritorio.png`, fullPage: true })
    await panel.setViewportSize({ width: 1180, height: 820 }); await panel.screenshot({ path: `${out}/integraciones-tableta.png`, fullPage: true })
    await panel.setViewportSize({ width: 390, height: 844 }); await panel.screenshot({ path: `${out}/integraciones-movil.png`, fullPage: true })
    // El orden del listado no es el de creación: se revoca la clave por su prefijo visible.
    const row = panel.getByRole('listitem').filter({ hasText: `${secret.slice(0, 8)}…` })
    await row.getByRole('button', { name: 'Revocar', exact: true }).click()
    await row.getByText('Revocada', { exact: false }).waitFor()
    const revoked = await fetch(apiUrl, { headers: { Authorization: `Bearer ${secret}` } })
    if (revoked.status !== 401) throw new Error('Una clave revocada sigue teniendo acceso.')
    await panel.goto(`${origin}/logiqd`)
    await panel.getByText('Esta página es solo para el equipo de LogiQD', { exact: true }).waitFor()
    await panel.screenshot({ path: `${out}/logiqd-denegado-movil.png`, fullPage: true })
    await owner.close()
    console.log('Navegador real: claim, soporte temporal, clave, HTTP carta, revocación y vistas a 2x verificados.')
  } finally { await browser.close() }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
