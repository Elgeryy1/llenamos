import type { PoolClient } from 'pg'
import type { z } from 'zod'
import type { Operation } from '../operations.js'
import type { WorkerHandler } from '../worker/types.js'
import type { ConsentCheck } from '../worker/messages.js'
import type { PrivacyContributor } from '../privacy/types.js'

/** Lectura en vivo: foto inicial por SQL y temas de eventos que obligan a refrescarla. */
export interface LiveQuery {
  name: string
  roles: readonly string[]
  input: z.ZodType
  output: z.ZodType
  restaurantId: (input: unknown) => string
  /**
   * Obligatorio si la entrada lleva un local: se comprueba en cada vuelta contra `memberships.location_ids`
   * (RLS solo filtra por restaurante). Quien tiene la lista vacía ve todos los locales.
   */
  locationId?: (input: unknown) => string | null
  /** Temas exactos, o `prefijo.*` para todos los que cuelguen de él. */
  topics: (input: unknown) => readonly string[]
  /** Cambios que no pasan por eventos (p. ej. los que hace plataforma): relee la foto cada tanto y la envía solo si difiere. */
  refreshMs?: number
  snapshot: (client: PoolClient, input: unknown, context: { uid: string }) => Promise<unknown>
}

/** Cada módulo vive en `src/modules/<modulo>/` y solo se registra en `src/modules/index.ts`. */
export interface ModuleDefinition {
  name: string
  operations: ReadonlyArray<readonly [string, Operation]>
  liveQueries?: ReadonlyArray<LiveQuery>
  /**
   * Manejadores del worker por tipo de outbox/trabajo (`modulo.accion`). Idempotentes. Los tipos
   * `webhook.stripe`, `webhook.whatsapp` y `mensaje.respuesta` admiten varios módulos a la vez.
   */
  workerHandlers?: ReadonlyArray<readonly [string, WorkerHandler]>
  /** Comprobación de consentimiento de marketing antes de enviar (módulo de clientes). */
  marketingConsent?: ConsentCheck
  /** Datos personales del módulo: existencia, exportación y borrado de una persona. */
  privacy?: PrivacyContributor
  /**
   * Tablas con datos personales de este módulo. Si declara alguna, `privacy` es obligatorio: sin él, las
   * exportaciones y borrados de privacidad se bloquean en vez de darse por completos.
   */
  personalData?: readonly string[]
}
