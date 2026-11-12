import { z } from 'zod'
import * as core from '@llenamos/core'
import type { ModuleDefinition } from '../types.js'
import { prepare, recover, SYNC_ROLES, synchronize } from './service.js'

export { registerSyncEntities, registerSyncExecutor } from './registry.js'

export const PrepareInputSchema = z.strictObject({ ...core.SyncScopeSchema.shape, entities: z.array(core.ServerEntityVersionSchema.omit({ version: true })).min(1).max(100) })
export const PrepareOutputSchema = z.object({
  versions: z.array(core.ServerEntityVersionSchema),
  contentHashes: z.array(core.ServerEntityVersionSchema.omit({ version: true }).extend({ hash: z.string().regex(/^[a-f0-9]{64}$/) })),
  synchronizedAt: core.MillisSchema,
})
const roles = SYNC_ROLES

/** Sincronización sin conexión: cola idempotente por dispositivo. Contrato en README.md. */
export const syncModule: ModuleDefinition = {
  name: 'sync',
  operations: [
    ['sincronizarComando', { access: 'member', roles, restaurantId: input => core.SincronizarComandoInputSchema.parse(input).command.restaurantId,
      input: core.SincronizarComandoInputSchema, output: core.SincronizarComandoOutputSchema,
      run: async (client, input, context) => ({ receipt: await synchronize(client, context.uid, core.SincronizarComandoInputSchema.parse(input).command) }) }],
    ['descartarComando', { access: 'member', roles, restaurantId: input => core.DescartarComandoInputSchema.parse(input).command.restaurantId,
      input: core.DescartarComandoInputSchema, output: core.DescartarComandoOutputSchema,
      run: async (client, input, context) => { const { command, requestId, reason } = core.DescartarComandoInputSchema.parse(input); return { receipt: await synchronize(client, context.uid, command, { requestId, reason }) } } }],
    ['recuperarComando', { access: 'member', roles, restaurantId: input => core.RecuperarComandoInputSchema.parse(input).restaurantId,
      input: core.RecuperarComandoInputSchema, output: core.RecuperarComandoOutputSchema,
      run: (client, input, context) => recover(client, context.uid, core.RecuperarComandoInputSchema.parse(input)) }],
    // No está en core: es la proyección de versiones que ya usaba el cliente (`prepararSinConexion`).
    ['prepararSinConexion', { access: 'member', roles, restaurantId: input => PrepareInputSchema.parse(input).restaurantId,
      input: PrepareInputSchema, output: PrepareOutputSchema,
      run: (client, input, context) => prepare(client, context.uid, PrepareInputSchema.parse(input)) }],
  ],
}
