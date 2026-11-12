import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'

// Playwright ya instalado por el coordinador; no añade dependencias al proyecto.
const require = createRequire(import.meta.url)
let playwright: typeof import('/srv/LogiQD/llenamos/.claude/pw/node_modules/playwright')
try { playwright = require('playwright') } catch { playwright = require('/srv/LogiQD/llenamos/.claude/pw/node_modules/playwright') }
async function main() {
const browser = await playwright.chromium.launch({ headless:true,executablePath:'/home/gery/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome',args:['--no-sandbox'] })
let context = await browser.newContext({ viewport:{ width:1440,height:1000 },deviceScaleFactor:2 })
let page = await context.newPage()
const errors: string[] = []
page.setDefaultTimeout(20000)
page.on('pageerror',error => errors.push(error.message))
const capture = async (name: string) => { await page.evaluate(() => window.scrollTo(0,0)); await page.waitForTimeout(150); await page.screenshot({ path:`docs/diseno/capturas/alta-billing/${name}.png`,fullPage:true }) }
try {
  await page.goto('http://localhost:3014/alta')
  await page.getByRole('heading',{ name:'Prepara tu restaurante a tu ritmo' }).waitFor()
  await capture('01-acceso')
  await page.getByRole('link',{ name:'Ya tengo un restaurante' }).click()
  await page.waitForURL('**/entrar')
  await page.getByRole('heading',{ name:'Entrar al panel' }).waitFor()
  await page.getByRole('textbox',{ name:'Correo',exact:true }).fill('propietario@lumbre.test')
  await page.locator('input[name="password"]').fill('Llenamos2026!')
  await page.getByRole('button',{ name:'Entrar',exact:true }).click()
  await page.waitForURL('**/panel')
  await page.getByRole('button',{ name:/Restaurante y local/ }).first().waitFor({ timeout:30000 })
  await context.close()
  context = await browser.newContext({ viewport:{ width:1440,height:1000 },deviceScaleFactor:2 })
  page = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror',error => errors.push(error.message))
  await page.goto('http://localhost:3014/alta')
  await page.getByLabel('Correo electrónico').fill(`alta-${Date.now()}@prueba.test`)
  await page.getByLabel('Contraseña',{ exact:true }).fill('Llenamos2026!')
  await page.getByRole('button',{ name:'Crear acceso y empezar' }).click()
  await page.getByRole('heading',{ name:'Vamos a llenar tu sala' }).waitFor()
  const slug = `casa-brasa-${Date.now()}`
  await page.getByLabel('Nombre del restaurante',{ exact:true }).fill('Casa Brasa')
  await page.getByLabel('Dirección de tu página de reservas').fill(slug)
  await page.getByRole('button',{ name:'Guardar y continuar' }).click()
  await page.getByRole('heading',{ name:'Dónde recibirás a tus clientes' }).waitFor()
  await page.getByLabel('Nombre del local').fill('El comedor')
  await page.getByLabel('Dirección',{ exact:true }).fill('Calle de la Brasa 4')
  await page.getByLabel('Ciudad').fill('Barcelona')
  await page.getByLabel('Teléfono de contacto').fill('600123456')
  await page.getByRole('button',{ name:'Guardar y continuar' }).click()
  await page.getByRole('heading',{ name:'Haz sitio para tu primer servicio' }).waitFor()
  await page.getByLabel('Número de mesas').fill('8')
  await capture('02-plano')
  await page.reload()
  await page.getByRole('heading',{ name:'Haz sitio para tu primer servicio' }).waitFor()
  assert.equal(await page.getByLabel('Número de mesas').inputValue(),'8')
  await page.getByRole('button',{ name:'Guardar y continuar' }).click()
  await page.getByRole('heading',{ name:'Cuándo abrís las puertas' }).waitFor()
  await page.getByRole('checkbox',{ name:/Lunes/ }).uncheck()
  await capture('03-horarios')
  await page.getByRole('button',{ name:'Guardar y continuar' }).click()
  await page.getByRole('heading',{ name:'Un primer vistazo a tu carta' }).waitFor()
  await page.getByRole('button',{ name:'Añadir plato' }).click()
  await page.getByLabel('Plato 1').fill('Patatas de la casa')
  await page.getByLabel('Precio en céntimos').fill('650')
  await page.getByRole('button',{ name:'Guardar y continuar' }).click()
  await page.getByRole('heading',{ name:'Empieza sin tarjeta' }).waitFor()
  await capture('04-prueba')
  await page.getByRole('button',{ name:'Guardar y continuar' }).click()
  await page.getByRole('heading',{ name:'Revisa y abre tu restaurante' }).waitFor()
  await page.getByRole('checkbox').check()
  await capture('05-revision')
  // Pierde la respuesta después de que el servidor haya completado el alta.
  let dropped = false
  await page.route('**/completarAlta',async route => {
    if (route.request().method()==='POST' && !dropped) { dropped = true; await route.fetch(); await route.abort('failed') } else await route.continue()
  })
  await page.getByRole('button',{ name:'Crear mi restaurante' }).click()
  await page.getByRole('button',{ name:'Reintentar la misma operación' }).waitFor({ timeout:30000 })
  await page.reload()
  await page.getByRole('button',{ name:'Reintentar la misma operación' }).waitFor()
  await page.getByRole('button',{ name:'Reintentar la misma operación' }).click()
  await page.getByRole('heading',{ name:'Tu restaurante ya está preparado' }).waitFor({ timeout:30000 })
  await capture('06-restaurante-creado')
  assert.equal(dropped,true)
  await page.getByRole('link',{ name:/Entrar en mi restaurante/ }).click()
  await page.waitForURL('**/panel')
  // El selector de restaurante conserva la demo. La ruta se comprueba con la cuenta del alta en su contexto.
  await page.goto('http://localhost:3014/panel/planes')
  await page.waitForTimeout(1200)
  // Selecciona el restaurante recién creado mediante el selector existente si la demo está activa.
  const switcher = page.getByRole('button',{ name:/Restaurante y local: Taberna Lumbre/ }).first()
  if (await switcher.count()) { await switcher.click(); const chosen = page.getByRole('menuitem').filter({ hasText:'Casa Brasa' }).first(); if (await chosen.count()) await chosen.click() }
  await page.getByRole('heading',{ name:'Prueba gratuita',exact:true }).waitFor({ timeout:30000 })
  await page.getByRole('button',{ name:'Continuar con el plan elegido' }).click()
  await page.getByText('La facturación de la suscripción no está configurada. No se ha realizado ningún cargo.',{ exact:true }).waitFor()
  await capture('07-planes-sin-claves')
  await page.setViewportSize({ width:390,height:844 })
  await capture('08-planes-movil')
  assert.deepEqual(errors,[])
  writeFileSync('docs/diseno/capturas/alta-billing/resultado.json',JSON.stringify({ slug,deviceScaleFactor:2,responseLostRecovered:true,browserErrors:errors },null,2)+'\n')
  console.log('Alta, recarga, respuesta perdida recuperada y Billing sin claves comprobados en Chromium.')
} catch (error) { console.error(await page.locator('body').innerText()); throw error } finally { await browser.close() }

}
void main().catch(error => { console.error(error); process.exitCode = 1 })
