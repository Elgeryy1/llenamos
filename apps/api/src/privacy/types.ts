import type { PoolClient } from 'pg'

/**
 * Lo que cada módulo sabe de una persona (id opaco de cliente). Se ejecuta en el worker dentro de una
 * transacción del restaurante; nunca debe devolver tokens, IP ni notas de terceros.
 */
export interface PrivacyContributor {
  /** Ya conoce a esta persona en este restaurante. El módulo de clientes la declara; sin ella no hay solicitudes. */
  subjectExists?: (client: PoolClient, restaurantId: string, subjectId: string) => Promise<boolean>
  /** Filas exportables, agrupadas por tabla o tipo, con solo los campos personales necesarios. */
  exportData: (client: PoolClient, restaurantId: string, subjectId: string) => Promise<Record<string, readonly Record<string, unknown>[]>>
  /** Motivos que impiden borrar ahora (servicio abierto, envíos en curso). Vacío = se puede borrar. */
  blockers?: (client: PoolClient, restaurantId: string, subjectId: string) => Promise<readonly string[]>
  /**
   * Como `blockers` pero con efectos (encolar la retirada de una tarjeta externa…). El gestor solo lo ejecuta si NINGÚN contribuyente bloquea: así lo que escribe
   * nunca se confirma junto a una solicitud que otro módulo ha bloqueado. Devuelve motivos de bloqueo (la solicitud queda bloqueada y sus efectos se confirman).
   */
  prepare?: (client: PoolClient, restaurantId: string, subjectId: string) => Promise<readonly string[]>
  /** Borra o anonimiza; devuelve cuántos registros tocó. Respeta retenciones legales (p. ej. fiscal). */
  erase: (client: PoolClient, restaurantId: string, subjectId: string) => Promise<number>
  /**
   * Paso final: el gestor lo ejecuta DESPUÉS del `erase` de todos los contribuyentes, sea cual sea su orden. Sirve para lo que cambia la llave
   * con la que los demás encuentran a la persona (p. ej. reasignar su id en las tablas de un módulo).
   */
  finalize?: (client: PoolClient, restaurantId: string, subjectId: string) => Promise<number>
}
