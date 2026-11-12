// Ajusta únicamente los datos del emulador de esta fila para las capturas de controles.
// El seed de fase 2 guarda autores nulos que su proyección de carta no admite todavía.
const { initializeApp } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')
if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8097') throw new Error('Usa el emulador del agente 2 en 127.0.0.1:8097.')
initializeApp({ projectId: 'demo-llenamos' })
async function main() {
  const db = getFirestore()
  const local = db.doc('restaurants/demo-lumbre/locations/centro')
  const collections = ['menuCategories', 'menuItems', 'dailyMenus', 'stations', 'settings']
  for (const name of collections) {
    const snapshot = await local.collection(name).get()
    const batch = db.batch()
    for (const doc of snapshot.docs) if (doc.get('updatedBy') === null) batch.update(doc.ref, { updatedBy: 'lumbre-propietario' })
    await batch.commit()
  }
  // Los cierres de revisión se vuelven a crear desde el formulario.
  await local.collection('settings').doc('reservations').update({ closures: [] })
  console.log('Datos de revisión listos, solo en el emulador del agente 2.')
}
main().catch(e => { console.error(e); process.exitCode = 1 })
