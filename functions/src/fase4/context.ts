import { FieldValue, type DocumentData, type DocumentReference, type Transaction } from 'firebase-admin/firestore'
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https'
import * as core from '@llenamos/core'
import { db, membership, uidOf } from '../shared'

export const names = Object.keys(core.CALLABLES_FASE4) as (keyof typeof core.CALLABLES_FASE4)[]
export type Name = keyof typeof core.CALLABLES_FASE4
export type Input<N extends Name> = core.CallableParsedInput<N>
export const personalNames = Object.keys(core.CALLABLES_FASE4_PERSONAL) as Name[]
/** Callables que solo leen: sin `requestId`, sin actividad y sin escrituras. */
export const readOnlyNames: readonly Name[] = ['informeHoras', 'exportarMisFichajes', 'horasParaPropinas', 'sugerirPedidos', 'margenPlatos']

export function fail(message: string): never { throw new HttpsError('failed-precondition', message) }
export function missing(message: string): never { throw new HttpsError('not-found', message) }
export const hash = (v: unknown) => core.sha256Hex(JSON.stringify(v))
/** Quita `undefined` y deja solo lo que Firestore guarda. */
export const clean = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** Un fallo que debe confirmar las escrituras ya preparadas (por ejemplo los intentos de PIN) antes de lanzarse. */
export class Deferred { constructor(readonly error: HttpsError) {} }

type Staged = { ref: DocumentReference; mode: 'create' | 'update' | 'set' | 'delete'; data: DocumentData }
export type Ctx = Awaited<ReturnType<typeof openContext>>

export interface OpenOptions {
  rid: string
  lid: string
  /** Sin nombre ni petición: lo ejecuta el sistema (disparadores y procesos). */
  name?: Name
  request?: CallableRequest<unknown> | null
  now?: number
}

/**
 * Prepara una operación dentro de una transacción: lectura del restaurante, del local y del
 * autor, comprobación de permiso y módulos, y una cola de escrituras que se confirma al final
 * con `flush` (Firestore exige leer todo antes de escribir).
 */
export async function openContext(tx: Transaction, o: OpenOptions) {
  const root = db.doc(`restaurants/${o.rid}`), local = root.collection('locations').doc(o.lid)
  const [r, l] = await Promise.all([tx.get(root), tx.get(local)])
  if (!r.exists || !l.exists) missing('No se encuentra el restaurante o el local.')
  const restaurant = r.data()!
  const actor = o.request ? await membership(tx, o.rid, uidOf(o.request)) : null
  if (o.name && o.request) {
    const access = core.FASE4_ACCESS[o.name]
    if (!actor?.active || (actor.locationIds.length && !actor.locationIds.includes(o.lid))) throw new HttpsError('permission-denied', 'No tienes permiso para esta operación en este local.')
    if (access.permission !== 'per_target' && !core.can(actor.role, access.permission)) throw new HttpsError('permission-denied', 'No tienes permiso para esta operación en este local.')
    if (access.modules.some((m) => !core.hasModule(restaurant, m))) fail('El módulo necesario está desactivado.')
  }
  const now = o.now ?? Date.now()
  const uid = actor?.uid ?? null
  const tz: string = typeof restaurant.timezone === 'string' && restaurant.timezone ? restaurant.timezone : 'Europe/Madrid'
  const staged = new Map<string, Staged>()
  const events: { action: string; summary: string; details: DocumentData }[] = []

  function can(permission: core.Permission): boolean { return !!actor && actor.active && core.can(actor.role, permission) }
  function require(permission: core.Permission): void {
    if (!can(permission)) throw new HttpsError('permission-denied', 'No tienes permiso para esta operación en este local.')
  }
  function create(ref: DocumentReference, data: DocumentData) {
    if (staged.has(ref.path)) fail('Se ha intentado crear dos veces el mismo documento.')
    staged.set(ref.path, { ref, mode: 'create', data })
  }
  /** Cambia campos de un documento existente (reemplaza cada campo entero, mapas incluidos). */
  function update(ref: DocumentReference, data: DocumentData) {
    const previous = staged.get(ref.path)
    if (previous?.mode === 'delete') fail('Se ha intentado cambiar un documento que se borra.')
    staged.set(ref.path, { ref, mode: previous?.mode ?? 'update', data: { ...previous?.data, ...data } })
  }
  /** Sustituye el documento entero (settings, bloqueos, claves de idempotencia). */
  function set(ref: DocumentReference, data: DocumentData) { staged.set(ref.path, { ref, mode: 'set', data }) }
  function remove(ref: DocumentReference) { staged.set(ref.path, { ref, mode: 'delete', data: {} }) }
  function audit(action: string, summary: string, details: DocumentData = {}) { events.push({ action, summary, details }) }
  const pending = () => staged.size

  /** Confirma todas las escrituras preparadas y la actividad, en esta misma transacción. */
  function flush() {
    for (const w of staged.values()) {
      if (w.mode === 'delete') { tx.delete(w.ref); continue }
      const value = { ...w.data, updatedBy: uid, updatedAt: FieldValue.serverTimestamp(), ...(w.mode === 'create' ? { createdAt: FieldValue.serverTimestamp() } : {}) }
      if (Buffer.byteLength(JSON.stringify(value)) > 900_000) fail('El documento supera el tamaño permitido.')
      if (w.mode === 'create') tx.create(w.ref, value)
      else if (w.mode === 'update') tx.update(w.ref, value)
      else tx.set(w.ref, { createdAt: FieldValue.serverTimestamp(), ...value })
    }
    for (const e of events) {
      tx.create(root.collection('activity').doc(), {
        action: e.action, summary: e.summary, details: e.details, actorUid: uid, actorName: actor?.displayName ?? null,
        entity: { type: 'location', id: o.lid }, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      })
    }
    staged.clear(); events.length = 0
  }
  return { tx, rid: o.rid, lid: o.lid, root, local, restaurant, tz, actor, uid, now, can, require, create, update, set, remove, audit, flush, pending }
}

export const col = (c: Pick<Ctx, 'local'>, name: string) => c.local.collection(name)
export const newId = (c: Pick<Ctx, 'local'>, name: string) => c.local.collection(name).doc().id

/** Miembro activo con acceso al local, o error. */
export async function localMember(c: Ctx, uid: string, what = 'Esa persona'): Promise<core.Member> {
  const snap = await c.tx.get(c.root.collection('members').doc(uid))
  const parsed = core.MemberSchema.safeParse(snap.data())
  if (!parsed.success || !parsed.data.active || (parsed.data.locationIds.length && !parsed.data.locationIds.includes(c.lid))) fail(`${what} no trabaja en este local.`)
  return parsed.data
}

export async function loadStaffSettings(c: Ctx): Promise<core.StaffSettings> {
  const snap = await c.tx.get(col(c, 'settings').doc('staff'))
  return snap.exists ? core.StaffSettingsSchema.parse(snap.data()) : core.defaultStaffSettings()
}
export async function loadInventorySettings(c: Pick<Ctx, 'tx' | 'local'>): Promise<core.InventorySettings> {
  const snap = await c.tx.get(c.local.collection('settings').doc('inventory'))
  return snap.exists ? core.InventorySettingsSchema.parse(snap.data()) : core.defaultInventorySettings()
}

export function requireRevision(actual: number, expected: number, what: string): void {
  if (actual !== expected) fail(`${what} ha cambiado mientras lo editabas. Recarga y vuelve a intentarlo.`)
}
