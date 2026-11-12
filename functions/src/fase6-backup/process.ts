import { onSchedule } from 'firebase-functions/v2/scheduler'
import { FieldPath } from 'firebase-admin/firestore'
import { db } from '../shared'
import { localOnly } from '../fase6-privacy/infra'
import { runContinuity } from './worker'
export async function continuityMaintenanceWork() {
  localOnly()
  let cursor:string|null = null
  do {
    let query = db.collection('restaurants').orderBy(FieldPath.documentId()).limit(25)
    if (cursor) query = query.startAfter(cursor)
    const docs = (await query.get()).docs
    for (const row of docs) await runContinuity(row.id)
    cursor = docs.length === 25 ? docs.at(-1)!.id : null
  } while (cursor)
}
export const copiasProgramadas = onSchedule({ region:'europe-west1',schedule:'every day 03:00',timeZone:'Europe/Madrid',secrets:['PLATFORM_DATA_KEY_V1'] },continuityMaintenanceWork)
