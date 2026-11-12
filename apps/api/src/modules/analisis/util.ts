import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { sumarDias, type Module } from '@llenamos/core'
import { requireModules } from '../comun/acceso.js'
import { ApiError } from '../../errors.js'

export const ANALYTICS = ['analytics'] as const satisfies readonly Module[]

/** Fechas `YYYY-MM-DD` de `from` a `to` ambas incluidas. */
export function dates(from: string, to: string): string[] {
  const out: string[] = []
  for (let date = from; date <= to; date = sumarDias(date, 1)) out.push(date)
  return out
}

/** UUID estable (forma v5) derivado de un texto: mismo texto, mismo id. Sirve de clave de outbox. */
export function stableUuid(text: string): string {
  const h = createHash('sha256').update(text).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0')}${h.slice(18, 20)}-${h.slice(20, 32)}`
}

export async function restaurantInfo(client: PoolClient, rid: string): Promise<{ timezone: string; name: string }> {
  const { rows } = await client.query<{ timezone: string; name: string }>('SELECT timezone,name FROM llenamos.restaurants WHERE id=$1', [rid])
  if (!rows[0]) throw new ApiError(404, 'not-found', 'No se encuentra el restaurante.')
  return rows[0]
}

/** ¿Está activo el módulo? (la misma regla que `requireModules`, sin lanzar). */
export async function moduleActive(client: PoolClient, rid: string, module: Module): Promise<boolean> {
  try { await requireModules(client, rid, [module]); return true } catch (error) {
    if (error instanceof ApiError && error.code === 'permission-denied') return false
    throw error
  }
}

export const msToDate = (ms: number) => new Date(ms)
