import type { ModuleDefinition } from '../modules/types.js'
import { messageHandler, MESSAGE_KIND, takeawayNoticeHandler, type ConsentCheck } from './messages.js'
import { REPLY_KIND, replyHandler, whatsappInboundHandler } from './whatsapp.js'
import type { WorkerHandler } from './types.js'
import { deleteFileHandler } from '../files/handlers.js'
import type { FileStore } from '../files/storage.js'
import { PRIVACY_JOB, privacyHandler } from '../privacy/handler.js'

/** Tipos cuya misma clave puede tener varios manejadores (cada módulo atiende su parte del evento). */
const shared = (kind: string) => kind.startsWith('webhook.') || kind === REPLY_KIND

/** Manejadores propios del worker más los que declaran los módulos. Un tipo duplicado es un error de arranque. */
export function buildHandlers(modules: readonly ModuleDefinition[], options: { consent?: ConsentCheck; files?: FileStore; privacyKey?: Buffer } = {}): ReadonlyMap<string, readonly WorkerHandler[]> {
  const map = new Map<string, WorkerHandler[]>()
  const add = (kind: string, handler: WorkerHandler, owner: string) => {
    const list = map.get(kind) ?? []
    if (list.length && !shared(kind)) throw new Error(`Manejador de worker duplicado: ${kind} (${owner})`)
    map.set(kind, [...list, handler])
  }
  const consent = options.consent ?? modules.find(module => module.marketingConsent)?.marketingConsent
  add(MESSAGE_KIND, messageHandler({ consent }), 'worker')
  add('aviso.mensaje', messageHandler({ consent }), 'worker')
  add('aviso.recogida', takeawayNoticeHandler(), 'worker')
  add('webhook.whatsapp', whatsappInboundHandler, 'worker')
  if (options.files) add('archivo.borrar', deleteFileHandler(options.files), 'worker')
  add(PRIVACY_JOB, privacyHandler({ modules: () => modules, store: options.files, key: options.privacyKey }), 'worker')
  const replyOwners = modules.some(module => (module.workerHandlers ?? []).some(([kind]) => kind === REPLY_KIND))
  add(REPLY_KIND, replyHandler(replyOwners), 'worker')
  for (const module of modules) for (const [kind, handler] of module.workerHandlers ?? []) add(kind, handler, module.name)
  return map
}
export { createWorker } from './runner.js'
export type { Worker } from './runner.js'
export * from './types.js'
export { enqueueMessage, MESSAGE_KIND, takeawayNoticeHandler } from './messages.js'
