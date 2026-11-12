import { Pool } from 'pg'
import type { IdentityToken } from '../../auth.js'
import { apiServer } from '../../server.js'
import { migrationSql } from '../../test-migrations.js'

/** Base temporal de pruebas: solo loopback y `llenamos_api_test_*`. */
export const postgresTests = process.env.TEST_POSTGRES_API === '1' && !!process.env.TEST_POSTGRES_URL

const identity = (uid: string): IdentityToken => ({ uid, sessionVersion: 'e'.repeat(32), authTime: 100, platformClaim: false })

export interface Fixture {
  admin: Pool
  app: Pool
  /** Llama a una operación por HTTP como `uid`; `uid=null` es una llamada sin identidad. */
  call: (name: string, uid: string | null, data: unknown) => Promise<{ status: number; body: any }>
  close: () => Promise<void>
}

/**
 * Dos restaurantes (`a`, `b`) con todos los módulos. Miembros de `a`: owner `alice`, manager `mia`,
 * waiter `wai` (solo local `a-main`), kitchen `kit`. Dueño de `b`: `bob`. `outsider` no es miembro.
 * `extraSql` se ejecuta con el rol propietario después de las migraciones.
 */
export async function createFixture(schemaName: string, extraSql = ''): Promise<Fixture> {
  const source = process.env.TEST_POSTGRES_URL!
  const url = new URL(source)
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.startsWith('/llenamos_api_test_')) throw new Error('Estas pruebas solo aceptan la base temporal loopback llenamos_api_test_*.')
  const admin = new Pool({ connectionString: source, max: 2 })
  // Cada suite usa su propia base para no compartir estado con otras.
  const dbName = `llenamos_api_test_${schemaName}_${process.pid}_${Date.now()}`.slice(0, 60).replace(/[^a-z0-9_]/g, '_')
  await admin.query(`CREATE DATABASE ${dbName}`)
  await admin.end()
  url.pathname = `/${dbName}`
  const owner = new Pool({ connectionString: url.toString(), max: 2 })
  for (const sql of migrationSql()) await owner.query(sql)
  await owner.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='llenamos_api_test') THEN CREATE ROLE llenamos_api_test LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD 'fixture-only' IN ROLE llenamos_app; END IF; END $$")
  const appUrl = new URL(url); appUrl.username = 'llenamos_api_test'; appUrl.password = 'fixture-only'
  const app = new Pool({ connectionString: appUrl.toString(), max: 4 })
  for (const uid of ['alice', 'mia', 'wai', 'kit', 'bob', 'outsider'])
    await owner.query("INSERT INTO llenamos.identities(uid,session_version,tokens_valid_after,locked) VALUES($1,$2,to_timestamp(100),false)", [uid, 'e'.repeat(32)])
  for (const id of ['a', 'b'])
    await owner.query("INSERT INTO llenamos.restaurants(id,name,slug,plan,active_modules) VALUES($1,$2,$1,'completo',$3)", [id, `Restaurante ${id}`, ['reservations', 'floor', 'kitchen', 'pos', 'repite', 'staff', 'inventory', 'loyalty', 'marketing', 'analytics']])
  for (const [rid, id] of [['a', 'a-main'], ['a', 'a-terraza'], ['b', 'b-main']]) await owner.query('INSERT INTO llenamos.locations(restaurant_id,id,name,slug) VALUES($1,$2,$2,$2)', [rid, id])
  for (const [rid, uid, role, locations] of [['a', 'alice', 'owner', []], ['a', 'mia', 'manager', []], ['a', 'wai', 'waiter', ['a-main']], ['a', 'kit', 'kitchen', []], ['b', 'bob', 'owner', []]] as const)
    await owner.query('INSERT INTO llenamos.memberships(restaurant_id,uid,role,active,display_name,email,location_ids) VALUES($1,$2::text,$3,true,$2::text,$4,$5)', [rid, uid, role, `${uid}@example.test`, locations])
  if (extraSql) await owner.query(extraSql)
  const server = apiServer(app, async token => identity(token), () => {})
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server address')
  const base = `http://127.0.0.1:${address.port}/v1/operations`
  return {
    admin: owner, app,
    call: async (name, uid, data) => {
      const response = await fetch(`${base}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(uid ? { Authorization: `Bearer ${uid}` } : {}) }, body: JSON.stringify({ data }) })
      return { status: response.status, body: await response.json() }
    },
    close: async () => {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
      await app.end(); await owner.end()
      const cleanup = new Pool({ connectionString: source, max: 1 })
      try { await cleanup.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`) } catch { /* base temporal del contenedor */ }
      await cleanup.end()
    },
  }
}
