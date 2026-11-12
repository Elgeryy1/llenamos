/** Procesos de personal (fase 4). */
import { onSchedule } from 'firebase-functions/v2/scheduler'
import * as core from '@llenamos/core'
import { db, options } from '../shared'
import { col, loadStaffSettings, openContext } from './context'


/**
 * Marca como olvidados los fichajes abiertos que pasan el límite de los ajustes y avisa al
 * encargado en la actividad. No cierra nada ni inventa horas: lo cierra un encargado.
 */
export async function reviewOpenEntries(now = Date.now(), only?: string) {
  let marked = 0
  const restaurants = only ? [await db.doc(`restaurants/${only}`).get()] : (await db.collection('restaurants').get()).docs
  for (const r of restaurants) {
    if (!r.exists) continue
    if (!core.hasModule(r.data()!, 'staff')) continue
    for (const l of (await r.ref.collection('locations').get()).docs) {
      const open = await l.ref.collection('timeEntries').where('status', '==', 'open').get()
      if (open.empty) continue
      const settingsSnap = await l.ref.collection('settings').doc('staff').get()
      const settings = settingsSnap.exists ? core.StaffSettingsSchema.parse(settingsSnap.data()) : core.defaultStaffSettings()
      const entries = open.docs.map((d) => ({ ...core.TimeEntrySchema.parse(d.data()), id: d.id }))
      for (const id of core.findForgottenEntries(entries, now, settings)) {
        const done = await db.runTransaction(async (tx) => {
          const c = await openContext(tx, { rid: r.id, lid: l.id, now })
          const [snap, limits] = await Promise.all([tx.get(col(c, 'timeEntries').doc(id)), loadStaffSettings(c)])
          if (!snap.exists) return false
          const entry = core.TimeEntrySchema.parse(snap.data())
          // Se vuelve a comprobar dentro de la transacción: pudo cerrarse mientras tanto.
          if (core.findForgottenEntries([{ ...entry, id }], now, limits).length === 0) return false
          const member = await tx.get(c.root.collection('members').doc(entry.uid))
          c.update(snap.ref, { forgotten: true, revision: entry.revision + 1 })
          c.audit('staff.entry_forgotten', `Fichaje sin cerrar de ${member.exists ? String(member.get('displayName')) : 'una persona'}.`, { entryId: id, uid: entry.uid, startAt: entry.startAt })
          c.flush()
          return true
        }, { maxAttempts: 5 })
        if (done) marked++
      }
    }
  }
  return { marked }
}

export const revisarFichajesAbiertos = onSchedule({ ...options, schedule: 'every 15 minutes', timeoutSeconds: 300 }, async () => { await reviewOpenEntries() })
