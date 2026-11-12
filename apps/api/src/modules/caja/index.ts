import type { Pool } from 'pg'
import { EXPIRE_SESSION_JOB, RECONCILE_JOB, expireSessionHandler, reconcileHandler, stripeCashHandler } from './worker.js'
import { cancelarCobroMovil, crearEnlaceCobro, publicOperations, resolverIncidenciaMovil } from './movil.js'
import { crearReciboDigital, verReciboDigital } from './recibo.js'
import { cajaPrivacy } from './privacy.js'
import { z } from 'zod'
import { ApiError } from '../../errors.js'
import * as core from '@llenamos/core'
import type { Operation } from '../../operations.js'
import type { ModuleDefinition } from '../types.js'
import { type Name, type Pos, fail, openPos, replay, remember, rolesFor } from './pos.js'
import * as accounts from './accounts.js'
import * as cash from './cash.js'
import * as payments from './payments.js'
import * as fiscal from './fiscal.js'
import * as print from './print.js'
import { cajaLiveQueries } from './live.js'

type Handler = (pos: Pos, input: never) => Promise<unknown>
const handlers: Partial<Record<Name, Handler>> = {
  guardarConfiguracionCaja: fiscal.guardarConfiguracionCaja, abrirCaja: cash.abrirCaja, cerrarCaja: cash.cerrarCaja, registrarMovimientoCaja: cash.registrarMovimientoCaja,
  abrirCuenta: accounts.abrirCuenta, verCuenta: accounts.verCuenta, ajustarCuenta: accounts.ajustarCuenta, dividirCuenta: accounts.dividirCuenta,
  prepararCobro: accounts.prepararCobro, desbloquearCuenta: accounts.desbloquearCuenta, registrarCobro: payments.registrarCobro, devolverCobro: payments.devolverCobro,
  emitirFactura: fiscal.emitirFactura, rectificarFactura: fiscal.rectificarFactura, sustituirSimplificada: fiscal.sustituirSimplificada, anularRegistroFiscal: fiscal.anularRegistroFiscal,
  repartirPropinas: cash.repartirPropinas, guardarImpresora: print.guardarImpresora, vincularPuente: print.vincularPuente, solicitarImpresion: print.solicitarImpresion,
  crearEnlaceCobro, crearReciboDigital, cancelarCobroMovil, resolverIncidenciaMovil,
}
// vincularPuente rota la credencial en cada llamada: no se guarda en claro el token en la tabla de idempotencia.
// crearEnlaceCobro y crearReciboDigital devuelven un secreto de enlace: tampoco se guarda en claro; repetir rota el secreto del mismo cobro o recibo.
const withoutReplay = new Set<Name>(['vincularPuente', 'crearEnlaceCobro', 'crearReciboDigital'])

/** Los errores de dominio de core (saldo, reparto, factura…) son precondiciones, no fallos internos. */
function domainError(error: unknown): never {
  if (error instanceof ApiError) throw error
  if ((error as { code?: string } | null)?.code === '23505') fail('Esta operación ya se registró con otros datos o a la vez desde otro dispositivo. Recarga e inténtalo de nuevo.')
  if (error && typeof error === 'object' && 'code' in error) throw error
  if (error instanceof z.ZodError) fail(error.issues.map(i => i.message).join(' ').slice(0, 400))
  if (error instanceof Error) fail(error.message)
  throw error
}
const StaleMarker = z.strictObject({ stale: z.literal(true) })
function memberOperation(name: Name): Operation {
  const schema = core.CALLABLE_SCHEMAS_FASE3[name], handler = handlers[name]!
  return {
    access: 'member', roles: rolesFor(name), input: schema.input, output: z.union([schema.output, StaleMarker]),
    restaurantId: input => (input as { restaurantId: string }).restaurantId,
    run: async (client, raw, context) => {
      const d = schema.input.parse(raw) as { restaurantId: string; locationId: string; requestId?: string }
      const pos = await openPos(client, context.uid, name, d)
      const requestId = withoutReplay.has(name) ? undefined : d.requestId
      if (requestId) { const old = await replay(pos, name, requestId, d, schema.output as { parse: (v: unknown) => unknown }); if (old) return old.value }
      // Como el original: si el consumo de la cuenta abierta cambió, se guarda el refresco y se pide recargar
      // en vez de cobrar, dividir o ajustar sobre una pantalla desfasada. El error se lanza tras el COMMIT.
      const billId = (d as { billId?: string }).billId
      if (billId && name !== 'verCuenta' && name !== 'abrirCuenta' && await accounts.refresh(pos, billId).catch(domainError)) {
        context.afterCommit(async () => { throw new ApiError(412, 'failed-precondition', 'El consumo ha cambiado y se ha actualizado la cuenta. Recarga y vuelve a repartir antes de cobrar.') })
        return { stale: true as const }
      }
      const value = schema.output.parse(await handler(pos, d as never).catch(domainError))
      if (requestId) await remember(pos, name, requestId, d, value)
      return value
    },
  }
}
function bridgeOperation<N extends 'reclamarImpresiones' | 'confirmarImpresion'>(name: N, run: (pool: Pool, input: never) => Promise<unknown>): Operation {
  const schema = core.CALLABLE_SCHEMAS_FASE3[name]
  return { access: 'public', input: schema.input, output: schema.output, runPublic: (input, { pool }) => run(pool, schema.input.parse(input) as never) }
}
const operations: [string, Operation][] = [
  ...(Object.keys(handlers) as Name[]).map(name => [name, memberOperation(name)] as [string, Operation]),
  ['reclamarImpresiones', bridgeOperation('reclamarImpresiones', print.reclamarImpresiones as never)],
  ['confirmarImpresion', bridgeOperation('confirmarImpresion', print.confirmarImpresion as never)],
  // Cobro móvil con la Stripe del restaurante y recibo digital: las públicas validan la credencial del enlace antes de abrir nada.
  ...publicOperations,
  ['verReciboDigital', { access: 'public', input: core.CALLABLE_SCHEMAS_FASE3.verReciboDigital.input, output: core.VerReciboDigitalVpsOutputSchema,
    runPublic: (input, { pool, clientIp }) => verReciboDigital(pool, clientIp ?? null, input as never) }],
]
export const cajaModule: ModuleDefinition = { name: 'caja', operations, liveQueries: cajaLiveQueries, workerHandlers: [['webhook.stripe', stripeCashHandler], [RECONCILE_JOB, reconcileHandler], [EXPIRE_SESSION_JOB, expireSessionHandler]], privacy: cajaPrivacy, personalData: ['pos_bills', 'pos_invoices'] }
export { registerBillSource, type BillSource, type BillSourceResult } from './source.js'
