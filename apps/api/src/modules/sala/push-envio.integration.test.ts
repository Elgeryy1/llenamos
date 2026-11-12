import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createECDH, randomBytes } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as core from '@llenamos/core'
import { MODULES } from '../index.js'
import { buildHandlers, createWorker } from '../../worker/index.js'
import { testDatabase } from '../../worker/harness.js'
import { fileStore } from '../../files/storage.js'
import { PUSH_JOB, pushMaintenance } from './push-envio.js'
import { seal } from './secrets.js'

const enabled = process.env.TEST_POSTGRES_API === '1' && !!process.env.TEST_POSTGRES_URL
const A = 'ra', B = 'rb', LID = 'la'

function vapid() {
  const ec = createECDH('prime256v1'); ec.generateKeys()
  return { publicKey: ec.getPublicKey().toString('base64url'), privateKey: ec.getPrivateKey().toString('base64url') }
}
function browserSubscription(host = 'fcm.googleapis.com', path = 'abc') {
  const ec = createECDH('prime256v1'); ec.generateKeys()
  return { endpoint: `https://${host}/send/${path}`, keys: { p256dh: ec.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }
}
const task = (over: Partial<core.FloorTask> = {}): core.FloorTask => ({
  type: 'call_waiter', status: 'open', sessionId: null, takeawayId: null, tableIds: [], label: 'Mesa 4', orderId: null, stationId: null, lineIds: [], note: '', dedupeKey: null, count: 1,
  openedAt: 1, dueAt: Date.now() - 60_000, createdBy: null, claimedBy: null, claimedByName: null, claimedAt: null, doneAt: null, doneBy: null, ...over,
} as core.FloorTask)

describe.skipIf(!enabled)('Avisos push de tareas vencidas con el worker real', { timeout: 30_000 }, () => {
  process.env.SALA_SECRET_KEY = 'cd'.repeat(32)
  const keys = vapid()
  process.env.VAPID_PUBLIC_KEY = keys.publicKey; process.env.VAPID_PRIVATE_KEY = keys.privateKey; process.env.VAPID_SUBJECT = 'mailto:avisos@example.test'
  let db: Awaited<ReturnType<typeof testDatabase>>, seq = 0
  const sent: Array<{ url: string }> = []
  let status = 201
  let delayMs = 0
// El worker entrega este `fetch` al manejador (`ctx.fetch`): nada sale a ningún servicio push real.
const stub = vi.fn(async (url: string | URL | Request) => { sent.push({ url: String(url) }); if (delayMs) await new Promise(r => setTimeout(r, delayMs)); return new Response('', { status }) })
  const worker = () => createWorker({ pool: db.worker, fetch: stub as unknown as typeof fetch, log: () => undefined, openCredentials: () => { throw new Error('sin credenciales') }, handlers: buildHandlers(MODULES, { files: fileStore('/tmp/llenamos-push-test') as never, privacyKey: Buffer.alloc(32, 1) }) })
  const drain = async () => { const w = worker(); for (let i = 0; i < 10; i++) if (!await w.runOnce()) break }
  const one = async (sql: string, v: unknown[] = []) => (await db.admin.query(sql, v)).rows[0]
  const deliveries = async (rid = A) => (await db.admin.query('SELECT * FROM llenamos.sala_push_deliveries WHERE restaurant_id=$1 ORDER BY id', [rid])).rows
  const run = async () => { await db.admin.query("DELETE FROM llenamos.jobs WHERE kind=$1", [PUSH_JOB]); const n = await pushMaintenance(db.worker)[0]!.run(); await drain(); return n }
  async function addTask(rid: string, id: string, doc: core.FloorTask) { await db.admin.query('INSERT INTO llenamos.sala_floor_tasks(restaurant_id,location_id,id,doc) VALUES($1,$2,$3,$4)', [rid, LID, id, JSON.stringify(doc)]) }
  async function addSub(rid: string, uid: string, enabled = true, host = 'fcm.googleapis.com') {
    const s = browserSubscription(host, `${uid}${++seq}`), id = core.sha256Hex(s.endpoint)
    await db.admin.query("INSERT INTO llenamos.sala_private(restaurant_id,location_id,kind,id,doc) VALUES($1,$2,'pushSubscriptions',$3,$4)", [rid, LID, id, JSON.stringify({ endpoint: s.endpoint, keysSealed: seal(rid, JSON.stringify(s.keys)), uid, enabled, publicKey: keys.publicKey })])
    return id
  }
  async function reset() {
    sent.length = 0; status = 201; delayMs = 0
    for (const t of ['sala_push_deliveries', 'sala_private', 'sala_floor_tasks']) await db.admin.query(`DELETE FROM llenamos.${t}`)
  }

  beforeAll(async () => {
    db = await testDatabase('push')
    await db.seed([A, B], [[A, 'waiter-a', 'waiter'], [A, 'kitchen-a', 'kitchen'], [A, 'gone-a', 'waiter'], [A, 'other-local', 'waiter'], [B, 'waiter-b', 'waiter']])
    await db.admin.query("UPDATE llenamos.restaurants SET plan='sala',active_modules='{reservations,floor,kitchen}'")
    for (const rid of [A, B]) await db.admin.query('INSERT INTO llenamos.locations(restaurant_id,id,name,slug,address,phone) VALUES($1,$2,$2,$2,$3,$4)', [rid, LID, 'Calle 1', '600000000'])
    await db.admin.query("UPDATE llenamos.memberships SET active=false WHERE uid='gone-a'")
    await db.admin.query("UPDATE llenamos.memberships SET location_ids='{otro}' WHERE uid='other-local'")
  })
  afterEach(reset)
  afterAll(async () => { await db?.close() })

  it('avisa una sola vez de una tarea vencida sin dueño, aunque el trabajo se repita', async () => {
    await addTask(A, 't1', task()); const sub = await addSub(A, 'waiter-a')
    expect(await run()).toBe(1)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.url).toContain('fcm.googleapis.com')
    const [delivery] = await deliveries()
    expect(delivery).toMatchObject({ task_id: 't1', subscription_id: sub, status: 'sent', attempts: 1 })
    await run()
    expect(sent).toHaveLength(1)
  })
  it('no avisa de tareas sin vencer, cogidas o hechas', async () => {
    await addTask(A, 'futura', task({ dueAt: Date.now() + 600_000 }))
    await addTask(A, 'cogida', task({ claimedBy: 'waiter-a', claimedByName: 'Ana', claimedAt: 1, status: 'claimed' }))
    await addTask(A, 'hecha', task({ status: 'done', doneAt: 1, doneBy: 'waiter-a' }))
    await addSub(A, 'waiter-a')
    expect(await run()).toBe(0)
    expect(sent).toHaveLength(0); expect(await deliveries()).toHaveLength(0)
  })
  it('una tarea cogida entre el trabajo encolado y el envío no avisa', async () => {
    await addTask(A, 't1', task()); await addSub(A, 'waiter-a')
    await db.admin.query("DELETE FROM llenamos.jobs WHERE kind=$1", [PUSH_JOB])
    expect(await pushMaintenance(db.worker)[0]!.run()).toBe(1) // el trabajo ya está encolado con la tarea sin dueño
    await db.admin.query("UPDATE llenamos.sala_floor_tasks SET doc=jsonb_set(jsonb_set(doc,'{status}','\"claimed\"'),'{claimedBy}','\"waiter-a\"')")
    await drain()
    expect(sent).toHaveLength(0); expect(await deliveries()).toHaveLength(0)
  })
  it('dos trabajos solapados del mismo local envían el aviso una sola vez', async () => {
    delayMs = 300
    await addTask(A, 't1', task()); await addSub(A, 'waiter-a')
    for (const key of ['m1', 'm2']) await db.admin.query("INSERT INTO llenamos.jobs(id,restaurant_id,kind,deduplication_key,payload,scheduled_at) VALUES(gen_random_uuid(),$1,$2,$3,$4,now())", [A, PUSH_JOB, key, JSON.stringify({ locationId: LID })])
    await Promise.all([drain(), drain()])
    expect(sent).toHaveLength(1)
    expect(await deliveries()).toHaveLength(1)
  })
  it('un envío en vuelo (espera vigente) no se repite aunque llegue otro trabajo', async () => {
    await addTask(A, 't1', task()); const sub = await addSub(A, 'waiter-a')
    const t = (await one('SELECT id,doc FROM llenamos.sala_floor_tasks')) as { id: string; doc: core.FloorTask }
    const id = core.sha256Hex(JSON.stringify([t.id, t.doc.dueAt, sub]))
    await db.admin.query("INSERT INTO llenamos.sala_push_deliveries(restaurant_id,location_id,id,task_id,subscription_id,status,lease,attempts,retry_at) VALUES($1,$2,$3,$4,$5,'sending',gen_random_uuid(),1,$6)", [A, LID, id, t.id, sub, Date.now() + 60_000])
    await run()
    expect(sent).toHaveLength(0)
    await db.admin.query('UPDATE llenamos.sala_push_deliveries SET retry_at=0') // la espera venció: se toma el relevo una vez
    await run()
    expect(sent).toHaveLength(1)
  })
  it('las suscripciones que no pueden recibir avisos no ocupan plazas ni cuestan trabajo', async () => {
    await addTask(A, 't1', task())
    // Más de 200 suscripciones de cocina, con identificadores que ordenan antes que la de la camarera.
    for (let i = 0; i < 210; i++) await db.admin.query("INSERT INTO llenamos.sala_private(restaurant_id,location_id,kind,id,doc) VALUES($1,$2,'pushSubscriptions',$3,$4)", [A, LID, `0${String(i).padStart(4, '0')}`.padEnd(64, '0'), JSON.stringify({ endpoint: `https://fcm.googleapis.com/send/k${i}`, keysSealed: 'x', uid: 'kitchen-a', enabled: true, publicKey: keys.publicKey })])
    await addSub(A, 'waiter-a')
    await run()
    expect(sent).toHaveLength(1)
    expect(await deliveries()).toHaveLength(1)
  })
  it('la retirada de entregas antiguas no reenvía una tarea que sigue abierta', async () => {
    await addTask(A, 'abierta', task()); await addTask(A, 'cerrada', task({ status: 'done', doneAt: 1, doneBy: 'waiter-a' })); const sub = await addSub(A, 'waiter-a')
    await run()
    expect(sent).toHaveLength(1)
    await db.admin.query("INSERT INTO llenamos.sala_push_deliveries(restaurant_id,location_id,id,task_id,subscription_id,status,lease,attempts,retry_at) VALUES($1,$2,$3,'cerrada',$4,'sent',gen_random_uuid(),1,0)", [A, LID, 'f'.repeat(64), sub])
    await db.admin.query("UPDATE llenamos.sala_push_deliveries SET updated_at=now()-interval '8 days'")
    await run()
    expect(sent).toHaveLength(1) // la entrega vieja de la tarea abierta se conserva: no hay segundo envío
    expect((await deliveries()).map(d => d.task_id)).toEqual(['abierta'])
  })
  it('solo avisa a quien puede atender tareas, está activo y ve el local', async () => {
    await addTask(A, 't1', task())
    await addSub(A, 'kitchen-a'); await addSub(A, 'gone-a'); await addSub(A, 'other-local')
    await run()
    expect(sent).toHaveLength(0)
    const ok = await addSub(A, 'waiter-a')
    await run()
    expect(sent).toHaveLength(1); expect((await deliveries()).map(d => d.subscription_id)).toEqual([ok])
  })
  it('una suscripción apagada o con otra clave VAPID no recibe nada', async () => {
    await addTask(A, 't1', task()); await addSub(A, 'waiter-a', false)
    const stale = await addSub(A, 'waiter-a')
    await db.admin.query("UPDATE llenamos.sala_private SET doc=jsonb_set(doc,'{publicKey}','\"otra\"') WHERE id=$1", [stale])
    await run()
    expect(sent).toHaveLength(0)
  })
  it('el aislamiento por restaurante se mantiene: el aviso de A no usa suscripciones de B', async () => {
    await addTask(A, 't1', task()); await addSub(B, 'waiter-b')
    await run()
    expect(sent).toHaveLength(0)
    expect(await deliveries(B)).toHaveLength(0)
  })
  it('un rechazo definitivo del servicio push (410) desactiva la suscripción', async () => {
    status = 410
    await addTask(A, 't1', task()); const sub = await addSub(A, 'waiter-a')
    await run()
    expect((await deliveries())[0]).toMatchObject({ status: 'expired' })
    expect((await one("SELECT doc FROM llenamos.sala_private WHERE id=$1", [sub])).doc.enabled).toBe(false)
  })
  it('un fallo temporal se reintenta con espera y se detiene al tercer intento', async () => {
    status = 503
    await addTask(A, 't1', task()); await addSub(A, 'waiter-a')
    await run()
    expect(sent).toHaveLength(1); expect((await deliveries())[0]).toMatchObject({ status: 'failed', attempts: 1, error: 'HTTP 503' })
    await run()
    expect(sent).toHaveLength(1) // aún dentro de la espera de un minuto
    for (let i = 0; i < 4; i++) { await db.admin.query('UPDATE llenamos.sala_push_deliveries SET retry_at=0'); await run() }
    expect(sent).toHaveLength(3)
    expect((await deliveries())[0]).toMatchObject({ status: 'failed', attempts: 3 })
  })
  it('sin claves VAPID no se encola ni se envía nada', async () => {
    await addTask(A, 't1', task()); await addSub(A, 'waiter-a')
    const saved = process.env.VAPID_PRIVATE_KEY; delete process.env.VAPID_PRIVATE_KEY
    try { expect(await run()).toBe(0); expect(sent).toHaveLength(0) } finally { process.env.VAPID_PRIVATE_KEY = saved }
  })
  it('en producción la captura se ignora: se envía de verdad', async () => {
    process.env.SALA_PUSH_CAPTURE = '1'; vi.stubEnv('NODE_ENV', 'production')
    try {
      await addTask(A, 't1', task()); await addSub(A, 'waiter-a')
      await run()
      expect(sent).toHaveLength(1); expect((await deliveries())[0]).toMatchObject({ status: 'sent', payload: null })
    } finally { delete process.env.SALA_PUSH_CAPTURE; vi.unstubAllEnvs() }
  })
  it('la clave privada puede venir de un archivo de secreto (VAPID_PRIVATE_KEY_FILE), como en el despliegue', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vapid-')), file = path.join(dir, 'vapid_private_key')
    writeFileSync(file, `${keys.privateKey}\n`)
    const saved = process.env.VAPID_PRIVATE_KEY; delete process.env.VAPID_PRIVATE_KEY; process.env.VAPID_PRIVATE_KEY_FILE = file
    try {
      await addTask(A, 't1', task()); await addSub(A, 'waiter-a')
      await run()
      expect(sent).toHaveLength(1)
    } finally { process.env.VAPID_PRIVATE_KEY = saved; delete process.env.VAPID_PRIVATE_KEY_FILE; rmSync(dir, { recursive: true }) }
  })
  it('el modo de captura guarda el aviso sin enviarlo y no revela claves', async () => {
    process.env.SALA_PUSH_CAPTURE = '1'
    try {
      await addTask(A, 't1', task()); await addSub(A, 'waiter-a')
      await run()
      expect(sent).toHaveLength(0)
      const [d] = await deliveries()
      expect(d.status).toBe('captured')
      expect(d.payload).toEqual({ tag: `task:${A}:${LID}:t1`, url: expect.stringContaining('/panel/avisos?task=t1') })
      expect(JSON.stringify(d.payload)).not.toContain('Mesa 4') // el título puede llevar el nombre de un cliente
      expect(JSON.stringify(d)).not.toContain(keys.privateKey)
    } finally { delete process.env.SALA_PUSH_CAPTURE }
  })
})
