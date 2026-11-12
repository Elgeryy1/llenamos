/**
 * Tamaño de cada pool de PostgreSQL. Con `max_connections=30` (deploy/vps/compose.postgres.yaml) deben sumar como mucho
 * 30 menos las 3 reservadas del superusuario y la holgura de migraciones y copias; lo comprueba `deploy/vps/memoria.test.mjs`.
 */
export const POOL_MAX = { api: 12, webhook: 3, worker: 5 } as const
