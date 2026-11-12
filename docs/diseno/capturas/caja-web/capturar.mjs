import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
const require = createRequire(import.meta.url)
let playwright
try {
  playwright = require("playwright")
} catch {
  playwright = require("/srv/LogiQD/llenamos/.claude/pw/node_modules/playwright")
}
const directory = fileURLToPath(new URL(".", import.meta.url))
const browser = await playwright.chromium.launch({
  executablePath:
    "/home/gery/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome",
  headless: true,
  args: ["--no-sandbox"],
})
const errors = []
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  })
  const page = await context.newPage()
  page.on("pageerror", (e) => errors.push(e.message))
  await page.goto("http://localhost:3012/entrar")
  await page
    .getByRole("button", {
      name: "Entrar como propietario con propietario@lumbre.test",
    })
    .click()
  await page.waitForURL(/\/panel/)
  await page.goto("http://localhost:3012/panel/caja")
  await page.getByRole("heading", { name: "La caja del servicio" }).waitFor()
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" })
  await page
    .getByText("No se pueden leer las cuentas", { exact: true })
    .waitFor()
  await page.screenshot({
    path: `${directory}escritorio-cuentas.png`,
    fullPage: true,
    animations: "disabled",
  })
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  )
  if (overflow) throw new Error("La caja desborda en escritorio")
  await page.getByRole("combobox", { name: "Tipo de cuenta" }).click()
  await page.getByRole("option", { name: "Para llevar", exact: true }).click()
  await page.screenshot({
    path: `${directory}escritorio-para-llevar.png`,
    fullPage: true,
    animations: "disabled",
  })
  await page.getByRole("button", { name: "Caja y arqueo", exact: true }).click()
  await page.getByLabel("Identificador de la caja").fill("principal")
  await page.getByLabel("Fondo inicial contado (€)").fill("150,00")
  await page.screenshot({
    path: `${directory}escritorio-apertura.png`,
    fullPage: true,
    animations: "disabled",
  })
  await page.getByRole("button", { name: "Abrir caja con este fondo" }).click()
  await page.getByText("Operación sin confirmar", { exact: true }).waitFor()
  await page.screenshot({
    path: `${directory}escritorio-backend-ausente.png`,
    fullPage: true,
    animations: "disabled",
  })
  const savedBefore = await page.evaluate(
    () =>
      Object.entries(sessionStorage).find(([key]) =>
        key.startsWith("llenamos:caja:"),
      )?.[1],
  )
  if (!savedBefore) throw new Error("No se ha conservado la intención")
  await page.reload()
  await page.getByText("Operación sin confirmar", { exact: true }).waitFor()
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" })
  const savedAfter = await page.evaluate(
    () =>
      Object.entries(sessionStorage).find(([key]) =>
        key.startsWith("llenamos:caja:"),
      )?.[1],
  )
  if (savedBefore !== savedAfter)
    throw new Error("La intención ha cambiado al recargar")
  await page
    .getByRole("button", { name: "Recuperar la misma operación" })
    .click()
  await page
    .getByRole("button", { name: "Recuperar la misma operación" })
    .waitFor()
  const savedRetry = await page.evaluate(
    () =>
      Object.entries(sessionStorage).find(([key]) =>
        key.startsWith("llenamos:caja:"),
      )?.[1],
  )
  if (savedBefore !== savedRetry)
    throw new Error("El reintento ha generado otra intención")
  await page.getByRole("button", { name: "Historial", exact: true }).click()
  await page.screenshot({
    path: `${directory}escritorio-historial.png`,
    fullPage: true,
    animations: "disabled",
  })
  await context.close()
  for (const [name, width, height] of [
    ["tableta", 1180, 820],
    ["movil", 390, 844],
  ]) {
    const touch = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 2,
      isMobile: name === "movil",
      hasTouch: true,
    })
    const p = await touch.newPage()
    p.on("pageerror", (e) => errors.push(e.message))
    await p.goto("http://localhost:3012/entrar")
    await p
      .getByRole("button", {
        name: "Entrar como propietario con propietario@lumbre.test",
      })
      .click()
    await p.waitForURL(/\/panel/)
    await p.goto("http://localhost:3012/panel/caja")
    await p.getByRole("heading", { name: "La caja del servicio" }).waitFor()
    await p.addStyleTag({ content: "nextjs-portal { display: none !important; }" })
    await p
      .getByText("No se pueden leer las cuentas", { exact: true })
      .waitFor()
    if (
      await p.evaluate(() => document.documentElement.scrollWidth > innerWidth)
    )
      throw new Error(`La caja desborda en ${name}`)
    await p.screenshot({
      path: `${directory}${name}-cuentas.png`,
      fullPage: true,
    animations: "disabled",
    })
    await p.getByRole("combobox", { name: "Tipo de cuenta" }).click()
    await p.getByRole("option", { name: "Para llevar", exact: true }).waitFor()
    await p.screenshot({
      path: `${directory}${name}-desplegable.png`,
      fullPage: false,
      animations: "disabled",
    })
    await p.getByRole("option", { name: "Para llevar", exact: true }).click()
    await p.getByRole("button", { name: "Caja y arqueo", exact: true }).click()
    await p.getByLabel("Identificador de la caja").fill("principal")
    await p.getByLabel("Fondo inicial contado (€)").fill("150,00")
    await p.screenshot({
      path: `${directory}${name}-apertura.png`,
      fullPage: true,
    animations: "disabled",
    })
    await p.getByRole("button", { name: "Cuentas", exact: true }).click()
    await p.getByRole("combobox", { name: "Tipo de cuenta" }).click()
    await p.getByRole("option", { name: "Para llevar", exact: true }).click()
    const requested = p.waitForRequest((r) =>
      r.method() === "POST" && r.url().endsWith("/abrirCuenta"),
    )
    await p.getByRole("button", { name: /Cliente de prueba de caja/ }).click()
    const payload = (await requested).postDataJSON()
    if (payload.data.target.kind !== "takeaway" || !payload.data.requestId)
      throw new Error("La recogida no llama al contrato real de abrirCuenta")
    await p.getByText("Operación sin confirmar", { exact: true }).waitFor()
    await p.screenshot({
      path: `${directory}${name}-backend-ausente.png`,
      fullPage: true,
      animations: "disabled",
    })
    await touch.close()
  }
  const waiter = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  })
  const p = await waiter.newPage()
  p.on("pageerror", (e) => errors.push(e.message))
  await p.goto("http://localhost:3012/entrar")
  await p
    .getByRole("button", {
      name: "Entrar como camarero con camarero@lumbre.test",
    })
    .click()
  await p.waitForURL(/\/panel/)
  await p.goto("http://localhost:3012/panel/caja")
  await p.getByRole("heading", { name: "La caja del servicio" }).waitFor()
  await p.getByLabel("Referencia de la caja abierta").waitFor()
  await p.getByRole("button", { name: "Caja y arqueo", exact: true }).click()
  await p.getByText(/La apertura, el arqueo y el cierre los hace/).waitFor()
  if (
    await p.getByRole("button", { name: "Abrir caja con este fondo" }).count()
  )
    throw new Error("El camarero puede abrir caja desde la pantalla")
  await p.screenshot({
    path: `${directory}movil-permisos-camarero.png`,
    fullPage: true,
    animations: "disabled",
  })
  await waiter.close()
  if (errors.length) throw new Error(errors.join("\n"))
  console.log(
    "Capturas reales a 2x guardadas. Sin desbordamiento, sin errores de página, permisos y recuperación de intención comprobados.",
  )
} finally {
  await browser.close()
}
