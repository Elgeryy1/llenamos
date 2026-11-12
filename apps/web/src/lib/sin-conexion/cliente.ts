import { z } from 'zod'
import { onAuthStateChanged } from 'firebase/auth'
import { MillisSchema, OFFLINE_PAYLOAD_SCHEMAS, ServerEntityVersionSchema, canonicalJson, sha256Hex, applyCommandReceipt, CommandReceiptSchema, nextLocalCommand, OFFLINE_MESSAGES, recoverLocalQueueAfterReload, retryLocalCommand, type CommandPrecondition, type OfflineCommand, type SyncScope } from '@llenamos/core'
import { getFirebaseIdentity } from '@/lib/firebase/auth-client'
import { operationBackend, operationErrorCode } from '@/lib/api/operations'
import { postOperation } from '@/lib/api/transport'
import { enqueue, mutate, scopeFor } from './almacen'
import { cargarClienteDemo, cargarFunctions } from '@/lib/firebase/cargar-demo'

let guardInstalled = false
export function protectSession(scope: SyncScope) {
  if (!guardInstalled) {
    guardInstalled = true
    onAuthStateChanged(getFirebaseIdentity().auth, user => {
      const saved = localStorage.getItem('llenamos:offline:active')
      if (saved && (!user || JSON.parse(saved).scope.actorUid !== user.uid)) localStorage.removeItem('llenamos:offline:active')
    })
  }
  if (getFirebaseIdentity().auth.currentUser?.uid === scope.actorUid) localStorage.setItem('llenamos:offline:active', JSON.stringify({ scope }))
}
export type ObservedEntity = Pick<CommandPrecondition, 'kind' | 'id'> & { observed?: unknown }
export class IntencionGuardada extends Error { constructor(message: string) { super(message); this.name = 'IntencionGuardada' } }
export function currentScope(restaurantId: string, locationId: string) {
  const user = getFirebaseIdentity().auth.currentUser
  if (!user) throw new Error('Inicia sesión para guardar en tu dispositivo.')
  return scopeFor(restaurantId, locationId, user.uid)
}
/**
 * Llama a la operación de sincronización con la identidad vigente. En el VPS va a la API; las
 * callables de Functions solo existen en la demo con emuladores. Nunca cambia de uno a otro por un fallo.
 */
async function call(scope: SyncScope, name: string, data: unknown) {
  if (getFirebaseIdentity().auth.currentUser?.uid !== scope.actorUid) throw new Error('Esta cola está bloqueada para la cuenta actual.')
  if (operationBackend() === 'postgres') return await postOperation(name, data, { authentication: 'required', timeoutMs: 20_000 }) as Record<string, unknown>
  const [{ httpsCallable }, { getFirebase }] = await Promise.all([cargarFunctions(), cargarClienteDemo()])
  return (await httpsCallable(getFirebase().functions, name, { timeout: 20_000 })(data)).data as Record<string, unknown>
}
export async function prepare(scope: SyncScope, entities: ObservedEntity[]) {
  if (!navigator.onLine || !entities.length) return
  const data = z.object({ versions: z.array(ServerEntityVersionSchema), contentHashes: z.array(ServerEntityVersionSchema.omit({ version: true }).extend({ hash: z.string().regex(/^[a-f0-9]{64}$/) })), synchronizedAt: MillisSchema }).parse(await call(scope, 'prepararSinConexion', { ...scope, entities: entities.map(({ kind, id }) => ({ kind, id })) }))
  const hashes = data.contentHashes as { kind: string; id: string; hash: string }[]
  const versions = (data.versions as CommandPrecondition[]).filter(v => {
    const observation = entities.find(e => e.kind === v.kind && e.id === v.id)?.observed
    return observation !== undefined && hashes.some(h => h.kind === v.kind && h.id === v.id && h.hash === sha256Hex(canonicalJson(JSON.parse(JSON.stringify(observation)))))
  })
  await mutate(scope, s => ({ ...s, versions: [...s.versions.filter(v => !versions.some(n => n.kind === v.kind && n.id === v.id)), ...versions], synchronizedAt: Number(data.synchronizedAt) }))
}
/** Web Locks excluye pestañas y libera el envío si la pestaña muere. */
export async function drain(scope: SyncScope, manual = false) {
  if (!navigator.onLine || !navigator.locks) return
  await navigator.locks.request(`llenamos:sync:${JSON.stringify(scope)}`, { ifAvailable: true }, async lock => {
    if (!lock) return
    let space = await mutate(scope, s => ({ ...s, entries: recoverLocalQueueAfterReload(s.entries).map(e => manual && e.state === 'uncertain' ? { ...e, attempts: 0, nextAttemptAt: 0 } : e) }))
    for (;;) {
      if (getFirebaseIdentity().auth.currentUser?.uid !== scope.actorUid || !navigator.onLine) return
      const entry = nextLocalCommand(space.entries, scope, Date.now())
      if (!entry || entry.attempts >= 12) return
      await mutate(scope, s => ({ ...s, entries: s.entries.map(e => e.command.commandId === entry.command.commandId ? { ...e, state: 'sending' } : e) }))
      try {
        let data = entry.state === 'uncertain' ? await call(scope, 'recuperarComando', { ...scope, commandId: entry.command.commandId }) : null
        if (!data?.receipt) data = await call(scope, 'sincronizarComando', { command: entry.command })
        const receipt = CommandReceiptSchema.parse(data.receipt)
        space = await mutate(scope, s => ({ ...s, entries: s.entries.map(e => e.command.commandId === entry.command.commandId ? applyCommandReceipt(e, receipt) : e), versions: receipt.result.status === 'applied' ? [...s.versions.filter(v => !receipt.result || receipt.result.status !== 'applied' || !receipt.result.versions.some(n => n.kind === v.kind && n.id === v.id)), ...receipt.result.versions] : s.versions }))
      } catch (error) {
        // not-deployed y failed-precondition no se arreglan reintentando: la intención queda guardada y a la vista, sin 12 intentos inciertos.
        const permanent = ['permission-denied', 'unauthenticated', 'invalid-argument', 'already-exists', 'not-deployed', 'failed-precondition'].includes(operationErrorCode(error))
        await mutate(scope, s => ({ ...s, entries: s.entries.map(e => e.command.commandId === entry.command.commandId ? permanent ? { ...e, state: 'rejected', lastError: error instanceof Error ? error.message : 'Revisa la sesión y los permisos antes de continuar.' } : retryLocalCommand(e, Date.now(), OFFLINE_MESSAGES.uncertain) : e) }))
        return
      }
    }
  })
}
export async function discard(scope: SyncScope, command: OfflineCommand, reason: string) {
  const data = await call(scope, 'descartarComando', { command, requestId: crypto.randomUUID(), reason })
  const receipt = CommandReceiptSchema.parse(data.receipt)
  await mutate(scope, s => ({ ...s, entries: s.entries.map(e => e.command.commandId === command.commandId ? applyCommandReceipt(e, receipt) : e) }))
  await drain(scope)
}
function entitiesFor(operation: OfflineCommand['operation'], payload: Record<string, unknown>): Pick<CommandPrecondition, 'kind' | 'id'>[] {
  return operation === 'cambiarEstadoLineas' ? (payload.lineIds as string[]).map(id => ({ kind: 'line', id }))
    : operation === 'cambiarEstadoTarea' ? [{ kind: 'task', id: String(payload.taskId) }]
    : operation === 'marcarAgotado' ? [{ kind: 'item', id: String(payload.itemId) }]
    : [{ kind: payload.sessionId ? 'session' : 'takeaway', id: String(payload.sessionId ?? payload.takeawayId) }]
}
/**
 * ¿Se puede guardar esta intención como cambio local? Solo si el navegador lo permite, la carga cumple el contrato de la cola
 * (p. ej. `enviarPedido` con `requestId`, destino y precios esperados) y la pantalla ya preparó la versión de cada entidad.
 * Si no, con conexión la operación va directa a la API como antes; no se falla por no haber preparado la pantalla.
 */
export async function puedeEncolar(operation: OfflineCommand['operation'], payload: Record<string, unknown>): Promise<boolean> {
  if (!navigator.locks) return false
  try {
    if (!OFFLINE_PAYLOAD_SCHEMAS[operation].safeParse(payload).success) return false
    const scope = currentScope(String(payload.restaurantId), String(payload.locationId))
    const space = await mutate(scope)
    return entitiesFor(operation, payload).every(e => space.versions.some(v => v.kind === e.kind && v.id === e.id))
  } catch { return false }
}
export async function queueOperation(operation: OfflineCommand['operation'], payload: Record<string, unknown>) {
  if (!navigator.locks) throw new Error('Este navegador no permite la exclusión segura entre pestañas. Usa un navegador compatible.')
  const scope = currentScope(String(payload.restaurantId), String(payload.locationId))
  protectSession(scope)
  const entities = entitiesFor(operation, payload)
  const entry = await enqueue(scope, { operation, payload, entities, commandId: operation === 'enviarPedido' ? String(payload.requestId) : undefined })
  if (navigator.onLine) await drain(scope)
  const latest = (await mutate(scope)).entries.find(e => e.command.commandId === entry.command.commandId)!
  if (latest.state === 'applied' && latest.result?.status === 'applied') return latest.result.response
  throw new IntencionGuardada(latest.state === 'conflict' || latest.state === 'rejected' ? OFFLINE_MESSAGES.conflict : operation === 'enviarPedido' ? OFFLINE_MESSAGES.pending : OFFLINE_MESSAGES.kitchen)
}
