import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https'
import { Timestamp, type Transaction } from 'firebase-admin/firestore'
import * as core from '@llenamos/core'
import { db, uidOf } from '../shared'
import { context, denied, type Context } from '../fase2/context'
import { executeInContext } from '../fase2'

const collections = { session: 'tableSessions', takeaway: 'takeaways', line: 'orderLines', task: 'floorTasks', item: 'menuItems' } as const
export type Entity = Pick<core.CommandPrecondition, 'kind' | 'id'>
function allowed(c: Context, e: Entity) {
  if (!c.actor) denied()
  const row = c.rows[collections[e.kind]].get(e.id)
  if (!row) throw new HttpsError('not-found', 'No se encuentra la entidad en este local.')
  if (c.actor!.role === 'kitchen' || c.actor!.role === 'bar') {
    const kind = c.actor!.role === 'bar' ? 'bar' : 'kitchen'
    if (e.kind === 'line') { if (!('stationKind' in row) || row.stationKind !== kind) denied() }
    else if (e.kind === 'item') {
      const station = c.rows.stations.get(('stationId' in row ? row.stationId : null) ?? c.settings.defaultStationId ?? '')
      if (station?.kind !== kind) denied()
    } else denied()
  } else if (!core.can(c.actor!.role, 'comandas.tomar')) denied()
  return row
}
/** Token de revisión más contenido: detecta también escritores antiguos que aún no emitan revisión. */
export function entityVersion(c: Context, e: Entity): core.CommandPrecondition {
  const row = allowed(c, e)
  const linked = e.kind === 'session' || e.kind === 'takeaway'
    ? [...c.rows.orderLines.values()].filter(l => e.kind === 'session' ? l.sessionId === e.id : l.takeawayId === e.id).sort((a, b) => a.id.localeCompare(b.id)).map(l => [l, c.versions.get(`orderLines/${l.id}`) ?? null])
    : e.kind === 'task' && 'lineIds' in row ? row.lineIds.map(id => [c.rows.orderLines.get(id) ?? null, c.versions.get(`orderLines/${id}`) ?? null]) : []
  return { ...e, version: core.sha256Hex(core.canonicalJson(JSON.parse(JSON.stringify([c.versions.get(`${collections[e.kind]}/${e.id}`) ?? null, row, linked])))) }
}
export async function syncContext(tx: Transaction, scope: core.SyncScope, request: CallableRequest<unknown>, name?: core.OfflineCommand['operation']) {
  if (uidOf(request) !== scope.actorUid) denied()
  const c = await context(tx, scope.restaurantId, scope.locationId, request, name ?? 'cambiarEstadoLineas')
  if (!core.hasModule(c.restaurant, 'floor')) denied()
  if (c.restaurant.entitlementVersion && (!c.restaurant.accessValidUntil || (core.timestampToMillis(c.restaurant.accessValidUntil) ?? 0) <= Date.now())) denied()
  const device = await tx.get(c.local.collection('syncDevices').doc(scope.deviceId))
  if (device.exists && (device.get('uid') !== scope.actorUid || device.get('active') !== true)) denied()
  return { ...c, syncDeviceCreatedAt: device.get('createdAt') ?? Timestamp.now() }
}
function versions(c: Context, command: core.OfflineCommand) {
  return command.preconditions.map(p => c.rows[collections[p.kind]].has(p.id) ? entityVersion(c, { kind: p.kind, id: p.id }) : { kind: p.kind, id: p.id, version: 'missing' })
}
function receipt(c: core.OfflineCommand, result: core.CommandResult): core.CommandReceipt {
  return { commandId: c.commandId, streamKey: core.syncStreamKey(c), sequence: c.sequence, fingerprint: core.commandFingerprint(c), result, recordedAt: Date.now() }
}
/** El efecto, orderSubmissions, revisiones, actividad y recibo se confirman juntos. */
export async function synchronize(command: core.OfflineCommand, request: CallableRequest<unknown>, discard?: { requestId: string; reason: string }) {
  return db.runTransaction(async tx => {
    const c = await syncContext(tx, command, request, command.operation)
    const ref = c.local.collection('syncReceipts').doc(core.offlineCommandKey(command))
    const stream = c.local.collection('syncStreams').doc(core.syncStreamKey(command))
    const [old, cursor, predecessors, submission] = await Promise.all([
      tx.get(ref), tx.get(stream), Promise.all(command.preconditions.filter(p => p.afterCommandId).map(p => tx.get(c.local.collection('syncReceipts').doc(core.offlineCommandKey({ ...command, commandId: p.afterCommandId! }))))),
      command.operation === 'enviarPedido' ? tx.get(c.local.collection('orderSubmissions').doc(core.sha256Hex(JSON.stringify(['enviarPedido', c.uid, command.commandId])))) : null,
    ])
    if (old.get('privacyRedacted') === true || submission?.get('privacyRedacted') === true) throw new HttpsError('failed-precondition', 'Este recibo se suprimió por privacidad. La operación no se volverá a ejecutar.')
    const previous = old.exists ? core.CommandReceiptSchema.parse(old.data()) : null
    if (previous && previous.fingerprint !== core.commandFingerprint(command)) throw new HttpsError('already-exists', 'Este identificador ya pertenece a otra intención.')
    if (previous && (!discard || ['applied', 'discarded'].includes(previous.result.status))) return previous
    const settled = Number(cursor.get('lastSettledSequence') ?? 0)
    if (command.sequence <= settled) throw new HttpsError('already-exists', 'La secuencia está consumida y falta su recibo. Conserva la intención y comunica la incidencia.')
    if (command.sequence !== settled + 1) throw new HttpsError('unavailable', 'Falta resolver una intención anterior del dispositivo.')
    let result: core.CommandResult
    if (submission?.exists && command.operation === 'enviarPedido') {
      const fingerprint = core.sha256Hex(JSON.stringify(core.EnviarPedidoInputSchema.parse(command.payload)))
      if (submission.get('fingerprint') !== fingerprint) throw new HttpsError('already-exists', 'Este envío ya se utilizó con otro contenido.')
      result = core.commandResultForResponse(command, submission.get('result'), versions(c, command))
    } else if (discard) {
      result = { status: 'discarded', reason: discard.reason }
      tx.create(c.local.collection('syncResolutions').doc(core.offlineCommandKey(command)), { commandId: command.commandId, original: previous?.result ?? null, reason: discard.reason, requestId: discard.requestId, updatedBy: c.uid, createdAt: Timestamp.now(), updatedAt: Timestamp.now() })
    } else {
      const current = versions(c, command)
      const decision = core.inspectCommand(command, settled, null, current, Date.now(), 86_400_000, predecessors.filter(s => s.exists).map(s => core.CommandReceiptSchema.parse(s.data())))
      if (decision.action !== 'execute') {
        result = { status: 'conflict', code: decision.action === 'conflict' ? decision.code : 'stale_version', message: core.OFFLINE_MESSAGES.conflict, currentVersions: current }
      } else {
        try {
          const response = await executeInContext(command.operation, command.payload, c, false)
          result = core.commandResultForResponse(command, response, versions(c, command))
        } catch (error) {
          if (!(error instanceof HttpsError) || !['failed-precondition', 'not-found', 'permission-denied'].includes(error.code)) throw error
          result = error.code === 'permission-denied' ? { status: 'rejected', code: 'permission_denied', message: error.message }
            : { status: 'conflict', code: 'service_locked', message: error.message, currentVersions: current }
        }
      }
    }
    const r = receipt(command, result)
    const done = result.status === 'applied' || result.status === 'discarded'
    if (result.status === 'applied') c.flush(`sync.${command.operation}`, 'Intención del dispositivo sincronizada.')
    if (result.status === 'discarded') tx.create(c.root.collection('activity').doc(), { action: 'sync.discarded', summary: discard!.reason, actorUid: c.uid, actorName: c.actor!.displayName, entity: { type: 'syncCommand', id: command.commandId }, createdAt: Timestamp.now(), updatedAt: Timestamp.now() })
    tx.set(ref, { ...core.commandReceiptForWrite(r, Timestamp.fromMillis), updatedBy: c.uid, operation: command.operation, createdAt: old.get('createdAt') ?? Timestamp.now(), updatedAt: Timestamp.now() })
    tx.set(stream, { actorUid: c.uid, deviceId: command.deviceId, lastSettledSequence: done ? command.sequence : settled, blockedCommandId: done ? null : command.commandId, updatedBy: c.uid, createdAt: cursor.get('createdAt') ?? Timestamp.now(), updatedAt: Timestamp.now() })
    tx.set(c.local.collection('syncDevices').doc(command.deviceId), { uid: c.uid, active: true, lastSeenAt: Timestamp.now(), updatedBy: c.uid, createdAt: c.syncDeviceCreatedAt, updatedAt: Timestamp.now() })
    return r
  })
}
