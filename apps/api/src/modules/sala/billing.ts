import * as core from '@llenamos/core'
import { ApiError } from '../../errors.js'
import { registerBillSource } from '../caja/source.js'

/**
 * Origen del consumo para caja: líneas de una mesa o de una recogida con el IVA con el que se pidieron.
 * Corre en la transacción de caja (identidad y RLS del actor), así que solo ve su restaurante.
 */
export function registerSalaBillSource() {
  registerBillSource({
    async load(client, scope, target) {
      const table = target.kind === 'session' ? 'sala_table_sessions' : 'sala_takeaways', column = target.kind === 'session' ? 'session_id' : 'takeaway_id'
      const destination = (await client.query<{ doc: Record<string, any> }>(`SELECT doc FROM llenamos.${table} WHERE restaurant_id=$1 AND location_id=$2 AND id=$3`, [scope.restaurantId, scope.locationId, target.id])).rows[0]
      if (!destination) return null
      const found = await client.query<{ id: string; doc: unknown }>(`SELECT id,doc FROM llenamos.sala_order_lines WHERE restaurant_id=$1 AND location_id=$2 AND ${column}=$3 ORDER BY id`, [scope.restaurantId, scope.locationId, target.id])
      try {
        return {
          customerId: destination.doc.customerId ?? null,
          lines: core.billLinesFromOrderLines(found.rows.map(r => ({ ...core.OrderLineSchema.parse(r.doc), id: r.id }))),
          cancelled: destination.doc.status === 'cancelled',
          reservationId: target.kind === 'session' ? destination.doc.reservationId ?? null : null,
        }
      } catch (error) {
        throw new ApiError(412, 'failed-precondition', error instanceof Error ? error.message : 'No se puede calcular el consumo.')
      }
    },
  })
}
