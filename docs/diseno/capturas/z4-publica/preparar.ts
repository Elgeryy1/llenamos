/** Datos de demostración para las capturas. Solo escribe en el emulador de la fila 2. */
import { writeFileSync } from 'node:fs'
import { initializeApp } from 'firebase-admin/app'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'
import { defaultReservationSettings, horaLocal, instanteDeHoraLocal, sumarDias, customerIdFor, sha256Hex, reservationForWrite, ReservationSchema, type Reservation } from '../../../../packages/core/src/index'

if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8097') throw new Error('Usa el emulador Firestore de la fila 2.')
initializeApp({ projectId: 'demo-llenamos' })
const db = getFirestore()
const today = horaLocal(Date.now(), 'Europe/Madrid').fecha
const date = sumarDias(today, 2)
const start = instanteDeHoraLocal(date, 13 * 60, 'Europe/Madrid')!
const slug = `lumbre-publica-${Date.now()}`
const path = `restaurants/${slug}/locations/centro`

async function call(name: string, data: unknown) {
  const res = await fetch(`http://127.0.0.1:5013/demo-llenamos/europe-west1/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }), signal: AbortSignal.timeout(25000) })
  const result = await res.json() as { result?: Record<string, unknown>; error?: unknown }
  if (!res.ok || !result.result) throw new Error(`${name}: ${JSON.stringify(result.error)}`)
  return result.result
}
async function until<T>(read: () => Promise<T | null | undefined | false>): Promise<T> {
  for (let i = 0; i < 120; i++) {
    const value = await read()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('El disparador no terminó en un minuto.')
}
const token = (ref: string) => `z4${ref}`.padEnd(43, 'a')
const href = (ref: string) => `/r/${slug}/reserva/${ref}?t=${token(ref)}&lang=es`
async function reservation(reference: string, status: Reservation['status'], deposit: Reservation['deposit'], offset = 0) {
  const r: Reservation = {
    guestName: 'Clara Vidal', phone: '+34612345678', email: 'clara@example.test', language: 'es', partySize: 4,
    startAt: start + offset * 86_400_000, durationMinutes: 90, status, tableIds: status === 'confirmed' ? ['mesa'] : [],
    suggestedTableIds: [], suggestionReason: null, source: 'web', notes: '', guestNotes: 'Una trona, por favor.',
    customerId: customerIdFor(slug, '+34612345678'), reference, manageTokenHash: sha256Hex(token(reference)),
    deposit, history: [], createdBy: null,
  }
  await db.doc(`${path}/reservations/${reference}`).set({ ...reservationForWrite(ReservationSchema.parse(r), Timestamp.fromMillis), createdAt: Timestamp.now(), updatedAt: Timestamp.now() })
  await db.doc(`restaurants/${slug}/reservationReferences/${reference}`).set({ locationId: 'centro', reservationId: reference })
}
async function main() {
  const s = defaultReservationSettings()
  s.publicBooking = true; s.autoConfirm = true; s.minNoticeMinutes = 0; s.waitlist.enabled = true
  for (const d of Object.keys(s.week) as (keyof typeof s.week)[]) s.week[d] = [{ name: 'Comida', from: '13:00', lastEntry: '15:30' }, { name: 'Cena', from: '20:00', lastEntry: '22:30' }]
  await db.recursiveDelete(db.doc(`restaurants/${slug}`))
  await db.doc(`restaurants/${slug}`).set({ name: 'Taberna Lumbre', slug, brandColor: '#8fc7a0', currency: 'EUR', timezone: 'Europe/Madrid', locale: 'es', isDemo: true, plan: 'reservas', activeModules: ['reservations'] })
  await db.doc(path).set({ name: 'Gràcia', slug: 'centro', address: 'Carrer de la Llibertat, 12', city: 'Barcelona', phone: '+34930000000' })
  await db.doc(`${path}/tables/mesa`).set({ name: 'Mesa 1', areaId: 'sala', seats: 4, shape: 'rect', x: 10, y: 10, w: 20, h: 20, joinableWith: [], enabled: true })
  await db.doc(`${path}/settings/reservations`).set(s)
  await until(async () => (await db.doc(`publicRestaurants/${slug}`).get()).get('bookingEnabled'))
  const none = { status: 'none' as const, amountCents: 0, checkoutSessionId: null }
  await reservation('CRAR22', 'confirmed', none, 10)
  await reservation('PEND22', 'pending', none, 11)
  await reservation('SENA22', 'pending', { status: 'required', amountCents: 2000, checkoutSessionId: null }, 12)
  await reservation('RNAC22', 'pending', { status: 'not_configured', amountCents: 2000, checkoutSessionId: null }, 13)
  await reservation('RREN22', 'confirmed', none)
  await reservation('RREN23', 'confirmed', none, 1)

  // La oferta nace de una cancelación real y el enlace sale del mensaje capturado.
  async function offer(offset: number, phone: string, reference: string) {
    const entry = await call('apuntarseListaEspera', { slug, locationId: 'centro', date: sumarDias(date, offset), from: '13:00', to: '13:00', partySize: 4, guestName: 'Clara Vidal', phone, email: 'clara@example.test', language: 'es', website: '' })
    await db.doc(`${path}/reservations/${reference}`).update({ status: 'cancelled', updatedAt: Timestamp.now() })
    const link = await until(async () => {
      const msg = await db.doc(`restaurants/${slug}/messages/offer_${entry.waitlistId}_email`).get()
      return msg.get('status') === 'captured' && msg.get('data.offerUrl') as string
    })
    const url = new URL(link)
    if (url.origin !== 'http://localhost:3012') throw new Error('Arranca funciones con PUBLIC_APP_URL=http://localhost:3012.')
    return { href: url.pathname + url.search, id: String(entry.waitlistId) }
  }
  const valid = await offer(0, '+34612345671', 'RREN22')
  const expired = await offer(1, '+34612345672', 'RREN23')
  await db.doc(`${path}/waitlist/${expired.id}`).update({ 'offer.expiresAt': Timestamp.fromMillis(Date.now() - 60_000) })
  writeFileSync('/tmp/llenamos-z4-rutas.json', JSON.stringify({ slug, date, confirmed: href('CRAR22'), pending: href('PEND22'), deposit: href('SENA22'), inactive: href('RNAC22'), offer: valid.href, expired: expired.href }))
  console.log('Datos de Z4 preparados: marca verde, confirmada, pendiente, señal y dos ofertas reales.')
}
main().catch(e => { console.error(e); process.exitCode = 1 }).finally(() => db.terminate())
