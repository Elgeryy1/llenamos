// Recorrido real de Z1, solo contra los emuladores de la fila 1.
const assert = require('node:assert/strict')
const path = require('node:path')
const { chromium } = require('playwright')
const base = 'http://localhost:3011'
const errors = []
const screens = [
  ['inicio', '/panel', /mesas listas|Hola/],
  ['ajustes', '/panel/ajustes', 'La identidad de tu restaurante'],
  ['equipo', '/panel/equipo', /personas en el equipo/],
  ['actividad', '/panel/actividad', 'Cada cambio tiene su historia'],
  ['mensajes', '/panel/mensajes', /mensajes|mensaje/],
]
async function photo(page, name, fullPage = true) {
  await page.addStyleTag({content:'nextjs-portal { display: none; }'})
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(400)
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Desborde en ${name}`)
  await page.screenshot({path:path.join(__dirname,`${name}.png`),fullPage,animations:'disabled'})
}
async function login(page, role='propietario', email) {
  await page.goto(base+'/entrar')
  const button = page.getByRole('button',{name:email ? `Entrar como ${role} con ${email}` : new RegExp(`Entrar como ${role}`)}).first()
  await button.click()
  await page.waitForURL('**/panel')
  await page.getByRole('heading',{level:1}).waitFor()
}
async function open(page, route, heading) {
  await page.goto(base+route)
  await page.getByRole('heading',{level:1,name:heading}).waitFor()
  await page.waitForTimeout(500)
}
async function main() {
 const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH} : {})
 try {
  for(const [kind,width,height,touch] of [['escritorio',1440,900,false],['movil',390,844,true],['tableta',1180,820,true]]) {
   const context = await browser.newContext({viewport:{width,height},deviceScaleFactor:2,isMobile:kind==='movil',hasTouch:touch,timezoneId:'Europe/Madrid'})
   const page=await context.newPage()
   page.setDefaultTimeout(20000)
   page.on('pageerror',e=>errors.push(e.message))
   await page.goto(base+'/entrar')
   await page.getByRole('heading',{name:'Entrar al panel'}).waitFor()
   if(kind!=='tableta') await photo(page,`entrar-${kind}`)
   await login(page)
   for(const [name,route,heading] of screens) {
    if(kind==='tableta' && !['inicio','equipo'].includes(name)) continue
    await open(page,route,heading)
    await photo(page,`${name}-${kind}`)
    if(name==='equipo' && kind!=='tableta') {
     await page.getByRole('button',{name:'Invitar',exact:true}).click()
     await page.getByRole('dialog').waitFor()
     await photo(page,`equipo-invitar-${kind}`)
     await page.keyboard.press('Escape')
    }
    if(name==='mensajes') {
     const row=page.getByRole('button',{name:/Abrir .* para/}).first()
     await row.waitFor()
     await row.click()
     await page.getByRole('dialog').waitFor()
     await photo(page,`mensaje-detalle-${kind}`)
     await page.keyboard.press('Escape')
    }
   }
   if(kind!=='tableta') {
    if(kind==='escritorio') {
     await open(page,'/panel/muestra','Muestra de componentes')
     await photo(page,'muestra-panel-general',false)
    }
    await page.goto(base+'/logiqd')
    await page.getByText('Esta página es solo para el equipo de LogiQD',{exact:true}).waitFor()
    await photo(page,`logiqd-sin-acceso-${kind}`)
    await page.getByRole('button',{name:'Salir',exact:true}).click()
    await page.waitForURL('**/entrar')
    await page.getByLabel('Correo',{exact:true}).fill('equipo@logiqd.test')
    await page.getByLabel('Contraseña',{exact:true}).fill('Llenamos2026!')
    await page.getByRole('button',{name:'Entrar',exact:true}).click()
    await page.waitForURL('**/panel')
    await page.goto(base+'/logiqd')
    await page.getByRole('heading',{name:'1 restaurante en Llenamos'}).waitFor()
    await photo(page,`logiqd-${kind}`)
    await page.getByRole('button',{name:'Cambiar plan',exact:true}).locator('visible=true').click()
    await page.getByRole('dialog').waitFor()
    await photo(page,`logiqd-plan-${kind}`)
    await page.keyboard.press('Escape')
   }
   await context.close()
  }
  for(const [role,email] of [['encargado','encargada@lumbre.test'],['camarero','camarero@lumbre.test']]) {
   const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true,timezoneId:'Europe/Madrid'})
   const page=await context.newPage()
   await login(page,role,email)
   await page.getByRole('heading',{level:1,name:/mesas listas/}).waitFor()
   await photo(page,`inicio-${role}-movil`)
   if(role==='encargado') {
    await open(page,'/panel/equipo',/personas en el equipo/)
    await photo(page,'equipo-encargado-movil')
   } else {
    await page.goto(base+'/panel/ajustes')
    await page.getByText('Tu rol no puede ver los ajustes',{exact:true}).waitFor()
    await photo(page,'ajustes-camarero-sin-acceso-movil')
   }
   await context.close()
  }
  assert.deepEqual(errors,[],'Errores de ejecución')
  console.log('Capturas Z1 completas, sin desbordes ni errores de ejecución.')
 } finally { await browser.close() }
}
main().catch(e=>{console.error(e);process.exitCode=1})
