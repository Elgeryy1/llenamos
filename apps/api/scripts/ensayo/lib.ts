// Utilidades del ensayo de despliegue. Se ejecutan en el host contra el gateway publicado en 127.0.0.1:18080
// (ver deploy/vps/ensayo/ensayo.sh); el SQL de siembra y la identidad de ensayo pasan por `docker exec` al proyecto llenamos-ensayo.
import { execFileSync } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROJECT = 'llenamos-ensayo'
// El recorrido y la carga crean datos y usuarios: solo contra el gateway local del ensayo, nunca contra una URL ajena o de producción.
export const BASE = (() => {
  const base = process.env.ENSAYO_BASE ?? 'http://127.0.0.1:18080'
  const url = new URL(base)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash)
    throw new Error('ENSAYO_BASE solo admite http://127.0.0.1:<puerto>: el ensayo no se ejecuta contra servidores ajenos.')
  return url.origin
})()
export const RUN = join(dirname(fileURLToPath(import.meta.url)), '../../../../deploy/vps/ensayo/.run')
export const secret = (name: string) => readFileSync(join(RUN, 'secrets', name), 'utf8').trim()

/** Literal SQL seguro para valores interpolados (comilla duplicada; sin NUL). Para datos externos, mejor `vars` y `:'nombre'`. */
export const lit = (value: unknown) => {
  const text = String(value)
  if (text.includes('\0')) throw new Error('Valor SQL no válido.')
  return `'${text.replaceAll("'", "''")}'`
}
/** `vars` se pasan con `psql -v nombre=valor` y se usan como `:'nombre'`: el valor nunca se mezcla con el texto SQL. */
export const sql = (query: string, user = 'llenamos_bootstrap', vars: Record<string, string> = {}) =>
  execFileSync('docker', ['exec', '-i', `${PROJECT}-postgres-1`, 'psql', '-U', user, '-d', 'llenamos', '-X', '-q', '-At', '-F', '\t', '-v', 'ON_ERROR_STOP=1', ...Object.entries(vars).flatMap(([k, v]) => ['-v', `${k}=${v}`])], { input: query, maxBuffer: 1 << 28 }).toString()
export const login = (email: string, password: string) =>
  execFileSync('docker', ['exec', '-i', `${PROJECT}-identity-1`, 'node', '/ensayo/cli.mjs', 'login', email], { input: password }).toString().trim()

// nginx limita a 20 peticiones/s por IP (ráfaga 100): una sola máquina de pruebas se pacea para medir el servidor y no el límite.
const minInterval = 1000 / Number(process.env.CARGA_RPS ?? 14)
let nextSlot = 0
/** Acumula la espera de pacing de cada medición para restarla: se mide el servidor, no el ritmo del generador. */
export const waits = new AsyncLocalStorage<{ waited: number }>()
export async function pace() {
  const now = performance.now(); nextSlot = Math.max(nextSlot, now) + minInterval
  const wait = nextSlot - minInterval - now
  if (wait > 0) { const store = waits.getStore(); if (store) store.waited += wait; await new Promise(r => setTimeout(r, wait)) }
}
export class CallError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}
export async function call<T = any>(name: string, data: unknown, token: string | null, headers: Record<string, string> = {}): Promise<T> {
  await pace()
  const response = await fetch(`${BASE}/api/v1/operations/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify({ data }) })
  const body = await response.json().catch(() => ({})) as { result?: T; error?: { code: string; message: string } }
  if (response.status !== 200) throw new CallError(response.status, body.error?.code ?? 'unknown', `${name}: ${response.status} ${body.error?.code ?? ''} ${body.error?.message ?? ''}`)
  return body.result as T
}
export const status = async (name: string, data: unknown, token: string | null) => call(name, data, token).then(() => 200, (e: CallError) => e.status)

/** Descifra el token de invitación de la base, como haría el correo de plataforma (el ensayo no tiene proveedor de correo). */
export function invitationToken(invitationId: string): string {
  const row = sql("SELECT token_ciphertext::text FROM llenamos.account_invitations WHERE id=:'invitation'", 'llenamos_bootstrap', { invitation: invitationId }).trim()
  const env = JSON.parse(row) as { iv: string; tag: string; data: string }
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(secret('platform_invitation_key'), 'hex'), Buffer.from(env.iv, 'base64url'))
  decipher.setAAD(Buffer.from(`llenamos:account-invitation:v1:${invitationId}`)); decipher.setAuthTag(Buffer.from(env.tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(env.data, 'base64url')), decipher.final()]).toString('utf8')
}
export const requestId = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`
export const randomHex = (bytes: number) => randomBytes(bytes).toString('hex')

export interface Step { name: string; ok: boolean; ms: number; detail?: string }
export const steps: Step[] = []
export async function step<T>(name: string, run: () => Promise<T>): Promise<T | undefined> {
  const start = performance.now()
  try {
    const value = await run()
    steps.push({ name, ok: true, ms: Math.round(performance.now() - start) })
    console.log(`  ✔ ${name} (${Math.round(performance.now() - start)} ms)`)
    return value
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    steps.push({ name, ok: false, ms: Math.round(performance.now() - start), detail })
    console.log(`  ✘ ${name}: ${detail}`)
    return undefined
  }
}
export function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message) }

/** Cliente SSE por fetch, igual que el del navegador (Authorization, nunca token en la URL). */
export async function openStream(name: string, token: string, input: unknown, headers: Record<string, string> = {}) {
  await pace()
  const controller = new AbortController()
  const response = await fetch(`${BASE}/api/v1/live/${name}`, { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify({ data: input }) })
  const frames: { id?: string; event?: string; data?: string; at: number }[] = []
  const waiters: Array<() => void> = []
  const done = (async () => {
    if (!response.body || response.status !== 200) return
    const reader = response.body.getReader(), decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { value, done: finished } = await reader.read()
        if (finished) break
        buffer += decoder.decode(value, { stream: true })
        for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
          const frame: { id?: string; event?: string; data?: string; at: number } = { at: performance.now() }
          for (const line of buffer.slice(0, at).split('\n')) {
            if (line.startsWith('id: ')) frame.id = line.slice(4)
            else if (line.startsWith('event: ')) frame.event = line.slice(7)
            else if (line.startsWith('data: ')) frame.data = line.slice(6)
          }
          buffer = buffer.slice(at + 2)
          if (frame.event) { frames.push(frame); waiters.splice(0).forEach(wake => wake()) }
        }
      }
    } catch { /* abortado */ }
  })()
  return {
    response, frames,
    async until(test: () => boolean, ms = 8000) {
      const limit = Date.now() + ms
      while (!test()) {
        if (Date.now() > limit) throw new Error(`tiempo agotado esperando la trama; tramas: ${frames.map(f => f.event).join(',')}`)
        await new Promise<void>(resolve => { waiters.push(resolve); setTimeout(resolve, 50) })
      }
    },
    snapshots: () => frames.filter(f => f.event === 'snapshot'),
    async close() { controller.abort(); await done },
  }
}
