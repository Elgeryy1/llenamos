import type { PoolClient } from 'pg'
import type * as core from '@llenamos/core'

/** Quién llama, ya comprobado contra la membresía activa del restaurante. */
export interface SyncActor { uid: string; role: string; locationIds: readonly string[] }
export interface EntityState { kind: core.CommandPrecondition['kind']; id: string; version: string; hash: string }

/**
 * Ejecuta una intención guardada sin conexión dentro de la transacción del servicio. Lo registra
 * el módulo dueño de la operación (sala y cocina) y debe ser idempotente por `command.commandId`:
 * el servicio ya evita repetir un recibo, pero el efecto y el recibo se confirman juntos.
 * Lanza `ApiError` con `failed-precondition`/`not-found` (conflicto) o `permission-denied` (rechazo);
 * cualquier otro error revierte todo y la intención se reintenta.
 */
export interface SyncExecutor {
  module: 'floor' | 'kitchen' | 'reservations' | 'pos' | 'repite'
  roles: readonly string[]
  execute(client: PoolClient, command: core.OfflineCommand, actor: SyncActor): Promise<unknown>
}
/**
 * Versión opaca de cada entidad que una intención da por vista (`missing` si no existe). La
 * implementa el módulo que posee las entidades; es la única parte que conoce sus tablas, y es
 * quien decide qué ve cada rol (cocina y barra solo sus líneas) lanzando `permission-denied`.
 */
export interface SyncEntities {
  read(client: PoolClient, scope: core.SyncScope, entities: ReadonlyArray<Pick<EntityState, 'kind' | 'id'>>, actor: SyncActor): Promise<Array<EntityState | null>>
}

const executors = new Map<string, SyncExecutor>()
let entities: SyncEntities | null = null
export function registerSyncExecutor(operation: core.OfflineCommand['operation'], executor: SyncExecutor): void {
  if (executors.has(operation)) throw new Error(`Ejecutor de sincronización duplicado: ${operation}`)
  executors.set(operation, executor)
}
export function registerSyncEntities(provider: SyncEntities): void {
  if (entities) throw new Error('El proveedor de entidades de sincronización ya está registrado.')
  entities = provider
}
export const syncExecutor = (operation: string): SyncExecutor | undefined => executors.get(operation)
export const syncEntities = (): SyncEntities | null => entities
/** Solo para pruebas: deja el registro como al arrancar. */
export function resetSyncRegistry(): void { executors.clear(); entities = null }
