import { FieldPath, Timestamp } from 'firebase-admin/firestore'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { db, options } from './shared'
import { processSubscriptions } from './fase6-billing/process'
import { processPlatformWebhooks } from './fase6-api/events'

export const suscripcionesProgramadas = onSchedule({ ...options, schedule: 'every 5 minutes', maxInstances: 1, timeoutSeconds: 540 }, async () => { await processSubscriptions() })

export async function processAllPlatformWebhooks() {
  let after: string | null = null, failed = 0, processed = 0
  do {
    let query = db.collection('restaurants').orderBy(FieldPath.documentId()).limit(50)
    if (after) query = query.startAfter(after)
    const page = await query.get()
    if (page.empty) break
    for (const row of page.docs) {
      try { await processPlatformWebhooks(row.id); processed++ }
      catch { failed++ }
    }
    after = page.docs.at(-1)!.id
  } while (after)
  await db.doc('platformWorkers/webhooks').set({ completedAt: Timestamp.now(), processed, failed, status: failed ? 'failed' : 'completed' }, { merge: true })
  if (failed) throw new Error('Hay entregas de plataforma pendientes de revisar; consulta la salud del trabajador.')
}
export const integracionesProgramadas = onSchedule({ ...options, schedule: 'every 5 minutes', maxInstances: 1, timeoutSeconds: 540, secrets: ['PLATFORM_API_MASTER_KEY'] }, processAllPlatformWebhooks)
