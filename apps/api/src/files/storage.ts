import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform, type Readable } from 'node:stream'
import { ApiError } from '../errors.js'

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ridPattern = /^[A-Za-z0-9_-]{1,128}$/

/** Volumen privado fuera de la raíz pública: `<root>/<restaurante>/<aa>/<id>`. Las rutas se construyen, nunca se reciben. */
export function fileStore(root: string) {
  if (!path.isAbsolute(root)) throw new Error('FILES_ROOT debe ser absoluta.')
  const tmp = path.join(root, '.tmp')
  const locate = (rid: string, id: string) => {
    if (!ridPattern.test(rid) || !idPattern.test(id)) throw new ApiError(400, 'invalid-argument', 'Archivo no válido.')
    return path.join(root, rid, id.slice(0, 2), id)
  }
  return {
    locate,
    /** Copia el flujo a un temporal con tope de tamaño; devuelve huella, tamaño y los primeros bytes. */
    async receive(source: Readable, maxBytes: number): Promise<{ temp: string; size: number; sha256: string; head: Buffer }> {
      await mkdir(tmp, { recursive: true, mode: 0o700 })
      const temp = path.join(tmp, randomUUID())
      const hash = createHash('sha256')
      let size = 0
      let head = Buffer.alloc(0)
      const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length
        if (size > maxBytes) return callback(new ApiError(413, 'resource-exhausted', 'El archivo supera el tamaño permitido.'))
        if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)])
        hash.update(chunk); callback(null, chunk)
      } })
      try { await pipeline(source, meter, createWriteStream(temp, { flags: 'wx', mode: 0o600 })) }
      catch (error) { await rm(temp, { force: true }); throw error instanceof ApiError ? error : new ApiError(400, 'invalid-argument', 'No se pudo recibir el archivo.') }
      return { temp, size, sha256: hash.digest('hex'), head }
    },
    async commit(temp: string, rid: string, id: string) {
      const target = locate(rid, id)
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
      await rename(temp, target)
    },
    async discard(temp: string) { await rm(temp, { force: true }) },
    async remove(rid: string, id: string) { await rm(locate(rid, id), { force: true }) },
    open(rid: string, id: string) { return createReadStream(locate(rid, id)) },
    async size(rid: string, id: string) { return (await stat(locate(rid, id))).size },
    /** Temporales abandonados (caída durante una subida): se borran pasada una hora. */
    async sweepTemp(olderThanMs = 3_600_000, now = Date.now()): Promise<number> {
      let removed = 0
      for (const name of await readdir(tmp).catch(() => [])) {
        const full = path.join(tmp, name)
        if (now - (await stat(full)).mtimeMs > olderThanMs) { await rm(full, { force: true }); removed++ }
      }
      return removed
    },
    /** Archivos del volumen que no tienen fila (commit del SQL perdido tras el rename). */
    async *listRestaurant(rid: string): AsyncGenerator<{ id: string; mtimeMs: number }> {
      if (!ridPattern.test(rid)) return
      const base = path.join(root, rid)
      for (const shard of await readdir(base).catch(() => [])) for (const id of await readdir(path.join(base, shard)).catch(() => []))
        if (idPattern.test(id)) yield { id, mtimeMs: (await stat(path.join(base, shard, id))).mtimeMs }
    },
  }
}
export type FileStore = ReturnType<typeof fileStore>
