import type { PoolClient } from 'pg'
import { CampaignSchema, MarketingSettingsSchema, SegmentSchema, DocIdSchema } from '@llenamos/core'
import { z } from 'zod'
import type { LiveQuery } from '../types.js'
import { loadScope, requireModules, rolesFor, type Scope } from '../comun/acceso.js'
import { CAMPAIGN_COLUMNS, campaignView, type CampaignRow } from './campanas.js'

export const LIVE_LIMIT = 200
const Input = z.strictObject({ restaurantId: DocIdSchema })
const rid = (input: unknown) => Input.parse(input).restaurantId
const roles = rolesFor('campanas.gestionar')

async function guarded(client: PoolClient, input: unknown, uid: string): Promise<{ rid: string; scope: Scope }> {
  const id = rid(input)
  await requireModules(client, id, ['marketing'])
  return { rid: id, scope: await loadScope(client, id, uid) }
}
const base = { roles, input: Input, restaurantId: rid }

/** Formas de apps/web/src/lib/campanas/datos.ts: campañas (con id), segmentos (con id) y ajustes (o null). */
export const liveQueries: LiveQuery[] = [
  { ...base, name: 'campanas.campanas', output: z.array(CampaignSchema.extend({ id: DocIdSchema })), topics: () => ['campanas.campana'],
    snapshot: async (client, input, { uid }) => {
      const g = await guarded(client, input, uid)
      // Quien tiene locales limitados solo ve campañas de esos locales (una campaña sin local es de todo el restaurante).
      const { rows } = await client.query<CampaignRow>(
        `SELECT ${CAMPAIGN_COLUMNS} FROM llenamos.marketing_campaigns WHERE restaurant_id=$1 AND (cardinality($2::text[])=0 OR location_id=ANY($2::text[]))
         ORDER BY created_at DESC,id LIMIT $3`, [g.rid, [...g.scope.locationIds], LIVE_LIMIT])
      return rows.map(campaignView)
    } },
  { ...base, name: 'campanas.segmentos', output: z.array(SegmentSchema.extend({ id: DocIdSchema })), topics: () => ['campanas.segmento'],
    snapshot: async (client, input, { uid }) => {
      const g = await guarded(client, input, uid)
      const { rows } = await client.query('SELECT id,name,rule,revision FROM llenamos.marketing_segments WHERE restaurant_id=$1 ORDER BY created_at DESC,id LIMIT $2', [g.rid, LIVE_LIMIT])
      return rows.map(r => ({ id: r.id, name: r.name, rule: r.rule, revision: r.revision }))
    } },
  { ...base, name: 'campanas.ajustes', output: MarketingSettingsSchema.nullable(), topics: () => ['campanas.ajustes'],
    snapshot: async (client, input, { uid }) => {
      const g = await guarded(client, input, uid)
      const { rows } = await client.query('SELECT settings FROM llenamos.marketing_settings WHERE restaurant_id=$1', [g.rid])
      return rows[0] ? rows[0].settings : null
    } },
]
