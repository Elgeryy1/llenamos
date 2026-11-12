import type { Pool, PoolClient } from 'pg'
import type { Credentials } from '../platform/integrations.js'

/** Fallo que no se arregla reintentando (datos no válidos, proveedor que rechaza). Termina en `failed`. */
export class PermanentFailure extends Error {
  constructor(readonly code: string, message = code) { super(message); this.name = 'PermanentFailure' }
}
/** Hay que mirar el elemento a mano (p. ej. firma de un proveedor que no cuadra): va a cuarentena. */
export class Quarantine extends Error {
  constructor(readonly code: string, message = code) { super(message); this.name = 'Quarantine' }
}
/** Fallo transitorio con espera propia (p. ej. `Retry-After` del proveedor). */
export class RetryLater extends Error {
  constructor(readonly seconds: number, message = 'retry') { super(message); this.name = 'RetryLater' }
}

/** Aún no hay quien atienda este elemento (p. ej. falta el manejador del módulo): espera sin gastar intentos. */
export class Defer extends Error {
  constructor(readonly seconds: number, message = 'defer') { super(message); this.name = 'Defer' }
}

export type QueueSource = 'outbox' | 'jobs'
export interface WorkItem {
  id: string
  restaurantId: string
  kind: string
  payload: Record<string, unknown>
  /** Intento actual, empezando en 1. */
  attempts: number
  source: QueueSource
}

export interface WorkerContext {
  item: WorkItem
  /** Pool del worker, para servicios de módulo que abren su propia transacción (señal de reserva, ofertas de espera). */
  pool: Pool
  /** Transacción con el contexto del restaurante del elemento (RLS). Sin llamadas externas dentro. */
  tenant<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>
  /** Credenciales selladas del restaurante; vacío si no ha configurado nada. Nunca hay fallback. */
  credentials(): Promise<Credentials>
  fetch: typeof fetch
  now(): Date
  /** Se activa al agotarse el tiempo del manejador o al perder el lease: hay que dejar de trabajar. */
  signal: AbortSignal
  /** Renueva el lease justo antes de un efecto externo; falso si el elemento ya es de otro worker. */
  extendLease(): Promise<boolean>
}

/**
 * Manejador de un tipo de trabajo. Debe ser idempotente: el mismo elemento puede entregarse más de una vez
 * (lease vencido, caída tras el efecto). Terminar sin lanzar = hecho.
 */
export type WorkerHandler = (context: WorkerContext) => Promise<void>

export interface WorkerDeps {
  pool: Pool
  handlers: ReadonlyMap<string, readonly WorkerHandler[]>
  openCredentials: (restaurantId: string, ciphertext: string | null) => Credentials
  fetch?: typeof fetch
  /** Duración del lease y tope del manejador (pruebas). */
  leaseSeconds?: number
  handlerTimeoutMs?: number
  log?: (entry: object) => void
}
