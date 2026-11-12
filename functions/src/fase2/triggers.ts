import { isDeepStrictEqual } from 'node:util'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { FieldValue } from 'firebase-admin/firestore'
import * as core from '@llenamos/core'
import { db, options } from '../shared'
import { context } from './context'
import { reconcile } from './service'

/** Publica el estado actual, nunca la carga antigua del evento que provocó la ejecución. */
export async function syncPublicMenu(rid: string, lid: string) {
  const root = db.doc(`restaurants/${rid}`), local = root.collection('locations').doc(lid)
  const projection = db.doc(`publicMenus/${core.publicMenuId(rid, lid)}`)
  await db.runTransaction(async tx => {
    const lock = local.collection('serviceLocks').doc('publication')
    const [r, l, lockDoc, floor, settings, previous] = await Promise.all([tx.get(root), tx.get(local), tx.get(lock), tx.get(local.collection('settings').doc('floor')), tx.get(local.collection('settings').doc('reservations')), tx.get(projection)])
    if (!r.exists || !l.exists) { tx.delete(projection); return }
    const [categories, items, menus] = await Promise.all(['menuCategories', 'menuItems', 'dailyMenus'].map(name => tx.get(local.collection(name))))
    const data = core.buildPublicMenu({ restaurantId: rid, locationId: lid, restaurantName: r.get('name'), locationName: l.get('name'), brandColor: r.get('brandColor'),
      timezone: settings.exists ? core.ReservationSettingsSchema.parse(settings.data()).timezone : r.get('timezone'),
      categories: Object.fromEntries(categories!.docs.map(d => [d.id, core.MenuCategorySchema.parse(d.data())])),
      items: Object.fromEntries(items!.docs.map(d => [d.id, core.MenuItemSchema.parse(d.data())])),
      dailyMenus: Object.fromEntries(menus!.docs.map(d => [d.id, core.DailyMenuSchema.parse(d.data())])),
      settings: floor.exists ? core.FloorSettingsSchema.parse(floor.data()) : core.defaultFloorSettings(), floorModule: core.hasModule(r.data()!, 'floor') })
    if (previous.exists && isDeepStrictEqual(core.PublicMenuSchema.parse(previous.data()), data)) return
    tx.set(lock, { revision: Number(lockDoc.get('revision') ?? 0) + 1, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    tx.set(projection, { ...core.PublicMenuSchema.parse(data), createdAt: previous.get('createdAt') ?? FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() })
  })
}
export const cartaPublica = onDocumentWritten({ ...options, document: 'restaurants/{rid}/locations/{lid}/{collection}/{id}' }, event => {
  if (['menuCategories', 'menuItems', 'dailyMenus'].includes(event.params.collection) || (event.params.collection === 'settings' && ['floor', 'reservations'].includes(event.params.id))) return syncPublicMenu(event.params.rid, event.params.lid)
  return undefined
})
export const cartaLocal = onDocumentWritten({ ...options, document: 'restaurants/{rid}/locations/{lid}' }, event => syncPublicMenu(event.params.rid, event.params.lid))
export const cartaRestaurante = onDocumentWritten({ ...options, document: 'restaurants/{rid}' }, async event => {
  const before = event.data?.before.data(), after = event.data?.after.data()
  if (before && after && ['name', 'brandColor', 'timezone', 'plan', 'moduleOverrides', 'activeModules'].every(k => isDeepStrictEqual(before[k], after[k]))) return
  const locals = await db.collection(`restaurants/${event.params.rid}/locations`).get()
  for (const l of locals.docs) await syncPublicMenu(event.params.rid, l.id)
})
const serviceCollections = ['tableSessions', 'orders', 'orderLines', 'floorTasks', 'takeaways', 'menuCategories', 'menuItems', 'dailyMenus', 'stations', 'settings', 'tableTokens']
export const actividadSala = onDocumentWritten({ ...options, document: 'restaurants/{rid}/locations/{lid}/{collection}/{id}' }, async event => {
  if (!serviceCollections.includes(event.params.collection) || (event.params.collection === 'settings' && event.params.id !== 'floor') || !event.data) return
  const before = event.data.before.data(), after = event.data.after.data(), data = after ?? before
  if (!data || (after?.changeId && after.changeId !== before?.changeId)) return
  const clean = (d: typeof data | undefined) => Object.fromEntries(Object.entries(d ?? {}).filter(([key]) => !['updatedAt', 'createdAt', 'updatedBy', 'changeId'].includes(key)))
  if (isDeepStrictEqual(clean(before), clean(after))) return
  const root = db.doc(`restaurants/${event.params.rid}`), ref = root.collection('activity').doc(core.sha256Hex(event.id))
  await db.runTransaction(async tx => {
    const previous = await tx.get(ref)
    if (previous.exists) return
    const uid = typeof data.updatedBy === 'string' ? data.updatedBy : null
    const actor = uid ? await tx.get(db.doc(`users/${uid}`)) : null
    tx.create(ref, { action: `${event.params.collection}.changed`, summary: 'Datos del servicio actualizados.', actorUid: uid, actorName: actor?.get('displayName') ?? null,
      entity: { type: event.params.collection, id: event.params.id }, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() })
  })
})
export async function reconcileLocation(rid: string, lid: string) {
  await db.runTransaction(async tx => {
    const [restaurant, local] = await Promise.all([tx.get(db.doc(`restaurants/${rid}`)), tx.get(db.doc(`restaurants/${rid}/locations/${lid}`))])
    if (!restaurant.exists || !local.exists) return
    const c = await context(tx, rid, lid)
    reconcile(c)
    c.flush('floor.reconciled', 'Consumo y tareas del servicio revisados.')
  })
}
export const reconciliarSala = onDocumentWritten({ ...options, document: 'restaurants/{rid}/locations/{lid}/{collection}/{id}' }, event => {
  if (['tableSessions', 'takeaways', 'orderLines', 'stations'].includes(event.params.collection)) return reconcileLocation(event.params.rid, event.params.lid)
  return undefined
})
