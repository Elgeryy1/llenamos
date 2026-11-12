import * as core from '@llenamos/core'
import type { Operation } from '../../operations.js'
import type { ModuleDefinition } from '../types.js'
import type { Name } from './context.js'
import { isPublic, runPublic, runStaff } from './execute.js'
import { liveQueries } from './live.js'
import { verCartaPublica } from './menu-public.js'
import { FIRE_TAKEAWAYS_JOB, fireTakeawaysHandler } from './jobs.js'
import { PUSH_JOB, processPush } from './push-envio.js'
import { salaPrivacy } from './privacy.js'
import { registerSalaBillSource } from './billing.js'
import { registerSalaOccupancySource } from './occupancy.js'
import { registerReservationHooks } from './hooks-reservas.js'
import { registerSalaSync } from './sync.js'

// Caja lee el consumo de mesas y recogidas por este origen.
registerSalaBillSource()
// Reservas ve las mesas sentadas y avisa a sala al sentar o terminar una reserva.
registerSalaOccupancySource()
registerReservationHooks()
// La cola sin conexión (módulo `sync`) aplica aquí sus cinco intenciones y lee las versiones de las entidades.
registerSalaSync()

const ROLES = ['owner', 'manager', 'waiter', 'kitchen', 'bar'] as const
const names = Object.keys(core.CALLABLES_FASE2) as Name[]

const operations = names.map((name): readonly [string, Operation] => {
  const { input, output } = core.CALLABLE_SCHEMAS_FASE2[name]
  if (isPublic(name)) {
    // La IP verificada la entrega el servidor (`client-ip.ts`); los cubos son por IP y por credencial.
    return [name, { access: 'public', input, output, runPublic: (data, context) => runPublic(name, data, context.pool, context.clientIp) }]
  }
  return [name, { access: 'member', roles: ROLES, input, output, restaurantId: data => (data as { restaurantId: string }).restaurantId,
    run: (client, data, context) => runStaff(name, client, data, context.uid) }]
})

/** Carta, QR, sala, cocina, barra y recogida. Contrato: `docs/tareas/vps-reparto.md` (V4). */
export const sala: ModuleDefinition = {
  name: 'sala',
  operations: [...operations, ['verCartaPublica', verCartaPublica]],
  liveQueries,
  workerHandlers: [[FIRE_TAKEAWAYS_JOB, fireTakeawaysHandler], [PUSH_JOB, processPush()]],
  privacy: salaPrivacy,
  personalData: ['sala_takeaways', 'sala_table_sessions', 'sala_orders', 'sala_order_lines', 'sala_floor_tasks', 'sala_private', 'sala_spend'],
}
