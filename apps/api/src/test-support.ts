import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { migrationSql } from './test-migrations.js'

/** Base temporal loopback con todas las migraciones y un rol de ejecución sin privilegios. */
export async function createTestDatabase(label: string) {
  const source = process.env.TEST_POSTGRES_URL!
  const url = new URL(source)
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.startsWith('/llenamos_api_test_')) throw new Error('Solo PostgreSQL temporal loopback de pruebas.')
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12), database = `llenamos_api_test_${label}_${suffix}`, runtime = `llenamos_api_${label}_${suffix}`
  const bootstrap = new Pool({ connectionString: source, max: 1 })
  await bootstrap.query(`CREATE DATABASE ${database}`)
  url.pathname = `/${database}`
  const admin = new Pool({ connectionString: url.toString(), max: 4 })
  for (const sql of migrationSql()) await admin.query(sql)
  if (label === 'rehearsal') await admin.query("INSERT INTO llenamos.platform_flags(name, enabled) VALUES('rehearsal', true) ON CONFLICT(name) DO UPDATE SET enabled=true")
  await admin.query(`CREATE ROLE ${runtime} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD 'fixture-only' IN ROLE llenamos_app`)
  const appUrl = new URL(url); appUrl.username = runtime; appUrl.password = 'fixture-only'
  return {
    admin, appUrl: appUrl.toString(), adminUrl: url.toString(),
    async drop(...pools: Array<Pool | undefined>) {
      for (const pool of [admin, ...pools]) pool?.on('error', error => { if ((error as { code?: string }).code !== '57P01') throw error })
      for (const pool of pools) await pool?.end()
      await admin.end()
      await bootstrap.query(`DROP DATABASE ${database} WITH(FORCE)`); await bootstrap.query(`DROP ROLE IF EXISTS ${runtime}`); await bootstrap.end()
    },
  }
}
export interface Frame { id?: string; event?: string; data?: string; comment?: string }
/** Cliente SSE mínimo por fetch, igual que el del navegador. */
export async function openStream(base: string, name: string, bearer: string | null, body: unknown, headers: Record<string, string> = {}) {
  const controller = new AbortController()
  const response = await fetch(`${base}/v1/live/${name}`, { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...headers }, body: JSON.stringify({ data: body }) })
  const frames: Frame[] = []
  let ended = false
  const waiters: Array<() => void> = []
  const done = (async () => {
    if (!response.body || response.status !== 200) { ended = true; return }
    const reader = response.body.getReader(), decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { value, done: finished } = await reader.read()
        if (finished) break
        buffer += decoder.decode(value, { stream: true })
        for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
          const frame: Frame = {}
          for (const line of buffer.slice(0, at).split('\n')) {
            if (line.startsWith(':')) frame.comment = line.slice(1).trim()
            else if (line.startsWith('id: ')) frame.id = line.slice(4)
            else if (line.startsWith('event: ')) frame.event = line.slice(7)
            else if (line.startsWith('data: ')) frame.data = line.slice(6)
          }
          buffer = buffer.slice(at + 2)
          frames.push(frame); waiters.splice(0).forEach(wake => wake())
        }
      }
    } catch { /* abortado */ }
    ended = true; waiters.splice(0).forEach(wake => wake())
  })()
  async function until(test: () => boolean, ms = 4000) {
    const limit = Date.now() + ms
    while (!test()) {
      if (Date.now() > limit) throw new Error(`Tiempo agotado; tramas: ${JSON.stringify(frames)}`)
      await new Promise<void>(resolve => { waiters.push(resolve); setTimeout(resolve, 50) })
    }
  }
  return { response, frames, controller, get ended() { return ended }, snapshots: () => frames.filter(frame => frame.event === 'snapshot'),
    errors: () => frames.filter(frame => frame.event === 'error').map(frame => JSON.parse(frame.data!) as { code: string; fatal?: boolean }),
    until, close: async () => { controller.abort(); await done } }
}
