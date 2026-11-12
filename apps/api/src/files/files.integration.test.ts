import { mkdtemp, readdir, rm, stat, writeFile, utimes } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { integrationVault } from '../platform/integrations.js'
import { apiServer } from '../server.js'
import { buildHandlers, createWorker } from '../worker/index.js'
import { testDatabase } from '../worker/harness.js'
import { workerMaintenance } from '../worker/tasks.js'
import { fileRoutes } from './routes.js'
import { fileStore } from './storage.js'
import { QUOTA } from './purposes.js'

const enabled = process.env.TEST_POSTGRES_API === '1' && !!process.env.TEST_POSTGRES_URL
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 1)])
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(500, 2)])

describe.skipIf(!enabled)('Archivos privados: subida, descarga y borrado autorizados', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>, root: string, server: ReturnType<typeof apiServer>, base: string
  let store: ReturnType<typeof fileStore>
  const upload = (rid: string, user: string, body: Buffer, type = 'image/jpeg', query = 'purpose=carta_foto&name=Tortilla.jpg') =>
    fetch(`${base}/v1/restaurants/${rid}/files?${query}`, { method: 'PUT', headers: { Authorization: `Bearer ${user}`, 'Content-Type': type }, body: new Uint8Array(body) })
  const get = (rid: string, id: string, user?: string) => fetch(`${base}/v1/restaurants/${rid}/files/${id}`, { headers: user ? { Authorization: `Bearer ${user}` } : {} })

  beforeAll(async () => {
    db = await testDatabase('files')
    const token = await db.seed(['tenant-a', 'tenant-b'], [['tenant-a', 'owner-a', 'owner'], ['tenant-a', 'waiter-a', 'waiter'], ['tenant-b', 'owner-b', 'owner']])
    root = await mkdtemp(path.join(os.tmpdir(), 'llenamos-files-'))
    store = fileStore(root)
    server = apiServer(db.app, async value => token(value), () => undefined, { routes: [fileRoutes(store)] })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  }, 60_000)
  afterAll(async () => {
    server?.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await db?.close(); await rm(root, { recursive: true, force: true })
  })

  it('un encargado sube una foto, queda fuera de la raíz pública y la descarga con cabeceras seguras', async () => {
    const response = await upload('tenant-a', 'owner-a', jpeg)
    expect(response.status).toBe(201)
    const { result } = await response.json() as { result: { id: string; sizeBytes: number; sha256: string } }
    expect(result.sizeBytes).toBe(jpeg.length)
    expect(existsSync(store.locate('tenant-a', result.id))).toBe(true)
    expect((await stat(store.locate('tenant-a', result.id))).mode & 0o077).toBe(0)
    const download = await get('tenant-a', result.id, 'owner-a')
    expect(download.status).toBe(200)
    expect(Buffer.from(await download.arrayBuffer()).equals(jpeg)).toBe(true)
    expect(Object.fromEntries(['content-type', 'x-content-type-options', 'cache-control', 'content-security-policy'].map(h => [h, download.headers.get(h)]))).toEqual({
      'content-type': 'image/jpeg', 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store', 'content-security-policy': "default-src 'none'; sandbox" })
    expect((await get('tenant-a', result.id, 'waiter-a')).status).toBe(200) // el personal con permiso de carta la ve
  })

  it('exige sesión, rol con permiso y pertenencia al restaurante', async () => {
    expect((await upload('tenant-a', 'waiter-a', jpeg)).status).toBe(403) // camarero sin carta.editar
    expect((await upload('tenant-a', 'owner-b', jpeg)).status).toBe(403) // otro restaurante
    const anonymous = await fetch(`${base}/v1/restaurants/tenant-a/files?purpose=carta_foto`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: new Uint8Array(jpeg) })
    expect(anonymous.status).toBe(401)
    const { result } = await (await upload('tenant-a', 'owner-a', jpeg)).json() as { result: { id: string } }
    expect((await get('tenant-a', result.id)).status).toBe(401)
    expect((await get('tenant-a', result.id, 'owner-b')).status).toBe(404) // RLS: ni siquiera se revela que existe
    expect((await get('tenant-b', result.id, 'owner-b')).status).toBe(404) // el ID no existe en su restaurante
    expect((await fetch(`${base}/v1/restaurants/tenant-a/files/${result.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer waiter-a' } })).status).toBe(403)
  })

  it('rechaza tipo no admitido, contenido que no coincide, vacío, enorme, propósito interno y nombres raros', async () => {
    expect((await upload('tenant-a', 'owner-a', jpeg, 'text/html')).status).toBe(415)
    expect((await upload('tenant-a', 'owner-a', Buffer.from('<script>alert(1)</script>'), 'image/jpeg')).status).toBe(415) // cabecera miente
    expect((await upload('tenant-a', 'owner-a', png, 'image/jpeg')).status).toBe(415)
    expect((await upload('tenant-a', 'owner-a', Buffer.alloc(5 * 1024 * 1024 + 1, 1), 'image/jpeg')).status).toBe(413)
    expect((await upload('tenant-a', 'owner-a', jpeg, 'image/jpeg', 'purpose=exportacion_privacidad')).status).toBe(400)
    expect((await upload('tenant-a', 'owner-a', jpeg, 'image/jpeg', 'purpose=desconocido')).status).toBe(400)
    const stored = await upload('tenant-a', 'owner-a', png, 'image/png', `purpose=carta_foto&name=${encodeURIComponent('../../etc/passwd\u0000.png')}`)
    expect(stored.status).toBe(201)
    const { result } = await stored.json() as { result: { id: string } }
    expect((await db.admin.query('SELECT display_name FROM llenamos.files WHERE id=$1', [result.id])).rows[0].display_name).toBe('....etcpasswd.png')
    expect((await get('tenant-a', '../../../etc/passwd', 'owner-a')).status).toBe(404)
    expect(await readdir(path.join(root, '.tmp'))).toEqual([]) // los rechazos no dejan temporales
  })

  it('descarga pública solo de propósitos públicos y sin listar; los documentos siguen privados', async () => {
    const photo = (await (await upload('tenant-a', 'owner-a', jpeg)).json() as { result: { id: string } }).result.id
    const doc = (await (await upload('tenant-a', 'owner-a', Buffer.from('%PDF-1.4 x'), 'application/pdf', 'purpose=documento')).json() as { result: { id: string } }).result.id
    const open = await fetch(`${base}/v1/public/files/tenant-a/${photo}`)
    expect(open.status).toBe(200)
    expect(open.headers.get('cache-control')).toBe('public, max-age=300')
    expect((await fetch(`${base}/v1/public/files/tenant-a/${doc}`)).status).toBe(404)
    expect((await fetch(`${base}/v1/public/files/tenant-b/${photo}`)).status).toBe(404) // el restaurante forma parte de la clave
    expect((await fetch(`${base}/v1/public/files/tenant-a`)).status).toBe(404)
    expect((await get('tenant-a', doc, 'waiter-a')).status).toBe(403) // documento: solo ajustes.gestionar
    expect((await get('tenant-a', doc, 'owner-a')).headers.get('content-disposition')).toMatch(/^attachment/)
  })

  it('respeta la cuota por restaurante y las subidas concurrentes no la rebasan', async () => {
    await db.admin.query("DELETE FROM llenamos.files WHERE restaurant_id='tenant-b'")
    await db.admin.query("INSERT INTO llenamos.files(id,restaurant_id,purpose,owner_uid,content_type,size_bytes,sha256) SELECT gen_random_uuid(),'tenant-b','carta_foto','x','image/jpeg',1,repeat('a',64) FROM generate_series(1,$1::int - 3)", [QUOTA.files])
    const results = await Promise.all(Array.from({ length: 8 }, () => upload('tenant-b', 'owner-b', jpeg)))
    expect(results.filter(r => r.status === 201)).toHaveLength(3)
    expect(results.filter(r => r.status === 412)).toHaveLength(5)
  })

  it('borrar marca la fila, el worker retira los bytes y después ya no hay descarga', async () => {
    const id = (await (await upload('tenant-a', 'owner-a', jpeg)).json() as { result: { id: string } }).result.id
    const removed = await fetch(`${base}/v1/restaurants/tenant-a/files/${id}`, { method: 'DELETE', headers: { Authorization: 'Bearer owner-a' } })
    expect(removed.status).toBe(200)
    expect((await get('tenant-a', id, 'owner-a')).status).toBe(404)
    expect((await fetch(`${base}/v1/public/files/tenant-a/${id}`)).status).toBe(404)
    expect(existsSync(store.locate('tenant-a', id))).toBe(true)
    const vault = integrationVault(Buffer.alloc(32, 1))
    await createWorker({ pool: db.worker, log: () => undefined, openCredentials: (rid, cipher) => vault.open(rid, cipher), handlers: buildHandlers([], { files: store }) }).runOnce()
    expect(existsSync(store.locate('tenant-a', id))).toBe(false)
    expect((await db.admin.query('SELECT 1 FROM llenamos.files WHERE id=$1', [id])).rows).toEqual([])
  })

  it('el mantenimiento barre temporales viejos y bytes huérfanos sin tocar archivos con fila', async () => {
    const keep = (await (await upload('tenant-a', 'owner-a', jpeg)).json() as { result: { id: string } }).result.id
    const orphan = '11111111-2222-3333-4444-555555555555'
    await store.commit(await writeTemp('orphan'), 'tenant-a', orphan)
    const old = new Date(Date.now() - 7_200_000)
    await utimes(store.locate('tenant-a', orphan), old, old)
    const stale = await writeTemp('stale'); await utimes(stale, old, old)
    const fresh = await writeTemp('fresh')
    const tasks = Object.fromEntries(workerMaintenance(db.worker, store).map(task => [task.name, task]))
    expect(await tasks.temporales!.run()).toBe(1)
    expect(existsSync(fresh)).toBe(true)
    expect(await tasks.huerfanos!.run()).toBe(1)
    expect(existsSync(store.locate('tenant-a', orphan))).toBe(false)
    expect(existsSync(store.locate('tenant-a', keep))).toBe(true)
  })
  async function writeTemp(name: string) {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(path.join(root, '.tmp'), { recursive: true })
    const file = path.join(root, '.tmp', name); await writeFile(file, 'x'); return file
  }
})
