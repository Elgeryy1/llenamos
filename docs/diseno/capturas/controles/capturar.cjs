// Recorridos reales del agente 2 con Firebase local. Los borradores se descartan al acabar.
const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const base = 'http://localhost:3012'
const checks = []
const errors = []
const native = 'input[type="date"], input[type="time"], input[type="datetime-local"], select:not([aria-hidden="true"])'

async function photo(page, name) {
  await page.addStyleTag({ content: 'nextjs-portal { display:none; }' })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(200)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Sin desborde: ${name}`)
  // Radix conserva un select oculto para formularios. Nunca abre el selector del navegador.
  assert.equal(await page.locator(native).count(), 0, `Sin controles nativos visibles: ${name}`)
  const floating = await page.locator('[data-slot=popover-content], [data-slot=select-content]').evaluateAll(els => els.filter(e => e.checkVisibility()).map(e => { const r = e.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom } }))
  for (const rect of floating) assert.ok(rect.left >= -0.5 && rect.right <= page.viewportSize().width + 0.5 && rect.top >= -0.5 && rect.bottom <= page.viewportSize().height + 0.5, `Ventana dentro de la pantalla: ${name} ${JSON.stringify(rect)}`)
  await page.screenshot({ path: path.join(__dirname, `${name}.png`), animations: 'disabled' })
}
async function choose(page, label, month, day) {
  await page.getByRole('button', { name: new RegExp(`^${label}`) }).click()
  const dialog = page.getByRole('dialog')
  for (let i = 0; i < 12 && !await dialog.locator('.rdp-month_caption').filter({ hasText: month }).count(); i++) await dialog.getByRole('button', { name: 'Ir al mes siguiente', exact: true }).click()
  await dialog.getByRole('button', { name: new RegExp(`, ${day} de ${month.replace(' ', ' de ')}`) }).click()
  await dialog.waitFor({ state: 'hidden' })
}
async function touchTargets(page, locator, minimum) {
  await page.waitForTimeout(250)
  const sizes = await locator.evaluateAll(elements => elements.filter(e => !e.disabled && e.checkVisibility()).map(e => ({ label: e.getAttribute('aria-label') || e.textContent, width: e.getBoundingClientRect().width, height: e.getBoundingClientRect().height })))
  assert.ok(sizes.length)
  assert.deepEqual(sizes.filter(e => e.width < minimum - 0.1 || e.height < minimum - 0.1), [], `Objetivos de ${minimum} px`)
  return sizes
}
async function main() {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
  try {
    for (const [size, viewport] of Object.entries({ escritorio: { width: 1440, height: 900 }, tableta: { width: 1180, height: 820 }, movil: { width: 390, height: 844 } })) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: size === 'movil', hasTouch: size !== 'escritorio', timezoneId: 'Europe/Madrid' })
      const page = await context.newPage()
      page.on('pageerror', e => errors.push(e.message))
      await page.goto(base + '/entrar')
      await page.getByRole('button', { name: /Entrar como propietario con/ }).click()
      await page.waitForURL('**/panel')
      await page.goto(base + '/panel/horarios')
      await page.getByRole('button', { name: 'Fecha del día especial nuevo', exact: true }).waitFor()
      await page.getByRole('button', { name: 'Fecha del día especial nuevo', exact: true }).click()
      if (size !== 'escritorio') await touchTargets(page, page.getByRole('dialog').locator('button'), 44)
      await photo(page, `fecha-nueva-${size}`)
      await page.keyboard.press('Escape')
      await choose(page, 'Fecha del día especial nuevo', 'diciembre 2026', 24)
      await page.getByRole('button', { name: 'Añadir día especial', exact: true }).click()
      await page.getByLabel('Tipo del día 2026-12-24', { exact: true }).getByRole('radio', { name: 'Otro horario', exact: true }).click()
      await page.getByLabel('Nombre del turno 1 del 2026-12-24', { exact: true }).waitFor()
      await photo(page, `dia-especial-${size}`)
      await page.getByRole('button', { name: 'Descartar', exact: true }).click()

      await page.getByRole('button', { name: 'Añadir cierre', exact: true }).click()
      const last = page.getByRole('button', { name: /^Último día del cierre 1:/ })
      await last.click()
      const dialog = page.getByRole('dialog')
      const selected = dialog.locator('button[data-selected-single="true"]')
      await selected.focus()
      await page.keyboard.press('ArrowLeft')
      await page.keyboard.press('Enter')
      await dialog.waitFor({ state: 'hidden' })
      assert.equal(await last.getAttribute('aria-invalid'), 'true')
      assert.equal(await page.getByRole('button', { name: 'Guardar configuración', exact: true }).isDisabled(), true)
      await photo(page, `cierre-error-${size}`)
      await choose(page, 'Último día del cierre 1:', 'diciembre 2026', 31)
      assert.notEqual(await last.getAttribute('aria-invalid'), 'true')
      if (size === 'escritorio') {
        await page.getByRole('button', { name: 'Guardar configuración', exact: true }).click()
        await page.getByRole('region', { name: 'Cambios sin guardar' }).waitFor({ state: 'hidden' })
        await page.reload()
        await page.getByRole('button', { name: /^Último día del cierre 1:/ }).waitFor()
        assert.match(await page.getByRole('button', { name: /^Último día del cierre 1:/ }).textContent(), /31 de diciembre/)
        await page.getByRole('button', { name: 'Quitar el cierre 1', exact: true }).click()
        await page.getByRole('button', { name: 'Guardar configuración', exact: true }).click()
        await page.getByRole('region', { name: 'Cambios sin guardar' }).waitFor({ state: 'hidden' })
        await page.reload()
        await page.getByText('No hay cierres previstos.', { exact: true }).waitFor()
      } else await page.getByRole('button', { name: 'Descartar', exact: true }).click()
      checks.push(`${size}: fechas propias, día especial, cierre inválido bloquea guardar y objetivos táctiles del calendario`)

      await page.goto(base + '/panel/reservas')
      await page.getByRole('button', { name: /Nueva reserva/ }).first().click()
      await page.getByRole('radio', { name: 'Entra ahora', exact: true }).click()
      const hour = page.getByRole('combobox', { name: 'Hora', exact: true })
      await hour.click()
      const option = page.getByRole('option', { name: '03:15', exact: true })
      await option.scrollIntoViewIfNeeded()
      if (size !== 'escritorio') await touchTargets(page, page.getByRole('listbox').getByRole('option'), 44)
      await photo(page, `hora-fuera-turno-${size}`)
      await option.click()
      assert.match(await hour.textContent(), /03:15/)
      await photo(page, `hora-elegida-${size}`)
      await page.getByRole('button', { name: 'Cancelar', exact: true }).click()
      checks.push(`${size}: hora fuera de turno 03:15 seleccionada sin control nativo`)

      if (size !== 'tableta') {
        await page.goto(base + '/r/taberna-lumbre')
        await page.getByRole('button', { name: 'Otra fecha', exact: true }).click()
        const calendar = page.getByRole('dialog')
        if (size === 'movil') await touchTargets(page, calendar.locator('button'), 48)
        await photo(page, `publica-calendario-${size}`)
        await page.keyboard.press('Escape')
        const more = page.getByRole('combobox')
        await more.click()
        if (size === 'movil') await touchTargets(page, page.getByRole('listbox').getByRole('option'), 48)
        await photo(page, `publica-desplegable-${size}`)
        await page.keyboard.press('Escape')
        checks.push(`${size}: calendario y desplegable públicos propios, 48 px en móvil`)
      }
      await context.close()
    }
    assert.deepEqual(errors, [])
    fs.writeFileSync(path.join(__dirname, 'comprobaciones.json'), JSON.stringify({ checks, errors }, null, 2) + '\n')
    console.log(checks.join('\n'))
  } finally { await browser.close() }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
