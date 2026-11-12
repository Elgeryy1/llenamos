import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import * as core from '@llenamos/core'
import { ApiError } from '../../errors.js'
import { emitEvent } from '../../events.js'

export function fail(message: string): never { throw new ApiError(412, 'failed-precondition', message) }
export function missing(message: string): never { throw new ApiError(404, 'not-found', message) }
export function deny(message = 'No tienes permiso para esta operación en este local.'): never { throw new ApiError(403, 'permission-denied', message) }
export const newId = () => randomUUID().replaceAll('-', '')

/** JSON con claves ordenadas: la misma carga da el mismo hash. */
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, stable(v)])) : value
export const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(stable(value))).digest('hex')

/** Reloj del servidor. Solo las pruebas lo sustituyen; ninguna operación recibe una hora del cliente. */
export const clock = { now: () => Date.now() }

export type Name = keyof typeof core.CALLABLES_FASE4
export type Input<N extends Name> = core.CallableParsedInput<N>
export type Scope = { restaurantId: string; locationId: string }
export const personalNames = new Set(Object.keys(core.CALLABLES_FASE4_PERSONAL))
/** Callables que solo leen: sin `requestId`, sin actividad y sin escrituras. Salvo `exportarMisFichajes`, que deja rastro (`staff.export_entries`) cuando un encargado exporta a otra persona; repetirla repite el rastro a propósito, porque cada acceso cuenta. */
export const readOnlyNames: ReadonlySet<Name> = new Set<Name>(['informeHoras', 'exportarMisFichajes', 'horasParaPropinas', 'sugerirPedidos', 'margenPlatos'])

/** Roles que cumplen el permiso base de cada operación (`per_target` se afina dentro del handler). */
export const rolesFor = (name: Name): readonly string[] => {
  const permission = core.FASE4_ACCESS[name].permission
  return core.ROLES.filter(role => permission === 'per_target' ? core.can(role, 'fichaje.registrar') : core.can(role, permission))
}

/** Tablas cerradas: nunca se interpola nada que venga del cliente. */
export const TABLES = {
  entries: 'staff_time_entries', entryEvents: 'staff_time_entry_events', pins: 'staff_pins', shifts: 'staff_shifts',
  ingredients: 'inv_ingredients', costs: 'inv_ingredient_costs', movements: 'inv_stock_movements', alerts: 'inv_stock_alerts',
  recipes: 'inv_recipes', recipeVersions: 'inv_recipe_versions', counts: 'inv_counts', suppliers: 'inv_suppliers',
  supplierItems: 'inv_supplier_items', orders: 'inv_purchase_orders', receipts: 'inv_goods_receipts', lineCosts: 'inv_line_costs',
} as const
export type Table = (typeof TABLES)[keyof typeof TABLES]

const TOPIC: Record<Table, string> = {
  staff_time_entries: 'personal.fichaje', staff_time_entry_events: 'personal.fichaje', staff_pins: 'personal.puesto', staff_shifts: 'personal.turno',
  inv_ingredients: 'inventario.stock', inv_ingredient_costs: 'inventario.stock', inv_stock_movements: 'inventario.stock', inv_stock_alerts: 'inventario.stock',
  inv_recipes: 'inventario.receta', inv_recipe_versions: 'inventario.receta', inv_counts: 'inventario.recuento', inv_line_costs: 'inventario.stock',
  inv_suppliers: 'compras.proveedor', inv_supplier_items: 'compras.proveedor', inv_purchase_orders: 'compras.pedido', inv_goods_receipts: 'compras.pedido',
}

export interface Ctx {
  client: PoolClient
  rid: string
  lid: string
  /** Autor de Auth; `null` cuando lo ejecuta el sistema (descuento por venta, procesos). */
  uid: string | null
  actorName: string | null
  role: core.Role | null
  now: number
  tz: string
  /** Temas de evento pendientes de emitir una sola vez al terminar. */
  topics: Set<string>
}

export interface Scoped { restaurantId: string; locationId: string }

async function restaurantOf(client: PoolClient, scope: Scoped) {
  const restaurant = (await client.query('SELECT plan,active_modules,module_overrides,entitlement_version,access_valid_until,timezone FROM llenamos.restaurants WHERE id=$1', [scope.restaurantId])).rows[0]
  const location = (await client.query('SELECT 1 FROM llenamos.locations WHERE restaurant_id=$1 AND id=$2', [scope.restaurantId, scope.locationId])).rows[0]
  if (!restaurant || !location) missing('No se encuentra el restaurante o el local.')
  const modules = { plan: restaurant.plan, moduleOverrides: restaurant.module_overrides, activeModules: restaurant.active_modules,
    ...(restaurant.entitlement_version ? { entitlementVersion: restaurant.entitlement_version, accessValidUntil: restaurant.access_valid_until.getTime() } : {}) }
  return { modules, tz: typeof restaurant.timezone === 'string' && restaurant.timezone ? restaurant.timezone : 'Europe/Madrid' }
}

/**
 * Abre el contexto de una operación dentro de la transacción de la petición: miembro activo con
 * acceso al local, permiso, módulos y un cerrojo consultivo que sustituye a las transacciones de
 * Firestore. Personal se serializa por restaurante (un fichaje abierto vale para todos los locales);
 * inventario, por local. Las lecturas puras no toman cerrojo.
 */
export async function openCtx(client: PoolClient, uid: string, name: Name, scope: Scoped, now = clock.now()): Promise<Ctx> {
  const access = core.FASE4_ACCESS[name]
  const c = await openAccess(client, uid, scope, access.permission, access.modules, now)
  if (!readOnlyNames.has(name)) {
    const key = personalNames.has(name) ? `staff:${scope.restaurantId}` : `inv:${scope.restaurantId}:${scope.locationId}`
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key])
  }
  return c
}

/** Miembro activo con acceso al local, permiso y módulos; sin cerrojo (lecturas en vivo y lecturas puras). */
export async function openAccess(client: PoolClient, uid: string, scope: Scoped, permission: core.Permission | 'per_target', modulesNeeded: readonly core.Module[], now = clock.now()): Promise<Ctx> {
  const member = (await client.query<{ role: core.Role; active: boolean; location_ids: string[]; display_name: string }>(
    'SELECT role,active,location_ids,display_name FROM llenamos.memberships WHERE restaurant_id=$1 AND uid=$2', [scope.restaurantId, uid])).rows[0]
  if (!member?.active || (member.location_ids.length && !member.location_ids.includes(scope.locationId))) deny()
  if (permission !== 'per_target' && !core.can(member.role, permission)) deny()
  const { modules, tz } = await restaurantOf(client, scope)
  if (modulesNeeded.some(module => !core.hasModule(modules, module))) fail('El módulo necesario está desactivado.')
  return { client, rid: scope.restaurantId, lid: scope.locationId, uid, actorName: member.display_name, role: member.role, now, tz, topics: new Set() }
}

/** Módulos y zona horaria ya conocidos de un restaurante. */
export interface KnownRestaurant { modules: core.RestaurantModulesLike; tz: string }

/** Ejecución del sistema (descuento por venta, procesos): sin autor, solo comprueba el módulo. */
export async function openSystemCtx(client: PoolClient, scope: Scoped, module: core.Module, lock: 'staff' | 'inv', now = clock.now(), known?: KnownRestaurant): Promise<Ctx | null> {
  // Con `known` (lo que ya cargó sala en un pedido público) no se vuelve a leer el restaurante, que ahí no es visible.
  const { modules, tz } = known ?? await restaurantOf(client, scope)
  if (!core.hasModule(modules, module)) return null
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [lock === 'staff' ? `staff:${scope.restaurantId}` : `inv:${scope.restaurantId}:${scope.locationId}`])
  return { client, rid: scope.restaurantId, lid: scope.locationId, uid: null, actorName: null, role: null, now, tz, topics: new Set() }
}

export function can(c: Ctx, permission: core.Permission): boolean { return !!c.role && core.can(c.role, permission) }
export function require(c: Ctx, permission: core.Permission): void { if (!can(c, permission)) deny() }

/** Emite los eventos de dominio acumulados (uno por tema) en la misma transacción. */
export async function flushEvents(c: Ctx): Promise<void> {
  for (const topic of c.topics) await emitEvent(c.client, { restaurantId: c.rid, locationId: c.lid, topic })
  c.topics.clear()
}

export async function audit(c: Ctx, action: string, summary: string, details: Record<string, unknown> = {}): Promise<void> {
  await c.client.query('INSERT INTO llenamos.fase4_activity(restaurant_id,location_id,action,summary,details,actor_uid,actor_name) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [c.rid, c.lid, action, summary.slice(0, 300), details, c.uid, c.actorName])
}

/* Documentos ------------------------------------------------------------------------------- */

type Schema<T> = { parse: (value: unknown) => T }

export async function get<T>(c: Ctx, table: Table, id: string, schema: Schema<T>, lid = c.lid): Promise<T | null> {
  const row = (await c.client.query<{ doc: unknown }>(`SELECT doc FROM llenamos.${table} WHERE restaurant_id=$1 AND location_id=$2 AND id=$3`, [c.rid, lid, id])).rows[0]
  return row ? schema.parse(row.doc) : null
}
export async function must<T>(c: Ctx, table: Table, id: string, schema: Schema<T>, what: string): Promise<T> {
  return (await get(c, table, id, schema)) ?? missing(`No se encuentra ${what}.`)
}
export async function exists(c: Ctx, table: Table, id: string): Promise<boolean> {
  return (await c.client.query(`SELECT 1 FROM llenamos.${table} WHERE restaurant_id=$1 AND location_id=$2 AND id=$3`, [c.rid, c.lid, id])).rowCount === 1
}
/** Varios documentos por id (solo los que existen), en una consulta. */
export async function getMany<T>(c: Ctx, table: Table, ids: readonly string[], schema: Schema<T>): Promise<Map<string, T>> {
  if (!ids.length) return new Map()
  const rows = (await c.client.query<{ id: string; doc: unknown }>(`SELECT id,doc FROM llenamos.${table} WHERE restaurant_id=$1 AND location_id=$2 AND id=ANY($3::text[])`, [c.rid, c.lid, [...new Set(ids)]])).rows
  return new Map(rows.map(r => [r.id, schema.parse(r.doc)]))
}
/** Consulta acotada: el WHERE y el ORDER son literales del código; los valores, siempre parámetros. */
export async function list<T>(c: Ctx, table: Table, schema: Schema<T>, where: string, params: unknown[], order: string, limit: number): Promise<(T & { id: string })[]> {
  const sql = `SELECT id,doc FROM llenamos.${table} WHERE restaurant_id=$1 AND location_id=$2${where ? ` AND (${where})` : ''} ORDER BY ${order} LIMIT ${Math.trunc(limit)}`
  return (await c.client.query<{ id: string; doc: unknown }>(sql, [c.rid, c.lid, ...params])).rows.map(r => ({ ...(schema.parse(r.doc) as object), id: r.id }) as T & { id: string })
}
/**
 * Como `list`, pero para lecturas que deben ser completas: si hay más filas que el tope falla en vez de recortar en
 * silencio (un recorte daría stock, costes o sugerencias a medias).
 */
export async function listAll<T>(c: Ctx, table: Table, schema: Schema<T>, where: string, params: unknown[], order: string, limit: number): Promise<(T & { id: string })[]> {
  const rows = await list(c, table, schema, where, params, order, limit + 1)
  if (rows.length > limit) fail(`Hay demasiados registros (más de ${limit}) para esta consulta. Acótala por fecha o estado.`)
  return rows
}
/** Crea un documento nuevo; un id repetido es un fallo, nunca una sobrescritura silenciosa. */
export async function create(c: Ctx, table: Table, id: string, doc: unknown): Promise<void> {
  await c.client.query(`INSERT INTO llenamos.${table}(restaurant_id,location_id,id,doc,updated_by) VALUES($1,$2,$3,$4,$5)`, [c.rid, c.lid, id, doc, c.uid])
  c.topics.add(TOPIC[table])
}
/** Sustituye el documento completo de uno existente. */
export async function replace(c: Ctx, table: Table, id: string, doc: unknown): Promise<void> {
  const done = await c.client.query(`UPDATE llenamos.${table} SET doc=$4,updated_at=now(),updated_by=$5 WHERE restaurant_id=$1 AND location_id=$2 AND id=$3`, [c.rid, c.lid, id, doc, c.uid])
  if (done.rowCount !== 1) missing('No se encuentra el documento.')
  c.topics.add(TOPIC[table])
}
export async function remove(c: Ctx, table: Table, id: string): Promise<void> {
  await c.client.query(`DELETE FROM llenamos.${table} WHERE restaurant_id=$1 AND location_id=$2 AND id=$3`, [c.rid, c.lid, id])
  c.topics.add(TOPIC[table])
}

/* Ajustes ---------------------------------------------------------------------------------- */

export async function loadStaffSettings(c: Ctx): Promise<core.StaffSettings> {
  const row = (await c.client.query<{ doc: unknown }>("SELECT doc FROM llenamos.fase4_settings WHERE restaurant_id=$1 AND location_id=$2 AND kind='staff'", [c.rid, c.lid])).rows[0]
  return row ? core.StaffSettingsSchema.parse(row.doc) : core.defaultStaffSettings()
}
export async function loadInventorySettings(c: Ctx): Promise<core.InventorySettings> {
  const row = (await c.client.query<{ doc: unknown }>("SELECT doc FROM llenamos.fase4_settings WHERE restaurant_id=$1 AND location_id=$2 AND kind='inventory'", [c.rid, c.lid])).rows[0]
  return row ? core.InventorySettingsSchema.parse(row.doc) : core.defaultInventorySettings()
}
export async function saveSettings(c: Ctx, kind: 'staff' | 'inventory', doc: unknown): Promise<void> {
  await c.client.query(`INSERT INTO llenamos.fase4_settings(restaurant_id,location_id,kind,doc,updated_by) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(restaurant_id,location_id,kind) DO UPDATE SET doc=EXCLUDED.doc,updated_at=now(),updated_by=EXCLUDED.updated_by`, [c.rid, c.lid, kind, doc, c.uid])
  c.topics.add(kind === 'staff' ? 'personal.ajustes' : 'inventario.ajustes')
}

export function requireRevision(actual: number, expected: number, what: string): void {
  if (actual !== expected) fail(`${what} ha cambiado mientras lo editabas. Recarga y vuelve a intentarlo.`)
}

/** Miembro activo con acceso al local, o error (RLS solo deja ver la propia membresía; lo resuelve un procedimiento estrecho). */
export async function localMember(c: Ctx, uid: string, what = 'Esa persona'): Promise<{ uid: string; displayName: string; role: core.Role }> {
  const row = (await c.client.query<{ uid: string; display_name: string; role: core.Role }>('SELECT uid,display_name,role FROM llenamos.fase4_local_members($1,$2) WHERE uid=$3', [c.rid, c.lid, uid])).rows[0]
  if (!row) fail(`${what} no trabaja en este local.`)
  return { uid: row.uid, displayName: row.display_name, role: row.role }
}

/* Idempotencia por local, actor, operación y requestId ------------------------------------- */

export async function replay(c: Ctx, name: string, requestId: string, input: unknown, output: Schema<unknown>): Promise<{ value: unknown } | null> {
  const old = (await c.client.query<{ request_hash: string; result: unknown }>(
    'SELECT request_hash,result FROM llenamos.idempotency WHERE restaurant_id=$1 AND actor_uid=$2 AND operation=$3 AND request_key=$4', [c.rid, c.uid, name, `${c.lid}:${requestId}`])).rows[0]
  if (!old) return null
  if (old.request_hash !== hash(input)) throw new ApiError(409, 'already-exists', 'Esta petición ya se usó con otros datos.')
  return { value: output.parse(old.result) }
}
export async function remember(c: Ctx, name: string, requestId: string, input: unknown, result: unknown): Promise<void> {
  await c.client.query('INSERT INTO llenamos.idempotency(restaurant_id,actor_uid,operation,request_key,request_hash,result) VALUES($1,$2,$3,$4,$5,$6)',
    [c.rid, c.uid, name, `${c.lid}:${requestId}`, hash(input), result])
}

/** Los errores de dominio de core (existencias, recepción, validaciones) son precondiciones, no fallos internos. */
export function domainError(error: unknown): never {
  if (error instanceof ApiError) throw error
  if (error instanceof z.ZodError) fail(error.issues.map(i => i.message).join(' ').slice(0, 400))
  if (error instanceof Error && !('code' in error)) fail(error.message)
  throw error
}
