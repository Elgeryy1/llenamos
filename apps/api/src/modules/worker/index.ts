import * as core from '@llenamos/core'
import { rolesWith } from '../../files/purposes.js'
import { MESSAGE_KIND } from '../../worker/messages.js'
import type { ModuleDefinition } from '../types.js'

/**
 * `procesarMensajesPendientes` ya no envía dentro de la petición ni adelanta avisos programados a futuro (como
 * el original, solo procesa lo ya vencido): el worker lo toma solo. Devuelve cuántos vencidos esperan y el
 * estado de las últimas 24 h.
 */
export const workerModule: ModuleDefinition = {
  name: 'worker',
  operations: [['procesarMensajesPendientes', {
    access: 'member', roles: rolesWith('mensajes.ver'),
    restaurantId: input => (input as { restaurantId?: string }).restaurantId ?? '',
    input: core.ProcesarMensajesPendientesInputSchema.refine(value => !!value.restaurantId, 'Selecciona un restaurante.'),
    output: core.ProcesarMensajesPendientesOutputSchema,
    run: async (client, raw) => {
      const input = core.ProcesarMensajesPendientesInputSchema.parse(raw)
      const recent = await client.query<{ status: string; n: number }>("SELECT status,count(*)::int AS n FROM llenamos.message_deliveries WHERE restaurant_id=$1 AND updated_at>now()-interval '24 hours' GROUP BY status", [input.restaurantId])
      const count = (status: string) => recent.rows.find(row => row.status === status)?.n ?? 0
      return { processed: (await client.query<{ n: number }>("SELECT count(*)::int AS n FROM llenamos.outbox WHERE restaurant_id=$1 AND kind=$2 AND status IN ('pending','leased') AND available_at<=now()", [input.restaurantId, MESSAGE_KIND])).rows[0]!.n, sent: count('sent'), captured: 0, notConfigured: count('not_configured'), failed: count('failed') }
    },
  }]],
}
