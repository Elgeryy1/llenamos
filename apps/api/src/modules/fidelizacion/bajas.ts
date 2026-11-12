import { z } from 'zod'
import { ApiError } from '../../errors.js'
import type { Operation } from '../../operations.js'

/**
 * Bajas pendientes en Repite: tarjetas que un borrado de privacidad dio por retiradas en local porque Repite no pudo retirarlas. Solo plataforma (LogiQD) las ve,
 * con el comercio y la tarjeta (ids opacos de Repite) y el restaurante, para pedir la baja y marcarla resuelta. No hay datos de la persona.
 */
const Pending = z.object({ restaurantId: z.string(), id: z.uuid(), merchantId: z.string(), cardId: z.string(), reason: z.enum(['repite_no_configurado', 'retirada_fallida']), createdAt: z.number() })

/** Las 500 más antiguas sin resolver (al resolverlas entran las siguientes). */
export const listarBajasRepitePendientes: readonly [string, Operation] = ['listarBajasRepitePendientes', {
  access: 'platform', input: z.strictObject({}), output: z.object({ pending: z.array(Pending) }),
  run: async client => {
    const { rows } = await client.query('SELECT * FROM llenamos.repite_removals_list()')
    return { pending: rows.map(r => ({ restaurantId: r.restaurant_id, id: r.id, merchantId: r.merchant_id, cardId: r.card_id, reason: r.reason, createdAt: r.created_at.getTime() })) }
  },
}]

export const resolverBajaRepite: readonly [string, Operation] = ['resolverBajaRepite', {
  access: 'platform', input: z.strictObject({ restaurantId: z.string().min(1).max(128), id: z.uuid() }), output: z.object({ ok: z.literal(true) }),
  restaurantId: input => (input as { restaurantId: string }).restaurantId,
  run: async (client, raw) => {
    const d = raw as { restaurantId: string; id: string }
    const { rows } = await client.query<{ ok: boolean }>('SELECT llenamos.repite_removal_resolve($1,$2) AS ok', [d.restaurantId, d.id])
    if (!rows[0]?.ok) throw new ApiError(404, 'not-found', 'No hay una baja pendiente con ese identificador.')
    return { ok: true as const }
  },
}]
