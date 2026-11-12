import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { migrationSql } from '../test-migrations.js'
import type { IdentityToken } from '../auth.js'

/** Solo pruebas: base temporal en el PostgreSQL de pruebas, con login de API y de worker sin privilegios. */
export async function testDatabase(label: string) {
  const source = process.env.TEST_POSTGRES_URL
  const url = new URL(source!)
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.startsWith('/llenamos_api_test_')) throw new Error('Solo PostgreSQL temporal loopback de pruebas.')
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12), database = `llenamos_api_test_${label}_${suffix}`
  const apiRole = `llenamos_api_${label}_${suffix}`, workerRole = `llenamos_wk_${label}_${suffix}`, webhookRole = `llenamos_wh_${label}_${suffix}`
  const bootstrap = new Pool({ connectionString: source, max: 1 })
  await bootstrap.query(`CREATE DATABASE ${database}`)
  url.pathname = `/${database}`
  const admin = new Pool({ connectionString: url.toString(), max: 2 })
  for (const sql of migrationSql()) await admin.query(sql)
  await admin.query(`CREATE ROLE ${apiRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD 'fixture-only' IN ROLE llenamos_app`)
  await admin.query(`CREATE ROLE ${workerRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD 'fixture-only' IN ROLE llenamos_app,llenamos_worker`)
  await admin.query(`CREATE ROLE ${webhookRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD 'fixture-only' IN ROLE llenamos_webhook`)
  const as = (role: string, max: number) => { const u = new URL(url); u.username = role; u.password = 'fixture-only'; return new Pool({ connectionString: u.toString(), max, statement_timeout: 8000 }) }
  const app = as(apiRole, 8), worker = as(workerRole, 8), webhook = as(webhookRole, 4)
  return {
    admin, app, worker, webhook,
    async seed(restaurants: string[], members: Array<[string, string, string]>) {
      const versions = new Map<string, string>()
      for (const [, uid] of members) if (!versions.has(uid)) {
        const version = (versions.size + 1).toString(16).padStart(2, '0').repeat(16)
        versions.set(uid, version)
        await admin.query('INSERT INTO llenamos.identities(uid,session_version,tokens_valid_after,locked) VALUES($1,$2,to_timestamp(100),false)', [uid, version])
      }
      for (const rid of restaurants) await admin.query('INSERT INTO llenamos.restaurants(id,name,slug) VALUES($1,$2,$1)', [rid, `Restaurante ${rid}`])
      for (const [rid, uid, role] of members)
        await admin.query('INSERT INTO llenamos.memberships(restaurant_id,uid,role,active,display_name,email) VALUES($1,$2::text,$3,true,$2::text,$4)', [rid, uid, role, `${uid}@example.test`])
      return (uid: string): IdentityToken => ({ uid, sessionVersion: versions.get(uid)!, authTime: 100, platformClaim: false })
    },
    async close() {
      for (const pool of [app, worker, webhook, admin]) pool.on('error', () => undefined)
      await app.end(); await worker.end(); await webhook.end(); await admin.end()
      await bootstrap.query(`DROP DATABASE ${database} WITH(FORCE)`)
      await bootstrap.query(`DROP ROLE IF EXISTS ${apiRole}`); await bootstrap.query(`DROP ROLE IF EXISTS ${workerRole}`); await bootstrap.query(`DROP ROLE IF EXISTS ${webhookRole}`)
      await bootstrap.end()
    },
  }
}
