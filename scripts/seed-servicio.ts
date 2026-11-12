import { initializeApp } from 'firebase-admin/app'
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore'
import { REFERENCE_ALPHABET, DIAS_SEMANA, diaSemana, horaAMinutos, horaLocal, instanteDeHoraLocal, customerIdFor, reservationForWrite, ReservationSchema, sha256Hex, type ReservationSource, type ReservationStatus } from '../packages/core/src/index'

// Un servicio lleno hoy, en los turnos de comida y cena, para ver el panel como en un día de
// verdad (capturas, demos y pruebas de diseño). Lo ya pasado sale terminado, lo de ahora
// sentado (alguna mesa va tarde) y lo que viene confirmado. Si el local no abre hoy, abre
// hoy con los turnos de la demo. Va encima de `pnpm seed` y se puede repetir: borra y rehace
// solo las reservas `servicio-*`. Solo contra los emuladores.
process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8085'
initializeApp({ projectId: 'demo-llenamos' })
const db = getFirestore()
const restaurant = db.doc('restaurants/demo-lumbre')
const location = restaurant.collection('locations').doc('centro')

const MIN = 60_000
const NOMBRES = [
  'Laia Ferrer', 'Marc Vidal', 'Lucía Romero', 'Pau Serra', 'Carmen Ortiz', 'Jordi Casas', 'Elena Navarro', 'Sergi Mas',
  'Paula Gil', 'Oriol Font', 'Marta Ibáñez', 'Hugo Molina', 'Clara Roig', 'Iván Prieto', 'Núria Bosch', 'Daniel Vega',
  'Sofía Reyes', 'Albert Pons', 'Irene Campos', 'Xavi Sala', 'Andrea Lozano', 'Bernat Riera', 'Julia Cano', 'Raúl Pastor',
  'Mireia Coll', 'Óscar Méndez', 'Alba Soler', 'Toni Vila', 'Rocío Herrera', 'Gerard Puig',
]
const NOTAS = ['Alergia a los frutos secos', 'Celíaca', 'Cumpleaños, traen tarta', 'Necesitan trona', 'Mesa tranquila si puede ser', '', '', '', '', '', '']
const ORIGEN: ReservationSource[] = ['web', 'web', 'phone', 'web', 'widget', 'phone', 'walk_in', 'web']

const ref = (n: number) => 'SV' + [3, 2, 1, 0].map((s) => REFERENCE_ALPHABET[Math.floor(n / REFERENCE_ALPHABET.length ** s) % REFERENCE_ALPHABET.length]).join('')
const duracion = (p: number) => (p <= 2 ? 90 : p <= 4 ? 105 : 120)

type Cambio = { from: ReservationStatus; to: ReservationStatus; at: number; by: string | null; reason: string | null }

async function guardar(n: number, tableId: string, start: number, dur: number, party: number, status: ReservationStatus, history: Cambio[]) {
  const name = NOMBRES[n % NOMBRES.length]!
  const phone = `+346${String(10_000_000 + n * 7919).slice(0, 8)}`
  const customerId = customerIdFor('demo-lumbre', phone)
  const reference = ref(n)
  const source = ORIGEN[n % ORIGEN.length]!
  const r = ReservationSchema.parse({
    guestName: name, phone, email: null, language: n % 6 === 5 ? 'en' : n % 6 === 4 ? 'ca' : 'es', partySize: party,
    startAt: start, durationMinutes: dur, status, tableIds: [tableId], suggestedTableIds: [], suggestionReason: null, source,
    notes: n % 9 === 0 ? 'Habitual, le gusta la mesa de la ventana' : '', guestNotes: NOTAS[n % NOTAS.length]!,
    customerId, reference, manageTokenHash: sha256Hex(`servicio-${n}`),
    deposit: { status: 'none', amountCents: 0, checkoutSessionId: null }, history,
    createdBy: source === 'web' || source === 'widget' ? null : 'lumbre-encargado',
  })
  await location.collection('reservations').doc(`servicio-${n}`).set({ ...reservationForWrite(r, Timestamp.fromMillis), createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() })
  await restaurant.collection('reservationReferences').doc(reference).set({ locationId: 'centro', reservationId: `servicio-${n}` })
  await restaurant.collection('customers').doc(customerId).set({
    name, phone, email: null, language: r.language, visits: 1 + (n % 4), cancellations: 0, noShows: status === 'no_show' ? 1 : 0,
    lastVisitAt: Timestamp.fromMillis(start - 20 * 24 * 60 * MIN), notes: '',
    allergies: r.guestNotes.startsWith('Alergia') ? 'Frutos secos' : r.guestNotes === 'Celíaca' ? 'Gluten' : '',
    tags: n % 9 === 0 ? ['habitual'] : [],
  }, { merge: true })
}

async function main() {
  const viejas = await location.collection('reservations').where('reference', '>=', 'SV').where('reference', '<', 'SW').get()
  const batch = db.batch()
  for (const d of viejas.docs) {
    batch.delete(d.ref)
    batch.delete(restaurant.collection('reservationReferences').doc(d.get('reference')))
  }
  await batch.commit()

  const tables = (await location.collection('tables').get()).docs
    .filter((t) => t.get('enabled'))
    .map((t) => ({ id: t.id, seats: t.get('seats') as number }))
    .sort((a, b) => a.id.localeCompare(b.id, 'es', { numeric: true }))

  const now = Math.floor(Date.now() / (5 * MIN)) * 5 * MIN
  const settingsRef = location.collection('settings').doc('reservations')
  const settings = (await settingsRef.get()).data() as { timezone: string; week: Record<string, Array<{ name: string; from: string; lastEntry: string }>> }
  const tz = settings.timezone
  const today = horaLocal(now, tz).fecha
  const dayKey = (['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const)[DIAS_SEMANA.indexOf(diaSemana(today))]!
  let shifts = settings.week[dayKey] ?? []
  if (shifts.length === 0) {
    shifts = [{ name: 'Comida', from: '13:00', lastEntry: '15:30' }, { name: 'Cena', from: '20:00', lastEntry: '22:30' }]
    await settingsRef.update({ [`week.${dayKey}`]: shifts })
  }

  let n = 0
  for (const shift of shifts) {
    const from = instanteDeHoraLocal(today, horaAMinutos(shift.from as never), tz)!
    const last = instanteDeHoraLocal(today, horaAMinutos(shift.lastEntry as never), tz)!
    for (const [ti, t] of tables.entries()) {
      // Cada mesa abre a una hora distinta y encadena reservas hasta la última entrada.
      let start = from + ((ti * 25) % 75) * MIN
      while (start <= last) {
        const party = Math.max(1, Math.min(t.seats, [2, 2, 3, 4, 2, 5, 6, 4][(n + ti) % 8]!))
        const dur = duracion(party)
        const end = start + dur * MIN
        let status: ReservationStatus
        const history: Cambio[] = []
        if (end <= now) status = n % 11 === 4 ? 'no_show' : 'finished'
        else if (start <= now) status = ti % 6 === 3 && now - start < 35 * MIN ? 'confirmed' : 'seated'
        else status = n % 5 === 2 ? 'pending' : 'confirmed'
        if (status === 'seated' || status === 'finished') history.push({ from: 'confirmed', to: 'seated', at: start + ((n * 3) % 9) * MIN, by: 'lumbre-camarero', reason: null })
        if (status === 'finished') history.push({ from: 'seated', to: 'finished', at: end - ((n * 7) % 15) * MIN, by: 'lumbre-camarero', reason: null })
        if (status === 'no_show') history.push({ from: 'confirmed', to: 'no_show', at: start + 20 * MIN, by: 'lumbre-encargado', reason: null })
        await guardar(n, t.id, start, dur, party, status, history)
        n++
        start = end + (10 + ((n * 13) % 35)) * MIN
      }
    }
  }
  console.log(`Servicio de demostración: ${n} reservas hoy (${today}) en ${tables.length} mesas.`)
}
main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => db.terminate())
