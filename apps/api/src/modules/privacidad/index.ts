import { createHash, randomBytes } from 'node:crypto'
import * as core from '@llenamos/core'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { ApiError } from '../../errors.js'
import { enqueueJob } from '../../jobs.js'
import { stableUuid } from '../../ids.js'
import { PRIVACY_JOB } from '../../privacy/handler.js'
import { rolesWith } from '../../files/purposes.js'
import type { PrivacyContributor } from '../../privacy/types.js'
import type { Operation } from '../../operations.js'
import type { ModuleDefinition } from '../types.js'

const roles = rolesWith('privacidad.gestionar')

/** Como en el original: solo quien ve todos los locales (sin restricción de `locationIds`) gestiona privacidad. */
export async function assertAllLocations(client: PoolClient, uid: string, rid: string) {
  const { rows } = await client.query<{ location_ids: string[] }>('SELECT location_ids FROM llenamos.memberships WHERE uid=$1 AND restaurant_id=$2 AND active', [uid, rid])
  if (rows[0]?.location_ids.length) throw new ApiError(403, 'permission-denied', 'La privacidad exige acceso a todos los locales.')
}
const hash = (value: unknown) => createHash('sha256').update(core.canonicalJson(value)).digest('hex')
const ms = (value: Date | null) => value ? value.getTime() : null

interface Row { id: string; subject_id: string; kind: 'export' | 'erase'; status: core.PrivacyJob['status']; requested_by: string; verified_by: string | null
  requested_at: Date; completed_at: Date | null; expires_at: Date | null; processed: number; error: string | null; artifact_file_id: string | null }
const job = (row: Row): core.PrivacyJob => ({ customerId: row.subject_id, kind: row.kind, status: row.status, requestedBy: row.requested_by, verifiedBy: row.verified_by,
  requestedAt: row.requested_at.getTime(), completedAt: ms(row.completed_at), artifactPath: null, expiresAt: ms(row.expires_at), cursor: null, processed: row.processed, error: row.error })
const columns = 'id,subject_id,kind,status,requested_by,verified_by,requested_at,completed_at,expires_at,processed,error,artifact_file_id'

const cursorPattern = z.string().regex(/^[A-Za-z0-9_-]{1,300}$/)
function decodeCursor(cursor: string | null): { at: string; id: string } | null {
  if (!cursor) return null
  try {
    const value = z.object({ at: z.string().datetime(), id: z.uuid() }).parse(JSON.parse(Buffer.from(cursorPattern.parse(cursor), 'base64url').toString()))
    return value
  } catch { throw new ApiError(400, 'invalid-argument', 'Cursor no válido.') }
}

/** Solicitudes de exportación y borrado de datos personales; la ejecución la hace el worker. */
export function privacyModule(contributors: () => readonly ModuleDefinition[], origin: () => string | undefined = () => process.env.PUBLIC_APP_URL): ModuleDefinition {
  const people = () => contributors().flatMap(module => module.privacy ? [module.privacy as PrivacyContributor] : [])
  const operations: Array<readonly [string, Operation]> = [
    ['solicitarPrivacidad', { access: 'member', roles, restaurantId: i => (i as { restaurantId: string }).restaurantId,
      input: core.SolicitarPrivacidadInputSchema, output: core.SolicitarPrivacidadOutputSchema,
      run: async (client, raw, context) => {
        const input = core.SolicitarPrivacidadInputSchema.parse(raw), digest = hash(input)
        await assertAllLocations(client, context.uid, input.restaurantId)
        const known = (await Promise.all(people().map(p => p.subjectExists?.(client, input.restaurantId, input.customerId) ?? false)))
        const prior = await client.query<Row & { request_hash: string }>(`SELECT ${columns},request_hash FROM llenamos.privacy_requests WHERE restaurant_id=$1 AND requested_by=$2 AND request_key=$3`, [input.restaurantId, context.uid, input.requestId])
        if (prior.rows[0]) {
          if (prior.rows[0].request_hash !== digest) throw new ApiError(409, 'already-exists', 'Esta petición ya se usó con otros datos.')
          return { jobId: prior.rows[0].id, job: job(prior.rows[0]) }
        }
        if (!known.some(Boolean)) throw new ApiError(412, 'failed-precondition', 'No se encuentra la ficha de esta persona.')
        const id = stableUuid('privacidad', input.restaurantId, context.uid, input.requestId)
        const { rows } = await client.query<Row>(`INSERT INTO llenamos.privacy_requests(id,restaurant_id,subject_id,kind,requested_by,reason,request_key,request_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${columns}`, [id, input.restaurantId, input.customerId, input.kind, context.uid, input.reason, input.requestId, digest])
        return { jobId: id, job: job(rows[0]!) }
      } }],
    ['verificarSolicitudPrivacidad', { access: 'member', roles, restaurantId: i => (i as { restaurantId: string }).restaurantId,
      input: core.VerificarSolicitudPrivacidadInputSchema, output: core.VerificarSolicitudPrivacidadOutputSchema,
      run: async (client, raw, context) => {
        const input = core.VerificarSolicitudPrivacidadInputSchema.parse(raw)
        await assertAllLocations(client, context.uid, input.restaurantId)
        const found = await client.query<{ id: string; subject_id: string; status: string }>('SELECT id,subject_id,status FROM llenamos.privacy_requests WHERE id::text=$1 AND restaurant_id=$2 FOR UPDATE', [input.jobId, input.restaurantId])
        const request = found.rows[0]
        if (!request) throw new ApiError(404, 'not-found', 'No se encuentra la solicitud.')
        if (!['requested', 'blocked'].includes(request.status)) throw new ApiError(412, 'failed-precondition', 'La solicitud ya está verificada o terminada.')
        const evidence = await client.query('SELECT 1 FROM llenamos.privacy_evidence WHERE restaurant_id=$1 AND id=$2 AND subject_id=$3 AND expires_at>now()', [input.restaurantId, input.evidenceId, request.subject_id])
        if (!evidence.rows[0]) throw new ApiError(412, 'failed-precondition', 'Falta una comprobación de identidad vigente para esta persona.')
        await client.query("UPDATE llenamos.privacy_requests SET status='verified',verified_by=$2,evidence_id=$3,error=NULL WHERE id=$1", [request.id, context.uid, input.evidenceId])
        // Un trabajo por intento de verificación: tras un bloqueo, verificar de nuevo vuelve a ejecutarlo.
        await enqueueJob(client, { id: stableUuid(PRIVACY_JOB, request.id, input.evidenceId, String(Date.now())), restaurantId: input.restaurantId, kind: PRIVACY_JOB,
          deduplicationKey: `${request.id}:${input.evidenceId}:${Date.now()}`, payload: { requestId: request.id } })
        return { ok: true as const }
      } }],
    ['listarSolicitudesPrivacidad', { access: 'member', roles, restaurantId: i => (i as { restaurantId: string }).restaurantId,
      input: core.ListarSolicitudesPrivacidadInputSchema, output: core.ListarSolicitudesPrivacidadOutputSchema,
      run: async (client, raw, context) => {
        const input = core.ListarSolicitudesPrivacidadInputSchema.parse(raw), after = decodeCursor(input.cursor)
        await assertAllLocations(client, context.uid, input.restaurantId)
        const { rows } = await client.query<Row>(`SELECT ${columns} FROM llenamos.privacy_requests WHERE restaurant_id=$1
          AND ($2::timestamptz IS NULL OR (requested_at,id)<($2::timestamptz,$3::uuid)) ORDER BY requested_at DESC,id DESC LIMIT $4`,
        [input.restaurantId, after?.at ?? null, after?.id ?? null, input.limit + 1])
        const page = rows.slice(0, input.limit), last = page.at(-1)
        return { jobs: page.map(row => { const { artifactPath: _p, cursor: _k, ...visible } = job(row); return { ...visible, id: row.id } }),
          nextCursor: rows.length > input.limit && last ? Buffer.from(JSON.stringify({ at: last.requested_at.toISOString(), id: last.id })).toString('base64url') : null }
      } }],
    ['descargarExportacionPrivacidad', { access: 'member', roles, restaurantId: i => (i as { restaurantId: string }).restaurantId,
      input: core.DescargarExportacionPrivacidadInputSchema, output: core.DescargarExportacionPrivacidadOutputSchema,
      run: async (client, raw, context) => {
        const input = core.DescargarExportacionPrivacidadInputSchema.parse(raw), base = origin()
        await assertAllLocations(client, context.uid, input.restaurantId)
        if (!base) throw new ApiError(503, 'failed-precondition', 'Falta el origen público de la aplicación.')
        const found = await client.query<Row>(`SELECT ${columns} FROM llenamos.privacy_requests WHERE id::text=$1 AND restaurant_id=$2`, [input.jobId, input.restaurantId])
        const request = found.rows[0]
        if (!request) throw new ApiError(404, 'not-found', 'No se encuentra la solicitud.')
        if (request.kind !== 'export' || request.status !== 'completed' || !request.artifact_file_id || !request.expires_at || request.expires_at.getTime() <= Date.now())
          throw new ApiError(412, 'failed-precondition', 'La exportación aún no está lista o ha caducado.')
        const ticket = randomBytes(32).toString('base64url'), expiresAt = Math.min(Date.now() + 900_000, request.expires_at.getTime())
        await client.query('INSERT INTO llenamos.privacy_downloads(ticket_hash,restaurant_id,request_id,actor_uid,expires_at) VALUES($1,$2,$3,$4,$5)',
          [createHash('sha256').update(ticket).digest('hex'), input.restaurantId, request.id, context.uid, new Date(expiresAt)])
        return { url: `${base.replace(/\/$/, '')}/api/v1/restaurants/${input.restaurantId}/privacy/exports/${request.id}?ticket=${ticket}`, expiresAt }
      } }],
  ]
  return { name: 'privacidad', operations }
}
