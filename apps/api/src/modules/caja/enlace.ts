import { timingSafeEqual } from 'node:crypto'
import type { Pool } from 'pg'
import * as core from '@llenamos/core'
import { ApiError } from '../../errors.js'
import { assertBelow, guardBeforeResolve, hit, ipKey } from '../reservas/abuse.js'
import { resolvePublicTenant, type Tenant } from '../reservas/scope.js'
import { fail } from './pos.js'

/** Antiabuso de los enlaces privados de pago y recibo. Ajustable en pruebas. Ventanas en segundos. */
export const limits = {
  ipRestaurant: { window: 600, max: 60 },
  failedIp: { window: 600, max: 15 },
  failedReference: { window: 3600, max: 10 },
}
export function tokenMatches(saved: unknown, raw: string) {
  const actual = core.sha256Hex(raw)
  return typeof saved === 'string' && saved.length === actual.length && timingSafeEqual(Buffer.from(saved), Buffer.from(actual))
}
export const invalidLink = () => new ApiError(403, 'permission-denied', 'El enlace no es válido o ha caducado.')

export interface PublicContext { pool: Pool; clientIp?: string | null }
/**
 * Orden fijo de una operación pública de cobro: límite en memoria, restaurante por slug, módulos, límite por IP y
 * bloqueo por fallos recientes (también el correcto) ANTES de abrir ninguna credencial ni contexto.
 */
export async function openPublic(context: PublicContext, slug: string, locationId: string, reference: string): Promise<{ tenant: Tenant; ip: string }> {
  guardBeforeResolve(context.clientIp ?? null)
  const tenant = await resolvePublicTenant(context.pool, slug, locationId)
  if (!core.hasModule(tenant.restaurant, 'pos') || !core.hasModule(tenant.restaurant, 'floor')) fail('El servicio de caja no está disponible.')
  const ip = ipKey(context.clientIp ?? null)
  await hit(context.pool, tenant.rid, 'cobro-ip', ip, limits.ipRestaurant)
  await assertBelow(context.pool, tenant.rid, 'cobro-fail-ip', ip, limits.failedIp)
  await assertBelow(context.pool, tenant.rid, 'cobro-fail-ref', reference, limits.failedReference)
  return { tenant, ip }
}
/** Un enlace falso cuenta por IP y por referencia en su propia transacción (el rechazo también suma). */
export async function rejectLink(context: PublicContext, tenant: Tenant, ip: string, reference: string): Promise<never> {
  await hit(context.pool, tenant.rid, 'cobro-fail-ip', ip, limits.failedIp)
  await hit(context.pool, tenant.rid, 'cobro-fail-ref', reference, limits.failedReference)
  throw invalidLink()
}
