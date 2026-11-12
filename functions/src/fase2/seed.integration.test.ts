import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { FieldValue } from 'firebase-admin/firestore'
import { db } from '../shared'
import { seedFase2 } from '../../../scripts/seed-fase2'
import { publicMenuId } from '@llenamos/core'

const enabled = process.env.TEST_FIREBASE_EMULATORS === '1' && process.env.GCLOUD_PROJECT === 'demo-llenamos' && !!process.env.FIRESTORE_EMULATOR_HOST
describe.skipIf(!enabled)('Seed de carta en el emulador', () => {
  const target = { restaurantId: `seed-fase2-${randomUUID()}`, locationId: 'centro' }
  const root = db.doc(`restaurants/${target.restaurantId}`), local = root.collection('locations').doc(target.locationId)
  afterAll(async () => {
    await db.recursiveDelete(root)
    await db.doc(`publicMenus/${publicMenuId(root.id, local.id)}`).delete()
    await db.doc(`publicRestaurants/${target.restaurantId}`).delete()
  }, 60000)
  it('no reescribe cartas iguales ni altera servicio, secretos o fechas', async () => {
    await root.set({ name: 'Prueba del seed', slug: target.restaurantId, currency: 'EUR', locale: 'es', isDemo: true, brandColor: '#f0a35e', timezone: 'Europe/Madrid', plan: 'sala', activeModules: ['floor','kitchen'] }, { merge: true })
    await local.set({ name: 'Centro' }, { merge: true })
    const secret = local.collection('tableTokens').doc('no-tocar')
    await secret.set({ tokenHash: 'se-conserva', rotatedAt: FieldValue.serverTimestamp() })
    await seedFase2(db, target)
    const snapshot = async () => {
      const rows = await Promise.all(['menuCategories','menuItems','dailyMenus','stations','settings'].map(name => local.collection(name).get()))
      return JSON.stringify([...rows.flatMap(rows => rows.docs.map(d => ({ path: d.ref.path, data: d.data() }))), (await db.doc(`publicMenus/${publicMenuId(root.id, local.id)}`).get()).data()])
    }
    const before = await snapshot()
    await seedFase2(db, target)
    expect(await snapshot()).toBe(before)
    expect((await secret.get()).get('tokenHash')).toBe('se-conserva')
    await secret.delete()
  }, 30000)
})
