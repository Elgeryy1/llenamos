import { FieldValue, Timestamp, type DocumentData, type DocumentReference, type Transaction } from 'firebase-admin/firestore'
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https'
import { z } from 'zod'
import * as core from '@llenamos/core'
import { db, membership, uidOf } from '../shared'

export type Name = keyof typeof core.CALLABLES_FASE5
export type Input<N extends Name> = core.CallableParsedInput<N>
export const names = Object.keys(core.CALLABLES_FASE5) as Name[]
export const hash = (v: unknown) => core.sha256Hex(JSON.stringify(v))
export const clean = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
export function fail(message: string): never { throw new HttpsError('failed-precondition', message) }
export function denied(): never { throw new HttpsError('permission-denied', 'No tienes permiso para esta operación en este local.') }
export function missing(): never { throw new HttpsError('not-found', 'No se encuentra el documento solicitado.') }
export function revision(actual: number, expected: number | null) { if (actual !== expected) fail('El documento ha cambiado. Recarga antes de continuar.') }
export const ts = (n: number | null) => n === null ? null : Timestamp.fromMillis(n)
export const ms = (v: unknown): number => core.TimestampSchema.parse(v)
export type Ctx = Awaited<ReturnType<typeof context>>

/** Lecturas antes de escrituras, como en caja y almacén; el autor procede siempre de Auth. */
export async function context(tx: Transaction, rid: string, request: CallableRequest<unknown> | null, name?: Name, lid?: string, at = Date.now()) {
  if (request?.auth?.token.logiqd === true) denied()
  const root = db.doc(`restaurants/${rid}`), snap = await tx.get(root)
  if (!snap.exists) missing()
  const restaurant = snap.data()!
  let actor: core.Member | null = null
  let uid: string | null = request?.auth?.uid ?? null
  if (name && core.FASE5_ACCESS[name].permission !== 'public') {
    if (!request?.auth) denied()
    const access = core.FASE5_ACCESS[name]
    if (access.permission === 'logiqd') {
      if (request.auth.token.logiqd !== true) denied()
    } else {
      actor = await membership(tx, rid, uidOf(request))
      if (!actor.active || !core.can(actor.role, access.permission as core.Permission)) denied()
    }
    if (access.modules.some(m => !core.hasModule(restaurant, m))) denied()
  } else if (!name) uid = null
  const tz = typeof restaurant.timezone === 'string' ? restaurant.timezone : 'Europe/Madrid'
  const staged = new Map<string, { ref: DocumentReference; data: DocumentData; mode: 'create' | 'set' | 'update' | 'delete' }>()
  const movementClocks = new Map<string,number>()
  const events: { action: string; summary: string; details: DocumentData }[] = []
  const ref = (path: string) => root.collection(path.split('/').slice(0, -1).join('/')).doc(path.split('/').at(-1)!)
  async function get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const doc = await tx.get(ref(path)); if (!doc.exists) missing(); return schema.parse(doc.data())
  }
  async function maybe<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
    const doc = await tx.get(ref(path)); return doc.exists ? schema.parse(doc.data()) : null
  }
  async function list<T>(path: string, schema: z.ZodType<T>): Promise<(T & { id: string })[]> {
    const rows = await tx.get(root.collection(path)); return rows.docs.map(d => ({ ...schema.parse(d.data()), id: d.id }))
  }
  function stage(path: string, data: DocumentData, mode: 'create' | 'set' | 'update' = 'set') {
    const previous = staged.get(path)
    staged.set(path, { ref: ref(path), data: mode === 'update' ? { ...previous?.data, ...data } : data, mode: previous?.mode === 'create' ? 'create' : mode })
  }
  function remove(path: string) { staged.set(path, { ref: ref(path), data: {}, mode: 'delete' }) }
  function audit(action: string, summary: string, details: DocumentData = {}) { events.push({ action, summary, details }) }
  function flush() {
    for (const w of staged.values()) {
      if (w.mode === 'delete') { tx.delete(w.ref); continue }
      const value = { ...w.data, updatedBy: uid, updatedAt: FieldValue.serverTimestamp() }
      if (Buffer.byteLength(JSON.stringify(value)) > 900_000) fail('El documento supera el tamaño permitido.')
      if (w.mode === 'create') tx.create(w.ref, { createdAt: FieldValue.serverTimestamp(), ...value })
      else if (w.mode === 'update') tx.update(w.ref, value)
      else tx.set(w.ref, { createdAt: FieldValue.serverTimestamp(), ...value })
    }
    for (const e of events) tx.create(root.collection('activity').doc(), { ...e, actorUid: uid, actorName: actor?.displayName ?? (uid ? 'LogiQD' : null), entity: { type: lid ? 'location' : 'restaurant', id: lid ?? rid }, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() })
    staged.clear(); events.length = 0
  }
  async function local(id: string) {
    if (actor?.locationIds.length && !actor.locationIds.includes(id)) denied()
    if (!(await tx.get(root.collection('locations').doc(id))).exists) missing()
    return `locations/${id}`
  }
  async function locations(ids: string[] | null) {
    const all = (await tx.get(root.collection('locations'))).docs.map(d => d.id)
    const selected = ids ?? all.filter(id => !actor?.locationIds.length || actor.locationIds.includes(id))
    for (const id of selected) { if (!all.includes(id)) missing(); if (actor?.locationIds.length && !actor.locationIds.includes(id)) denied() }
    return [...new Set(selected)]
  }
  if (lid) await local(lid)
  return { tx, root, rid, lid, restaurant, actor, uid, now: at, tz, ref, get, maybe, list, stage, remove, audit, flush, local, locations, movementClocks }
}
export const raw = z.record(z.string(), z.unknown())
export async function settings<T>(c: Ctx, key: string, schema: z.ZodType<T>, fallback: T): Promise<T> {
  const d = await c.tx.get(c.ref(`settings/${key}`))
  if (!d.exists) return fallback
  const value = { ...d.data() }; delete value.createdAt; delete value.updatedAt; delete value.updatedBy
  return schema.parse(value)
}
export const loyaltySettings = (c: Ctx) => settings(c, 'loyalty', core.LoyaltySettingsSchema, core.defaultLoyaltySettings())
export const repiteSettings = (c: Ctx) => settings(c, 'repite', core.RepiteSettingsSchema, core.defaultRepiteSettings())
export const marketingSettings = (c: Ctx) => settings(c, 'marketing', core.MarketingSettingsSchema, core.defaultMarketingSettings(String(c.restaurant.name)))
