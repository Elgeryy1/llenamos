import { randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import type { PoolClient } from 'pg'
import { bearer } from '../auth.js'
import { withIdentity } from '../database.js'
import { ApiError } from '../errors.js'
import type { HttpRoute, RouteContext } from '../http.js'
import { enqueueJob } from '../jobs.js'
import { stableUuid } from '../ids.js'
import { FILE_PURPOSES, QUOTA, rolesWith, sniff } from './purposes.js'
import type { FileStore } from './storage.js'

const privateRoute = /^\/v1\/restaurants\/([A-Za-z0-9_-]{1,128})\/files(?:\/([0-9a-f-]{36}))?$/
const publicRoute = /^\/v1\/public\/files\/([A-Za-z0-9_-]{1,128})\/([0-9a-f-]{36})$/

const hardening = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'same-site' }

async function member(client: PoolClient, uid: string, rid: string, roles: readonly string[]) {
  const { rows } = await client.query<{ role: string }>('SELECT role FROM llenamos.memberships WHERE uid=$1 AND restaurant_id=$2 AND active', [uid, rid])
  if (!roles.includes(rows[0]?.role ?? '')) throw new ApiError(403, 'permission-denied', 'Permisos insuficientes.')
  const access = await client.query<{ allowed: boolean }>('SELECT llenamos.can_access_restaurant($1) AS allowed', [rid])
  if (!access.rows[0]?.allowed) throw new ApiError(412, 'failed-precondition', 'La suscripción no permite acceder al servicio. Revisa el plan.')
}

function purposeOf(name: unknown) {
  const purpose = typeof name === 'string' ? FILE_PURPOSES[name] : undefined
  if (!purpose || purpose.internal) throw new ApiError(400, 'invalid-argument', 'Tipo de archivo no válido.')
  return purpose
}

/**
 * Subida, descarga y borrado de archivos privados.
 * - `PUT /v1/restaurants/:rid/files?purpose=…&name=…` cuerpo binario, Authorization Bearer.
 * - `GET /v1/restaurants/:rid/files/:id` con sesión; `DELETE` igual.
 * - `GET /v1/public/files/:rid/:id` solo para propósitos públicos (fotos de la carta).
 */
export function fileRoutes(store: FileStore): HttpRoute {
  async function upload({ req, pool, verify, respond }: RouteContext, rid: string) {
    const url = new URL(req.url ?? '/', 'http://api.invalid')
    const token = await verify(bearer(req.headers.authorization))
    const purpose = purposeOf(url.searchParams.get('purpose'))
    const name = (url.searchParams.get('name') ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f/\\]/g, '').slice(0, 120)
    const declared = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
    const length = req.headers['content-length']
    if (!length || !/^\d+$/.test(length)) { req.resume(); throw new ApiError(411, 'invalid-argument', 'Falta la longitud del archivo.') }
    if (Number(length) > purpose.maxBytes) { req.resume(); throw new ApiError(413, 'resource-exhausted', 'El archivo supera el tamaño permitido.') }
    if (!purpose.types.includes(declared)) { req.resume(); throw new ApiError(415, 'unsupported-media-type', 'Tipo de archivo no admitido.') }
    // Permiso antes de leer el cuerpo: quien no puede escribir no consume disco.
    await withIdentity(pool, token, rid, client => member(client, token.uid, rid, rolesWith(purpose.write)))
    const received = await store.receive(req, purpose.maxBytes)
    try {
      const real = sniff(received.head)
      if (real !== declared || received.size === 0) throw new ApiError(415, 'unsupported-media-type', 'El contenido no coincide con el tipo indicado.')
      const id = randomUUID()
      await withIdentity(pool, token, rid, async client => {
        await member(client, token.uid, rid, rolesWith(purpose.write))
        // Serializa las subidas del restaurante para que la cuota no se rebase en paralelo.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`files:${rid}`])
        const usage = await client.query<{ bytes: string; files: string }>("SELECT coalesce(sum(size_bytes),0) AS bytes,count(*) AS files FROM llenamos.files WHERE restaurant_id=$1 AND status='active'", [rid])
        if (Number(usage.rows[0]!.bytes) + received.size > QUOTA.bytes || Number(usage.rows[0]!.files) >= QUOTA.files)
          throw new ApiError(412, 'resource-exhausted', 'Has alcanzado el espacio de archivos del restaurante.')
        await client.query('INSERT INTO llenamos.files(id,restaurant_id,purpose,owner_uid,content_type,size_bytes,sha256,display_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [id, rid, url.searchParams.get('purpose'), token.uid, declared, received.size, received.sha256, name])
        await store.commit(received.temp, rid, id)
      })
      respond(201, { result: { id, contentType: declared, sizeBytes: received.size, sha256: received.sha256 } })
    } catch (error) { await store.discard(received.temp); throw error }
  }

  async function send(res: RouteContext['res'], rid: string, id: string, meta: { content_type: string; size_bytes: string | number }, cache: string) {
    const pdf = meta.content_type === 'application/pdf'
    res.writeHead(200, { 'Content-Type': meta.content_type, 'Content-Length': String(meta.size_bytes), 'Cache-Control': cache,
      'Content-Disposition': `${pdf ? 'attachment' : 'inline'}; filename="archivo-${id.slice(0, 8)}"`, ...hardening })
    try { await pipeline(store.open(rid, id), res) } catch { res.destroy() }
  }

  return async context => {
    const { req, res, path, pool, verify } = context
    const publicMatch = publicRoute.exec(path)
    if (publicMatch) {
      if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); throw new ApiError(405, 'method-not-allowed', 'Método no permitido.') }
      const [, rid, id] = publicMatch as unknown as [string, string, string]
      // El propósito público (carta_foto) y el servicio vigente se fijan en SQL, no los decide quien llama.
      const { rows } = await pool.query<{ content_type: string; size_bytes: string }>('SELECT * FROM llenamos.file_public_lookup($1,$2)', [rid, id])
      if (!rows[0]) throw new ApiError(404, 'not-found', 'No existe el archivo.')
      await send(res, rid, id, rows[0], 'public, max-age=300')
      return true
    }
    const match = privateRoute.exec(path)
    if (!match) return false
    const [, rid, id] = match as unknown as [string, string, string | undefined]
    if (req.method === 'PUT' && !id) { await upload(context, rid); return true }
    if (!id || !['GET', 'DELETE'].includes(req.method ?? '')) { res.setHeader('Allow', id ? 'GET, DELETE' : 'PUT'); throw new ApiError(405, 'method-not-allowed', 'Método no permitido.') }
    const token = await verify(bearer(req.headers.authorization))
    if (req.method === 'GET') {
      const row = await withIdentity(pool, token, rid, async client => {
        const found = await client.query<{ purpose: string; content_type: string; size_bytes: string }>("SELECT purpose,content_type,size_bytes FROM llenamos.files WHERE id=$1 AND restaurant_id=$2 AND status='active'", [id, rid])
        const purpose = FILE_PURPOSES[found.rows[0]?.purpose ?? '']
        if (!found.rows[0] || !purpose) throw new ApiError(404, 'not-found', 'No existe el archivo.')
        await member(client, token.uid, rid, rolesWith(purpose.read))
        return found.rows[0]
      })
      await send(res, rid, id, row, 'private, no-store')
      return true
    }
    await withIdentity(pool, token, rid, async client => {
      const found = await client.query<{ purpose: string }>("SELECT purpose FROM llenamos.files WHERE id=$1 AND restaurant_id=$2 AND status='active' FOR UPDATE", [id, rid])
      const purpose = FILE_PURPOSES[found.rows[0]?.purpose ?? '']
      if (!found.rows[0] || !purpose) throw new ApiError(404, 'not-found', 'No existe el archivo.')
      await member(client, token.uid, rid, rolesWith(purpose.write))
      await client.query("UPDATE llenamos.files SET status='deleted',deleted_at=now() WHERE id=$1", [id])
      // Los bytes los retira el worker: el borrado no depende de que el disco responda ahora.
      await enqueueJob(client, { id: stableUuid('archivo.borrar', id), restaurantId: rid, kind: 'archivo.borrar', deduplicationKey: id, payload: { fileId: id } })
    })
    respond(context, 200, { result: { ok: true } })
    return true
  }
}
function respond(context: RouteContext, status: number, value: unknown) { context.respond(status, value) }
