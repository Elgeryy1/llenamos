import { onSchedule } from 'firebase-functions/v2/scheduler'
import * as core from '@llenamos/core'
import { db, options } from '../shared'
import { context } from './context'
import { destinationLines, lineStatus, reconcile } from './service'

/** Planificador y script local comparten este procesador, sin endpoint administrativo público. */
export async function processTakeaways(rid?: string, lid?: string) {
  const restaurants = rid ? [db.doc(`restaurants/${rid}`)] : (await db.collection('restaurants').get()).docs.map(d => d.ref)
  let fired = 0
  for (const root of restaurants) {
    const locations = lid ? [root.collection('locations').doc(lid)] : (await root.collection('locations').get()).docs.map(d => d.ref)
    for (const local of locations) {
      fired += await db.runTransaction(async tx => {
        const c = await context(tx, root.id, local.id)
        if (!core.hasModule(c.restaurant, 'floor')) return 0
        let count = 0
        for (const take of c.rows.takeaways.values()) {
          if (take.status !== 'accepted') continue
          for (const line of core.dueTakeawayLines(destinationLines(c, null, take.id), c.now)) {
            lineStatus(c, line, 'fired'); count++
          }
        }
        if (count) { reconcile(c); c.flush('orderLine.statusChanged', 'Platos para llevar marchados a su hora.') }
        return count
      })
    }
  }
  return { fired }
}
export const marcharParaLlevar = onSchedule({ ...options, schedule: 'every 1 minutes', timeZone: 'Europe/Madrid' }, () => processTakeaways().then(() => undefined))
