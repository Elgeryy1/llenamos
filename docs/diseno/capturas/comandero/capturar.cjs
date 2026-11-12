// Capturas reales. No intercepta respuestas ni carga fichas de ejemplo.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright")
const path = require("node:path")
const assert = require("node:assert/strict")

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
    args: ["--no-sandbox"],
  })
  try {
    for (const [name, width, height] of [
      ["escritorio", 1440, 900],
      ["tableta", 1180, 820],
      ["movil", 390, 844],
    ]) {
      const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: 2,
      })
      const page = await context.newPage()
      const errors = []
      page.on("pageerror", (error) => errors.push(error.message))
      await page.goto("http://localhost:3011/entrar")
      await page
        .getByLabel("Correo", { exact: true })
        .fill(
          name === "movil" ? "camarero@lumbre.test" : "propietario@lumbre.test",
        )
      await page.getByLabel("Contraseña", { exact: true }).fill("Llenamos2026!")
      await page.getByRole("button", { name: "Entrar", exact: true }).click()
      await page.waitForURL("**/panel")
      for (const [route, heading] of [
        ["comandero", "Un pedido, pocos toques"],
        ["sala", "Sala en directo"],
        ["para-llevar", "Recogidas a su hora"],
      ]) {
        await page.goto(`http://localhost:3011/panel/${route}`)
        await page
          .getByRole("heading", { name: heading, exact: true })
          .waitFor()
        await page.getByRole("alert").first().waitFor()
        await page.screenshot({
          path: path.join(__dirname, `${route}-${name}.png`),
          fullPage: true,
          animations: "disabled",
        })
        assert.ok(
          await page.getByRole("alert").count(),
          "Se muestra el fallo real de lectura del backend de fase 2",
        )
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
          `Sin desbordamiento en ${route} ${name}`,
        )
      }
      await page.goto("http://localhost:3011/panel/comandero")
      await page
        .getByRole("button", { name: "Abrir mesa o sentar", exact: true })
        .click()
      await page.getByRole("button", { name: "S1 · 2", exact: true }).click()
      await page
        .getByRole("button", { name: "Abrir mesa", exact: true })
        .click()
      await page
        .getByText(
          /Puede que falte el servidor de esta función|Falta el servidor de esta función/,
        )
        .waitFor()
      await page.screenshot({
        path: path.join(__dirname, `falta-servidor-${name}.png`),
        fullPage: true,
        animations: "disabled",
      })
      assert.equal(errors.length, 0, errors.join("\n"))
      console.log(
        `${name}: capturas a 2x, apertura sin servidor y sin errores de React`,
      )
      await context.close()
    }
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
