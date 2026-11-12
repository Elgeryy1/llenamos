import type { PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { emitEvent } from '../events.js'
import { enqueueJob } from '../jobs.js'
import { stableUuid } from '../ids.js'
import type { FileStore } from '../files/storage.js'
import { PermanentFailure, type WorkerHandler } from '../worker/types.js'
import { sealExport, subjectHash } from './crypto.js'
import { deliveriesContributor } from './own.js'
import { uncoveredTables } from './known.js'
import type { ModuleDefinition } from '../modules/types.js'

export const PRIVACY_JOB = 'privacidad.procesar'
const EXPORT_HOURS = 24

export function privacyHandler(options: { modules: () => readonly ModuleDefinition[]; store?: FileStore; key?: Buffer }): WorkerHandler {
  return async ctx => {
    const requestId = ctx.item.payload.requestId
    if (typeof requestId !== 'string') throw new PermanentFailure('payload-invalido')
    const rid = ctx.item.restaurantId
    const modules = options.modules()
    const all = [deliveriesContributor, ...modules.flatMap(module => module.privacy ? [module.privacy] : [])]
    const uncovered = modules.filter(module => module.personalData?.length && !module.privacy).map(module => module.name)
    await ctx.tenant(async client => {
      const found = await client.query<{ id: string; subject_id: string; kind: 'export' | 'erase'; status: string }>(
        'SELECT id,subject_id,kind,status FROM llenamos.privacy_requests WHERE id=$1 AND restaurant_id=$2 FOR UPDATE', [requestId, rid])
      const request = found.rows[0]
      if (!request || !['verified', 'running', 'failed'].includes(request.status)) return
      const fail = async (status: 'blocked' | 'failed', message: string) => {
        await client.query('UPDATE llenamos.privacy_requests SET status=$2,error=$3 WHERE id=$1', [requestId, status, message.slice(0, 300)])
        await emitEvent(client, { restaurantId: rid, topic: 'privacidad.solicitud', entityId: requestId, payload: { status } })
      }
      // Un módulo con datos personales y sin borrador haría la solicitud incompleta: se bloquea, no se completa.
      if (uncovered.length) { await fail('blocked', `Faltan adaptadores de privacidad en: ${uncovered.join(', ')}.`); return }
      // Datos de la persona en tablas conocidas sin adaptador: ni exportar ni borrar se dan por completos.
      const missing = await uncoveredTables(client, rid, request.subject_id, modules)
      if (missing.length) { await fail('blocked', `Hay datos de esta persona sin adaptador de privacidad en: ${missing.join(', ')}.`); return }
      await client.query("UPDATE llenamos.privacy_requests SET status='running',error=NULL WHERE id=$1", [requestId])
      if (request.kind === 'export') {
        if (!options.store || !options.key) { await fail('failed', 'El almacén de exportaciones no está configurado.'); return }
        const data: Record<string, unknown> = {}
        let processed = 0
        for (const contributor of all) {
          for (const [name, rows] of Object.entries(await contributor.exportData(client, rid, request.subject_id))) {
            data[name] = [...(data[name] as unknown[] ?? []), ...rows]; processed += rows.length
          }
        }
        const bytes = sealExport(options.key, rid, requestId, Buffer.from(JSON.stringify({ restaurantId: rid, subjectId: request.subject_id, generatedAt: ctx.now().toISOString(), data })))
        const fileId = randomUUID(), temp = await options.store.receive((await import('node:stream')).Readable.from(bytes), bytes.length + 1)
        await options.store.commit(temp.temp, rid, fileId)
        await client.query(`INSERT INTO llenamos.files(id,restaurant_id,purpose,owner_uid,content_type,size_bytes,sha256,display_name)
          VALUES($1,$2,'exportacion_privacidad','worker','application/json',$3,$4,'datos-personales.json.enc')`, [fileId, rid, temp.size, temp.sha256])
        await client.query("UPDATE llenamos.privacy_requests SET status='completed',completed_at=now(),artifact_file_id=$2,expires_at=now()+make_interval(hours=>$3),processed=$4,error=NULL WHERE id=$1", [requestId, fileId, EXPORT_HOURS, processed])
      } else {
        // En serie y sin efectos: los `blockers` solo leen.
        const blockers: string[] = []
        for (const contributor of all) blockers.push(...(await contributor.blockers?.(client, rid, request.subject_id) ?? []))
        if (blockers.length) { await fail('blocked', blockers[0]!); return }
        // Con nadie bloqueando, los pasos con efectos (p. ej. encolar la retirada de una tarjeta en Repite) pueden escribir; si bloquean, sus efectos se confirman.
        const prepared: string[] = []
        // Se para en el primer `prepare` que bloquea: lo que escribió se confirma con el bloqueo, y no se ejecuta ninguno más.
        for (const contributor of all) { prepared.push(...(await contributor.prepare?.(client, rid, request.subject_id) ?? [])); if (prepared.length) break }
        if (prepared.length) { await fail('blocked', prepared[0]!); return }
        let processed = 0
        for (const contributor of all) processed += await contributor.erase(client, rid, request.subject_id)
        for (const contributor of all) processed += await contributor.finalize?.(client, rid, request.subject_id) ?? 0
        await client.query('INSERT INTO llenamos.privacy_tombstones(restaurant_id,subject_hash) VALUES($1,$2) ON CONFLICT DO NOTHING', [rid, subjectHash(rid, request.subject_id)])
        await retireExports(client, rid, request.subject_id, requestId)
        await client.query("UPDATE llenamos.privacy_requests SET status='completed',completed_at=now(),processed=$2,error=NULL WHERE id=$1", [requestId, processed])
      }
      await emitEvent(client, { restaurantId: rid, topic: 'privacidad.solicitud', entityId: requestId, payload: { status: 'completed' } })
    })
  }
}

/** Tras borrar a una persona no debe quedar ninguna exportación anterior suya descargable. */
async function retireExports(client: PoolClient, rid: string, subjectId: string, exceptRequest: string) {
  const { rows } = await client.query<{ artifact_file_id: string }>(
    'SELECT artifact_file_id FROM llenamos.privacy_requests WHERE restaurant_id=$1 AND subject_id=$2 AND id<>$3 AND artifact_file_id IS NOT NULL', [rid, subjectId, exceptRequest])
  for (const row of rows) {
    await client.query("UPDATE llenamos.files SET status='deleted',deleted_at=now() WHERE id=$1", [row.artifact_file_id])
    await enqueueJob(client, { id: stableUuid('archivo.borrar', row.artifact_file_id), restaurantId: rid, kind: 'archivo.borrar', deduplicationKey: row.artifact_file_id, payload: { fileId: row.artifact_file_id } })
  }
  await client.query("UPDATE llenamos.privacy_requests SET expires_at=now() WHERE restaurant_id=$1 AND subject_id=$2 AND id<>$3 AND artifact_file_id IS NOT NULL", [rid, subjectId, exceptRequest])
}
