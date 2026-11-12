import { randomUUID } from 'node:crypto'
import { vi } from 'vitest'
import type { PoolClient } from 'pg'
import { withIdentity } from '../../database.js'
import type { IdentityToken } from '../../auth.js'
import { integrationVault } from '../../platform/integrations.js'
import { apiServer } from '../../server.js'
import { buildHandlers, createWorker } from '../../worker/index.js'
import { testDatabase } from '../../worker/harness.js'
import { MODULES } from '../index.js'
import { setPublicAppOrigin } from '../campanas/config.js'
import { connectClientesModules } from './conexion.js'

export const vault = integrationVault(Buffer.alloc(32, 9))
export const ALL_MODULES = ['reservations', 'floor', 'kitchen', 'pos', 'repite', 'staff', 'inventory', 'loyalty', 'marketing', 'analytics']
export const cid = (n: number) => n.toString(16).padStart(20, '0')
export const req = () => randomUUID()

/**
 * Base temporal con los roles reales de API y worker. Restaurantes `a` (locales a-main y a-terraza) y `b` (b-main).
 * Miembros de `a`: owner-a, manager mgr, waiter wai, y `lim` (encargado limitado a a-main). `owner-b` dirige `b`. `plat` es operador de plataforma.
 */
export async function clientesEnvironment(label: string) {
  process.env.PUBLIC_APP_URL = 'https://app.example.test'
  setPublicAppOrigin('https://app.example.test')
  const db = await testDatabase(label)
  const issued = await db.seed(['a', 'b'], [['a', 'owner-a', 'owner'], ['a', 'mgr', 'manager'], ['a', 'wai', 'waiter'], ['a', 'lim', 'manager'], ['b', 'owner-b', 'owner']])
  await db.admin.query("INSERT INTO llenamos.identities(uid,session_version,tokens_valid_after,locked,platform_operator) VALUES('plat',$1,to_timestamp(100),false,true)", ['f'.repeat(32)])
  const token = (uid: string): IdentityToken => uid === 'plat' ? { uid, sessionVersion: 'f'.repeat(32), authTime: 100, platformClaim: true } : issued(uid)
  await db.admin.query("UPDATE llenamos.restaurants SET plan='completo',active_modules=$1,is_demo=true", [ALL_MODULES])
  await db.admin.query("UPDATE llenamos.memberships SET location_ids=ARRAY['a-main'] WHERE uid='lim'")
  for (const [rid, id] of [['a', 'a-main'], ['a', 'a-terraza'], ['b', 'b-main']]) await db.admin.query('INSERT INTO llenamos.locations(restaurant_id,id,name,slug) VALUES($1,$2,$2,$2)', [rid, id])
  connectClientesModules()
  const server = apiServer(db.app, async value => token(value), () => undefined)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const provider: Array<{ url: string; body: any }> = []
  const fetchStub = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    provider.push({ url: String(url), body: JSON.parse(String(init!.body)) })
    return new Response(JSON.stringify({ id: `re_${provider.length}` }), { status: 200 })
  }) as unknown as typeof fetch
  const call = async (name: string, uid: string | null, data: unknown) => {
    const response = await fetch(`${base}/v1/operations/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(uid ? { Authorization: `Bearer ${uid}` } : {}) }, body: JSON.stringify({ data }) })
    return { status: response.status, body: await response.json() as any }
  }
  return {
    db, token, provider, call,
    ok: async (name: string, uid: string, data: unknown) => { const r = await call(name, uid, data); if (r.status !== 200) throw new Error(`${name} → ${r.status} ${JSON.stringify(r.body)}`); return r.body.result },
    member: <T>(rid: string, uid: string, fn: (client: PoolClient) => Promise<T>) => withIdentity(db.app, token(uid), rid, fn),
    /** Corre el worker real (todos los módulos) hasta que no quede nada vencido. */
    drain: async (options: Parameters<typeof buildHandlers>[1] = {}) => {
      for (let i = 0; i < 30; i++) {
        const worker = createWorker({ pool: db.worker, fetch: fetchStub, log: () => undefined, openCredentials: (rid, cipher) => vault.open(rid, cipher), handlers: buildHandlers(MODULES, options) })
        if (!(await worker.runOnce())) return
      }
    },
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await db.close() },
  }
}
export type ClientesEnvironment = Awaited<ReturnType<typeof clientesEnvironment>>
