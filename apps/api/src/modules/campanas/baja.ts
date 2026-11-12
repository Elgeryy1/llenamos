import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { CALLABLE_SCHEMAS_FASE5_MARKETING as S } from '@llenamos/core'
import { ApiError } from '../../errors.js'
import type { Operation } from '../../operations.js'
import { ipKey } from '../reservas/abuse.js'
import { getUnsubscribeLimits } from './config.js'

/**
 * Baja pública sin identidad. El campo trampa `website` relleno responde ok sin tocar nada. El resto va a un único
 * procedimiento SECURITY DEFINER que cuenta por ventana (slug, slug+token; slugs inexistentes en un único contador),
 * consume el token por hash y devuelve `ok` igual exista o no el slug o el token; solo `limited` se traduce en 429.
 * Además de los fallos por slug, cada IP verificada (`src/client-ip.ts`, agrupada por /64 en IPv6) tiene su propio contador.
 */
export async function unsubscribe(pool: Pool, input: { slug: string; token: string; website: string }, now: Date = new Date(), clientIp: string | null = null): Promise<{ ok: true }> {
  if (input.website !== '') return { ok: true }
  const l = getUnsubscribeLimits()
  const hash = createHash('sha256').update(input.token).digest('hex')
  const ipHash = createHash('sha256').update(`baja-ip:${ipKey(clientIp)}`).digest('hex')
  const { rows } = await pool.query<{ result: string }>('SELECT llenamos.marketing_unsubscribe($1,$2,$3,$4,$5,$6,$7,$8) AS result',
    [input.slug, hash, now, l.windowSeconds, l.failuresPerSlug, l.unknownSlug, ipHash, l.perIp])
  if (rows[0]?.result === 'limited') throw new ApiError(429, 'resource-exhausted', 'Demasiadas solicitudes. Inténtalo de nuevo en unos minutos.')
  return { ok: true }
}

export const darseDeBaja: readonly [string, Operation] = ['darseDeBaja', {
  access: 'public', input: S.darseDeBaja.input, output: S.darseDeBaja.output,
  runPublic: (input, { pool, clientIp }) => unsubscribe(pool, input as { slug: string; token: string; website: string }, new Date(), clientIp ?? null),
}]
