import type { Operation } from '../../operations.js'
import * as core from '@llenamos/core'
import { memberOperation, type Handler } from '../fase4/operacion.js'
import type { Name } from '../fase4/contexto.js'
import type { ModuleDefinition } from '../types.js'
import * as existencias from './existencias.js'
import * as compras from './compras.js'
import { inventarioLiveQueries } from './live.js'

const handlers = { ...existencias, ...compras } as unknown as Record<string, Handler>
const operations = (Object.keys(core.CALLABLES_FASE4_INVENTARIO) as Name[]).map(name => {
  const handler = handlers[name]
  if (!handler) throw new Error(`Falta el handler de ${name}`)
  return [name, memberOperation(name, handler)] as [string, Operation]
})
/** Inventario, escandallos, costes y compras. El descuento por venta no es una operación: ver `consumo.ts`. */
export const inventarioModule: ModuleDefinition = { name: 'inventario', operations, liveQueries: inventarioLiveQueries, workerHandlers: [[JOB_RECONCILE, reconciliarConsumosHandler]] }
import { consumeLine, reconciliarConsumosHandler } from './consumo.js'
import { JOB_RECONCILE, RECONCILE_EVERY_MS, scheduleLocalJob } from '../fase4/trabajos.js'
import { registerLineStateHook } from '../sala/hooks.js'
export { consumeLine, reconcileConsumption } from './consumo.js'
export type { ConsumeOutcome } from './consumo.js'

/**
 * Descuento de stock conectado a sala: cada línea de pedido nueva o con otro estado se pasa a `consumeLine` en la misma
 * transacción que la guarda. Va en un SAVEPOINT: si inventario falla, el pedido sigue y la reconciliación lo corrige.
 */
registerLineStateHook(async (client, scope, lineIds, now, restaurant) => {
  const known = { modules: { plan: restaurant.plan, activeModules: restaurant.activeModules, moduleOverrides: restaurant.moduleOverrides, entitlementVersion: restaurant.entitlementVersion, accessValidUntil: restaurant.accessValidUntil } as core.RestaurantModulesLike, tz: restaurant.timezone }
  for (const lineId of lineIds) {
    await client.query('SAVEPOINT inventario_consumo')
    try {
      await consumeLine(client, scope, lineId, now, known)
      await client.query('RELEASE SAVEPOINT inventario_consumo')
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT inventario_consumo')
      const code = (error as { code?: unknown })?.code
      console.error(JSON.stringify({ level: 'error', event: 'inventario_consumo_fallido', restaurantId: scope.restaurantId, locationId: scope.locationId, lineId, errorCode: typeof code === 'string' ? code : 'unexpected' }))
      // Programar la reconciliación es mejor esfuerzo: tampoco puede tumbar el pedido.
      await client.query('SAVEPOINT inventario_programar')
      try { await scheduleLocalJob(client, scope.restaurantId, scope.locationId, JOB_RECONCILE, RECONCILE_EVERY_MS, now); await client.query('RELEASE SAVEPOINT inventario_programar') }
      catch { await client.query('ROLLBACK TO SAVEPOINT inventario_programar') }
    }
  }
})
