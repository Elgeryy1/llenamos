/**
 * Prueba con navegador del enlace de la lista de espera (`/r/[slug]/lista-espera/[waitlistId]?t=`).
 *
 * Solo contra emuladores y la web local. Monta un restaurante de prueba con la sala llena, apunta
 * a dos personas, cancela la reserva (el disparador ofrece el hueco), saca el enlace del mensaje
 * capturado y lo abre con Chromium:
 *   1. aceptar la oferta crea la reserva y lleva a «gestionar reserva»;
 *   2. una oferta pasada de `offerMinutes` enseña que ha caducado y no deja aceptar;
 *   3. un enlace sin código lo dice;
 *   4. sin Stripe, la web explica que el pago está inactivo y no ofrece pagar;
 *   5. el panel lee el Excel y muestra sus tres filas válidas (requiere `pnpm seed` antes).
 *
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8097 FUNCTIONS_EMULATOR_HOST=127.0.0.1:5013 WEB_URL=http://localhost:3012 \
 *   pnpm e2e:lista-espera
 *
 * Playwright no es dependencia del repositorio: se busca con `require('playwright')` y, si no
 * está, en la carpeta que diga `PLAYWRIGHT_DIR` (una cuyo `node_modules` tenga `playwright`; la web debe estar arrancada y con
 * `PUBLIC_APP_URL` de las funciones apuntando a esa misma dirección). `CHROMIUM_PATH` fija el Chromium si el de Playwright no es el que hay instalado.
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { initializeApp } from 'firebase-admin/app'
import { Timestamp, getFirestore } from 'firebase-admin/firestore'
import { CrearReservaPublicaOutputSchema, customerIdFor, defaultReservationSettings, horaLocal, instanteDeHoraLocal, reservationForWrite, sha256Hex, sumarDias } from '../packages/core/src/index'

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST, functionsHost = process.env.FUNCTIONS_EMULATOR_HOST, web = (process.env.WEB_URL ?? '').replace(/\/$/, '')
if (!firestoreHost || !functionsHost || !web) throw new Error('Indica FIRESTORE_EMULATOR_HOST, FUNCTIONS_EMULATOR_HOST y WEB_URL de tus emuladores y tu web.')
if (firestoreHost !== '127.0.0.1:8097' || functionsHost !== '127.0.0.1:5013' || !/^http:\/\/(localhost|127\.0\.0\.1):3012$/.test(web)) throw new Error('Esta prueba solo usa los puertos locales del agente 2.')
const captures = resolve('docs/diseno/capturas/pendientes')
mkdirSync(captures, { recursive: true })
initializeApp({ projectId: 'demo-llenamos' })
const db = getFirestore()

const requireFromHere = createRequire(resolve(process.cwd(), 'package.json'))
// Playwright se carga desde una instalación externa ya existente; no hay tipos locales
// porque añadirlo como dependencia del proyecto no forma parte del encargo.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { chromium } = ((): any => {
  try { return requireFromHere('playwright') } catch { return createRequire(resolve(process.env.PLAYWRIGHT_DIR ?? process.cwd(), 'package.json'))('playwright') }
})()

const rid = `e2e-le-${Date.now()}`, slug = rid, lid = 'centro', path = `restaurants/${rid}/locations/${lid}`
const startAt = instanteDeHoraLocal(sumarDias(horaLocal(Date.now(), 'Europe/Madrid').fecha, 2), 13 * 60, 'Europe/Madrid')!
const date = horaLocal(startAt, 'Europe/Madrid').fecha

async function call<T>(name: string, data: unknown): Promise<T> {
  const response = await fetch(`http://${functionsHost}/demo-llenamos/europe-west1/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) })
  const body = (await response.json()) as { result?: T; error?: { message: string } }
  if (!response.ok || body.result === undefined) throw new Error(`${name}: ${body.error?.message ?? response.status}`)
  return body.result
}
async function until<T>(what: string, read: () => Promise<T | null | false>, ms = 60000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > end) throw new Error(`Tiempo agotado esperando: ${what}`)
    await new Promise(r => setTimeout(r, 500))
  }
}
const check = (ok: unknown, what: string) => { if (!ok) throw new Error(`Falla: ${what}`); console.log(`ok · ${what}`) }
const join = async (guestName: string, phone: string) => (await call<{ waitlistId: string }>('apuntarseListaEspera', { slug, locationId: lid, date, from: '13:00', to: '13:00', partySize: 4, guestName, phone, email: `${guestName.toLowerCase()}@example.test`, language: 'es', website: '' })).waitlistId
async function offerLink(waitlistId: string): Promise<string> {
  const message = db.doc(`restaurants/${rid}/messages/offer_${waitlistId}_email`)
  const link = String(await until(`mensaje de oferta de ${waitlistId}`, async () => { const s = await message.get(); return s.get('status') === 'captured' && s.get('data.offerUrl') }))
  check(String((await message.get()).get('rendered.body')).includes(link), 'el texto capturado contiene el enlace completo')
  return link
}
const cancelBooking = async (id: string) => { await db.doc(`${path}/reservations/${id}`).update({ status: 'cancelled', updatedAt: Timestamp.now() }) }

async function seed() {
  const s = defaultReservationSettings()
  s.publicBooking = true; s.autoConfirm = true; s.minNoticeMinutes = 0; s.waitlist = { enabled: true, offerMinutes: 30 }
  for (const day of Object.keys(s.week) as (keyof typeof s.week)[]) s.week[day] = [{ name: 'comida', from: '13:00', lastEntry: '13:00' }]
  await db.doc(`restaurants/${rid}`).set({ name: 'Prueba lista de espera', slug, brandColor: '#f0a35e', currency: 'EUR', timezone: 'Europe/Madrid', locale: 'es', isDemo: true, plan: 'reservas', activeModules: ['reservations'] })
  await db.doc(path).set({ name: 'Centro', slug: lid, address: '', city: '', phone: '' })
  await db.doc(`${path}/settings/reservations`).set(s)
  await db.doc(`${path}/tables/t1`).set({ name: 'Mesa 1', areaId: 'sala', seats: 4, shape: 'rect', x: 0, y: 0, w: 10, h: 10, joinableWith: [], enabled: true })
  await db.doc(`publicRestaurants/${slug}`).set({ restaurantId: rid, name: 'Prueba lista de espera', brandColor: '#f0a35e', locale: 'es', timezone: 'Europe/Madrid', bookingEnabled: true, bookingDisabledReason: null, locations: [{ id: lid, name: 'Centro', address: '', city: '', phone: '' }], minPartySize: 1, maxPartySize: 12, maxAdvanceDays: 90, deposit: s.deposit, cancellationFreeUntilHours: 0 })
  const booked = { guestName: 'Ana', phone: '+34600000001', email: null, language: 'es' as const, partySize: 4, startAt, durationMinutes: 90, status: 'confirmed' as const, tableIds: ['t1'], suggestedTableIds: [], suggestionReason: null, source: 'web' as const, notes: '', guestNotes: '', customerId: customerIdFor(rid, '+34600000001'), reference: 'ABCD23', manageTokenHash: sha256Hex('test'), deposit: { status: 'none' as const, amountCents: 0, checkoutSessionId: null }, history: [], createdBy: null }
  await db.doc(`restaurants/${rid}/reservationReferences/ABCD23`).set({ locationId: lid, reservationId: 'book1' })
  await db.doc(`${path}/reservations/book1`).set({ ...reservationForWrite(booked, Timestamp.fromMillis), createdAt: Timestamp.now(), updatedAt: Timestamp.now() })
}

async function main() {
let browser
try {
  await seed()
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage()
  // La prueba falla si alguna pantalla intenta contactar con un proveedor real.
  await page.route(/https:\/\/(api\.stripe\.com|checkout\.stripe\.com|api\.resend\.com|graph\.facebook\.com)\//, () => { throw new Error('La prueba no admite proveedores reales.') })
  const luis = await join('Luis', '+34600000002'), marta = await join('Marta', '+34600000003')

  // 1. Aceptar la oferta desde el enlace.
  await cancelBooking('book1')
  const link = new URL(await offerLink(luis))
  check(link.pathname === `/r/${slug}/lista-espera/${luis}` && link.searchParams.get('t'), `el mensaje lleva el enlace ${link.pathname}`)
  check(link.origin === web, 'el enlace capturado apunta a la web local configurada')
  await page.goto(link.href)
  await page.getByRole('heading', { name: 'Se ha liberado una mesa' }).waitFor()
  await page.screenshot({ path: resolve(captures, 'oferta-movil.png'), fullPage: true, style: "nextjs-portal { display: none !important; }" })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: resolve(captures, 'oferta-escritorio.png'), fullPage: true, style: "nextjs-portal { display: none !important; }" })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Aceptar la mesa' }).click()
  await page.waitForURL(/\/reserva\/[A-Z0-9]{6}\?/)
  check(true, `aceptar lleva a gestionar la reserva (${new URL(page.url()).pathname})`)
  await page.getByText('Luis').first().waitFor()
  const accepted = (await db.collection(`${path}/reservations`).where('source', '==', 'waitlist').get()).docs[0]
  check(accepted && accepted.get('guestName') === 'Luis' && accepted.get('status') === 'confirmed', 'se crea la reserva confirmada de Luis (origen lista de espera)')
  check((await db.doc(`${path}/waitlist/${luis}`).get()).get('status') === 'booked', 'la entrada pasa a reservada')
  await page.screenshot({ path: resolve(captures, 'oferta-aceptada-movil.png'), fullPage: true, style: "nextjs-portal { display: none !important; }" })

  // 2. Una oferta pasada de `offerMinutes` caduca: la página lo dice y no deja aceptar.
  await cancelBooking(accepted!.id)
  const second = new URL(await offerLink(marta))
  await db.doc(`${path}/waitlist/${marta}`).update({ 'offer.expiresAt': Timestamp.fromMillis(Date.now() - 1000) })
  await page.goto(second.href)
  await page.getByRole('button', { name: 'Aceptar la mesa' }).click()
  await page.getByText('La oferta ha caducado o el enlace no es válido.').waitFor()
  check(await page.getByRole('button', { name: 'Aceptar la mesa' }).count() === 0, 'la oferta caducada lo dice y quita el botón de aceptar')
  check((await db.collection(`${path}/reservations`).where('source', '==', 'waitlist').where('status', '==', 'confirmed').get()).size === 0, 'no se crea ninguna reserva con la oferta caducada')
  await page.screenshot({ path: resolve(captures, 'oferta-caducada-movil.png'), fullPage: true, style: "nextjs-portal { display: none !important; }" })

  // 3. Sin código en el enlace.
  await page.goto(`${web}/r/${slug}/lista-espera/${marta}`)
  await page.getByText('Al enlace le falta el código de la reserva.').waitFor()
  check(await page.getByRole('button', { name: 'Aceptar la mesa' }).count() === 0, 'un enlace sin código no ofrece aceptar')

  // 4. Sin clave de Stripe, la web explica la señal y mantiene la reserva pendiente.
  await db.doc(`${path}/settings/reservations`).update({ deposit: { mode: 'perPerson', amountCents: 500, fromPartySize: 1 } })
  const unpaid = CrearReservaPublicaOutputSchema.parse(await call('crearReservaPublica', { slug, locationId: lid, date, time: '13:00', partySize: 4, guestName: 'Berta', phone: '+34600000004', language: 'es', acceptPolicy: true, website: '' }))
  check(unpaid.status === 'pending' && unpaid.deposit.status === 'not_configured', 'sin Stripe la señal está sin configurar y la reserva pendiente')
  await page.goto(`${web}/r/${slug}/reserva/${unpaid.reference}?t=${unpaid.manageToken}`)
  await page.getByRole('heading', { name: 'Reserva pendiente', exact: true }).waitFor()
  await page.getByText(/el pago en línea no está activo/).waitFor()
  check(await page.getByRole('button', { name: 'Pagar la señal' }).count() === 0, 'la web explica que falta configurar Stripe y no ofrece pagar')
  await page.screenshot({ path: resolve(captures, 'senal-no-configurada-movil.png'), fullPage: true, style: "nextjs-portal { display: none !important; }" })

  // 5. Excel real en Chromium, con el SDK cliente autenticado contra nuestros emuladores.
  await page.goto(`${web}/entrar`)
  await page.getByLabel('Correo', { exact: true }).fill('propietario@lumbre.test')
  await page.getByLabel('Contraseña', { exact: true }).fill('Llenamos2026!')
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
  await page.waitForURL(/\/panel/)
  await page.goto(`${web}/panel/importar`)
  await page.getByLabel('Archivo de reservas (Excel o CSV)').setInputFiles(resolve('tests/fixtures/reservas-ejemplo.xlsx'))
  await page.getByText('Ana García', { exact: true }).waitFor()
  await page.getByText('Núria Vidal', { exact: true }).waitFor()
  check(await page.getByRole('button', { name: 'Importar 3 reservas', exact: true }).isEnabled(), 'Chromium lee el Excel y muestra tres reservas con fechas y horas convertidas')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: resolve(captures, 'importar-excel-escritorio.png'), fullPage: true, style: "nextjs-portal { display: none !important; }" })
  await page.setViewportSize({ width: 1180, height: 820 })
  await page.screenshot({ path: resolve(captures, 'importar-excel-tableta.png'), fullPage: true, style: "nextjs-portal { display: none !important; }" })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: resolve(captures, 'importar-excel-movil.png'), fullPage: true, style: "nextjs-portal { display: none !important; }" })
  console.log('Todo bien.')
} finally {
  await browser?.close()
  await db.recursiveDelete(db.doc(`restaurants/${rid}`))
  await db.doc(`publicRestaurants/${slug}`).delete()
}
}
main().catch(e => { console.error(e); process.exitCode = 1 })
