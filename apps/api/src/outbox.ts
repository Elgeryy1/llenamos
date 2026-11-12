import type { PoolClient } from 'pg'

export interface OutboxMessage {
  /** ID estable (uuid): repetir la operación no debe generar un segundo envío. */
  id: string
  restaurantId: string
  /** Tipo de trabajo del worker, p. ej. `aviso.reserva_confirmada`. */
  kind: string
  payload: Record<string, unknown>
  availableAt?: Date
}

/** Encola dentro de la transacción del hecho. El worker reclama con lease e idempotencia. */
export async function enqueueOutbox(client: PoolClient, message: OutboxMessage): Promise<void> {
  await client.query(
    'INSERT INTO llenamos.outbox(id,restaurant_id,kind,payload,available_at) VALUES($1,$2,$3,$4,coalesce($5,now())) ON CONFLICT (id) DO NOTHING',
    [message.id, message.restaurantId, message.kind, message.payload, message.availableAt ?? null])
}
