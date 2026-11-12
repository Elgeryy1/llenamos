import type { Pool, PoolClient } from 'pg'
import * as core from '@llenamos/core'
import { enqueueExpirationJob } from '../fidelizacion/ganchos.js'
import { aggregateRecentDays } from '../analisis/dias.js'
import { dailyEvents, evaluateAutomations, expireRecommendations, purgeAutomationEvents } from '../analisis/procesos.js'
import { sendDailySummary } from '../analisis/resumen.js'
import { isPortUnavailable, FACTS_UNAVAILABLE } from '../analisis/puertos.js'
import { withTenant } from '../../worker/tenant.js'
import type { MaintenanceTask } from '../../worker/maintenance.js'

/** Recorre los restaurantes en lotes (función del worker que lista ids) y suma lo que cambia cada uno. Un restaurante que falla no corta a los demás. */
async function forEachRestaurant(pool: Pool, fn: (rid: string) => Promise<number>, log: (rid: string, error: unknown) => void): Promise<number> {
  let after = '', changed = 0
  for (;;) {
    const { rows } = await pool.query<{ id: string }>('SELECT * FROM llenamos.worker_restaurants($1,200) AS id', [after])
    for (const row of rows) { try { changed += await fn(row.id) } catch (error) { log(row.id, error) } }
    if (rows.length < 200) return changed
    after = rows.at(-1)!.id
  }
}
const logFailure = (task: string) => (rid: string, error: unknown) => console.error(JSON.stringify({ level: 'error', event: 'maintenance_restaurant_failed', task, restaurantId: rid, code: (error as { code?: string }).code ?? (error as Error).name }))

/**
 * Tareas periódicas de fidelización, campañas y análisis (se suman a las del worker en `worker-main.ts`). Cada una recorre los
 * restaurantes y trabaja en la transacción de cada uno, con lotes acotados e ids deterministas: repetir una pasada es inocuo.
 *  - resumen-diario (15 min): `sendDailySummary` deja el resumen en el outbox de avisos cuando toca (lo decide la hora de los ajustes).
 *  - automatizaciones (5 min): `evaluateAutomations` + `expireRecommendations`.
 *  - analisis-diario (3 h): eventos diarios, instantáneas de los últimos días y purga de eventos viejos.
 *  - puntos-caducan (1 h): deja el trabajo de caducidad de puntos del día de cada restaurante (ID por día).
 *  - poda-marketing (6 h): tokens de baja y destinatarios antiguos.
 */
export function clientesMaintenance(pool: Pool): MaintenanceTask[] {
  const each = (task: string, fn: (rid: string, client: PoolClient) => Promise<number>) =>
    () => forEachRestaurant(pool, rid => withTenant(pool, rid, client => fn(rid, client)), logFailure(task))
  return [
    { name: 'resumen-diario', everyMs: 900_000, run: each('resumen-diario', async (rid, client) => {
      try { return await sendDailySummary(client, rid) } catch (error) { if (isPortUnavailable(error, FACTS_UNAVAILABLE)) return 0; throw error }
    }) },
    { name: 'automatizaciones', everyMs: 300_000, run: each('automatizaciones', async (rid, client) => (await evaluateAutomations(client, rid)) + (await expireRecommendations(client, rid))) },
    { name: 'analisis-diario', everyMs: 10_800_000, run: each('analisis-diario', async (rid, client) => {
      let changed = 0
      const events = await dailyEvents(client, rid)
      changed += events.lapsed + events.forecast
      try { changed += await aggregateRecentDays(client, rid) } catch (error) { if (!isPortUnavailable(error, FACTS_UNAVAILABLE)) throw error }
      return changed + await purgeAutomationEvents(client, rid)
    }) },
    { name: 'puntos-caducan', everyMs: 3_600_000, run: each('puntos-caducan', async (rid, client) => {
      const tz = (await client.query<{ timezone: string }>('SELECT timezone FROM llenamos.restaurants WHERE id=$1', [rid])).rows[0]?.timezone ?? 'Europe/Madrid'
      await enqueueExpirationJob(client, rid, core.horaLocal(Date.now(), tz).fecha)
      return 0
    }) },
    { name: 'poda-marketing', everyMs: 21_600_000, run: each('poda-marketing', async (rid, client) => (await client.query<{ n: number }>('SELECT llenamos.marketing_prune($1,now(),2000) AS n', [rid])).rows[0]!.n) },
  ]
}
