import { z } from 'zod'
import type { PoolClient } from 'pg'
import * as core from '@llenamos/core'
import type { Operation } from '../../operations.js'
import type { LiveQuery } from '../types.js'
import { openAccess, openCtx, flushEvents, domainError, readOnlyNames, remember, replay, rolesFor, type Ctx, type Name, type Scoped } from './contexto.js'

/** Operaciones con PIN: no se guardan en `idempotency` (la huella de la entrada permitiría recuperar el PIN por fuerza bruta). */
const withoutReplay = new Set<Name>(['ficharEnPuesto', 'guardarPinFichaje'])

export type Handler = (c: Ctx, input: never, afterCommit: (task: (output: unknown) => Promise<unknown>) => void) => Promise<unknown>

/**
 * Operación de miembro del contrato de core: permiso y local en `openCtx`, idempotencia por
 * `requestId` (repetir devuelve el resultado original sin repetir efectos) y eventos de dominio
 * emitidos una vez, dentro de la misma transacción.
 */
export function memberOperation(name: Name, handler: Handler): Operation {
  const schema = core.CALLABLE_SCHEMAS_FASE4[name]
  return {
    access: 'member', roles: rolesFor(name), input: schema.input, output: schema.output,
    restaurantId: input => (input as { restaurantId: string }).restaurantId,
    run: async (client, raw, context) => {
      const d = schema.input.parse(raw) as Scoped & { requestId?: string }
      const c = await openCtx(client, context.uid, name, d)
      const requestId = readOnlyNames.has(name) || withoutReplay.has(name) ? undefined : d.requestId
      if (requestId) { const old = await replay(c, name, requestId, d, schema.output); if (old) return old.value }
      const value = schema.output.parse(await handler(c, d as never, context.afterCommit).catch(domainError))
      if (requestId) await remember(c, name, requestId, d, value)
      await flushEvents(c)
      return value
    },
  }
}

export type LiveScope = { restaurantId: string; locationId: string }
export const rolesWith = (permission: core.Permission) => core.ROLES.filter(role => core.can(role, permission))

/** Lectura en vivo con el mismo contrato de acceso que las operaciones: miembro, local, permiso y módulo. */
export function liveQuery<I extends z.ZodType<LiveScope, unknown>, O extends z.ZodType>(
  name: string, permission: core.Permission, modules: readonly core.Module[], input: I, output: O, topics: readonly string[],
  snapshot: (c: Ctx, input: z.output<I>) => Promise<z.input<O>>,
): LiveQuery {
  return {
    name, roles: rolesWith(permission), input, output,
    restaurantId: i => (i as LiveScope).restaurantId, topics: () => topics,
    snapshot: async (client: PoolClient, raw, context) => {
      const i = input.parse(raw) as z.output<I>
      const c = await openAccess(client, context.uid, i, permission, modules)
      return output.parse(await snapshot(c, i))
    },
  }
}
