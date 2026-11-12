/**
 * Imágenes del README (docs/readme/*.png): capturas reales de la web contra los emuladores,
 * montadas en marcos con el fondo de la marca. Así se pueden rehacer cuando cambien las pantallas.
 *
 * Preparación: emuladores y web en marcha, con los datos de demostración cargados
 *   pnpm seed && pnpm seed:servicio && pnpm seed:caja && tsx scripts/seed-fase4.ts && tsx scripts/seed-fase5.ts
 * Ejecución:
 *   tsx scripts/readme-imagenes.ts            # capturas y montaje
 *   tsx scripts/readme-imagenes.ts montar     # solo montaje, con las capturas ya hechas
 *
 * Variables opcionales: README_WEB (por defecto http://localhost:3000) y README_CAPTURAS
 * (carpeta de las capturas sueltas, por defecto docs/readme/capturas).
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let playwright: any
try { playwright = require('playwright') } catch { playwright = require('/srv/LogiQD/llenamos/.claude/pw/node_modules/playwright') }

// El Chromium del equipo de desarrollo, si está; si no, el que traiga Playwright.
const CHROME = '/home/gery/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome'
const lanzar = () => playwright.chromium.launch(existsSync(CHROME) ? { executablePath: CHROME } : {})

const WEB = process.env.README_WEB ?? 'http://localhost:3000'
const CAPTURAS = resolve(process.env.README_CAPTURAS ?? 'docs/readme/capturas')
const SALIDA = resolve('docs/readme')
const CLAVE = 'Llenamos2026!'
const SOLO_MONTAR = process.argv[2] === 'montar'

const ESCRITORIO = { width: 1440, height: 900 }
const TABLETA = { width: 1180, height: 820 }
const MOVIL = { width: 390, height: 844 }

/* Capturas ------------------------------------------------------------------------------------- */

type Pantalla = { archivo: string, ruta: string, quien: string | null, vista: { width: number, height: number }, antes?: (p: any) => Promise<void> }

const PANTALLAS: Pantalla[] = [
  { archivo: 'entrar', ruta: '/entrar', quien: null, vista: ESCRITORIO },
  { archivo: 'inicio', ruta: '/panel', quien: 'propietario', vista: ESCRITORIO },
  { archivo: 'reservas', ruta: '/panel/reservas', quien: 'encargada', vista: ESCRITORIO },
  { archivo: 'reserva-publica', ruta: '/r/taberna-lumbre', quien: null, vista: MOVIL },
  { archivo: 'sala', ruta: '/panel/sala', quien: 'encargada', vista: ESCRITORIO },
  { archivo: 'comandero', ruta: '/panel/comandero', quien: 'camarero', vista: MOVIL },
  { archivo: 'cocina', ruta: '/panel/cocina', quien: 'cocina', vista: TABLETA },
  { archivo: 'caja', ruta: '/panel/caja', quien: 'encargada', vista: ESCRITORIO },
  { archivo: 'fichaje', ruta: '/panel/fichaje', quien: 'camarero', vista: MOVIL },
  { archivo: 'cuadrante', ruta: '/panel/personal/cuadrante', quien: 'encargada', vista: ESCRITORIO },
  { archivo: 'escandallos', ruta: '/panel/escandallos', quien: 'encargada', vista: ESCRITORIO },
  { archivo: 'inventario', ruta: '/panel/inventario', quien: 'encargada', vista: TABLETA },
  { archivo: 'analisis', ruta: '/panel/analisis', quien: 'propietario', vista: ESCRITORIO },
  { archivo: 'fidelizacion', ruta: '/panel/fidelizacion', quien: 'encargada', vista: MOVIL },
  { archivo: 'campanas', ruta: '/panel/campanas', quien: 'propietario', vista: TABLETA },
  { archivo: 'equipo', ruta: '/panel/equipo', quien: 'propietario', vista: ESCRITORIO },
  { archivo: 'actividad', ruta: '/panel/actividad', quien: 'propietario', vista: ESCRITORIO },
]

const FUNCIONES = process.env.README_FUNCIONES ?? 'http://127.0.0.1:5001/demo-llenamos/europe-west1'
const AUTH = process.env.README_AUTH ?? 'http://127.0.0.1:9099'
const SCOPE = { restaurantId: 'demo-lumbre', locationId: 'centro' }

async function llamar(nombre: string, quien: string, datos: object) {
  const t = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `${quien}@lumbre.test`, password: CLAVE, returnSecureToken: true }),
  })
  const { idToken } = (await t.json()) as { idToken: string }
  const r = await fetch(`${FUNCIONES}/${nombre}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` }, body: JSON.stringify({ data: { ...SCOPE, ...datos } }) })
  const cuerpo = (await r.json()) as { result?: any, error?: { message: string } }
  if (cuerpo.error) throw new Error(`${nombre}: ${cuerpo.error.message}`)
  return cuerpo.result
}

/** Sesión de mesa que abre el servidor al sentar una reserva (lectura con Admin en el emulador). */
async function firestore() {
  process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8085'
  const { getApps, initializeApp } = await import('firebase-admin/app')
  const { getFirestore } = await import('firebase-admin/firestore')
  if (!getApps().length) initializeApp({ projectId: 'demo-llenamos' })
  return getFirestore()
}
async function hastaSesion(reservationId: string): Promise<string> {
  const sesiones = (await firestore()).collection('restaurants/demo-lumbre/locations/centro/tableSessions')
  for (let i = 0; i < 60; i++) {
    const d = (await sesiones.where('reservationId', '==', reservationId).get()).docs[0]
    if (d) return d.id
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('La reserva no abrió sesión de mesa.')
}

/** Unas mesas sentadas ahora con comandas enviadas, para que sala, comandero, cocina y caja no salgan vacías. */
async function servicioEnMarcha(navegador: any) {
  const pedidos = [['Patatas bravas', 'Hamburguesa Lumbre', 'Agua mineral'], ['Ensalada de tomate y burrata', 'Lubina a la brasa'], ['Entrecot de ternera', 'Patatas bravas', 'Crema catalana']]
  const c = await navegador.newContext({ viewport: ESCRITORIO, deviceScaleFactor: 1 })
  const p = await c.newPage()
  p.setDefaultTimeout(30_000)
  await p.goto(`${WEB}/entrar`)
  await p.locator('input[name="email"]:not([disabled])').fill('camarero@lumbre.test')
  await p.locator('input[type="password"]:not([disabled])').fill(CLAVE)
  await p.getByRole('button', { name: 'Entrar', exact: true }).click()
  await p.waitForURL('**/panel')
  // Se sientan las primeras reservas del seed que aún no han llegado (sus mesas ya están libres).
  const db = await firestore()
  const ahora = Date.now()
  const hoy = (await db.collection('restaurants/demo-lumbre/locations/centro/reservations').get()).docs
    .filter((d) => ['confirmed', 'pending'].includes(d.get('status')) && (d.get('tableIds') ?? []).length)
    .filter((d) => { const t = d.get('startAt').toMillis(); return t > ahora - 3_600_000 && t < ahora + 4 * 3_600_000 })
    .sort((a, b) => a.get('startAt').toMillis() - b.get('startAt').toMillis())
  let hechas = 0
  for (const r of hoy) {
    if (hechas === pedidos.length) break
    try {
      await llamar('cambiarEstadoReserva', 'encargada', { reservationId: r.id, status: 'seated' })
      const sesion = await hastaSesion(r.id)
      await p.goto(`${WEB}/panel/comandero?s=${sesion}`)
      await p.getByRole('button', { name: `Añadir ${pedidos[hechas]![0]}`, exact: true }).waitFor()
      for (const plato of pedidos[hechas]!) await p.getByRole('button', { name: `Añadir ${plato}`, exact: true }).click()
      await p.getByRole('button', { name: /^Revisar total/ }).click()
      await p.getByRole('button', { name: 'Enviar pedido', exact: true }).click()
      await p.getByRole('button', { name: 'Marchar todo', exact: true }).click({ timeout: 4000 }).catch(() => {})
      await p.waitForTimeout(1500)
      hechas++
      console.log(`  servicio: ${r.get('guestName')} sentada con su comanda`)
    } catch (error) { console.warn(`  servicio: ${r.get('guestName')} no se pudo preparar (${(error as Error).message.slice(0, 120)})`) }
  }
  await c.close()
}

async function capturar() {
  await mkdir(CAPTURAS, { recursive: true })
  const navegador = await lanzar()
  if (process.env.README_SIN_SERVICIO !== '1') await servicioEnMarcha(navegador)
  const errores: string[] = []
  for (const s of PANTALLAS) {
    const c = await navegador.newContext({ viewport: s.vista, deviceScaleFactor: 2, hasTouch: s.vista.width < 800, colorScheme: 'dark' })
    // Nada sale a internet: solo la web local y los emuladores.
    await c.route('**/*', (r: any) => (['localhost', '127.0.0.1'].includes(new URL(r.request().url()).hostname) ? r.continue() : r.abort()))
    const p = await c.newPage()
    p.setDefaultTimeout(45_000)
    p.on('pageerror', (e: Error) => errores.push(`${s.archivo}: ${e.message}`))
    if (s.quien) {
      await p.goto(`${WEB}/entrar`)
      await p.locator('input[name="email"]:not([disabled])').fill(`${s.quien}@lumbre.test`)
      await p.locator('input[type="password"]:not([disabled])').fill(CLAVE)
      await p.getByRole('button', { name: 'Entrar', exact: true }).click()
      await p.waitForURL('**/panel')
    }
    // La red nunca se queda quieta (suscripciones en directo de Firestore): se espera a la carga
    // y a que desaparezcan los esqueletos.
    await p.goto(`${WEB}${s.ruta}`, { waitUntil: 'load' })
    await p.waitForFunction(() => !document.querySelector('[data-slot="skeleton"], .animate-pulse'), null, { timeout: 20_000 }).catch(() => {})
    await s.antes?.(p)
    await p.waitForTimeout(3000)
    await p.mouse.move(1, 1)
    await p.screenshot({ path: `${CAPTURAS}/${s.archivo}.png`, style: 'nextjs-portal { display: none !important; }' })
    console.log(`  captura ${s.archivo}`)
    await c.close()
  }
  await navegador.close()
  if (errores.length) console.warn(`Errores de página:\n${errores.join('\n')}`)
}

/* Montaje -------------------------------------------------------------------------------------- */

const fuente = (paquete: string, archivo: string) => pathToFileURL(resolve(`apps/landing/node_modules/@fontsource-variable/${paquete}/files/${archivo}`)).href
const img = (nombre: string) => pathToFileURL(`${CAPTURAS}/${nombre}.png`).href

const ESTILO = `
@font-face { font-family: Geist; src: url(${fuente('geist', 'geist-latin-wght-normal.woff2')}) format('woff2'); font-weight: 100 900; }
@font-face { font-family: Geist Mono; src: url(${fuente('geist-mono', 'geist-mono-latin-wght-normal.woff2')}) format('woff2'); font-weight: 100 900; }
* { box-sizing: border-box; margin: 0; }
html, body { background: #131209; }
body { width: 1600px; font-family: Geist, sans-serif; color: #f4efe6; -webkit-font-smoothing: antialiased;
  background: radial-gradient(900px 520px at 88% 0%, rgba(240,163,94,.13), transparent 70%), radial-gradient(700px 400px at 0% 100%, rgba(143,199,160,.05), transparent 70%), #131209; }
.lienzo { display: flex; align-items: flex-start; justify-content: center; gap: 28px; padding: 44px 40px; }
.marco { border-radius: 22px; overflow: hidden; border: 1px solid rgba(244,239,230,.13); background: #1a1813;
  box-shadow: 0 30px 80px rgba(0,0,0,.55), 0 0 0 1px rgba(0,0,0,.4); flex: none; }
.marco img { display: block; width: 100%; }
.movil { border-radius: 38px; border-width: 1px; padding: 0; }
.pie { margin-top: 12px; font-size: 13px; color: rgba(244,239,230,.55); text-align: center; letter-spacing: .01em; }
.col { display: flex; flex-direction: column; align-items: center; }
`

/** Una fila de marcos de la misma altura que llena el ancho del lienzo (1600 CSS; la imagen sale a 3200). */
const VISTA = Object.fromEntries(PANTALLAS.map((s) => [s.archivo, s.vista]))
function fila(...piezas: [nombre: string, pie: string][]) {
  const proporcion = (n: string) => VISTA[n]!.width / VISTA[n]!.height
  const alto = (1520 - 28 * (piezas.length - 1)) / piezas.reduce((t, [n]) => t + proporcion(n), 0)
  return `<div class="lienzo">${piezas.map(([n, pie]) => {
    const movil = VISTA[n]!.width < 800
    return `<div class="col"><div class="marco${movil ? ' movil' : ''}" style="width:${Math.round(alto * proporcion(n))}px"><img src="${img(n)}"></div><div class="pie">${pie}</div></div>`
  }).join('')}</div>`
}

const COMPOSICIONES: Record<string, string> = {
  panel: fila(['reservas', 'Reservas del día con la sala al lado'], ['reserva-publica', 'Página de reservas del restaurante']),
  servicio: fila(['comandero', 'Comandero en el móvil'], ['cocina', 'Pantalla de cocina en la tableta'], ['caja', 'Caja y arqueo']),
  personal: fila(['fichaje', 'Fichaje en el móvil'], ['cuadrante', 'Cuadrante de la semana']),
  costes: fila(['inventario', 'Existencias en la tableta'], ['escandallos', 'Escandallos con coste y margen']),
  clientes: fila(['analisis', 'Panel de ventas y sala'], ['campanas', 'Campañas solo a quien dio permiso'], ['fidelizacion', 'Puntos y promociones']),
  'equipo-actividad': fila(['equipo', 'Equipo y roles'], ['actividad', 'Actividad que nadie puede borrar']),
  'entrar-inicio': fila(['entrar', 'Acceso del personal'], ['inicio', 'Inicio del panel']),
}

/** La cabecera es una ilustración (no una captura): logo, lema, módulos y un plano de sala. */
async function cabecera() {
  const logo = await readFile('docs/readme/logo.svg', 'utf8')
  const mesa = (nombre: string, dato: string, estado: 'libre' | 'reservada' | 'sentados', redonda = false, ancho = 96) =>
    `<div class="mesa ${estado}${redonda ? ' redonda' : ''}" style="width:${redonda ? 76 : ancho}px"><b>${nombre}</b><span>${dato}</span></div>`
  const modulos = ['Reservas', 'Sala', 'Cocina', 'Caja', 'Personal', 'Inventario', 'Clientes', 'Análisis']
  return `<style>
  .cab { display: flex; justify-content: space-between; align-items: center; height: 560px; padding: 0 60px; }
  .izq { width: 820px; }
  .marca { display: flex; align-items: center; gap: 14px; font-size: 28px; font-weight: 650; letter-spacing: -.02em; }
  .marca svg { width: 40px; height: 40px; } .marca small { font-size: 15px; font-weight: 400; color: rgba(244,239,230,.6); margin-left: 4px; }
  h1 { margin-top: 30px; font-size: 70px; line-height: 1; letter-spacing: -.045em; font-weight: 640;
    background: linear-gradient(180deg, #fbf7f0 30%, #cbbfae); -webkit-background-clip: text; color: transparent; }
  .lema { margin-top: 24px; font-size: 19px; line-height: 1.5; color: rgba(244,239,230,.68); max-width: 700px; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 26px; }
  .chip { padding: 7px 14px; border-radius: 999px; font-size: 15px; border: 1px solid rgba(244,239,230,.12); background: rgba(244,239,230,.04); }
  .chip.on { background: #f0a35e; color: #1b130a; border-color: #f0a35e; font-weight: 550; }
  .plano { width: 600px; border-radius: 22px; border: 1px solid rgba(244,239,230,.13); background: #1a1813; box-shadow: 0 30px 80px rgba(0,0,0,.55); }
  .plano header { display: flex; justify-content: space-between; padding: 18px 22px; border-bottom: 1px solid rgba(244,239,230,.08); font-size: 18px; }
  .plano header b { font-weight: 600; } .plano header span { color: rgba(244,239,230,.6); margin-left: 8px; }
  .plano header i { font-style: normal; font-family: 'Geist Mono'; color: #8fc7a0; font-size: 16px; }
  .filas { padding: 16px 22px 6px; display: flex; flex-direction: column; gap: 16px; }
  .fila { display: flex; justify-content: space-between; align-items: center; }
  .mesa { height: 66px; border-radius: 12px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
    border: 1.5px solid rgba(244,239,230,.16); background: #211e18; font-size: 15px; }
  .mesa.redonda { height: 76px; border-radius: 50%; }
  .mesa span { font-family: 'Geist Mono'; font-size: 13px; color: rgba(244,239,230,.6); }
  .mesa.sentados { border-color: #8fc7a0; background: rgba(143,199,160,.1); color: #8fc7a0; } .mesa.sentados span { color: #8fc7a0; }
  .mesa.reservada { border-color: #f0a35e; background: rgba(240,163,94,.1); color: #f0a35e; } .mesa.reservada span { color: #f0a35e; }
  .plano footer { display: flex; justify-content: space-between; align-items: center; padding: 10px 22px 18px; font-size: 15px; color: rgba(244,239,230,.62); }
  .leyenda { display: flex; gap: 18px; } .leyenda em { font-style: normal; display: inline-flex; align-items: center; gap: 7px; }
  .leyenda em::before { content: ''; width: 13px; height: 13px; border-radius: 3px; border: 1.5px solid rgba(244,239,230,.3); }
  .leyenda .r::before { border-color: #f0a35e; background: rgba(240,163,94,.25); } .leyenda .s::before { border-color: #8fc7a0; background: rgba(143,199,160,.25); }
  .espera { padding: 7px 13px; border-radius: 999px; border: 1px solid rgba(244,239,230,.1); color: #f4efe6; } .espera b { color: #8fc7a0; font-weight: 550; }
  </style>
  <div class="cab">
    <div class="izq">
      <div class="marca">${logo}llenamos<small>by LogiQD</small></div>
      <h1>Llena cada turno<br>sin coger el teléfono</h1>
      <p class="lema">Reservas, sala, cocina, caja, personal y clientes para restaurantes, en un solo sistema. Empieza con reservas y activa el resto cuando quieras.</p>
      <div class="chips">${modulos.map((m, i) => `<span class="chip${i === 0 ? ' on' : ''}">${m}</span>`).join('')}</div>
    </div>
    <div class="plano">
      <header><div><b>Sala</b><span>Taberna Lumbre · cena</span></div><i>31/44 plazas</i></header>
      <div class="filas">
        <div class="fila">${mesa('S1', '4 pax', 'sentados')}${mesa('S2', '21:30', 'reservada', true)}${mesa('S3', '4', 'libre')}${mesa('S4', '2 pax', 'sentados')}${mesa('S5', '2', 'libre', true)}</div>
        <div class="fila">${mesa('S6', '22:00', 'reservada')}${mesa('S7', '22:00', 'reservada')}${mesa('S8', '8 pax', 'sentados', false, 140)}${mesa('S9', '3 pax', 'sentados', true)}</div>
        <div class="fila">${mesa('T1', '2', 'libre', true)}${mesa('T2', '4 pax', 'sentados')}${mesa('T3', '21:45', 'reservada', true)}${mesa('T4', '6', 'libre')}${mesa('T5', '6 pax', 'sentados')}</div>
      </div>
      <footer><div class="leyenda"><em>libre</em><em class="r">reservada</em><em class="s">sentados</em></div><span class="espera">Lista de espera: <b>mesa para 2 avisada</b></span></footer>
    </div>
  </div>`
}

async function montar() {
  await mkdir(CAPTURAS, { recursive: true })
  const navegador = await lanzar()
  const p = await navegador.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 })
  const piezas: Record<string, string> = { ...COMPOSICIONES, cabecera: await cabecera() }
  for (const [nombre, html] of Object.entries(piezas)) {
    const falta = [...html.matchAll(/capturas\/([\w-]+)\.png/g)].map((m) => m[1]).filter((n) => !existsSync(`${CAPTURAS}/${n}.png`))
    if (falta.length) { console.warn(`  sin capturas para ${nombre}: ${falta.join(', ')}`); continue }
    // Desde un archivo local para que la página pueda cargar capturas y fuentes del disco.
    const pagina = `${CAPTURAS}/_${nombre}.html`
    await writeFile(pagina, `<!doctype html><meta charset="utf-8"><style>${ESTILO}</style><body>${html}</body>`)
    await p.goto(pathToFileURL(pagina).href, { waitUntil: 'load' })
    await p.evaluate(() => document.fonts.ready)
    await p.locator('body').screenshot({ path: `${SALIDA}/${nombre}.png` })
    await rm(pagina)
    console.log(`  imagen ${nombre}`)
  }
  await navegador.close()
}

async function main() {
  if (!SOLO_MONTAR) await capturar()
  await montar()
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
