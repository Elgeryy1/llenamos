import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { integrationVault } from '../platform/integrations.js'
import { apiServer } from '../server.js'
import { fileStore } from '../files/storage.js'
import { fileRoutes } from '../files/routes.js'
import type { ModuleDefinition } from '../modules/types.js'
import { privacyModule } from '../modules/privacidad/index.js'
import { buildHandlers, createWorker } from '../worker/index.js'
import { testDatabase } from '../worker/harness.js'
import { workerMaintenance } from '../worker/tasks.js'
import { privacyRoutes } from './routes.js'
import { subjectHash } from './crypto.js'
import type { PrivacyContributor } from './types.js'

const enabled = process.env.TEST_POSTGRES_API === '1' && !!process.env.TEST_POSTGRES_URL
const key = Buffer.alloc(32, 5), vault = integrationVault(key)

describe.skipIf(!enabled)('Privacidad: exportación y borrado con identidad verificada', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>, root: string, server: ReturnType<typeof apiServer>, base: string, store: ReturnType<typeof fileStore>
  let registry: ModuleDefinition[] = [], original: ModuleDefinition[] = []
  const customers = new Map([['cus1', { name: 'Ana Pérez', phone: '+34600111222' }], ['cus2', { name: 'Luis Gómez', phone: '+34600333444' }]])
  const erased: string[] = []
  const contributor: PrivacyContributor = {
    subjectExists: async (_c, _r, subject) => customers.has(subject),
    exportData: async (_c, _r, subject) => ({ clientes: [{ nombre: customers.get(subject)?.name ?? null, telefono: customers.get(subject)?.phone ?? null }] }),
    blockers: async (_c, _r, subject) => subject === 'cus2' ? ['Hay servicio abierto con esta persona.'] : [],
    erase: async (_c, _r, subject) => { erased.push(subject); customers.delete(subject); return 1 },
  }
  const modules: ModuleDefinition[] = [{ name: 'clientes', operations: [], privacy: contributor }]
  const call = (name: string, user: string, data: unknown) => fetch(`${base}/v1/operations/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${user}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) })
  const run = async () => createWorker({ pool: db.worker, log: () => undefined, openCredentials: (rid, cipher) => vault.open(rid, cipher), handlers: buildHandlers(modules, { files: store, privacyKey: key }) }).runOnce()
  const evidence = (rid: string, id: string, subject: string, offset = '1 day') => db.admin.query(`INSERT INTO llenamos.privacy_evidence(id,restaurant_id,subject_id,method,expires_at,recorded_by) VALUES($1,$2,$3,'in_person',now()+interval '${offset}','owner-a')`, [id, rid, subject])
  const command = (suffix: string) => `privacy_${suffix}_${'0'.repeat(16)}`
  let seq = 0
  const request = async (user: string, rid: string, customerId: string, kind: 'export' | 'erase') => {
    const response = await call('solicitarPrivacidad', user, { restaurantId: rid, requestId: command(`r${++seq}`), customerId, kind, reason: 'Petición de la persona' })
    return { status: response.status, body: await response.json() as any }
  }

  beforeAll(async () => {
    db = await testDatabase('privacy')
    const token = await db.seed(['tenant-a', 'tenant-b'], [['tenant-a', 'owner-a', 'owner'], ['tenant-a', 'waiter-a', 'waiter'], ['tenant-b', 'owner-b', 'owner']])
    root = await mkdtemp(path.join(os.tmpdir(), 'llenamos-privacy-')); store = fileStore(root)
    process.env.PUBLIC_APP_URL = 'https://app.example.test'
    const module = privacyModule(() => modules)
    // El servidor se construye con el registro real salvo que sustituimos el módulo de privacidad por uno con contribuyentes de prueba.
    const { MODULES } = await import('../modules/index.js')
    registry = MODULES as ModuleDefinition[]; original = [...registry]
    registry.splice(0, registry.length, ...original.filter(m => m.name !== 'privacidad'), module)
    server = apiServer(db.app, async value => token(value), () => undefined, { routes: [fileRoutes(store), privacyRoutes(store, key)] })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  }, 60_000)
  afterAll(async () => {
    registry.splice(0, registry.length, ...original)
    server?.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await db?.close(); await rm(root, { recursive: true, force: true })
  })

  it('solo gestiona privacidad quien tiene el permiso; la petición repetida no duplica y con otros datos conflicto', async () => {
    expect((await call('solicitarPrivacidad', 'waiter-a', { restaurantId: 'tenant-a', requestId: command('w'), customerId: 'cus1', kind: 'export', reason: 'x' })).status).toBe(403)
    expect((await call('solicitarPrivacidad', 'owner-b', { restaurantId: 'tenant-a', requestId: command('b'), customerId: 'cus1', kind: 'export', reason: 'x' })).status).toBe(403)
    const input = { restaurantId: 'tenant-a', requestId: command('same'), customerId: 'cus1', kind: 'export', reason: 'Petición de la persona' }
    const [one, two] = await Promise.all([call('solicitarPrivacidad', 'owner-a', input), call('solicitarPrivacidad', 'owner-a', input)])
    expect([one.status, two.status].sort()).toContain(200)
    expect((await call('solicitarPrivacidad', 'owner-a', input)).status).toBe(200)
    expect((await call('solicitarPrivacidad', 'owner-a', { ...input, kind: 'erase' })).status).toBe(409)
    expect(Number((await db.admin.query("SELECT count(*) AS n FROM llenamos.privacy_requests WHERE request_key=$1", [input.requestId])).rows[0].n)).toBe(1)
    const unknown = await request('owner-a', 'tenant-a', 'cus-no-existe', 'export')
    expect(unknown.status).toBe(412)
  })

  it('no se procesa nada sin comprobación de identidad vigente para esa persona', async () => {
    const { body } = await request('owner-a', 'tenant-a', 'cus1', 'export')
    const jobId = body.result.jobId
    const verify = (evidenceId: string) => call('verificarSolicitudPrivacidad', 'owner-a', { restaurantId: 'tenant-a', requestId: command(`v${++seq}`), jobId, evidenceId })
    expect((await verify('ev-missing')).status).toBe(412)
    await evidence('tenant-a', 'ev-other', 'cus2'); expect((await verify('ev-other')).status).toBe(412) // de otra persona
    await db.admin.query("INSERT INTO llenamos.privacy_evidence(id,restaurant_id,subject_id,method,expires_at,recorded_by) VALUES('ev-old','tenant-a','cus1','in_person',now()-interval '1 hour','owner-a')")
    expect((await verify('ev-old')).status).toBe(412) // caducada
    expect(await run()).toBe(0)
    expect((await db.admin.query('SELECT status FROM llenamos.privacy_requests WHERE id::text=$1', [jobId])).rows[0].status).toBe('requested')
  })

  it('exportación: el worker genera un archivo cifrado, el ticket sirve una vez y caduca la exportación', async () => {
    const { body } = await request('owner-a', 'tenant-a', 'cus1', 'export')
    const jobId = body.result.jobId
    await evidence('tenant-a', 'ev-export', 'cus1')
    expect((await call('verificarSolicitudPrivacidad', 'owner-a', { restaurantId: 'tenant-a', requestId: command(`v${++seq}`), jobId, evidenceId: 'ev-export' })).status).toBe(200)
    expect((await call('descargarExportacionPrivacidad', 'owner-a', { restaurantId: 'tenant-a', jobId })).status).toBe(412) // aún no está lista
    expect(await run()).toBe(1)
    const listed = await (await call('listarSolicitudesPrivacidad', 'owner-a', { restaurantId: 'tenant-a' })).json() as any
    expect(listed.result.jobs.find((job: any) => job.id === jobId)).toMatchObject({ status: 'completed', kind: 'export' })
    const fileRow = (await db.admin.query('SELECT f.id,f.purpose FROM llenamos.privacy_requests r JOIN llenamos.files f ON f.id=r.artifact_file_id WHERE r.id::text=$1', [jobId])).rows[0]
    expect(fileRow.purpose).toBe('exportacion_privacidad')
    const onDisk = await (await import('node:fs/promises')).readFile(store.locate('tenant-a', fileRow.id))
    expect(onDisk.toString()).not.toContain('Ana Pérez') // cifrado en el volumen
    const link = ((await (await call('descargarExportacionPrivacidad', 'owner-a', { restaurantId: 'tenant-a', jobId })).json()) as any).result.url as string
    expect(link).toMatch(/^https:\/\/app\.example\.test\/api\/v1\/restaurants\/tenant-a\/privacy\/exports\//)
    const local = link.replace('https://app.example.test/api', base)
    expect((await fetch(local)).status).toBe(401) // sin sesión no sirve aunque tenga ticket
    expect((await fetch(local, { headers: { Authorization: 'Bearer waiter-a' } })).status).toBe(403)
    expect((await fetch(local.replace(/ticket=.*/, 'ticket=' + 'A'.repeat(43)), { headers: { Authorization: 'Bearer owner-a' } })).status).toBe(403)
    const ok = await fetch(local, { headers: { Authorization: 'Bearer owner-a' } })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('cache-control')).toBe('no-store, private')
    const exported = await ok.json() as any
    expect(exported.data.clientes).toEqual([{ nombre: 'Ana Pérez', telefono: '+34600111222' }])
    expect((await fetch(local, { headers: { Authorization: 'Bearer owner-a' } })).status).toBe(403) // un solo uso
    // caducidad: el mantenimiento retira la exportación y el worker borra los bytes
    await db.admin.query("UPDATE llenamos.privacy_requests SET expires_at=now()-interval '1 minute' WHERE id::text=$1", [jobId])
    expect((await call('descargarExportacionPrivacidad', 'owner-a', { restaurantId: 'tenant-a', jobId })).status).toBe(412)
    const tasks = Object.fromEntries(workerMaintenance(db.worker, store).map(task => [task.name, task]))
    expect(await tasks.exportaciones!.run()).toBeGreaterThanOrEqual(1)
    await run()
    expect((await db.admin.query('SELECT 1 FROM llenamos.files WHERE id=$1', [fileRow.id])).rows).toEqual([])
  })

  it('borrado: bloquea si hay servicio abierto y, al reintentar con comprobación, anonimiza, cancela avisos y deja huella', async () => {
    await db.admin.query(`INSERT INTO llenamos.outbox(id,restaurant_id,kind,payload) VALUES(gen_random_uuid(),'tenant-a','mensaje.enviar','{"to":"ana@example.test","customerId":"cus1"}'),(gen_random_uuid(),'tenant-b','mensaje.enviar','{"to":"b@example.test","customerId":"cus1"}')`)
    await db.admin.query(`INSERT INTO llenamos.message_deliveries(id,restaurant_id,channel,template,recipient,status,context) VALUES(gen_random_uuid(),'tenant-a','email','confirmation','ana@example.test','sent','{"customerId":"cus1","reservationId":"r1"}'),(gen_random_uuid(),'tenant-b','email','confirmation','b@example.test','sent','{"customerId":"cus1"}')`)
    // bloqueo
    const blocked = (await request('owner-a', 'tenant-a', 'cus2', 'erase')).body.result.jobId
    await evidence('tenant-a', 'ev-erase2', 'cus2')
    await call('verificarSolicitudPrivacidad', 'owner-a', { restaurantId: 'tenant-a', requestId: command(`v${++seq}`), jobId: blocked, evidenceId: 'ev-erase2' })
    await run()
    expect((await db.admin.query('SELECT status,error FROM llenamos.privacy_requests WHERE id::text=$1', [blocked])).rows[0]).toEqual({ status: 'blocked', error: 'Hay servicio abierto con esta persona.' })
    expect(erased).not.toContain('cus2')
    // borrado
    const job = (await request('owner-a', 'tenant-a', 'cus1', 'erase')).body.result.jobId
    await evidence('tenant-a', 'ev-erase1', 'cus1')
    await call('verificarSolicitudPrivacidad', 'owner-a', { restaurantId: 'tenant-a', requestId: command(`v${++seq}`), jobId: job, evidenceId: 'ev-erase1' })
    await run()
    expect((await db.admin.query('SELECT status,processed FROM llenamos.privacy_requests WHERE id::text=$1', [job])).rows[0]).toMatchObject({ status: 'completed' })
    expect(erased).toEqual(['cus1'])
    const a = (await db.admin.query("SELECT status,payload FROM llenamos.outbox WHERE restaurant_id='tenant-a' AND kind='mensaje.enviar'")).rows
    expect(JSON.stringify(a)).not.toContain('ana@example.test')
    expect((await db.admin.query("SELECT recipient,context FROM llenamos.message_deliveries WHERE restaurant_id='tenant-a'")).rows[0]).toEqual({ recipient: 'suprimido', context: { privacyRedacted: true } })
    // otro restaurante con el mismo id de cliente queda intacto
    expect((await db.admin.query("SELECT recipient FROM llenamos.message_deliveries WHERE restaurant_id='tenant-b'")).rows[0].recipient).toBe('b@example.test')
    expect(JSON.stringify((await db.admin.query("SELECT payload FROM llenamos.outbox WHERE restaurant_id='tenant-b'")).rows)).toContain('b@example.test')
    expect((await db.admin.query('SELECT 1 FROM llenamos.privacy_tombstones WHERE restaurant_id=$1 AND subject_hash=$2', ['tenant-a', subjectHash('tenant-a', 'cus1')])).rows).toHaveLength(1)
    // el borrado repetido no vuelve a tocar nada y los eventos no llevan datos personales
    const events = (await db.admin.query("SELECT payload FROM llenamos.events WHERE topic='privacidad.solicitud'")).rows
    expect(events.length).toBeGreaterThan(0)
    expect(JSON.stringify(events)).not.toMatch(/Ana|600111222|ana@/)
  })
})
