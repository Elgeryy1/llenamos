import { createHash } from 'node:crypto'
import { bearer } from '../auth.js'
import { withIdentity } from '../database.js'
import { ApiError } from '../errors.js'
import type { HttpRoute } from '../http.js'
import { rolesWith } from '../files/purposes.js'
import type { FileStore } from '../files/storage.js'
import { openExport } from './crypto.js'

const route = /^\/v1\/restaurants\/([A-Za-z0-9_-]{1,128})\/privacy\/exports\/([0-9a-f-]{36})$/

/** Descarga de una exportación: sesión, ticket de un uso (huella en SQL), vigente y del mismo usuario que lo pidió. */
export function privacyRoutes(store: FileStore, key: Buffer): HttpRoute {
  return async ({ req, res, path, pool, verify }) => {
    const match = route.exec(path)
    if (!match) return false
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); throw new ApiError(405, 'method-not-allowed', 'Método no permitido.') }
    const [, rid, requestId] = match as unknown as [string, string, string]
    const token = await verify(bearer(req.headers.authorization))
    const ticket = new URL(req.url ?? '/', 'http://api.invalid').searchParams.get('ticket') ?? ''
    if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw new ApiError(403, 'permission-denied', 'El enlace ha caducado, ya se usó o no está autorizado.')
    // El ticket solo se gasta cuando el contenido ya se ha leído y descifrado: un fallo no lo quema.
    const ticketHash = createHash('sha256').update(ticket).digest('hex')
    const plain = await withIdentity(pool, token, rid, async client => {
      const member = await client.query<{ role: string; location_ids: string[] }>('SELECT role,location_ids FROM llenamos.memberships WHERE uid=$1 AND restaurant_id=$2 AND active', [token.uid, rid])
      if (!rolesWith('privacidad.gestionar').includes(member.rows[0]?.role as never) || member.rows[0]!.location_ids.length) throw new ApiError(403, 'permission-denied', 'Permisos insuficientes.')
      const valid = await client.query<{ artifact_file_id: string }>(`SELECT r.artifact_file_id FROM llenamos.privacy_downloads d JOIN llenamos.privacy_requests r ON r.id=d.request_id
        WHERE d.ticket_hash=$1 AND d.restaurant_id=$2 AND d.request_id::text=$3 AND d.actor_uid=$4 AND NOT d.used AND d.expires_at>now()
          AND r.status='completed' AND r.expires_at>now() AND r.artifact_file_id IS NOT NULL FOR UPDATE OF d`, [ticketHash, rid, requestId, token.uid])
      if (!valid.rows[0]) throw new ApiError(403, 'permission-denied', 'El enlace ha caducado, ya se usó o no está autorizado.')
      let bytes: Buffer
      try {
        const chunks: Buffer[] = []
        for await (const chunk of store.open(rid, valid.rows[0].artifact_file_id)) chunks.push(chunk as Buffer)
        bytes = openExport(key, rid, requestId, Buffer.concat(chunks))
      } catch { throw new ApiError(404, 'not-found', 'La exportación ya no está disponible.') }
      await client.query('UPDATE llenamos.privacy_downloads SET used=true WHERE ticket_hash=$1', [ticketHash])
      return bytes
    })
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="datos-personales.json"',
      'Cache-Control': 'no-store, private', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Length': String(plain.length) })
    res.end(plain)
    return true
  }
}
