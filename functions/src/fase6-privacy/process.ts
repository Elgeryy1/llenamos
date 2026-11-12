import { onSchedule } from 'firebase-functions/v2/scheduler'
import { FieldPath } from 'firebase-admin/firestore'
import { db } from '../shared'
import { localOnly } from './infra'
import { processPrivacyJobs,runRetention } from './worker'
/** El emulador no ejecuta el planificador: scripts/privacidad-local.ts invoca este mismo trabajo. */
export async function privacyMaintenanceWork() {
  localOnly()
  let cursor:string|null = null
  do {
    let query = db.collection('restaurants').orderBy(FieldPath.documentId()).limit(25)
    if (cursor) query = query.startAfter(cursor)
    const docs = (await query.get()).docs
    for (const row of docs) { await runRetention(row.id);await processPrivacyJobs(row.id) }
    cursor = docs.length === 25 ? docs.at(-1)!.id : null
  } while (cursor)
}
export const privacidadProgramada = onSchedule({ region:'europe-west1',schedule:'every day 02:00',timeZone:'Europe/Madrid',secrets:['PLATFORM_DATA_KEY_V1'] },privacyMaintenanceWork)
