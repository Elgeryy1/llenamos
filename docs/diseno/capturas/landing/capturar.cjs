// Revisión de las capturas reales en la web de venta, sin servicios externos.
const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

async function main() {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
  const checks = []
  try {
    for (const [size, viewport] of Object.entries({ escritorio: { width: 1440, height: 900 }, movil: { width: 390, height: 844 } })) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: size === 'movil', hasTouch: size === 'movil', reducedMotion: 'reduce' })
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', e => errors.push(e.message))
      await page.goto('http://localhost:5192')
      const figures = page.locator('figure').filter({ has: page.locator('img[src^="/capturas/"]') })
      assert.equal(await figures.count(), 3)
      for (let i = 0; i < 3; i++) {
        const figure = figures.nth(i)
        await figure.scrollIntoViewIfNeeded()
        await figure.locator('img').evaluate(img => img.decode())
        const data = await figure.evaluate(el => {
          const img = el.querySelector('img'), rect = img.getBoundingClientRect()
          return { caption: el.querySelector('figcaption').textContent, alt: img.alt, width: img.naturalWidth, height: img.naturalHeight, declaredWidth: img.width, expectedWidth: Number(img.getAttribute('width')), expectedHeight: Number(img.getAttribute('height')), left: rect.left, right: rect.right }
        })
        assert.match(data.caption, /Captura/)
        assert.doesNotMatch(data.caption, /Ilustración/)
        assert.ok(data.alt.length > 50)
        assert.equal(data.width, data.expectedWidth)
        assert.equal(data.height, data.expectedHeight)
        assert.ok(data.left >= -0.5 && data.right <= viewport.width + 0.5)
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
        await page.waitForTimeout(200)
        await page.screenshot({ path: path.join(__dirname, `${['sala', 'movil', 'reservas'][i]}-${size}.png`), animations: 'disabled' })
        checks.push({ size, capture: ['sala', 'movil', 'reservas'][i], ...data })
      }
      assert.deepEqual(errors, [])
      await context.close()
    }
    fs.writeFileSync(path.join(__dirname, 'comprobaciones.json'), JSON.stringify(checks, null, 2) + '\n')
    console.log('6 vistas: imágenes cargadas, dimensiones reales, textos Captura y sin desbordes.')
  } finally { await browser.close() }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
