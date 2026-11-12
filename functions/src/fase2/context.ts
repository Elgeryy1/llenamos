import { randomUUID } from 'node:crypto'
import { FieldPath, FieldValue, Timestamp, type Transaction, type DocumentData } from 'firebase-admin/firestore'
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https'
import { z } from 'zod'
import * as core from '@llenamos/core'
import { db, membership, uidOf } from '../shared'
import { providerAvailability } from '../providers/tenant'
import { enqueuePlatformEvent, enqueueReservationEvent, platformEventId } from '../fase6-api/events'

export const fail = (message: string): never => { throw new HttpsError('failed-precondition', message) }
export const denied = (): never => { throw new HttpsError('permission-denied', 'No tienes permiso para esta operación en este local.') }
export type Row<T> = T & { id: string }
export type Name = keyof typeof core.CALLABLE_SCHEMAS_FASE2
export type Input<N extends Name> = z.output<(typeof core.CALLABLE_SCHEMAS_FASE2)[N]['input']>
const schemas = {
  menuCategories: core.MenuCategorySchema, menuItems: core.MenuItemSchema,
  dailyMenus: core.DailyMenuSchema, stations: core.StationSchema,
  tableSessions: core.TableSessionSchema, orders: core.OrderSchema,
  orderLines: core.OrderLineSchema, floorTasks: core.FloorTaskSchema,
  takeaways: core.TakeawaySchema, tables: core.TableSchema,
  reservations: core.ReservationSchema, waitlist: core.WaitlistEntrySchema,
} as const
type Collections = { [K in keyof typeof schemas]: Map<string, Row<z.output<(typeof schemas)[K]>>> }
export type Context = Awaited<ReturnType<typeof context>>

export async function resolveRestaurant(tx: Transaction, slug: string) {
  const rows = await tx.get(db.collection('restaurants').where('slug', '==', slug).limit(1))
  if (rows.empty) throw new HttpsError('not-found', 'No se encuentra el restaurante.')
  return rows.docs[0]!.id
}

/** Lectura completa del servicio antes de preparar escrituras. El bloqueo compartido evita fantasmas. */
export async function context(tx: Transaction, rid: string, lid: string, request?: CallableRequest<unknown>, name?: Name) {
  const root = db.doc(`restaurants/${rid}`), local = root.collection('locations').doc(lid)
  const providers = await providerAvailability(tx, rid)
  const [r, l, lock, floor, reservations] = await Promise.all([
    tx.get(root), tx.get(local), tx.get(local.collection('reservationLocks').doc('current')),
    tx.get(local.collection('settings').doc('floor')), tx.get(local.collection('settings').doc('reservations')),
  ])
  if (!r.exists || !l.exists) throw new HttpsError('not-found', 'No se encuentra el restaurante o el local.')
  const restaurant = r.data()!, location = l.data()!
  const actor = request ? await membership(tx, rid, uidOf(request)) : null
  if (actor && (!actor.active || (actor.locationIds.length > 0 && !actor.locationIds.includes(lid)))) denied()
  if (name && actor) {
    const access = core.FASE2_ACCESS[name]
    if (access.permission !== 'public' && access.permission !== 'per_line' && !core.can(actor.role, access.permission)) denied()
    if (!core.hasModule(restaurant, access.module)) fail('El módulo necesario está desactivado.')
    if ((actor.role === 'kitchen' || actor.role === 'bar') && !core.hasModule(restaurant, 'kitchen')) denied()
  }
  const versions = new Map<string, string>()
  const rows = {} as Collections
  await Promise.all(Object.entries(schemas).map(async ([name, schema]) => {
    const snap = await tx.get(local.collection(name))
    for (const d of snap.docs) versions.set(`${name}/${d.id}`, d.get('syncRevision') ?? d.updateTime.toDate().toISOString() + ':' + d.updateTime.nanoseconds)
    const values = new Map(snap.docs.map(d => [d.id, { ...schema.parse(d.data()), id: d.id }]))
    Object.assign(rows, { [name]: values })
  }))
  const privateNames = ['tableTokens', 'reservationSessions', 'taskKeys', 'spendContributions', 'serviceLocks', 'pushSubscriptions', 'takeawaySecrets'] as const
  const privateRows = {} as Record<(typeof privateNames)[number], Map<string, DocumentData>>
  await Promise.all(privateNames.map(async name => {
    // La publicación no forma parte del servicio. Leer su bloqueo aquí crea una
    // espera circular al guardar un plato mientras se publica la carta anterior.
    const query = name === 'serviceLocks'
      ? local.collection(name).where(FieldPath.documentId(), '!=', 'publication')
      : local.collection(name)
    privateRows[name] = new Map((await tx.get(query)).docs.map(d => [d.id, d.data()]))
  }))
  const [customersSnap, membersSnap, refsSnap, messagesSnap] = await Promise.all([
    tx.get(root.collection('customers')), tx.get(root.collection('members')), tx.get(root.collection('takeawayReferences')), tx.get(root.collection('messages')),
  ])
  const messages = new Map(messagesSnap.docs.map(d => [d.id, d.data()]))
  const customers = new Map(customersSnap.docs.map(d => [d.id, d.data()]))
  const members = new Map(membersSnap.docs.map(d => [d.id, core.MemberSchema.parse(d.data())]))
  const takeawayReferences = new Map(refsSnap.docs.map(d => [d.id, d.data()]))
  const posBills = new Map((await tx.get(local.collection('bills'))).docs.map(d => [d.id, core.BillSchema.parse(d.data())]))
  const posTargets = new Map((await tx.get(local.collection('billTargets'))).docs.map(d => [d.id,d.get('billId') as string]))
  const writes = new Map<string, { data: DocumentData; fresh: boolean }>()
  const now = Date.now(), uid = actor?.uid ?? null
  const changeId = root.collection('activity').doc().id
  function stage(path: string, data: DocumentData, fresh = false) {
    const previous = writes.get(path)
    writes.set(path, { data: { ...previous?.data, ...data }, fresh: previous?.fresh ?? fresh })
  }
  // Hechos comprometidos para webhooks: se encolan en flush, en la misma transacción que las escrituras.
  type Fact = { type: 'order.placed' | 'orderLine.statusChanged' | 'reservation.statusChanged'; entityId: string; status: string | null; from: string | null; decision: string | number }
  const facts = new Map<string, Fact>()
  const flags = { announcedElsewhere: new Set<string>() }
  function track(name: string, row: Row<unknown>, previous: unknown) {
    const next = row as Row<{ status?: string; history?: unknown[] }>, before = previous as { status?: string } | undefined
    if (name === 'orders' && !before) facts.set(`order.placed:${row.id}`, { type: 'order.placed', entityId: row.id, status: next.status ?? null, from: null, decision: changeId })
    else if (name === 'orderLines' && before) {
      const key = `orderLine.statusChanged:${row.id}`, from = facts.get(key)?.from ?? before.status ?? null
      if (from === (next.status ?? null)) facts.delete(key)
      else facts.set(key, { type: 'orderLine.statusChanged', entityId: row.id, status: next.status ?? null, from, decision: changeId })
    } else if (name === 'reservations' && before && !flags.announcedElsewhere.has(row.id) && before.status !== next.status)
      facts.set(`reservation.statusChanged:${row.id}`, { type: 'reservation.statusChanged', entityId: row.id, status: next.status ?? null, from: before.status ?? null, decision: next.history?.length ?? 0 })
  }
  function put<K extends keyof Collections>(name: K, value: Collections[K] extends Map<string, infer V> ? V : never, fresh = false) {
    const row = value as Row<unknown>
    const previous = (rows[name] as Map<string, unknown>).get(row.id)
    guardPosWrite(name, row.id, value as DocumentData)
    ;(rows[name] as Map<string, unknown>).set(row.id, value)
    track(name, row, previous)
    const syncRevision = randomUUID()
    versions.set(`${name}/${row.id}`, syncRevision)
    const { id: _id, ...data } = row
    stage(`${local.path}/${name}/${row.id}`, { ...data, syncRevision }, fresh)
    if (name === 'reservations' && ['seated', 'finished'].includes((data as { status: string }).status)) {
      for (const message of messagesSnap.docs) if (message.get('reservationId') === row.id && message.get('status') === 'queued') stage(message.ref.path, { status: 'cancelled' })
    }
  }
  function secret(name: (typeof privateNames)[number], id: string, data: DocumentData) {
    const fresh = !privateRows[name].has(id)
    privateRows[name].set(id, data)
    stage(`${local.path}/${name}/${id}`, data, fresh)
  }
  function guardPosWrite(name: string, id: string, next: DocumentData) {
    const billFor = (kind: string, targetId: string) => posBills.get(posTargets.get(core.sha256Hex(JSON.stringify([kind,targetId]))) ?? '')
    const frozen = (kind: string, targetId: string) => { const bill = billFor(kind,targetId); return !!bill && bill.status !== 'open' && bill.status !== 'cancelled' }
    if (name === 'orderLines') {
      const old = rows.orderLines.get(id)
      const targets = [old, next].filter(Boolean) as DocumentData[]
      const changed = !old || ['sessionId','takeawayId','totalCents','taxRate','quantity','parentLineId'].some(k => (old as DocumentData)[k] !== next[k]) || ((old.status === 'cancelled') !== (next.status === 'cancelled'))
      if (changed && targets.some(l => l.sessionId ? frozen('session',l.sessionId) : l.takeawayId && frozen('takeaway',l.takeawayId))) fail('La cuenta está bloqueada para cobrar. No se puede cambiar el consumo ni su destino.')
    }
    if (name === 'tableSessions') {
      const old = rows.tableSessions.get(id)
      if (old && frozen('session',id) && (JSON.stringify(old.tableIds) !== JSON.stringify(next.tableIds) || old.label !== next.label || (old.status === 'closed' && next.status !== 'closed') || next.status === 'merged' || next.status === 'cancelled')) fail('La cuenta está bloqueada o saldada. No se puede mover, juntar, separar ni reabrir la mesa.')
      if (next.status === 'closed' && old?.status !== 'closed' && core.hasModule(restaurant,'pos')) {
        const lines = [...rows.orderLines.values()].filter(l => l.sessionId === id && l.status !== 'cancelled')
        if (lines.some(l => l.totalCents > 0 || l.status === 'pending') && billFor('session',id)?.status !== 'settled') fail('Salda la cuenta antes de cerrar la mesa.')
      }
    }
    if (name === 'takeaways') {
      const old = rows.takeaways.get(id)
      if (old && frozen('takeaway',id) && (next.status === 'cancelled' || (old.status === 'picked_up' && next.status !== old.status))) fail('La cuenta está bloqueada o saldada. No se puede cancelar ni reabrir el pedido.')
      if (next.status === 'picked_up' && old?.status !== 'picked_up' && core.hasModule(restaurant,'pos')) {
        const lines = [...rows.orderLines.values()].filter(l => l.takeawayId === id && l.status !== 'cancelled')
        if (lines.some(l => l.totalCents > 0 || l.status === 'pending') && billFor('takeaway',id)?.status !== 'settled') fail('Salda la cuenta antes de recoger el pedido para llevar.')
      }
    }
  }
  function flush(action: string | null, summary: string) {
    if (!writes.size) return
    const conversions: Record<string, (v: never, convert: typeof Timestamp.fromMillis) => unknown> = {
      tableSessions: core.tableSessionForWrite, orders: core.orderForWrite, orderLines: core.orderLineForWrite,
      floorTasks: core.floorTaskForWrite, takeaways: core.takeawayForWrite, reservations: core.reservationForWrite,
    }
    for (const [path, { data, fresh }] of writes) {
      const collection = path.split('/').at(-2)!
      const convert = conversions[collection]
      const value = convert ? convert(data as never, Timestamp.fromMillis) as DocumentData : data
      const stamped = { ...value, updatedBy: uid, changeId, updatedAt: FieldValue.serverTimestamp(), ...(fresh ? { createdAt: FieldValue.serverTimestamp() } : {}) }
      // El recuento es absoluto: quitar el límite de una variante debe borrar su clave.
      // La mezcla recursiva de mapas conservaría los límites que se han quitado.
      tx.set(db.doc(path), stamped, collection === 'menuItems' && Object.hasOwn(value, 'portions') ? { mergeFields: Object.keys(stamped) } : { merge: true })
    }
    tx.set(lock.ref, { revision: FieldValue.increment(1) }, { merge: true })
    for (const fact of facts.values()) {
      if (fact.type === 'reservation.statusChanged') enqueueReservationEvent(tx, { restaurantId: rid, locationId: lid, type: fact.type, reservationId: fact.entityId, status: fact.status ?? '', decision: fact.decision, at: now })
      else enqueuePlatformEvent(tx, { id: platformEventId(rid, lid, fact.type, fact.entityId, fact.decision), type: fact.type, version: 1, restaurantId: rid, locationId: lid, occurredAt: now, data: { entityId: fact.entityId, status: fact.status } })
    }
    facts.clear()
    if (action) tx.create(root.collection('activity').doc(changeId), { action, summary, actorUid: uid, actorName: actor?.displayName ?? null, entity: { type: 'location', id: lid }, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() })
  }
  return { tx, rid, lid, root, local, providers, restaurant, location, actor, uid, now, posBills, posTargets, versions, rows, privateRows, customers, members, takeawayReferences, messages, writes, stage, put, secret, flush, flags,
    floorExists: floor.exists,
    settings: floor.exists ? core.FloorSettingsSchema.parse(floor.data()) : core.defaultFloorSettings(),
    reservationSettings: reservations.exists ? core.ReservationSettingsSchema.parse(reservations.data()) : core.defaultReservationSettings(restaurant.timezone),
  }
}
export function requireFloor(c: Context) {
  if (!core.hasModule(c.restaurant, 'floor')) fail('El módulo de sala está desactivado.')
}
export function get<K extends keyof Collections>(c: Context, collection: K, id: string): Collections[K] extends Map<string, infer V> ? V : never {
  const value = c.rows[collection].get(id)
  if (!value) throw new HttpsError('not-found', 'No se encuentra el documento en este local.')
  return value as Collections[K] extends Map<string, infer V> ? V : never
}
export function permission(c: Context, p: core.Permission) { return !!c.actor && core.can(c.actor.role, p) }
export function newId(c: Context, collection: string) { return c.local.collection(collection).doc().id }
export function checkLine(c: Context, line: core.OrderLine, status: core.LineStatus, reason: string | null = null) {
  if (line.kind === 'menu') fail('El estado del menú lo determinan sus platos.')
  if (line.status === status) return
  if (line.status === 'pending') fail('Decide primero el pedido pendiente.')
  const allowed = (p: core.Permission) => permission(c, p) &&
    (!['cocina.preparar', 'barra.preparar'].includes(p) || core.hasModule(c.restaurant, 'kitchen'))
  const result = core.checkLineTransition(line, status, allowed, reason)
  if (!result.ok) { if (!core.lineTransitionPermissions(line.status, status, line.stationKind).some(allowed)) denied(); fail(result.reason) }
}
export function publicMenu(c: Context) {
  return core.buildPublicMenu({ restaurantId: c.rid, locationId: c.lid, restaurantName: c.restaurant.name, locationName: c.location.name,
    brandColor: c.restaurant.brandColor, timezone: c.reservationSettings.timezone, settings: c.settings,
    categories: Object.fromEntries(c.rows.menuCategories), items: Object.fromEntries(c.rows.menuItems), dailyMenus: Object.fromEntries(c.rows.dailyMenus), floorModule: core.hasModule(c.restaurant, 'floor') })
}
