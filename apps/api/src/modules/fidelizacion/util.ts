import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import * as core from '@llenamos/core'
import { emitEvent } from '../../events.js'
import { ApiError } from '../../errors.js'
import { requireModules } from '../comun/acceso.js'

export const hashId = (...parts: unknown[]) => core.sha256Hex(JSON.stringify(parts))
/** UUID estable derivado de un texto (ID del outbox/jobs). */
export function stableUuid(text: string): string {
  const h = createHash('sha256').update(text).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}
export const failed = (message: string, code = 'failed-precondition') => new ApiError(412, code, message)
export const notFound = (message = 'No se encuentra el documento solicitado.') => new ApiError(404, 'not-found', message)
export const revisionConflict = () => failed('El documento ha cambiado. Recarga antes de continuar.')

export async function moduleActive(client: PoolClient, rid: string, module: core.Module): Promise<boolean> {
  try { await requireModules(client, rid, [module]); return true } catch (error) { if (error instanceof ApiError && error.status === 403) return false; throw error }
}
export const notify = (client: PoolClient, rid: string, topic: string, entityId?: string) => emitEvent(client, { restaurantId: rid, topic, entityId: entityId ?? null })

export async function restaurantTimezone(client: PoolClient, rid: string): Promise<string> {
  const { rows } = await client.query('SELECT timezone FROM llenamos.restaurants WHERE id=$1', [rid])
  return rows[0]?.timezone ?? 'Europe/Madrid'
}

export async function loyaltySettings(client: PoolClient, rid: string): Promise<core.LoyaltySettings> {
  const { rows } = await client.query('SELECT settings FROM llenamos.loyalty_settings WHERE restaurant_id=$1', [rid])
  return rows[0] ? core.LoyaltySettingsSchema.parse(rows[0].settings) : core.defaultLoyaltySettings()
}
export async function loyaltySettingsOrNull(client: PoolClient, rid: string): Promise<core.LoyaltySettings | null> {
  const { rows } = await client.query('SELECT settings FROM llenamos.loyalty_settings WHERE restaurant_id=$1', [rid])
  return rows[0] ? core.LoyaltySettingsSchema.parse(rows[0].settings) : null
}
export async function repiteSettingsOrNull(client: PoolClient, rid: string): Promise<core.RepiteSettings | null> {
  const { rows } = await client.query('SELECT merchant_id,enabled,stamp_on,auto_create_card FROM llenamos.repite_settings WHERE restaurant_id=$1', [rid])
  const r = rows[0]
  return r ? core.RepiteSettingsSchema.parse({ merchantId: r.merchant_id, enabled: r.enabled, stampOn: r.stamp_on, autoCreateCard: r.auto_create_card }) : null
}
export async function repiteSettings(client: PoolClient, rid: string): Promise<core.RepiteSettings> {
  return (await repiteSettingsOrNull(client, rid)) ?? core.defaultRepiteSettings()
}

/** La ficha de cliente la porta V3; mientras, `customer_marketing` (011) es la prueba de que existe. */
export async function customerRow(client: PoolClient, rid: string, customerId: string) {
  const { rows } = await client.query('SELECT name,language,redacted FROM llenamos.customer_marketing WHERE restaurant_id=$1 AND customer_id=$2', [rid, customerId])
  return rows[0] as { name: string; language: 'es' | 'ca' | 'en'; redacted: boolean } | undefined
}
