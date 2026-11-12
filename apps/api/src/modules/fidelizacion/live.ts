import type { PoolClient } from 'pg'
import { z } from 'zod'
import * as core from '@llenamos/core'
import type { LiveQuery } from '../types.js'
import { loadScope, requireModules, rolesFor } from '../comun/acceso.js'
import { loyaltySettingsOrNull, repiteSettingsOrNull } from './util.js'
import { promotionRow, promotionInScopeSql, MAX_ACTIVE_PROMOTIONS } from './promociones.js'

const Input = z.strictObject({ restaurantId: core.DocIdSchema })
type Input = z.output<typeof Input>
const rid = (input: unknown) => (input as Input).restaurantId
const base = { input: Input, restaurantId: rid }
const withId = <S extends z.ZodType>(schema: S) => z.array(z.intersection(z.object({ id: z.string() }), schema as z.ZodType<object>))

/** Premios y promociones que caben en una pantalla de gestión. */
export const MAX_LIVE_ROWS = 500

/** Los ajustes del programa (condiciones, puntos por euro) los lee también quien atiende al cliente: la ficha de cliente los usa con `fidelizacion.ver`. Premios, promociones y Repite, solo quien gestiona. */
export const liveQueries: readonly LiveQuery[] = [
  { name: 'fidelizacion.ajustes', roles: rolesFor('fidelizacion.ver'), ...base, output: core.LoyaltySettingsSchema.nullable(), topics: () => ['fidelizacion.ajustes'],
    snapshot: async (client: PoolClient, input) => { await requireModules(client, rid(input), ['loyalty']); return loyaltySettingsOrNull(client, rid(input)) } },
  { name: 'fidelizacion.premios', roles: rolesFor('fidelizacion.gestionar'), ...base, output: withId(core.LoyaltyRewardSchema), topics: () => ['fidelizacion.premio'],
    snapshot: async (client, input) => {
      await requireModules(client, rid(input), ['loyalty'])
      const { rows } = await client.query('SELECT * FROM llenamos.loyalty_rewards WHERE restaurant_id=$1 ORDER BY points_cost,id LIMIT $2', [rid(input), MAX_LIVE_ROWS])
      return rows.map(r => ({ id: r.id, name: r.name, pointsCost: r.points_cost, kind: r.kind, valueCents: Number(r.value_cents), itemId: r.item_id, active: r.active, revision: r.revision }))
    } },
  { name: 'fidelizacion.promociones', roles: rolesFor('promociones.gestionar'), ...base, output: withId(core.PromotionSchema), topics: () => ['fidelizacion.promocion'],
    snapshot: async (client, input, { uid }) => {
      await requireModules(client, rid(input), ['loyalty'])
      // Quien tiene locales limitados solo ve las promociones cuyos locales están todos dentro de su alcance.
      const scope = await loadScope(client, rid(input), uid)
      const { rows } = await client.query(`SELECT * FROM llenamos.promotions WHERE restaurant_id=$1 AND status<>'archived' AND ${promotionInScopeSql(3)} ORDER BY id LIMIT $2`,
        [rid(input), Math.min(MAX_LIVE_ROWS, MAX_ACTIVE_PROMOTIONS * 2), [...scope.locationIds]])
      return rows.map(promotionRow)
    } },
  { name: 'fidelizacion.repite', roles: rolesFor('fidelizacion.gestionar'), ...base, output: core.RepiteSettingsSchema.nullable(), topics: () => ['fidelizacion.repite'],
    snapshot: async (client, input) => { await requireModules(client, rid(input), ['repite']); return repiteSettingsOrNull(client, rid(input)) } },
]
