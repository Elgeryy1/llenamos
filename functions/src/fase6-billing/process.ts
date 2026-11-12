import { FieldPath, Timestamp } from 'firebase-admin/firestore'
import { db } from '../shared'
import { refreshPlatformAccess } from './context'

/** Páginas estables por id. Cada restaurante tiene su propia transacción y reevaluación. */
export async function processSubscriptions(now = Date.now()) {
  const health = db.doc('platformWorkers/billing'), startedAt = Timestamp.fromMillis(now)
  let cursor: string | null = null, evaluated = 0
  await health.set({ status: 'running', startedAt }, { merge: true })
  try {
    while (true) {
      const base = db.collection('restaurants').orderBy(FieldPath.documentId()).limit(100)
      const page = await (cursor ? base.startAfter(cursor) : base).get()
      if (page.empty) break
      for (const row of page.docs) if (row.get('entitlementVersion')) {
        await db.runTransaction(async tx => { const access = await refreshPlatformAccess(tx, row.id, now); access?.commit() })
        evaluated++
      }
      cursor = page.docs.at(-1)!.id
    }
    await health.set({ status: 'completed', completedAt: Timestamp.now(), evaluated, error: null }, { merge: true })
    return { evaluated }
  } catch (error) {
    await health.set({ status: 'failed', failedAt: Timestamp.now(), error: 'No se ha podido reevaluar el acceso de las suscripciones.' }, { merge: true })
    throw error
  }
}
