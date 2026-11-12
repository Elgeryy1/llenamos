/** Arnés de las pruebas de integración de personal e inventario: PostgreSQL temporal, API real y roles reales. */
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import * as core from '@llenamos/core'
import { migrationSql } from '../../test-migrations.js'
import { apiServer } from '../../server.js'
import type { IdentityToken } from '../../auth.js'
import type { WorkerContext } from '../../worker/types.js'
import { withTenant } from '../../worker/tenant.js'

export const source = process.env.TEST_POSTGRES_URL
export const enabled = process.env.TEST_POSTGRES_API === '1' && !!source
export const token = (uid: string, version: string): IdentityToken => ({ uid, sessionVersion: version.repeat(32), authTime: 100, platformClaim: false })

export const versionOf = (uid: string) => 'abcdef0123456789'[(USERS as readonly string[]).indexOf(uid)]!
export const identity = (uid: string) => token(uid, versionOf(uid))
export const USERS = ['owner-a', 'manager-a', 'waiter-a', 'ana-a', 'berta-a', 'kitchen-a', 'bar-a', 'owner-b', 'inactive-a', 'limited-a'] as const
const ROLE: Record<string, core.Role> = { 'owner-a': 'owner', 'manager-a': 'manager', 'waiter-a': 'waiter', 'ana-a': 'waiter', 'berta-a': 'waiter', 'kitchen-a': 'kitchen', 'bar-a': 'bar', 'owner-b': 'owner', 'inactive-a': 'owner', 'limited-a': 'owner' }

export interface Harness {
  admin: Pool
  app: Pool
  base: string
  call: (name: string, data: unknown, actor?: string) => Promise<{ status: number; body: any }>
  errors: unknown[]
  /** Operación pública (sin sesión) desde una IP de prueba distinta cada vez. */
  callPublic: (name: string, data: unknown) => Promise<{ status: number; body: any }>
  /** Pool con el login del worker (miembro de `llenamos_worker`), sin identidad de miembro. */
  worker: () => Promise<Pool>
  /** Contexto de un elemento del worker: `tenant` abre una transacción acotada al restaurante, sin actor. */
  workerContext: (restaurantId: string, kind: string, payload: Record<string, unknown>, nowMs: number) => Promise<WorkerContext>
  ok: <T = any>(name: string, data: unknown, actor?: string) => Promise<T>
  scope: (rid?: 'a' | 'b') => { restaurantId: string; locationId: string }
  mutation: (rid?: 'a' | 'b') => { restaurantId: string; locationId: string; requestId: string }
  close: () => Promise<void>
}

export async function startHarness(prefix: string): Promise<Harness> {
  const url = new URL(source!)
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.startsWith('/llenamos_api_test_')) throw new Error('Solo PostgreSQL temporal loopback de pruebas.')
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12), database = `llenamos_api_test_${prefix}_${suffix}`, runtime = `llenamos_api_${prefix}_${suffix}`
  const bootstrap = new Pool({ connectionString: source, max: 1 })
  await bootstrap.query(`CREATE DATABASE ${database}`)
  url.pathname = `/${database}`
  const admin = new Pool({ connectionString: url.toString(), max: 2 })
  for (const sql of migrationSql()) await admin.query(sql)
  await admin.query(`CREATE ROLE ${runtime} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD 'fixture-only' IN ROLE llenamos_app`)
  url.username = runtime; url.password = 'fixture-only'
  const app = new Pool({ connectionString: url.toString(), max: 12, statement_timeout: 8000 })
  for (const rid of ['a', 'b']) {
    await admin.query('INSERT INTO llenamos.restaurants(id,name,slug,plan,active_modules) VALUES($1,$2,$1,$3,$4)', [`rest-${rid}`, `Restaurante ${rid}`, 'completo', ['reservations', 'floor', 'kitchen', 'pos', 'staff', 'inventory']])
    await admin.query('INSERT INTO llenamos.locations(restaurant_id,id,name,slug) VALUES($1,$2,$3,$4)', [`rest-${rid}`, 'centro', 'Centro', 'centro'])
    await admin.query('INSERT INTO llenamos.locations(restaurant_id,id,name,slug) VALUES($1,$2,$3,$4)', [`rest-${rid}`, 'otro', 'Otro', 'otro'])
  }
  const identities: Record<string, IdentityToken> = {}
  for (const [i, uid] of USERS.entries()) {
    const version = versionOf(uid)
    identities[uid] = token(uid, version)
    await admin.query('INSERT INTO llenamos.identities(uid,session_version,tokens_valid_after,locked) VALUES($1,$2,to_timestamp(100),false)', [uid, version.repeat(32)])
    const restaurant = uid.endsWith('-b') ? 'rest-b' : 'rest-a'
    await admin.query('INSERT INTO llenamos.memberships(restaurant_id,uid,role,active,display_name,email,location_ids) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [restaurant, uid, ROLE[uid], uid !== 'inactive-a', `Persona ${uid}`, `${uid}@example.test`, uid === 'limited-a' ? ['otro'] : []])
  }
  const errors: unknown[] = []
  const server = apiServer(app, async value => identities[value] ?? (() => { throw new Error('token') })(), entry => errors.push(entry))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('address')
  const base = `http://127.0.0.1:${address.port}`
  const call = async (name: string, data: unknown, actor = 'owner-a') => {
    const response = await fetch(`${base}/v1/operations/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${actor}` }, body: JSON.stringify({ data }) })
    return { status: response.status, body: await response.json() as any }
  }
  let workerPool: Pool | null = null
  const worker = async () => {
    if (workerPool) return workerPool
    await admin.query(`CREATE ROLE ${runtime}_w LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD 'fixture-only' IN ROLE llenamos_app, llenamos_worker`)
    const workerUrl = new URL(url.toString()); workerUrl.username = `${runtime}_w`
    return (workerPool = new Pool({ connectionString: workerUrl.toString(), max: 4, statement_timeout: 8000 }))
  }
  /** Contexto completo del worker de V2 (`source:'jobs'`, credenciales, fetch, señal y lease) con su `withTenant` real. */
  const workerContext = async (restaurantId: string, kind: string, payload: Record<string, unknown>, nowMs: number): Promise<WorkerContext> => {
    const pool = await worker()
    return {
      item: { id: randomUUID(), restaurantId, kind, payload, attempts: 1, source: 'jobs' }, pool,
      tenant: fn => withTenant(pool, restaurantId, fn),
      credentials: async () => ({}),
      fetch: async () => { throw new Error('Sin red en las pruebas.') },
      now: () => new Date(nowMs),
      signal: new AbortController().signal,
      extendLease: async () => true,
    }
  }
  let ip = 0
  const callPublic = async (name: string, data: unknown) => {
    const response = await fetch(`${base}/v1/operations/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-ip': `198.51.100.${(++ip % 250) + 1}` }, body: JSON.stringify({ data }) })
    return { status: response.status, body: await response.json() as any }
  }
  return {
    admin, app, base, call, callPublic, errors, worker, workerContext,
    ok: async (name, data, actor) => { const r = await call(name, data, actor); if (r.status !== 200) throw new Error(`${name}: ${r.status} ${JSON.stringify(r.body)} ${JSON.stringify(errors.slice(-2))}`); return r.body.result },
    scope: (rid = 'a') => ({ restaurantId: `rest-${rid}`, locationId: 'centro' }),
    mutation: (rid = 'a') => ({ restaurantId: `rest-${rid}`, locationId: 'centro', requestId: randomUUID().replaceAll('-', '') }),
    close: async () => {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
      // DROP ... WITH (FORCE) puede cortar conexiones que el pool aún no soltó: ese aviso es esperable.
      for (const pool of [app, admin, workerPool]) pool?.on('error', () => undefined)
      await app.end(); await workerPool?.end(); await admin.end()
      await bootstrap.query(`DROP DATABASE ${database} WITH(FORCE)`); await bootstrap.query(`DROP ROLE IF EXISTS ${runtime}`); await bootstrap.query(`DROP ROLE IF EXISTS ${runtime}_w`); await bootstrap.end()
    },
  }
}
