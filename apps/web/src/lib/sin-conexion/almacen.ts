import { canonicalJson, OfflineCommandSchema, SyncScopeSchema, enqueueLocalCommand, syncStreamKey, type CallableInput, type CommandPrecondition, type LocalQueueEntry, type OfflineCashNote, type OfflineCommand, type SyncScope } from '@llenamos/core'

export type Espacio = { key: string; sequence: number; entries: LocalQueueEntry[]; versions: CommandPrecondition[]; synchronizedAt: number; cash: OfflineCashNote[]; cashRequests?: Record<string, CallableInput<"registrarCobro">> }
const empty = (key: string): Espacio => ({ key, sequence: 0, entries: [], versions: [], synchronizedAt: 0, cash: [] })
let database: Promise<IDBDatabase> | undefined
function open() {
  return database ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('llenamos:sin-conexion:1', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('spaces', { keyPath: 'key' })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => { database = undefined; reject(new Error('No se puede guardar en este dispositivo. No se ha guardado la intención.')) }
  })
}
/** Secuencia e intención se confirman juntas antes de mostrar guardado. */
export async function mutate(scope: SyncScope, change?: (space: Espacio) => Espacio): Promise<Espacio> {
  const db = await open(), key = syncStreamKey(scope)
  return new Promise((resolve, reject) => {
    const tx = db.transaction('spaces', change ? 'readwrite' : 'readonly'), store = tx.objectStore('spaces')
    const get = store.get(key)
    let value: Espacio
    get.onsuccess = () => {
      try { value = change ? change(get.result ?? empty(key)) : get.result ?? empty(key); if (change) store.put(value) }
      catch (error) { tx.abort(); reject(error) }
    }
    tx.oncomplete = () => { if (change) window.dispatchEvent(new Event('llenamos:cola')); resolve(value) }
    tx.onerror = () => reject(new Error('No se ha podido guardar. Revisa el espacio disponible del dispositivo.'))
    tx.onabort = () => reject(new Error('No se ha guardado la intención en este dispositivo.'))
  })
}
export function scopeFor(restaurantId: string, locationId: string, actorUid: string): SyncScope {
  const key = `llenamos:device:${actorUid}`
  let deviceId = localStorage.getItem(key)
  if (!deviceId) { deviceId = crypto.randomUUID(); localStorage.setItem(key, deviceId) }
  return SyncScopeSchema.parse({ actorUid, restaurantId, locationId, deviceId })
}
export async function enqueue(scope: SyncScope, input: { operation: OfflineCommand['operation']; payload: unknown; commandId?: string; entities: Pick<CommandPrecondition, 'kind' | 'id'>[] }) {
  let stored!: LocalQueueEntry
  await mutate(scope, space => {
    const commandId = input.commandId ?? crypto.randomUUID()
    const previous = space.entries.find(e => e.command.commandId === commandId)
    // Un envío en vuelo conserva su contenido original al recuperar.
    if (previous) {
      if (canonicalJson(previous.command.payload) !== canonicalJson(input.payload)) throw new Error('Esta clave ya pertenece a otra intención. Recupera el envío original.')
      stored = previous; return space
    }
    const conditions = input.entities.map(entity => {
      const known = space.versions.find(v => v.kind === entity.kind && v.id === entity.id)
      if (!known) throw new Error('Prepara esta pantalla con conexión antes de guardar cambios locales.')
      const predecessor = [...space.entries].reverse().find(e => !['applied', 'discarded', 'rejected', 'conflict'].includes(e.state) && e.command.preconditions.some(p => p.kind === entity.kind && p.id === entity.id))
      return { ...known, ...(predecessor ? { afterCommandId: predecessor.command.commandId } : {}) }
    })
    const command = OfflineCommandSchema.parse({ ...scope, operation: input.operation, payload: input.payload, commandId, sequence: space.sequence + 1, clientCreatedAt: Date.now(), preconditions: conditions })
    const entries = enqueueLocalCommand(space.entries, command)
    stored = entries[entries.length - 1]
    return { ...space, sequence: command.sequence, entries }
  })
  return stored
}
