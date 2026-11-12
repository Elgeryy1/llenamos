import { initializeApp, getApps } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

async function main() {
if (process.env.GCLOUD_PROJECT !== 'demo-llenamos' || !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')) throw new Error('Este procesador solo admite los emuladores locales de demo-llenamos.')
if (!getApps().length) initializeApp({ projectId: 'demo-llenamos' })
const { processSafely } = await import('../functions/src/fase3-print/triggers')
const { expireLeases } = await import('../functions/src/fase3-print/queue')
const db = getFirestore()
const [restaurantId, locationId] = process.argv.slice(2)
if (!restaurantId || !locationId || restaurantId.includes('/') || locationId.includes('/')) throw new Error('Indica restaurantId y locationId válidos.')
const expired = await expireLeases({ restaurantId,locationId })
const requests = await db.collection(`restaurants/${restaurantId}/locations/${locationId}/printRequests`).where('status','in',['queued','not_configured']).limit(100).get()
for (const r of requests.docs) await processSafely({ restaurantId,locationId },r.id)
console.log(`Leases caducados: ${expired}. Peticiones revisadas: ${requests.size}. Consulta la proyección de estado; esto no confirma impresión.`)

}
main().catch(error => { console.error(error instanceof Error ? error.message : "No se pudo completar la prueba local."); process.exitCode = 1 })
