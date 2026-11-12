import * as core from '@llenamos/core'
import type { Pool } from 'pg'
import { enqueueJob } from '../../jobs.js'
import { stableUuid } from '../../ids.js'
import { forEachRestaurant } from '../../worker/tasks.js'
import { withTenant } from '../../worker/tenant.js'
import type { MaintenanceTask } from '../../worker/maintenance.js'
import { PermanentFailure, type WorkerHandler } from '../../worker/types.js'
import { loadContext, restaurantView } from './context.js'
import { destinationLines, lineStatus, reconcile } from './service.js'

export const FIRE_TAKEAWAYS_JOB = 'sala.marchar_recogidas'

/**
 * Trabajo `sala.marchar_recogidas` de un local: los platos de recogidas aceptadas pasan de «esperando» a «marchar» en
 * cuanto llega su hora (`fireAt`). Es el `marcharParaLlevar` del original. Idempotente: lo ya marchado no se toca.
 */
export const fireTakeawaysHandler: WorkerHandler = async ctx => {
  const locationId = ctx.item.payload.locationId
  if (typeof locationId !== 'string' || !locationId) throw new PermanentFailure('payload-invalido')
  await ctx.tenant(async client => {
    const rid = ctx.item.restaurantId
    const restaurant = (await client.query('SELECT * FROM llenamos.restaurants WHERE id=$1', [rid])).rows[0]
    const location = (await client.query('SELECT * FROM llenamos.locations WHERE restaurant_id=$1 AND id=$2', [rid, locationId])).rows[0]
    if (!restaurant || !location || !core.hasModule(restaurantView(restaurant), 'floor')) return
    const c = await loadContext(client, { restaurant, location }, locationId, null)
    let fired = 0
    for (const take of c.rows.takeaways.values()) {
      if (take.status !== 'accepted') continue
      for (const line of core.dueTakeawayLines(destinationLines(c, null, take.id), c.now)) { lineStatus(c, line, 'fired'); fired++ }
    }
    if (fired) { reconcile(c); await c.flush() }
  })
}

/**
 * Cada minuto deja un trabajo por local que tenga recogidas aceptadas. El ID depende del local y del minuto, así que
 * varios workers (o un reinicio) no duplican la tarea.
 */
export function salaMaintenance(pool: Pool, now: () => number = Date.now): MaintenanceTask[] {
  return [{ name: 'sala-recogidas', everyMs: 60_000, run: () => forEachRestaurant(pool, rid => withTenant(pool, rid, async client => {
    const minute = Math.floor(now() / 60_000)
    // Solo locales con algún plato retenido de una recogida aceptada cuya hora ya llegó.
    const { rows } = await client.query<{ location_id: string }>(
      `SELECT DISTINCT t.location_id FROM llenamos.sala_takeaways t
         JOIN llenamos.sala_order_lines l ON l.restaurant_id=t.restaurant_id AND l.location_id=t.location_id AND l.takeaway_id=t.id
         WHERE t.restaurant_id=$1 AND t.status='accepted' AND l.status='held' AND l.doc->>'kind'<>'menu' AND (l.doc->>'fireAt')::bigint<=$2`, [rid, now()])
    for (const { location_id } of rows)
      await enqueueJob(client, { id: stableUuid(FIRE_TAKEAWAYS_JOB, rid, location_id, String(minute)), restaurantId: rid, kind: FIRE_TAKEAWAYS_JOB, deduplicationKey: `${location_id}:${minute}`, payload: { locationId: location_id } })
    return rows.length
  })) }]
}
