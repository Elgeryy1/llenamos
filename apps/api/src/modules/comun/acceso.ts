import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { z } from 'zod'
import { ROLES, can, hasModule, type Module, type Permission } from '@llenamos/core'
import { ApiError } from '../../errors.js'
import type { Operation } from '../../operations.js'

/** Roles de la matriz de permisos de core que tienen un permiso concreto. */
export const rolesFor = (permission: Permission): string[] => ROLES.filter(role => can(role, permission))

export interface Scope { uid: string; role: string; locationIds: readonly string[] }

export const denied = (message = 'No tienes permiso para esta operación en este local.') => new ApiError(403, 'permission-denied', message)
export const failed = (message: string, code = 'failed-precondition') => new ApiError(412, code, message)
export const missing = (message = 'No se encuentra el documento solicitado.') => new ApiError(404, 'not-found', message)

/** El módulo se calcula con el mismo `hasModule` que usa la web; sin módulo no hay operación. */
export async function requireModules(client: PoolClient, rid: string, modules: readonly Module[]) {
  if (!modules.length) return
  const { rows } = await client.query('SELECT plan,active_modules,module_overrides,entitlement_version,access_valid_until FROM llenamos.restaurants WHERE id=$1', [rid])
  const r = rows[0]
  if (!r) throw denied('No tienes acceso al restaurante.')
  const restaurant = { plan: r.plan, activeModules: r.active_modules, moduleOverrides: r.module_overrides,
    ...(r.entitlement_version ? { entitlementVersion: r.entitlement_version, accessValidUntil: r.access_valid_until?.getTime() ?? null } : {}) }
  for (const module of modules) if (!hasModule(restaurant as never, module)) throw denied('Este módulo no está activo en el plan del restaurante.')
}

export async function loadScope(client: PoolClient, rid: string, uid: string): Promise<Scope> {
  const { rows } = await client.query('SELECT role,location_ids FROM llenamos.memberships WHERE restaurant_id=$1 AND uid=$2 AND active', [rid, uid])
  if (!rows[0]) throw denied('No tienes acceso al restaurante.')
  return { uid, role: rows[0].role, locationIds: rows[0].location_ids }
}

/**
 * Locales que puede ver quien opera (vacío en la membresía = todos) y que existen en este restaurante.
 * `location_exists` (SECURITY DEFINER) solo responde a miembros del restaurante (016: exige `can_access_restaurant`): un miembro con
 * locales limitados distingue «no existe» (404) de «no es tuyo» (403) dentro de SU restaurante, y nadie de fuera averigua nada.
 */
export async function visibleLocations(client: PoolClient, rid: string, scope: Scope, requested: readonly string[] | null): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>('SELECT id FROM llenamos.locations WHERE restaurant_id=$1 ORDER BY id', [rid])
  const allowed = scope.locationIds.length ? rows.map(r => r.id).filter(id => scope.locationIds.includes(id)) : rows.map(r => r.id)
  if (requested === null) return allowed
  for (const id of requested) {
    const exists = (await client.query<{ ok: boolean }>('SELECT llenamos.location_exists($1, $2) AS ok', [rid, id])).rows[0]?.ok
    if (!exists) throw missing()
    if (!allowed.includes(id)) throw denied()
  }
  return [...new Set(requested)]
}
export async function assertLocation(client: PoolClient, rid: string, scope: Scope, lid: string) { await visibleLocations(client, rid, scope, [lid]) }

export function stableHash(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : 1).map(([k, x]) => [k, sort(x)])) : v
  return createHash('sha256').update(JSON.stringify(sort(value))).digest('hex')
}

/**
 * Misma `requestId` y misma entrada devuelven el resultado original; otra entrada, `already-exists`.
 * Dos peticiones simultáneas se serializan por la clave primaria de `llenamos.idempotency`.
 */
export async function idempotent<T>(client: PoolClient, rid: string, uid: string, operation: string, requestId: string, input: unknown, run: () => Promise<T>): Promise<T> {
  const hash = stableHash({ ...(input as object), requestId: undefined })
  const inserted = await client.query('INSERT INTO llenamos.idempotency(restaurant_id,actor_uid,operation,request_key,request_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [rid, uid, operation, requestId, hash])
  if (!inserted.rowCount) {
    const { rows } = await client.query('SELECT request_hash,result FROM llenamos.idempotency WHERE restaurant_id=$1 AND actor_uid=$2 AND operation=$3 AND request_key=$4', [rid, uid, operation, requestId])
    if (rows[0]?.request_hash !== hash) throw new ApiError(409, 'already-exists', 'Este identificador ya se usó con otros datos.')
    if (rows[0].result === null) throw new ApiError(409, 'aborted', 'La operación original sigue en curso. Reintenta.')
    return rows[0].result as T
  }
  const result = await run()
  await client.query('UPDATE llenamos.idempotency SET result=$5 WHERE restaurant_id=$1 AND actor_uid=$2 AND operation=$3 AND request_key=$4', [rid, uid, operation, requestId, JSON.stringify(result)])
  return result
}

export interface MemberOperationSpec<I extends { restaurantId: string }, O> {
  permission: Permission
  modules: readonly Module[]
  input: z.ZodType<I>
  output: z.ZodType<O>
  /** Si la entrada trae `requestId` se vuelve idempotente de forma automática. */
  run: (client: PoolClient, input: I, scope: Scope) => Promise<O>
}

/** Operación de miembro: rol por permiso, módulo activo, local acotado e idempotencia por `requestId`. */
export function memberOperation<I extends { restaurantId: string }, O>(name: string, spec: MemberOperationSpec<I, O>): readonly [string, Operation] {
  return [name, {
    access: 'member', input: spec.input, output: spec.output as z.ZodType,
    roles: rolesFor(spec.permission),
    restaurantId: input => (input as I).restaurantId,
    run: async (client, raw, context) => {
      const input = raw as I, rid = input.restaurantId
      await requireModules(client, rid, spec.modules)
      const scope = await loadScope(client, rid, context.uid)
      const requestId = (input as { requestId?: string }).requestId
      return requestId
        ? idempotent(client, rid, context.uid, name, requestId, input, () => spec.run(client, input, scope))
        : spec.run(client, input, scope)
    },
  }]
}
