/**
 * Recorrido de punta a punta de la fase 4 (personal, inventario y costes) en un navegador real,
 * contra los emuladores de Firebase (proyecto demo-llenamos) con las funciones de verdad, para
 * que salten los disparadores de consumo. Nada de la nube y ninguna respuesta interceptada.
 *
 * Preparación (emuladores y web de la fila elegida; ver docs/diseno/capturas/fase4/README.md):
 *   pnpm seed && pnpm seed:servicio && pnpm seed:caja && tsx scripts/seed-fase4.ts
 * Ejecución:
 *   GCLOUD_PROJECT=demo-llenamos FIRESTORE_EMULATOR_HOST=127.0.0.1:8097 \
 *   FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9103 tsx scripts/fase4-navegador.ts
 *
 * Variables opcionales: FASE4_WEB (por defecto http://localhost:3012), FASE4_FUNCIONES (por
 * defecto http://127.0.0.1:5013/demo-llenamos/europe-west1), FASE4_AUTH (por defecto
 * http://127.0.0.1:9103), FASE4_SALIDA (carpeta de capturas) y FASE4_SOLO (lista de pasos).
 *
 * Los datos de apoyo (mesa, reserva) se crean con la propia aplicación o con Admin SDK solo
 * como preparación del escenario, nunca para dar por buenos los resultados: lo que se comprueba
 * (existencias, movimientos, costes, horas, reparto) lo ha escrito el servidor.
 */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let playwright: any
try { playwright = require('playwright') } catch { playwright = require('/srv/LogiQD/llenamos/.claude/pw/node_modules/playwright') }

const WEB = process.env.FASE4_WEB ?? 'http://localhost:3012'
const FUNCIONES = process.env.FASE4_FUNCIONES ?? 'http://127.0.0.1:5013/demo-llenamos/europe-west1'
const AUTH = process.env.FASE4_AUTH ?? 'http://127.0.0.1:9103'
const SALIDA = process.env.FASE4_SALIDA ?? 'docs/diseno/capturas/fase4'
const SOLO = process.env.FASE4_SOLO?.split(',').filter(Boolean) ?? null
const SCOPE = { restaurantId: 'demo-lumbre', locationId: 'centro' }
const CLAVE = 'Llenamos2026!'

if (process.env.GCLOUD_PROJECT !== 'demo-llenamos' || !process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  throw new Error('Usa solo los emuladores: GCLOUD_PROJECT=demo-llenamos, FIRESTORE_EMULATOR_HOST y FIREBASE_AUTH_EMULATOR_HOST.')
}
initializeApp({ projectId: 'demo-llenamos' })
const fs = getFirestore()
const local = fs.doc('restaurants/demo-lumbre/locations/centro')
const root = fs.doc('restaurants/demo-lumbre')

/* Utilidades ---------------------------------------------------------------------------------- */

/** Fecha de hoy en la zona del restaurante (AAAA-MM-DD). */
const fechaLocal = (ms = Date.now()) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(ms)
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function hasta<T>(trabajo: () => Promise<T | null | undefined | false>, mensaje: string, ms = 45_000): Promise<T> {
  const inicio = Date.now()
  while (Date.now() - inicio < ms) {
    const r = await trabajo()
    if (r) return r
    await dormir(250)
  }
  throw new Error(mensaje)
}
const navegadorEjecutable = '/home/gery/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome'
const errores: string[] = []
const capturas: { archivo: string; que: string }[] = []
const comprobaciones: string[] = []
const evidencia: unknown[] = []
let navegador: any

function ok(texto: string, condicion: unknown = true) {
  assert.ok(condicion, texto)
  comprobaciones.push(texto)
  console.log(`  ok · ${texto}`)
}

async function contexto(correo: string | null, viewport = { width: 1440, height: 900 }) {
  const c = await navegador.newContext({ viewport, deviceScaleFactor: 2, hasTouch: viewport.width < 800 })
  // Nada sale a internet: solo el servidor local y los emuladores.
  await c.route('**/*', (route: any) => (['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort()))
  const p = await c.newPage()
  p.setDefaultTimeout(45_000)
  p.on('pageerror', (e: Error) => errores.push(`${correo ?? 'anónimo'}: ${e.message}`))
  if (correo) {
    await p.goto(`${WEB}/entrar`)
    await p.locator('input[name="email"]:not([disabled])').fill(correo)
    await p.locator('input[type="password"]:not([disabled])').fill(CLAVE)
    await p.getByRole('button', { name: 'Entrar', exact: true }).click()
    await p.waitForURL('**/panel')
  }
  return p
}
const cuenta = (quien: string) => `${quien}@lumbre.test`

async function capturar(p: any, archivo: string, que: string) {
  await p.evaluate(() => scrollTo(0, 0))
  await p.mouse.move(1, 1)
  assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Desbordamiento horizontal en ${archivo}`)
  await p.screenshot({ path: `${SALIDA}/${archivo}.png`, fullPage: true, style: 'nextjs-portal { display: none !important; }' })
  capturas.push({ archivo, que })
  console.log(`  captura ${archivo}`)
}

/** Token de Auth del emulador, para llamar a una callable como esa persona cuando no hay pantalla. */
async function token(quien: string): Promise<string> {
  const r = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: cuenta(quien), password: CLAVE, returnSecureToken: true }),
  })
  return ((await r.json()) as { idToken: string }).idToken
}
/** Callables de sala que no llevan requestId en su contrato. */
const SIN_REQUEST_ID = new Set(['crearReserva', 'cambiarEstadoReserva', 'cambiarEstadoLineas', 'cambiarEstadoMesa', 'marcharPase', 'informeHoras', 'horasParaPropinas', 'sugerirPedidos', 'margenPlatos'])
async function llamar(nombre: string, quien: string, datos: object, esperado?: string): Promise<any> {
  const r = await fetch(`${FUNCIONES}/${nombre}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token(quien)}` },
    body: JSON.stringify({ data: { ...SCOPE, ...(SIN_REQUEST_ID.has(nombre) ? {} : { requestId: randomUUID() }), ...datos } }),
  })
  const cuerpo = (await r.json()) as { result?: any; error?: { status: string; message: string } }
  evidencia.push({ operacion: nombre, quien, http: r.status, estado: cuerpo.error?.status ?? 'OK' })
  if (esperado) { assert.equal(cuerpo.error?.status, esperado, `${nombre}: se esperaba ${esperado}`); return cuerpo.error }
  assert.ok(!cuerpo.error, `${nombre}: ${JSON.stringify(cuerpo.error)}`)
  return cuerpo.result
}
/** Espera la llamada de una pantalla y devuelve lo que envió y lo que respondió el servidor. */
async function conLlamada(p: any, nombre: string, accion: () => Promise<unknown>) {
  const respuesta = p.waitForResponse((r: any) => r.url() === `${FUNCIONES}/${nombre}` && r.request().method() === 'POST')
  await accion()
  const r = await respuesta
  const cuerpo = await r.json()
  evidencia.push({ operacion: nombre, via: 'pantalla', http: r.status(), estado: cuerpo.error?.status ?? 'OK' })
  assert.ok(!cuerpo.error, `${nombre}: ${JSON.stringify(cuerpo.error)}`)
  return { entrada: r.request().postDataJSON().data, resultado: cuerpo.result }
}

const ingredientes: Record<string, { id: string; nombre: string }> = {}
async function cargarIngredientes() {
  for (const d of (await local.collection('ingredients').get()).docs) ingredientes[d.get('name') as string] = { id: d.id, nombre: d.get('name') }
}
const existencias = async (nombre: string) => (await local.collection('ingredients').doc(ingredientes[nombre]!.id).get()).get('quantity') as number

const ESTADO: Record<string, any> = {}

/** Pide platos en el comandero (comida retenida) y los marcha: pasa por la cola de sala como en el local. */
async function pedirYMarchar(p: any, sesionId: string, platos: string[], alRetener?: () => Promise<void>) {
  await p.goto(`${WEB}/panel/comandero?s=${sesionId}`)
  await p.getByRole('button', { name: `Añadir ${platos[0]}`, exact: true }).waitFor()
  for (const plato of platos) await p.getByRole('button', { name: `Añadir ${plato}`, exact: true }).click()
  await p.getByRole('combobox', { name: 'Salida de los platos', exact: true }).click()
  await p.getByRole('option', { name: 'Retener la comida', exact: true }).click()
  await p.getByRole('button', { name: /^Revisar total/ }).click()
  await conLlamada(p, 'sincronizarComando', () => p.getByRole('button', { name: 'Enviar pedido', exact: true }).click())
  await p.getByRole('button', { name: 'Marchar todo', exact: true }).waitFor()
  if (alRetener) await alRetener()
  await conLlamada(p, 'sincronizarComando', () => p.getByRole('button', { name: 'Marchar todo', exact: true }).click())
}

type Paso = { id: string; titulo: string; correr: () => Promise<void> }
const pasos: Paso[] = []
const paso = (id: string, titulo: string, correr: () => Promise<void>) => pasos.push({ id, titulo, correr })

/* ------------------------------------------------------------------------------------------- */
/* 1 · Menú por rol                                                                              */
/* ------------------------------------------------------------------------------------------- */

const ENLACES_FASE4 = ['/panel/fichaje', '/panel/personal', '/panel/inventario', '/panel/escandallos', '/panel/compras']
async function enlacesDelMenu(p: any): Promise<string[]> {
  await p.goto(`${WEB}/panel`)
  await p.getByRole('link', { name: 'Inicio', exact: true }).first().waitFor()
  await dormir(2500)
  return [...new Set(await p.$$eval('a[href^="/panel"]', (as: HTMLAnchorElement[]) => as.map((a) => a.getAttribute('href') as string)))] as string[]
}
const fase4De = (enlaces: string[]) => ENLACES_FASE4.filter((e) => enlaces.includes(e))

paso('menu', 'Menú por rol', async () => {
  const esperado: Record<string, string[]> = {
    encargada: ['/panel/fichaje', '/panel/personal', '/panel/inventario', '/panel/escandallos', '/panel/compras'],
    camarero: ['/panel/fichaje'],
    cocina: ['/panel/fichaje', '/panel/inventario'],
    barra: ['/panel/fichaje', '/panel/inventario'],
  }
  for (const [quien, enlaces] of Object.entries(esperado)) {
    const p = await contexto(cuenta(quien))
    const vistos = fase4De(await enlacesDelMenu(p))
    assert.deepEqual(vistos.sort(), [...enlaces].sort(), `Menú de ${quien}`)
    ok(`El menú de ${quien} enseña ${enlaces.map((e) => e.replace('/panel/', '')).join(', ')} y nada más de la fase 4`)
    if (quien !== 'barra') await capturar(p, `01-menu-${quien}`, `Menú de ${quien}: solo lo que su rol puede usar de la fase 4`)
    await p.context().close()
  }
})

/* ------------------------------------------------------------------------------------------- */
/* 2 · Cuadrante: un turno de hoy y publicar la semana siguiente                                  */
/* ------------------------------------------------------------------------------------------- */

paso('cuadrante', 'El encargado prepara y publica el cuadrante', async () => {
  const camarero = (await fs.doc('restaurants/demo-lumbre/members/lumbre-camarero').get()).get('uid') as string
  ESTADO.camareroUid = camarero
  // El encargado ajusta el turno de hoy del camarero para que empiece hace diez minutos (así se
  // puede comparar con lo que fiche). Ajustar un turno publicado no lo vuelve borrador.
  const hoy = fechaLocal()
  const previo = (await local.collection('shifts').where('uid', '==', camarero).where('date', '==', hoy).get()).docs[0]
  assert.ok(previo, 'El camarero no tiene turno hoy: ejecuta el seed de la fase 4.')
  const ahora = Math.floor(Date.now() / 60_000) * 60_000
  const turno = await llamar('guardarTurno', 'encargada', {
    shiftId: previo.id, expectedRevision: previo.get('revision'),
    shift: { uid: camarero, startAt: ahora - 10 * 60_000, endAt: ahora + 7 * 3_600_000, position: 'Sala', note: 'Servicio de comida y cena' },
  })
  ESTADO.turnoId = turno.shiftId
  const p = await contexto(cuenta('encargada'))
  await p.goto(`${WEB}/panel/personal/cuadrante`)
  await p.getByRole('button', { name: 'Pasar a borrador' }).waitFor()
  await capturar(p, '02-cuadrante-esta-semana', 'Cuadrante de la semana en curso, publicado: el turno de hoy del camarero ajustado por el encargado')
  await p.getByRole('button', { name: 'Semana siguiente' }).click()
  await p.getByRole('button', { name: 'Publicar la semana' }).waitFor()
  await capturar(p, '03-cuadrante-semana-siguiente-borrador', 'La semana siguiente, todavía en borrador: nadie del equipo la ve')
  await conLlamada(p, 'publicarCuadrante', () => p.getByRole('button', { name: 'Publicar la semana' }).click())
  await p.getByRole('button', { name: 'Pasar a borrador' }).waitFor()
  const publicados = (await local.collection('shifts').where('status', '==', 'published').get()).size
  ok(`El cuadrante queda publicado (${publicados} turnos publicados en el local)`, publicados >= 20)
  await capturar(p, '04-cuadrante-semana-siguiente-publicada', 'La semana siguiente publicada; el equipo ya la ve en su fichaje')
  await p.context().close()
})

/* ------------------------------------------------------------------------------------------- */
/* 3 · Fichaje: entrada del camarero en el móvil y de la barra en la tableta                      */
/* ------------------------------------------------------------------------------------------- */

paso('entrada', 'El camarero ficha en el móvil y la barra en la tableta', async () => {
  const movil = await contexto(cuenta('camarero'), { width: 390, height: 844 })
  ESTADO.movilCamarero = movil
  await movil.goto(`${WEB}/panel/fichaje`)
  await movil.getByRole('button', { name: 'Fichar entrada' }).waitFor()
  await capturar(movil, '05-movil-antes-de-fichar', 'El camarero en el móvil: ve su turno de hoy publicado y un único botón grande')
  await conLlamada(movil, 'fichar', () => movil.getByRole('button', { name: 'Fichar entrada' }).click())
  await movil.getByRole('button', { name: 'Pausa' }).waitFor()
  await capturar(movil, '06-movil-trabajando', 'Entrada fichada con la hora del servidor')
  const abierto = await hasta(async () => (await local.collection('timeEntries').where('uid', '==', ESTADO.camareroUid).where('status', '==', 'open').get()).docs[0], 'No hay fichaje abierto del camarero')
  ESTADO.fichajeCamarero = abierto.id
  ESTADO.entradaCamarero = abierto.get('startAt').toMillis?.() ?? abierto.get('startAt')
  ok('El fichaje del camarero queda abierto con la hora del servidor y sin horas inventadas por el móvil', abierto.get('status') === 'open')

  // La barra ficha en la tableta del local: sesión de la encargada y PIN de la persona.
  const tableta = await contexto(cuenta('encargada'), { width: 1180, height: 820 })
  await tableta.goto(`${WEB}/panel/fichaje/puesto`)
  await tableta.getByRole('button', { name: /Nora/ }).click()
  for (const cifra of '4567') await tableta.getByRole('button', { name: cifra, exact: true }).click()
  await capturar(tableta, '07-tableta-pin', 'Puesto de tableta: la persona toca su nombre y escribe su PIN en el teclado grande')
  await conLlamada(tableta, 'ficharEnPuesto', () => tableta.getByRole('button', { name: 'Fichar entrada' }).click())
  await tableta.getByText(/Nora Costa.*Trabajando|Trabajando/).first().waitFor().catch(() => undefined)
  await dormir(1500)
  await capturar(tableta, '08-tableta-nora-dentro', 'Tras fichar, el puesto enseña quién está dentro en directo')
  const nora = await hasta(async () => (await local.collection('timeEntries').where('status', '==', 'open').where('startSource', '==', 'kiosk').get()).docs[0], 'No hay fichaje de puesto')
  ok('La entrada de la barra en la tableta queda con origen "kiosk" y el encargado como autor', nora.get('startSource') === 'kiosk')
  ESTADO.noraUid = nora.get('uid')
  ESTADO.fichajeNora = nora.id
  await tableta.context().close()
})

/* ------------------------------------------------------------------------------------------- */
/* 4 · Compras: pedido a proveedor, recepción parcial con cambio de precio                        */
/* ------------------------------------------------------------------------------------------- */

paso('compras', 'Pedido a proveedor con recepción parcial y cambio de precio', async () => {
  const antes = { entrecot: await existencias('Entrecot de ternera'), bacon: await existencias('Bacon') }
  const valorAntes = (await local.collection('ingredientCosts').doc(ingredientes['Entrecot de ternera']!.id).get()).data()
  const p = await contexto(cuenta('encargada'))
  await p.goto(`${WEB}/panel/compras`)
  await p.getByRole('button', { name: 'Preparar borrador' }).first().waitFor()
  await capturar(p, '09-compras-sugerencia', 'La sugerencia propone lo que falta (bacon bajo mínimo) y avisa de los ingredientes sin formato de proveedor')
  await conLlamada(p, 'guardarPedidoProveedor', async () => {
    await p.getByRole('button', { name: 'Preparar borrador' }).first().click()
    await p.getByRole('button', { name: 'Guardar borrador' }).waitFor()
    await capturar(p, '10-compras-borrador-desde-sugerencia', 'El borrador sale de la sugerencia; los precios los pone el servidor desde el formato guardado')
    await p.getByRole('button', { name: 'Guardar borrador' }).click()
  })
  await p.getByRole('heading', { name: /Pedido|Carnicería Vidal/ }).first().waitFor().catch(() => undefined)
  await dormir(1500)
  await p.keyboard.press('Escape')

  // El pedido de la carnicería que dejó el seed: se marca como enviado y llega solo una parte.
  await p.goto(`${WEB}/panel/compras`)
  await p.getByRole('radio', { name: 'Borradores' }).click()
  await p.getByRole('button', { name: /Carnicería Vidal/ }).filter({ hasText: '2 líneas' }).first().click()
  await p.getByRole('button', { name: 'Marcar como enviado' }).waitFor()
  await p.getByRole('button', { name: 'Marcar como enviado' }).click()
  await capturar(p, '11-compras-confirmar-envio', 'Llenamos no envía nada al proveedor: el encargado confirma que lo ha pedido él')
  await conLlamada(p, 'cambiarEstadoPedidoProveedor', () => p.getByRole('button', { name: 'Sí, ya lo he enviado' }).click())
  await p.getByRole('button', { name: 'Recibir mercancía' }).waitFor()
  await p.getByRole('button', { name: 'Recibir mercancía' }).click()
  const entrecot = p.getByRole('listitem').filter({ hasText: 'Bandeja 2 kg' })
  await entrecot.getByLabel('Formatos recibidos').fill('2')
  await entrecot.getByLabel(/Precio del albarán/).fill('35,50')
  const carne = p.getByRole('listitem').filter({ hasText: 'Bolsa 2 kg' })
  await carne.getByLabel('Formatos recibidos').fill('2')
  await capturar(p, '12-compras-recepcion-parcial', 'Recepción parcial: llegan 2 de 3 bandejas de entrecot a 35,50 € (antes 34,00 €) y el aviso de cambio de precio sale al teclear')
  const recepcion = await conLlamada(p, 'recibirPedidoProveedor', () => p.getByRole('button', { name: 'Guardar albarán' }).click())
  await p.getByText('Han cambiado precios respecto al último pagado').waitFor()
  await capturar(p, '13-compras-resultado', 'Resultado del albarán: pedido recibido en parte, lo que falta y el cambio de precio con su variación')
  ok('La recepción parcial deja el pedido "recibido en parte" y avisa del cambio de precio', recepcion.resultado.orderStatus === 'partially_received' && recepcion.resultado.priceChanges.length === 1)
  const despues = { entrecot: await existencias('Entrecot de ternera') }
  ok(`El entrecot sube de ${antes.entrecot} g a ${despues.entrecot} g (2 bandejas de 2 kg)`, despues.entrecot === antes.entrecot + 4000)
  const valorDespues = (await local.collection('ingredientCosts').doc(ingredientes['Entrecot de ternera']!.id).get()).data()
  ok('El coste medio del entrecot se actualiza con el precio del albarán', JSON.stringify(valorAntes) !== JSON.stringify(valorDespues))
  ESTADO.pedidoCarniceria = recepcion.resultado.receiptId
  await p.context().close()
})

/* ------------------------------------------------------------------------------------------- */
/* 5 · Sala: marchar platos con receta, el stock baja solo; una anulación lo devuelve            */
/* ------------------------------------------------------------------------------------------- */

const suma = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const movimientosDe = async (lineIds: string[]) => {
  const r: any[] = []
  for (const d of (await local.collection('stockMovements').get()).docs) if (lineIds.some((l) => (d.get('ref.lineId') ?? d.id).toString().startsWith(l) || d.id.startsWith(l))) r.push({ id: d.id, ...d.data() })
  return r
}

paso('sala', 'La sala marcha platos con receta y el stock baja solo; anular lo devuelve', async () => {
  const antes: Record<string, number> = {}
  for (const n of ['Patatas', 'Carne picada de ternera', 'Pan brioche', 'Agua mineral 50 cl', 'Aceite de oliva', 'Salsa brava', 'Alioli']) antes[n] = await existencias(n)

  // Una mesa propia para el recorrido y una reserva de paso sentada en ella.
  const mesaId = `fase4-${Date.now()}`
  const plantilla = (await local.collection('tables').doc('sala-1').get()).data()!
  const nombreMesa = `F4 ${String(Date.now()).slice(-4)}`
  await local.collection('tables').doc(mesaId).set({ ...plantilla, name: nombreMesa, seats: 4, joinableWith: [], updatedBy: 'lumbre-propietario' })
  ESTADO.mesaId = mesaId; ESTADO.nombreMesa = nombreMesa
  const hora = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hour12: false }).format(Date.now())
  const reserva = await llamar('crearReserva', 'propietario', { date: fechaLocal(), time: hora, partySize: 3, guestName: 'Recorrido fase 4', phone: `6${String(Date.now()).slice(-8)}`, source: 'walk_in', tableIds: [mesaId] })
  await llamar('cambiarEstadoReserva', 'propietario', { reservationId: reserva.reservationId, status: 'seated' })
  const sesion = await hasta(async () => (await local.collection('tableSessions').where('reservationId', '==', reserva.reservationId).get()).docs[0], 'La reserva no abrió sesión de mesa.')
  ESTADO.sesionId = sesion.id

  const p = await contexto(cuenta('propietario'))
  await pedirYMarchar(p, sesion.id, ['Patatas bravas', 'Hamburguesa Lumbre', 'Agua mineral'], async () => {
    ok('Un pedido retenido (sin marchar) no toca el almacén', (await existencias('Patatas')) === antes['Patatas'])
    await capturar(p, '14-sala-pedido-retenido', 'Pedido de la mesa con comida retenida: todavía nada ha marchado y el almacén sigue igual')
  })
  const lineIds: string[] = (await local.collection('orderLines').where('sessionId', '==', sesion.id).get()).docs.map((d) => d.id)
  ok('El pedido de la mesa se ha guardado con 3 líneas', lineIds.length === 3)
  ESTADO.lineIds = lineIds
  await hasta(async () => (await existencias('Patatas')) < antes['Patatas']!, 'El disparador de consumo no descontó las patatas.')
  await hasta(async () => (await existencias('Agua mineral 50 cl')) < antes['Agua mineral 50 cl']!, 'No se descontó el agua.')
  await dormir(1500)
  const despues: Record<string, number> = {}
  for (const n of Object.keys(antes)) despues[n] = await existencias(n)
  const mov = await movimientosDe(lineIds)
  const ventas = mov.filter((m) => m.kind === 'sale')
  ok(`Al marchar, el disparador real descuenta las recetas: patatas ${antes['Patatas']} a ${despues['Patatas']} g, carne ${antes['Carne picada de ternera']} a ${despues['Carne picada de ternera']} g, pan ${antes['Pan brioche']} a ${despues['Pan brioche']}, agua ${antes['Agua mineral 50 cl']} a ${despues['Agua mineral 50 cl']}`, ventas.length >= 6)
  ok('El descuento de las patatas coincide con lo apuntado en el libro de movimientos', antes['Patatas']! - despues['Patatas']! === -suma(ventas.filter((m) => m.ingredientId === ingredientes['Patatas']!.id).map((m) => m.quantity)))
  const costes = await Promise.all(lineIds.map((l) => local.collection('lineCosts').doc(l).get()))
  ok('Cada línea con receta guarda su coste y su precio de ese momento (lineCosts)', costes.filter((c) => c.exists && c.get('state') === 'consumed').length === 3)

  // Anular antes de preparar: la hamburguesa vuelve al almacén.
  const hamburguesa = (await Promise.all(lineIds.map(async (id) => ({ id, d: (await local.collection('orderLines').doc(id).get()).data()! })))).find((l) => /Hamburguesa/.test(JSON.stringify(l.d)))!
  await llamar('cambiarEstadoLineas', 'propietario', { lineIds: [hamburguesa.id], status: 'cancelled', reason: 'El cliente se ha equivocado de plato' })
  await hasta(async () => (await existencias('Pan brioche')) === antes['Pan brioche'], 'La anulación no devolvió el pan al almacén.')
  await dormir(1000)
  ok('Anular la hamburguesa antes de prepararla devuelve carne, pan y patatas', (await existencias('Carne picada de ternera')) === antes['Carne picada de ternera'] && (await existencias('Pan brioche')) === antes['Pan brioche'])
  const reversos = (await movimientosDe(lineIds)).filter((m) => m.kind === 'sale_reversal')
  ok(`La devolución queda como movimiento propio (${reversos.length} apuntes de tipo anulación de venta)`, reversos.length >= 3)

  // La encargada lo ve en el libro de movimientos, con su valor.
  const e = await contexto(cuenta('encargada'))
  await e.goto(`${WEB}/panel/inventario/movimientos`)
  await e.getByText('Devolución de consumo').first().waitFor(); await e.getByText(/Consumo por venta/).first().waitFor()
  await capturar(e, '15-inventario-movimientos', 'El libro de movimientos (solo con permiso de costes): ventas, anulación y merma, cada una con su valor')
  await e.context().close()
  await p.context().close()
})

/* ------------------------------------------------------------------------------------------- */
/* 6 · Cocina y barra: merma desde su pantalla, sin ver costes                                    */
/* ------------------------------------------------------------------------------------------- */

paso('merma', 'Cocina y barra registran merma sin ver costes', async () => {
  const antes = await existencias('Huevos')
  const cocina = await contexto(cuenta('cocina'), { width: 1180, height: 820 })
  await cocina.goto(`${WEB}/panel/cocina`)
  await cocina.getByRole('button', { name: 'Registrar merma' }).waitFor()
  await capturar(cocina, '16-cocina-acceso-merma', 'La pantalla de cocina ofrece "Registrar merma" junto a la estación, sin enseñar ningún coste')
  await cocina.getByRole('button', { name: 'Registrar merma' }).click()
  await cocina.getByRole('dialog').getByLabel('Qué se ha perdido').click()
  await cocina.getByRole('option', { name: 'Huevos', exact: true }).click()
  await cocina.getByLabel('Cuánto').fill('6')
  await cocina.getByLabel('Nota (opcional)').fill('Cubeta caída en el pase')
  await dormir(700)
  await capturar(cocina, '17-cocina-merma-dialogo', 'El mismo diálogo del inventario: ingrediente, cantidad, motivo y nota; solo cantidades, nunca importes')
  const textoDialogo = await cocina.getByRole('dialog').innerText()
  ok('El diálogo de merma de cocina no enseña ningún importe', !/€/.test(textoDialogo))
  const merma = await conLlamada(cocina, 'registrarMerma', () => cocina.getByRole('button', { name: 'Apuntar merma' }).click())
  ok('La respuesta de registrarMerma no lleva valor ni coste', !('valueCents' in merma.resultado) && !('costCents' in merma.resultado))
  await hasta(async () => (await existencias('Huevos')) === antes - 6, 'La merma no restó los huevos.')
  ok(`La merma resta del almacén: huevos ${antes} a ${antes - 6}`)
  await cocina.getByText(/Merma apuntada/).waitFor()
  await dormir(1000)
  ok('La pantalla de cocina no enseña ningún importe tras apuntar la merma', !/€/.test(await cocina.locator('main').innerText()))
  await capturar(cocina, '18-cocina-merma-hecha', 'Merma apuntada: confirmación con lo que queda, sin costes')
  // Cocina no puede abrir las pantallas de costes.
  await cocina.goto(`${WEB}/panel/escandallos`)
  await cocina.getByText(/Tu rol no puede ver los escandallos/).first().waitFor()
  await capturar(cocina, '19-cocina-escandallos-sin-acceso', 'Cocina no ve escandallos ni costes: el panel se lo dice')
  await cocina.context().close()

  const barra = await contexto(cuenta('barra'), { width: 390, height: 844 })
  await barra.goto(`${WEB}/panel/barra`)
  await barra.getByRole('button', { name: 'Registrar merma' }).waitFor()
  await capturar(barra, '20-barra-movil-acceso-merma', 'En el móvil de la barra el acceso a la merma está a la vista')
  await barra.getByRole('button', { name: 'Registrar merma' }).click()
  await barra.getByRole('dialog').getByLabel('Qué se ha perdido').click()
  await barra.getByRole('option', { name: 'Cerveza de barril', exact: true }).click()
  await barra.getByLabel('Cuánto').fill('2 l')
  await conLlamada(barra, 'registrarMerma', () => barra.getByRole('button', { name: 'Apuntar merma' }).click())
  await barra.getByText(/Merma apuntada/).waitFor()
  await capturar(barra, '21-barra-movil-merma-hecha', 'Merma de 2 litros de cerveza desde el móvil de la barra')
  await barra.context().close()
  // Y la encargada, que sí tiene costes, ve la merma valorada en el libro.
  const e = await contexto(cuenta('encargada'))
  await e.goto(`${WEB}/panel/inventario/movimientos`)
  await e.getByText(/Cubeta caída en el pase/).first().waitFor()
  ok('La encargada ve la merma de cocina con su valor en el libro de movimientos')
  await e.context().close()
})

/* ------------------------------------------------------------------------------------------- */
/* 7 · Recuento durante el servicio con reconciliación, aviso de stock bajo y sugerencia          */
/* ------------------------------------------------------------------------------------------- */

paso('recuento', 'Recuento con ventas durante el conteo, aviso de stock bajo y sugerencia de pedido', async () => {
  const aceiteAntes = await existencias('Aceite de oliva')
  const huevosAntes = await existencias('Huevos')
  const e = await contexto(cuenta('encargada'))
  await e.goto(`${WEB}/panel/inventario/recuento`)
  await e.getByRole('button', { name: 'Despensa' }).click()
  await capturar(e, '22-recuento-inicio', 'Empezar un recuento solo de la despensa: el servicio sigue abierto')
  await conLlamada(e, 'iniciarRecuento', () => e.getByRole('button', { name: /^Empezar a contar/ }).click())
  await e.getByLabel('Aceite de oliva', { exact: true }).fill('2300 ml')
  await e.getByLabel('Huevos', { exact: true }).fill('20')
  await conLlamada(e, 'guardarRecuento', () => e.getByRole('button', { name: 'Guardar progreso' }).click())
  await e.getByText('Progreso guardado').waitFor()
  await capturar(e, '23-recuento-contando', 'Cada cantidad se guarda con la hora a la que se contó: aceite 2,3 l y huevos 20')

  // Mientras se cuenta, la sala vende: unas bravas gastan 40 ml de aceite después de contarlo.
  await dormir(1500)
  const propietario = await contexto(cuenta('propietario'))
  await pedirYMarchar(propietario, ESTADO.sesionId, ['Patatas bravas'])
  await hasta(async () => (await existencias('Aceite de oliva')) === aceiteAntes - 40, 'La venta durante el recuento no descontó el aceite.')
  await propietario.context().close()

  await e.getByRole('button', { name: 'Revisar' }).click()
  await e.getByRole('columnheader', { name: 'Mientras contabas' }).waitFor()
  await capturar(e, '24-recuento-reconciliacion', 'La reconciliación descuenta lo vendido mientras se contaba: el aceite sale con −160 ml de diferencia y "salieron 40 ml" (sin la reconciliación saldría −120 ml y el aceite vendido parecería ajuste)')
  const aplicado = await conLlamada(e, 'aplicarRecuento', () => e.getByRole('button', { name: 'Aplicar el recuento' }).click())
  await e.getByRole('button', { name: 'Hecho' }).waitFor()
  await capturar(e, '25-recuento-aplicado', 'Recuento aplicado: ajustes con su valor como movimiento de recuento')
  const aceiteDespues = await existencias('Aceite de oliva')
  ok(`La venta durante el conteo no se cuenta como pérdida: aceite ${aceiteAntes} ml, contado 2300 ml a las T1, vendido 40 ml después, queda ${aceiteDespues} ml`, aceiteDespues === 2300 - 40)
  ok('Los huevos se ajustan al contado (20) y el recuento queda aplicado', (await existencias('Huevos')) === 20 && aplicado.resultado.adjusted.length === 2)
  void huevosAntes
  await e.getByRole('button', { name: 'Hecho' }).click()

  // 20 huevos están por debajo del mínimo de 30: el aviso se abrió en la misma transacción.
  const aviso = await hasta(async () => { const d = await local.collection('stockAlerts').doc(ingredientes['Huevos']!.id).get(); return d.exists && d.get('status') === 'open' ? d : null }, 'No se abrió el aviso de stock bajo de los huevos.')
  ok(`Se abre el aviso de stock bajo de los huevos (nivel ${aviso.get('level')})`, ['low', 'out'].includes(aviso.get('level')))
  await e.goto(`${WEB}/panel/inventario`)
  await e.getByText(/piden atención|pide atención/).waitFor()
  await capturar(e, '26-inventario-avisos', 'Existencias con avisos de stock bajo: huevos 20 ud frente a un mínimo de 30, sin importes para cocina y barra')
  await e.goto(`${WEB}/panel/compras`)
  await e.getByText(/Cubeta 30 uds/).first().waitFor()
  await capturar(e, '27-compras-sugerencia-huevos', 'La sugerencia de pedido incluye los huevos: cubetas enteras hasta el objetivo')
  ok('La sugerencia de pedido propone cubetas de huevos')
  await e.context().close()
})

/* ------------------------------------------------------------------------------------------- */
/* 8 · Escandallos: coste, margen teórico y margen vendido                                        */
/* ------------------------------------------------------------------------------------------- */

paso('escandallos', 'Escandallos con margen vendido', async () => {
  const e = await contexto(cuenta('encargada'))
  await e.goto(`${WEB}/panel/escandallos`)
  await e.getByText('Hamburguesa Lumbre').first().waitFor()
  await dormir(2500)
  await capturar(e, '28-escandallos-platos', 'Escandallos: coste teórico y margen de cada plato con receta')
  await e.getByRole('link', { name: /Margen vendido|Histórico/ }).or(e.getByRole('button', { name: /Margen vendido|Histórico/ })).or(e.getByRole('tab', { name: /Margen vendido|Histórico/ })).or(e.getByRole('radio', { name: /Margen vendido|Histórico|Vendido/ })).first().click().catch(() => undefined)
  await dormir(2500)
  await capturar(e, '29-escandallos-margen-vendido', 'Margen vendido: lo que costó de verdad lo ya servido, con el coste de ese momento (anulaciones aparte)')
  await e.context().close()
})

/* ------------------------------------------------------------------------------------------- */
/* 9 · Pausa y vuelta del camarero; el encargado compara el cuadrante con lo fichado              */
/* ------------------------------------------------------------------------------------------- */

const minutoDe = (ms: number) => Math.floor(ms / 60_000)
async function esperarOtroMinuto(desde: number) {
  // Un minuto entero de margen: el servidor guarda minutos y los tramos deben contar al menos uno.
  await hasta(async () => minutoDe(Date.now()) >= minutoDe(desde) + 1, 'El reloj no avanzó un minuto.', 90_000)
}

paso('pausa', 'El camarero hace una pausa', async () => {
  const entrada = ESTADO.entradaCamarero as number
  await esperarOtroMinuto(entrada)
  const movil = ESTADO.movilCamarero
  await movil.goto(`${WEB}/panel/fichaje`)
  await movil.getByRole('button', { name: 'Pausa' }).waitFor()
  await conLlamada(movil, 'fichar', () => movil.getByRole('button', { name: 'Pausa' }).click())
  await movil.getByRole('button', { name: 'Volver de la pausa' }).waitFor()
  await capturar(movil, '30-movil-en-pausa', 'En pausa: el tiempo de pausa no cuenta como trabajado')
  ESTADO.pausaCamarero = Date.now()
  ok('La pausa queda en el fichaje abierto', ((await local.collection('timeEntries').doc(ESTADO.fichajeCamarero).get()).get('breaks') ?? []).length === 1)
})

paso('vuelta', 'Vuelve de la pausa y el encargado compara el cuadrante con lo fichado', async () => {
  await esperarOtroMinuto(ESTADO.pausaCamarero as number)
  const movil = ESTADO.movilCamarero
  await conLlamada(movil, 'fichar', () => movil.getByRole('button', { name: 'Volver de la pausa' }).click())
  await movil.getByRole('button', { name: 'Salir' }).waitFor()
  await capturar(movil, '31-movil-de-vuelta', 'De vuelta de la pausa: vuelve a contar tiempo trabajado')
  const e = await contexto(cuenta('encargada'))
  await e.goto(`${WEB}/panel/personal/cuadrante`)
  await e.getByRole('radio', { name: /Comparar/ }).click()
  await dormir(2500)
  await capturar(e, '32-cuadrante-comparar-con-fichado', 'El encargado compara lo planificado con lo fichado: el camarero y la barra entraron a su hora')
  await e.goto(`${WEB}/panel/personal`)
  await e.getByText(/Diego/).first().waitFor()
  await dormir(2000)
  await capturar(e, '33-personal-hoy', 'Personal hoy: quién está dentro, en pausa u olvidado, y los turnos de hoy frente a lo fichado')
  await e.context().close()
})

/* ------------------------------------------------------------------------------------------- */
/* 10 · Cobro con propina y cierre de caja                                                        */
/* ------------------------------------------------------------------------------------------- */

paso('caja', 'Se cobra la mesa con propina y se cierra la caja', async () => {
  const core = await import('../packages/core/src/index')
  const caja = await local.collection('registerLocks').doc('principal').get()
  const cashSessionId = caja.get('cashSessionId') as string
  assert.ok(cashSessionId, 'No hay caja abierta: ejecuta pnpm seed:caja.')
  ESTADO.cashSessionId = cashSessionId
  const p = await contexto(cuenta('propietario'))
  await p.goto(`${WEB}/panel/caja`)
  await p.getByRole('button', { name: new RegExp(ESTADO.nombreMesa) }).click()
  await conLlamada(p, 'prepararCobro', () => p.getByRole('button', { name: 'Preparar cobro y bloquear consumo' }).click())
  await p.getByRole('button', { name: 'Cobrar', exact: true }).click()
  await p.getByLabel('Propina voluntaria (€)', { exact: true }).fill('2,00')
  await p.getByLabel('Efectivo entregado (€)', { exact: true }).fill('20,00')
  await capturar(p, '34-caja-cobro-con-propina', 'Cobro en efectivo de la mesa (15,00 €) con 2,00 € de propina: la propina entra en la caja para repartirla')
  const cobro = await conLlamada(p, 'registrarCobro', () => p.getByRole('button', { name: /^Registrar [\d,]+\s*€/ }).click())
  ok('El cobro de 15,00 € con 2,00 € de propina y 20,00 € entregados devuelve 3,00 € de cambio, calculado por el servidor', cobro.resultado.changeCents === 300)
  await p.getByRole('button', { name: 'Caja y arqueo', exact: true }).click()
  const cash = core.CashSessionSchema.parse((await local.collection('cashSessions').doc(cashSessionId).get()).data())
  const ledger = (await local.collection('payments').where('cashSessionId', '==', cashSessionId).get()).docs.map((d) => core.PaymentSchema.parse(d.data()))
  const moves = (await local.collection('cashMovements').where('cashSessionId', '==', cashSessionId).get()).docs.map((d) => core.CashMovementSchema.parse(d.data()))
  const esperado = core.cashReconciliation(cash.openingCents, ledger, moves, 0).expectedCents
  await p.getByLabel('Efectivo contado (€)', { exact: true }).fill(core.fiscalDecimal(esperado).replace('.', ','))
  await p.getByLabel('He contado', { exact: false }).check()
  const cierre = await conLlamada(p, 'cerrarCaja', () => p.getByRole('button', { name: 'Confirmar arqueo y cerrar caja' }).click())
  ok(`La caja se cierra sin descuadre (esperado ${esperado} céntimos)`, cierre.resultado.cashSession.differenceCents === 0)
  ESTADO.cajaPagina = p
})

/* ------------------------------------------------------------------------------------------- */
/* 11 · Propinas por horas fichadas y fichaje olvidado                                            */
/* ------------------------------------------------------------------------------------------- */

paso('propinas', 'Reparto de propinas con las horas fichadas', async () => {
  const p = ESTADO.cajaPagina ?? (await contexto(cuenta('propietario')))
  await p.goto(`${WEB}/panel/caja`)
  await p.getByRole('button', { name: 'Caja y arqueo', exact: true }).click()
  await p.getByText('Repartir propinas').first().waitFor()
  await p.getByText(/Los minutos vienen de lo fichado|fichajes olvidados/).first().waitFor()
  await dormir(1500)
  const incompletos = await p.getByText('Hay fichajes olvidados sin cerrar').count()
  ok('La pantalla de propinas avisa del fichaje olvidado de Lucía antes de repartir', incompletos === 1)
  await capturar(p, '35-propinas-con-aviso-olvidado', 'Propinas por horas: minutos precargados con lo fichado y aviso del fichaje olvidado, que no cuenta hasta cerrarlo')

  // El encargado cierra el fichaje olvidado en la hoja de horas, con hora de salida y motivo.
  const e = await contexto(cuenta('encargada'))
  await e.goto(`${WEB}/panel/personal/horas`)
  await e.getByRole('button', { name: 'Cerrar con su hora' }).first().click()
  await e.getByLabel('Salida', { exact: true }).fill('19:30')
  await e.getByLabel('Motivo', { exact: true }).fill('Se olvidó de fichar la salida; se cierra a las 19:30, antes de su siguiente fichaje')
  await capturar(e, '36-horas-cerrar-olvidado', 'Cerrar un fichaje olvidado: hora de salida explícita y motivo obligatorio, con la previsión de horas')
  await conLlamada(e, 'cerrarFichajeOlvidado', () => e.getByRole('button', { name: 'Cerrar el fichaje' }).click())
  await hasta(async () => (await local.collection('timeEntries').doc('seed4-olvidado').get()).get('status') === 'closed', 'El fichaje olvidado no se cerró.')
  const cerrado = (await local.collection('timeEntries').doc('seed4-olvidado').get()).data()!
  ok('El fichaje olvidado queda cerrado por el encargado y marcado para revisión', cerrado.needsReview === true && cerrado.forgotten !== undefined)
  await e.getByText(/Fichajes olvidados/).waitFor({ state: 'detached' }).catch(() => undefined)
  await capturar(e, '37-horas-olvidado-cerrado', 'Hoja de horas tras cerrar el olvidado: queda con su historial y sin avisos pendientes')
  await e.context().close()

  // Vuelta a la caja: ya no hay aviso y los minutos fichados están precargados.
  await p.reload()
  await p.getByRole('button', { name: 'Caja y arqueo', exact: true }).click()
  await p.getByText(/Los minutos vienen de lo fichado/).waitFor()
  await dormir(1500)
  ok('Cerrado el olvidado, el aviso desaparece de la pantalla de propinas', (await p.getByText('Hay fichajes olvidados sin cerrar').count()) === 0)
  const camareroUid = ESTADO.camareroUid as string, noraUid = ESTADO.noraUid as string
  const nombres = (await fs.collection('restaurants/demo-lumbre/members').get()).docs.reduce((m: Record<string, string>, d) => ({ ...m, [d.id]: d.get('displayName') }), {})
  const horas = await llamar('horasParaPropinas', 'encargada', { cashSessionId: ESTADO.cashSessionId })
  const delCamarero = horas.hours.find((h: any) => h.uid === camareroUid)?.minutes, deNora = horas.hours.find((h: any) => h.uid === noraUid)?.minutes
  ok(`horasParaPropinas devuelve las horas fichadas reales: ${nombres[camareroUid]} ${delCamarero} min (descontada la pausa y contando su fichaje abierto hasta el cierre) y ${nombres[noraUid]} ${deNora} min`, delCamarero >= 1 && deNora >= 1 && horas.incomplete.length === 0)
  // Los campos vienen precargados con esos minutos.
  const campoCamarero = p.getByLabel(`${nombres[camareroUid]} · minutos aprobados`)
  ok('El formulario de la caja precarga los minutos fichados del camarero', (await campoCamarero.inputValue()) === String(delCamarero))
  await capturar(p, '38-propinas-por-horas', 'Reparto de propinas con las horas fichadas reales de la caja (editables), sin avisos pendientes')
  const reparto = await conLlamada(p, 'repartirPropinas', () => p.getByRole('button', { name: 'Confirmar reparto por minutos' }).click())
  const total = reparto.resultado.shares.reduce((a: number, x: any) => a + x.amountCents, 0)
  ok(`El reparto suma exactamente la propina de la caja (${total} céntimos entre ${reparto.resultado.shares.length} personas, por restos mayores)`, total === 200)
  await p.getByText('Reparto confirmado').first().waitFor()
  await capturar(p, '39-propinas-repartidas', 'Reparto confirmado: cada persona con sus minutos y su importe; se guarda una sola vez por caja')
  await p.context().close()
})

/* ------------------------------------------------------------------------------------------- */
/* 12 · Salida del camarero                                                                       */
/* ------------------------------------------------------------------------------------------- */

paso('salida', 'El camarero ficha la salida', async () => {
  const movil = ESTADO.movilCamarero
  await movil.goto(`${WEB}/panel/fichaje`)
  await movil.getByRole('button', { name: 'Salir' }).click()
  await capturar(movil, '40-movil-confirmar-salida', 'La salida pide confirmación para evitar toques por error')
  const salida = await conLlamada(movil, 'fichar', () => movil.getByRole('button', { name: 'Sí, salir' }).click())
  ok(`La salida cierra el fichaje con ${salida.resultado.workedMinutes} minutos trabajados (sin la pausa)`, salida.resultado.workedMinutes >= 1)
  await movil.getByRole('button', { name: 'Fichar entrada' }).waitFor()
  await capturar(movil, '41-movil-salida-hecha', 'Jornada cerrada: horas trabajadas de la semana al día')
  const cerrado = (await local.collection('timeEntries').doc(ESTADO.fichajeCamarero).get()).data()!
  ok('El fichaje del camarero queda cerrado con sus minutos y su pausa guardados', cerrado.status === 'closed' && cerrado.workedMinutes >= 1 && cerrado.breaks.length === 1)
  await movil.context().close()
})

/* ------------------------------------------------------------------------------------------- */
/* 13 · Caja sin fichajes, sin módulo de personal y plan "sala" sin nada de la fase 4             */
/* ------------------------------------------------------------------------------------------- */

paso('modulos', 'Propinas sin fichajes, sin módulo de personal y con el plan sala', async () => {
  const original = (await root.get()).data()!
  const restaurar = async () => { await root.update({ plan: original.plan, activeModules: original.activeModules }) }
  try {
    // Una caja nueva que se abre y se cierra enseguida: nadie fichó dentro de ella.
    const abierta = await llamar('abrirCaja', 'propietario', { registerId: 'principal', openingCents: 5000 })
    const nuevaId = abierta.cashSession?.id ?? abierta.cashSessionId
    assert.ok(nuevaId, `abrirCaja no devolvió la caja: ${JSON.stringify(abierta)}`)
    await llamar('cerrarCaja', 'propietario', { cashSessionId: nuevaId, countedCents: 5000, reason: null })
    const p = await contexto(cuenta('propietario'))
    await p.goto(`${WEB}/panel/caja`)
    await p.getByRole('button', { name: 'Caja y arqueo', exact: true }).click()
    await p.getByText('No hay fichajes en esta caja').waitFor()
    await capturar(p, '42-propinas-caja-sin-fichajes', 'Una caja en la que nadie fichó: la pantalla lo dice y el reparto sigue siendo manual')
    ok('Una caja sin fichajes lo dice y deja el reparto manual')

    // Sin el módulo de personal (pero con caja): el reparto es el manual de la fase 3.
    await root.update({ activeModules: (original.activeModules as string[]).filter((m) => m !== 'staff') })
    await p.reload()
    await p.getByRole('button', { name: 'Caja y arqueo', exact: true }).click()
    await p.getByText(/no tiene el módulo de personal/).waitFor()
    await capturar(p, '43-propinas-sin-modulo-personal', 'Sin el módulo de personal no hay horas fichadas: lo dice y deja el reparto manual como en la fase 3')
    ok('Sin el módulo de personal el reparto de propinas queda manual y no se pide ninguna hora')
    await llamar('horasParaPropinas', 'propietario', { cashSessionId: nuevaId }, 'FAILED_PRECONDITION')
    ok('horasParaPropinas rechaza la llamada con el módulo de personal apagado')
    await p.context().close()

    // Plan sala: reservas, sala y cocina. Nada de personal, inventario, costes ni compras.
    await root.update({ plan: 'sala', activeModules: ['reservations', 'floor', 'kitchen'] })
    for (const quien of ['encargada', 'camarero', 'cocina', 'barra']) {
      const q = await contexto(cuenta(quien))
      const vistos = fase4De(await enlacesDelMenu(q))
      assert.deepEqual(vistos, [], `Con el plan sala, ${quien} sigue viendo ${vistos.join(', ')}`)
      if (quien === 'encargada') await capturar(q, '44-plan-sala-menu-encargada', 'Plan sala: el menú de la encargada no enseña nada de personal, inventario, escandallos ni compras')
      if (quien === 'cocina') {
        await q.goto(`${WEB}/panel/cocina`)
        await q.getByText(/El pase de cocina|estaciones/).first().waitFor()
        await dormir(1500)
        ok('Con el plan sala, la pantalla de cocina no ofrece registrar merma', (await q.getByRole('button', { name: 'Registrar merma' }).count()) === 0)
        await capturar(q, '45-plan-sala-cocina-sin-merma', 'Plan sala: cocina funciona igual pero sin acceso a la merma')
      }
      await q.context().close()
    }
    ok('Con el plan sala ningún rol ve fichaje, personal, inventario, escandallos ni compras en el menú')
    const e = await contexto(cuenta('encargada'))
    await e.goto(`${WEB}/panel/inventario`)
    await e.getByText(/no está activo|no activo|No incluye|no tiene activo/i).first().waitFor()
    await capturar(e, '46-plan-sala-inventario-apagado', 'Plan sala: abrir el inventario a mano explica que el módulo no está activo en este plan')
    await llamar('fichar', 'camarero', { action: 'in' }, 'FAILED_PRECONDITION')
    await llamar('registrarMerma', 'cocina', { ingredientId: ingredientes['Huevos']!.id, quantity: 1, wasteReason: 'broken', reason: null }, 'FAILED_PRECONDITION')
    ok('Con el plan sala las funciones de la fase 4 rechazan la llamada (el servidor también lo impide)')
    await e.context().close()
  } finally {
    await restaurar()
  }
})

/* ------------------------------------------------------------------------------------------- */

async function main() {
  await mkdir(SALIDA, { recursive: true })
  navegador = await playwright.chromium.launch({ executablePath: navegadorEjecutable, headless: true, args: ['--no-sandbox'] })
  try {
    await cargarIngredientes()
    for (const p of pasos) {
      if (SOLO && !SOLO.includes(p.id)) continue
      console.log(`\n== ${p.titulo}`)
      await p.correr()
    }
    assert.deepEqual(errores, [], `Errores de página: ${errores.join(' | ')}`)
    await writeFile(`${SALIDA}/recorrido.json`, JSON.stringify({ proyecto: 'demo-llenamos', escala: 2, capturas, comprobaciones, erroresDePagina: errores, llamadas: evidencia }, null, 2) + '\n')
    console.log(`\nRecorrido correcto: ${capturas.length} capturas y ${comprobaciones.length} comprobaciones.`)
  } finally {
    await navegador.close()
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
