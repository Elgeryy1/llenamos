import type { PoolClient } from 'pg'

export interface DomainEvent {
  restaurantId: string
  locationId?: string | null
  /** Tema en minúsculas con puntos, p. ej. `reservas.reserva`. Lo usan las suscripciones. */
  topic: string
  entityId?: string | null
  /** Solo lo mínimo para refrescar: nunca datos personales que el suscriptor no pueda leer. */
  payload?: Record<string, unknown>
}

/** Llamar dentro de la transacción del hecho; si la transacción falla, el evento no existe. */
export async function emitEvent(client: PoolClient, event: DomainEvent): Promise<void> {
  await client.query('INSERT INTO llenamos.events(restaurant_id,location_id,topic,entity_id,payload) VALUES($1,$2,$3,$4,$5)',
    [event.restaurantId, event.locationId ?? null, event.topic, event.entityId ?? null, event.payload ?? {}])
}
