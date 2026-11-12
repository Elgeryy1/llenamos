import type { PoolClient } from 'pg'
import type * as core from '@llenamos/core'
import { ApiError } from '../../errors.js'

export interface BillSourceResult {
  customerId: string | null
  /** Líneas ya con IVA histórico (`core.billLinesFromOrderLines`). */
  lines: core.BillLine[]
  /** La mesa o la recogida se canceló; solo entonces se admite anular un registro fiscal. */
  cancelled: boolean
  /** Reserva de origen de la sesión, si la hay (señal de V3). */
  reservationId?: string | null
}
/**
 * Consumo de una mesa o recogida. Lo implementa el módulo de sala (V4), dueño de pedidos y líneas;
 * caja no lee sus tablas. Devuelve `null` si el destino no existe en este local.
 */
export interface BillSource {
  load(client: PoolClient, scope: { restaurantId: string; locationId: string }, target: core.PosTarget): Promise<BillSourceResult | null>
}
let source: BillSource | null = null
export const registerBillSource = (next: BillSource | null) => { source = next }
export function billSource(): BillSource {
  if (!source) throw new ApiError(412, 'not-deployed', 'El origen del consumo (sala y recogida) todavía no está desplegado en el VPS. No se puede abrir ni actualizar una cuenta.')
  return source
}
