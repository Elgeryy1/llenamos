import type { Operation } from '../../operations.js'
import * as core from '@llenamos/core'
import { memberOperation, type Handler } from '../fase4/operacion.js'
import type { Name } from '../fase4/contexto.js'
import type { ModuleDefinition } from '../types.js'
import * as fichajes from './fichajes.js'
import * as cuadrante from './cuadrante.js'
import { exportarMisFichajes, anonimizarFichajesHandler } from './retencion.js'
import { personalLiveQueries } from './live.js'
import { revisarFichajesHandler } from './procesos.js'
import { JOB_ANONYMIZE_ENTRIES, JOB_REVIEW_ENTRIES } from '../fase4/trabajos.js'

const handlers = { ...fichajes, ...cuadrante, exportarMisFichajes } as unknown as Record<string, Handler>
const operations = (Object.keys(core.CALLABLES_FASE4_PERSONAL) as Name[]).map(name => {
  const handler = handlers[name]
  if (!handler) throw new Error(`Falta el handler de ${name}`)
  return [name, memberOperation(name, handler)] as [string, Operation]
})
export const personalModule: ModuleDefinition = { name: 'personal', operations, liveQueries: personalLiveQueries, workerHandlers: [[JOB_REVIEW_ENTRIES, revisarFichajesHandler], [JOB_ANONYMIZE_ENTRIES, anonimizarFichajesHandler]] }
export { reviewOpenEntries } from './procesos.js'
export { anonymizeOldEntries } from './retencion.js'
