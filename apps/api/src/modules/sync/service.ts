import type { PoolClient } from 'pg'
import * as core from '@llenamos/core'
import { ApiError } from '../../errors.js'
import { syncEntities, syncExecutor, type EntityState, type SyncActor } from './registry.js'

export const SYNC_ROLES = ['owner', 'manager', 'waiter', 'kitchen', 'bar'] as const
const MAX_AGE_MS = 86_400_000
const denied = () => new ApiError(403, 'permission-denied', 'No tienes permiso para sincronizar en este local.')
const notDeployed = () => new ApiError(404, 'not-deployed', 'Esta operación todavía no está conectada al servicio sin conexión.')

interface Authorized { actor: SyncActor; actorName: string; deviceCreatedAt: Date | null }
/** Auth, membresía activa, local, módulo y dispositivo; igual al contexto de la callable original. */
async function authorize(client: PoolClient, uid: string, scope: core.SyncScope, roles: readonly string[], module: 'floor' | 'kitchen' | 'reservations' | 'pos' | 'repite'): Promise<Authorized> {
  if (scope.actorUid !== uid) throw denied()
  const member = await client.query<{ role: string; location_ids: string[]; display_name: string }>('SELECT role,location_ids,display_name FROM llenamos.memberships WHERE restaurant_id=$1 AND uid=$2 AND active', [scope.restaurantId, uid])
  const row = member.rows[0]
  if (!row || !roles.includes(row.role) || (row.location_ids.length > 0 && !row.location_ids.includes(scope.locationId))) throw denied()
  const place = await client.query('SELECT 1 FROM llenamos.locations WHERE restaurant_id=$1 AND id=$2', [scope.restaurantId, scope.locationId])
  if (!place.rowCount) throw new ApiError(404, 'not-found', 'No se encuentra el local.')
  const restaurant = await client.query('SELECT plan,module_overrides,active_modules,entitlement_version,access_valid_until FROM llenamos.restaurants WHERE id=$1', [scope.restaurantId])
  const r = restaurant.rows[0]
  if (!r || !core.hasModule({ plan: r.plan, moduleOverrides: r.module_overrides, activeModules: r.active_modules, entitlementVersion: r.entitlement_version, accessValidUntil: r.access_valid_until?.getTime() ?? null }, module)) throw denied()
  const device = await client.query<{ uid: string; active: boolean; created_at: Date }>('SELECT uid,active,created_at FROM llenamos.sync_devices WHERE restaurant_id=$1 AND location_id=$2 AND device_id=$3 FOR UPDATE', [scope.restaurantId, scope.locationId, scope.deviceId])
  if (device.rows[0] && (device.rows[0].uid !== uid || !device.rows[0].active)) throw denied()
  return { actor: { uid, role: row.role, locationIds: row.location_ids }, actorName: row.display_name, deviceCreatedAt: device.rows[0]?.created_at ?? null }
}
async function readReceipt(client: PoolClient, restaurantId: string, key: string, ignoreRedacted = false) {
  const { rows } = await client.query<{ command_id: string; stream_key: string; sequence: number; fingerprint: string; result: unknown; recorded_at_ms: string; privacy_redacted: boolean }>(
    'SELECT command_id,stream_key,sequence,fingerprint,result,recorded_at_ms,privacy_redacted FROM llenamos.sync_receipts WHERE restaurant_id=$1 AND receipt_key=$2', [restaurantId, key])
  const row = rows[0]
  if (!row) return null
  if (row.privacy_redacted) {
    // Un predecesor suprimido por privacidad no impide ejecutar el comando actual (como en el original).
    if (ignoreRedacted) return null
    throw new ApiError(412, 'failed-precondition', 'Este recibo se suprimió por privacidad. La operación no se volverá a ejecutar.')
  }
  return core.CommandReceiptSchema.parse({ commandId: row.command_id, streamKey: row.stream_key, sequence: row.sequence, fingerprint: row.fingerprint, result: row.result, recordedAt: Number(row.recorded_at_ms) })
}
async function currentVersions(client: PoolClient, command: core.OfflineCommand, actor: SyncActor): Promise<core.CommandPrecondition[]> {
  const provider = syncEntities()
  if (!provider) throw notDeployed()
  const states = await provider.read(client, command, command.preconditions.map(({ kind, id }) => ({ kind, id })), actor)
  return command.preconditions.map((p, index) => states[index] ? { kind: p.kind, id: p.id, version: states[index]!.version } : { kind: p.kind, id: p.id, version: 'missing' })
}

/** El efecto, el recibo, el cursor del flujo y el dispositivo se confirman en la misma transacción. */
export async function synchronize(client: PoolClient, uid: string, command: core.OfflineCommand, discard?: { requestId: string; reason: string }): Promise<core.CommandReceipt> {
  const executor = syncExecutor(command.operation)
  if (!executor) throw notDeployed()
  const { actor, actorName, deviceCreatedAt } = await authorize(client, uid, command, executor.roles, executor.module)
  const rid = command.restaurantId, streamKey = core.syncStreamKey(command), key = core.offlineCommandKey(command)
  // Una fila de flujo por dispositivo y el bloqueo de fila serializan sus comandos (y dos pestañas).
  await client.query('INSERT INTO llenamos.sync_streams(restaurant_id,stream_key,location_id,device_id,uid) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [rid, streamKey, command.locationId, command.deviceId, uid])
  const cursor = await client.query<{ last_settled_sequence: number }>('SELECT last_settled_sequence FROM llenamos.sync_streams WHERE restaurant_id=$1 AND stream_key=$2 FOR UPDATE', [rid, streamKey])
  const settled = cursor.rows[0]!.last_settled_sequence
  const previous = await readReceipt(client, rid, key)
  if (previous && previous.fingerprint !== core.commandFingerprint(command)) throw new ApiError(409, 'already-exists', 'Este identificador ya pertenece a otra intención.')
  if (previous && (!discard || ['applied', 'discarded'].includes(previous.result.status))) return previous
  if (command.sequence <= settled) throw new ApiError(409, 'already-exists', 'La secuencia está consumida y falta su recibo. Conserva la intención y comunica la incidencia.')
  if (command.sequence !== settled + 1) throw new ApiError(503, 'unavailable', 'Falta resolver una intención anterior del dispositivo.')
  let result: core.CommandResult
  if (discard) {
    result = { status: 'discarded', reason: discard.reason }
    await client.query('INSERT INTO llenamos.sync_resolutions(restaurant_id,receipt_key,command_id,original,reason,request_id,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [rid, key, command.commandId, previous?.result ?? null, discard.reason, discard.requestId, uid])
  } else {
    const predecessors: core.CommandReceipt[] = []
    for (const p of command.preconditions) if (p.afterCommandId) {
      const found = await readReceipt(client, rid, core.offlineCommandKey({ ...command, commandId: p.afterCommandId }), true)
      if (found) predecessors.push(found)
    }
    const current = await currentVersions(client, command, actor)
    const decision = core.inspectCommand(command, settled, null, current, Date.now(), MAX_AGE_MS, predecessors)
    if (decision.action !== 'execute') {
      result = { status: 'conflict', code: decision.action === 'conflict' ? decision.code : 'stale_version', message: core.OFFLINE_MESSAGES.conflict, currentVersions: current }
    } else {
      // Un fallo de dominio no puede dejar efectos a medias ni abortar la transacción del recibo.
      await client.query('SAVEPOINT sync_execute')
      try {
        const response = await executor.execute(client, command, actor)
        result = core.commandResultForResponse(command, response, await currentVersions(client, command, actor))
        await client.query('RELEASE SAVEPOINT sync_execute')
      } catch (error) {
        if (!(error instanceof ApiError) || !['failed-precondition', 'not-found', 'permission-denied'].includes(error.code)) throw error
        await client.query('ROLLBACK TO SAVEPOINT sync_execute')
        result = error.code === 'permission-denied' ? { status: 'rejected', code: 'permission_denied', message: error.message }
          : { status: 'conflict', code: 'service_locked', message: error.message, currentVersions: current }
      }
    }
  }
  const done = result.status === 'applied' || result.status === 'discarded'
  const receipt: core.CommandReceipt = { commandId: command.commandId, streamKey, sequence: command.sequence, fingerprint: core.commandFingerprint(command), result, recordedAt: Date.now() }
  await client.query(`INSERT INTO llenamos.sync_receipts(restaurant_id,receipt_key,command_id,stream_key,sequence,fingerprint,operation,result,recorded_at_ms,updated_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (restaurant_id,receipt_key) DO UPDATE SET result=EXCLUDED.result,recorded_at_ms=EXCLUDED.recorded_at_ms,updated_by=EXCLUDED.updated_by,updated_at=now()`,
  [rid, key, command.commandId, streamKey, command.sequence, receipt.fingerprint, command.operation, JSON.stringify(result), receipt.recordedAt, uid])
  // Auditoría equivalente a `activity` de Firestore: el descarte lleva autor y motivo; lo aplicado, su operación.
  if (result.status === 'discarded' || result.status === 'applied') {
    await client.query('INSERT INTO llenamos.sync_activity(restaurant_id,location_id,action,summary,actor_uid,actor_name,command_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [rid, command.locationId, result.status === 'discarded' ? 'sync.discarded' : `sync.${command.operation}`, result.status === 'discarded' ? result.reason : 'Intención del dispositivo sincronizada.', uid, actorName, command.commandId])
  }
  await client.query('UPDATE llenamos.sync_streams SET last_settled_sequence=$3,blocked_command_id=$4,updated_at=now() WHERE restaurant_id=$1 AND stream_key=$2',
    [rid, streamKey, done ? command.sequence : settled, done ? null : command.commandId])
  await client.query(`INSERT INTO llenamos.sync_devices(restaurant_id,location_id,device_id,uid,active,created_at) VALUES($1,$2,$3,$4,true,coalesce($5,now()))
    ON CONFLICT (restaurant_id,location_id,device_id) DO UPDATE SET last_seen_at=now()`, [rid, command.locationId, command.deviceId, uid, deviceCreatedAt])
  return receipt
}

export async function recover(client: PoolClient, uid: string, input: { commandId: string } & core.SyncScope): Promise<{ receipt: core.CommandReceipt | null }> {
  await authorize(client, uid, input, SYNC_ROLES, 'floor')
  return { receipt: await readReceipt(client, input.restaurantId, core.offlineCommandKey(input)) }
}

/** Versión opaca y huella del contenido de cada entidad: el cliente solo conserva la versión si la huella coincide. */
export async function prepare(client: PoolClient, uid: string, input: core.SyncScope & { entities: Array<Pick<EntityState, 'kind' | 'id'>> }) {
  const { actor } = await authorize(client, uid, input, SYNC_ROLES, 'floor')
  const provider = syncEntities()
  if (!provider) throw notDeployed()
  const states = await provider.read(client, input, input.entities, actor)
  const found = states.map((state, index) => { if (!state) throw new ApiError(404, 'not-found', 'No se encuentra la entidad en este local.'); return { ...state, kind: input.entities[index]!.kind } })
  return { versions: found.map(({ kind, id, version }) => ({ kind, id, version })), contentHashes: found.map(({ kind, id, hash }) => ({ kind, id, hash })), synchronizedAt: Date.now() }
}
