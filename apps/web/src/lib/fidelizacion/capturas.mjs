/** Recorrido local y capturas a 2x. Ejecutar desde la raíz, con los emuladores de la fila 2. */
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

const require = createRequire(import.meta.url)
let playwright
try { playwright = require("playwright") } catch { playwright = require("/srv/LogiQD/llenamos/.claude/pw/node_modules/playwright") }
const destino = path.resolve("docs/diseno/capturas/fase5-fidelizacion")
await mkdir(destino, { recursive: true })
const browser = await playwright.chromium.launch({ executablePath: "/home/gery/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome", headless: true })
const errores = []
const resultados = []
const base = "http://localhost:3012"

async function entrar(page, correo) {
  await page.goto(`${base}/entrar`)
  await page.getByLabel("Correo", { exact: true }).fill(correo)
  await page.getByLabel("Contraseña", { exact: true }).fill("Llenamos2026!")
  await page.getByRole("button", { name: "Entrar", exact: true }).click()
  await page.waitForURL("**/panel")
}
async function comprobarAncho(page, nombre) {
  const medidas = await page.evaluate(() => ({ ancho: document.documentElement.clientWidth, contenido: document.documentElement.scrollWidth }))
  assert(medidas.contenido <= medidas.ancho + 1, `Desbordamiento en ${nombre}: ${JSON.stringify(medidas)}`)
}
async function capturar(page, nombre) {
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" })
  await page.evaluate(async () => { window.scrollTo(0, 0); await document.fonts.ready; await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))) })
  await comprobarAncho(page, nombre)
  await page.screenshot({ path: path.join(destino, `${nombre}.png`), fullPage: true, animations: "disabled" })
  resultados.push(nombre)
}
try {
  for (const [nombre, width, height, tactil] of [["escritorio", 1440, 900, false], ["tableta", 1180, 820, true], ["movil", 390, 844, true]]) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, hasTouch: tactil })
    const page = await context.newPage()
    page.on("pageerror", (e) => errores.push(`${nombre}: ${e.message}`))
    await entrar(page, "propietario@lumbre.test")
    await page.goto(`${base}/panel/fidelizacion/demo`)
    await page.getByRole("heading", { name: "Últimos movimientos", exact: true }).waitFor()
    await capturar(page, `${nombre}-cliente-cuenta`)
    await page.getByRole("button", { name: "Aplicar Las noches del jueves" }).click()
    await page.getByText(/Falta el backend para confirmar/).waitFor()
    assert.equal(await page.getByText(/Promoción confirmada/).count(), 0)
    await capturar(page, `${nombre}-sin-backend`)
    await page.getByRole("button", { name: "Programa", exact: true }).click()
    await page.getByRole("heading", { name: "Cómo se ganan los puntos" }).waitFor()
    await capturar(page, `${nombre}-programa`)
    await page.getByRole("button", { name: "Promociones", exact: true }).click()
    await page.getByRole("button", { name: "Editar Las noches del jueves" }).click()
    await page.getByLabel("Nombre de la promoción").waitFor()
    await capturar(page, `${nombre}-promociones-editor`)
    await page.getByRole("button", { name: "Repite", exact: true }).click()
    await page.getByRole("button", { name: "Consultar informe" }).click()
    await page.getByText("Repite no está conectado. Esta vista usa datos de ejemplo.").waitFor()
    await capturar(page, `${nombre}-repite`)
    // Lectura real: las reglas de fase 5 aún no existen en este worktree.
    await page.goto(`${base}/panel/fidelizacion`)
    await page.getByText(/Faltan las reglas de fidelización/).waitFor()
    await capturar(page, `${nombre}-ruta-real`)
    await context.close()
  }
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true })
  const page = await context.newPage()
  page.on("pageerror", (e) => errores.push(`camarero: ${e.message}`))
  await entrar(page, "camarero@lumbre.test")
  await page.goto(`${base}/panel/fidelizacion/demo`)
  await page.getByRole("heading", { name: "Últimos movimientos", exact: true }).waitFor()
  assert.equal(await page.getByRole("button", { name: "Programa", exact: true }).count(), 0)
  assert.equal(await page.getByRole("link", { name: "Programa y premios", exact: true }).count(), 0)
  await page.getByRole("button", { name: "Canjear Cinco euros para volver" }).click()
  await page.getByText(/Falta el backend para confirmar/).waitFor()
  assert.equal(await page.getByText(/Canje confirmado/).count(), 0)
  await capturar(page, "movil-camarero")
  await page.goto(`${base}/panel/fidelizacion/promociones`)
  await page.getByText("Esta pantalla no está disponible para tu acceso").waitFor()
  assert.equal(await page.getByRole("button", { name: "Nueva promoción" }).count(), 0)
  await context.close()
  assert.deepEqual(errores, [], "Errores de ejecución en el navegador")
  await writeFile(path.join(destino, "resultado.json"), JSON.stringify({ proyecto: "demo-llenamos", puertos: { auth: 9103, firestore: 8097, functions: 5013, web: 3012 }, escala: 2, capturas: resultados, errores, backendFase5: "Pendiente de integración. No se han simulado mutaciones correctas." }, null, 2) + "\n")
  console.log(`${resultados.length} capturas a 2x. Sin desbordamientos ni errores de página.`)
} finally {
  await browser.close()
}
