import type { PoolClient } from 'pg'
import { ApiError } from './errors.js'

/** Rol activo en el restaurante y suscripción vigente; lo comparten operaciones y lecturas en vivo. */
export async function requireMember(client: PoolClient, uid: string, rid: string, roles: readonly string[] | undefined): Promise<string> {
  const { rows } = await client.query('SELECT role FROM llenamos.memberships WHERE uid=$1 AND restaurant_id=$2 AND active', [uid, rid])
  const role = rows[0]?.role as string | undefined
  if (!role || !roles?.includes(role)) throw new ApiError(403, 'permission-denied', 'Permisos insuficientes.')
  const access = await client.query<{ allowed: boolean }>('SELECT llenamos.can_access_restaurant($1) AS allowed', [rid])
  if (!access.rows[0]?.allowed) throw new ApiError(412, 'failed-precondition', 'La suscripción no permite acceder al servicio. Revisa el plan.')
  return role
}

/** El miembro solo puede leer los locales que tiene asignados (lista vacía = todos). */
export async function requireLocation(client: PoolClient, uid: string, rid: string, locationId: string): Promise<void> {
  const { rows } = await client.query<{ location_ids: string[] }>('SELECT location_ids FROM llenamos.memberships WHERE uid=$1 AND restaurant_id=$2 AND active', [uid, rid])
  const assigned = rows[0]?.location_ids
  if (!assigned || (assigned.length > 0 && !assigned.includes(locationId))) throw new ApiError(403, 'permission-denied', 'No tienes asignado este local.')
}
