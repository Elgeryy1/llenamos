// Datos locales de presentación para enseñar los estados de la lista de espera.
// Ejecutar después de los dos seeds. Nunca escribe fuera de los emuladores de la fila 5.
const assert = require('node:assert/strict')
assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8100')
const { initializeApp } = require('firebase-admin/app')
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore')
initializeApp({ projectId: 'demo-llenamos' })
const db = getFirestore()
async function main() {
  const ref = db.collection('restaurants/demo-lumbre/locations/centro/waitlist')
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const entries = [
    ['z3-oferta', 'Núria Vidal', 2, 'offered', 'web'],
    ['z3-espera', 'Familia Roca', 5, 'waiting', 'widget'],
    ['z3-reservada', 'Joan Puig', 3, 'booked', 'web'],
  ]
  for (const [id, guestName, partySize, status, source] of entries) {
    await ref.doc(id).set({ guestName, phone: '+34699222555', email: null, language: 'es', partySize, date, from: '20:00', to: '22:00', status, source, customerId: require('node:crypto').createHash('sha256').update('demo-lumbre:+34699222555').digest('hex').slice(0, 20), offer: status === 'offered' ? { startAt: Timestamp.fromDate(new Date(`${date}T21:00:00+01:00`)), expiresAt: Timestamp.fromMillis(Date.now() + 30 * 60_000), tokenHash: '0'.repeat(64) } : null, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() })
  }
  console.log('Tres entradas de demostración para los estados de la lista de espera, solo en la fila 5.')
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
