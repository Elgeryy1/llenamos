import { getApps, initializeApp } from 'firebase-admin/app'
import { FieldValue, getFirestore, type Firestore } from 'firebase-admin/firestore'
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'
import { demoMenu, buildPublicMenu, publicMenuId, hasModule } from '../packages/core/src/index'

/** Idempotente: no rota QR ni toca pedidos, mesas abiertas o datos del servicio. */
export async function seedFase2(db: Firestore, target = { restaurantId: 'demo-lumbre', locationId: 'centro' }) {
  if (!process.env.FIRESTORE_EMULATOR_HOST || (process.env.GCLOUD_PROJECT ?? getApps()[0]?.options.projectId) !== 'demo-llenamos') throw new Error('El seed de sala solo funciona en demo-llenamos con el emulador de Firestore indicado.')
  const root = db.doc(`restaurants/${target.restaurantId}`), local = root.collection('locations').doc(target.locationId)
  const [restaurant, location] = await Promise.all([root.get(), local.get()])
  if (!restaurant.exists || !location.exists) throw new Error('Ejecuta primero el seed principal.')
  const demo = demoMenu()
  async function upsert(path: string, data: Record<string, unknown>) {
    await db.runTransaction(async tx => {
      const ref = db.doc(path), old = await tx.get(ref)
      if (old.exists && old.get('updatedBy') !== null && Object.entries(data).every(([key, value]) => isDeepStrictEqual(old.get(key), value))) return
      tx.set(ref, { ...data, updatedBy: FieldValue.delete(), ...(old.exists ? {} : { createdAt: FieldValue.serverTimestamp() }), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    })
  }
  for (const [collection, rows] of Object.entries({ menuCategories: demo.categories, menuItems: demo.items, dailyMenus: demo.dailyMenus, stations: demo.stations })) {
    for (const [id, data] of Object.entries(rows)) await upsert(`${local.path}/${collection}/${id}`, data)
  }
  await upsert(`${local.path}/settings/floor`, demo.settings)
  const menu = buildPublicMenu({ restaurantId: root.id, locationId: local.id, restaurantName: restaurant.get('name'), locationName: location.get('name'), brandColor: restaurant.get('brandColor'), timezone: restaurant.get('timezone'), ...demo, floorModule: hasModule(restaurant.data()!, 'floor') })
  await upsert(`publicMenus/${publicMenuId(root.id, local.id)}`, menu)
  console.log('Carta de demostración cargada con categorías, platos, menú del día y tres estaciones.')
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Indica FIRESTORE_EMULATOR_HOST del emulador local.')
  const app = getApps()[0] ?? initializeApp({ projectId: 'demo-llenamos' })
  const db = getFirestore(app)
  seedFase2(db).catch(error => { console.error(error); process.exitCode = 1 }).finally(() => db.terminate())
}
