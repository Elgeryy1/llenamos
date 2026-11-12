/**
 * Fase 4 · Personal, inventario y costes: las 31 callables, con transacciones, idempotencia por
 * `requestId` (`staffRequests` e `inventoryRequests`), auditoría y actividad; y los procesos
 * `consumirPorLinea`, `reconciliarConsumos` y `revisarFichajesAbiertos`.
 *
 * Cada callable se ejecuta en una sola transacción: lecturas, cálculo con core y una cola de
 * escrituras que se confirma al final junto con la actividad. Los cálculos de horas, costes y
 * existencias son siempre del servidor; ninguna entrada trae costes, valores, autor ni estados.
 */
import { onCall, HttpsError, type CallableRequest } from '../identity-call'
import { z } from 'zod'
import * as core from '@llenamos/core'
import { db, options, parse, safe } from '../shared'
import { Deferred, hash, clean, names, openContext, personalNames, readOnlyNames, type Ctx, type Input, type Name } from './context'
import * as personal from './personal'
import * as inventario from './inventario'
import * as compras from './compras'

type Handler = (c: Ctx, d: never) => Promise<unknown>
const handlers = { ...personal, ...inventario, ...compras } as unknown as Record<Name, Handler>

export interface ExecuteOptions {
  /** Solo para pruebas: reloj del servidor simulado. La callable nunca lo recibe. */
  now?: number
}

export async function execute<N extends Name>(name: N, data: unknown, request: CallableRequest<unknown> | null, opts: ExecuteOptions = {}): Promise<core.CallableOutput<N>> {
  const schema = core.CALLABLE_SCHEMAS_FASE4[name]
  const d = parse(schema.input as unknown as z.ZodType<Input<N>>, data)
  const scope = d as { restaurantId: string; locationId: string; requestId?: string }
  if (!request) throw new HttpsError('permission-denied', 'La operación necesita personal autenticado.')
  const readOnly = readOnlyNames.includes(name)
  try {
    const result = await db.runTransaction(async (tx) => {
      const c = await openContext(tx, { rid: scope.restaurantId, lid: scope.locationId, name, request, now: opts.now })
      let intent: FirebaseFirestore.DocumentReference | null = null
      const payloadHash = hash(d)
      if (!readOnly) {
        const folder = personalNames.includes(name) ? 'staffRequests' : 'inventoryRequests'
        intent = c.local.collection(folder).doc(hash([c.uid, name, scope.requestId]))
        const old = await tx.get(intent)
        if (old.exists) {
          // La misma petición con la misma entrada devuelve el resultado original sin repetir efectos.
          if (old.get('payloadHash') !== payloadHash) throw new HttpsError('already-exists', 'Esta petición ya se usó con otros datos.')
          return { value: schema.output.parse(old.get('result')) }
        }
      }
      const value = await handlers[name](c, d as never)
      if (value instanceof Deferred) { c.flush(); return { deferred: value.error } }
      const output = schema.output.parse(value)
      if (intent) c.set(intent, { requestId: scope.requestId, actorUid: c.uid, route: name, payloadHash, result: clean(output) })
      c.flush()
      return { value: output }
    }, readOnly ? { readOnly: true } : { maxAttempts: 10 })
    if ('deferred' in result) throw result.deferred
    return result.value as core.CallableOutput<N>
  } catch (error) {
    if (error instanceof HttpsError) throw error
    // Los errores de core (`planReceipt`, validaciones) llevan ya un mensaje en castellano para enseñar.
    if (error instanceof z.ZodError || (error instanceof Error && !('code' in error))) throw new HttpsError('failed-precondition', error instanceof z.ZodError ? error.issues.map((i) => i.message).join(' ').slice(0, 400) : error.message)
    throw error
  }
}

function callable(name: Name) { return onCall(options, (request) => safe(() => execute(name, request.data, request))) }

export const guardarConfiguracionPersonal = callable('guardarConfiguracionPersonal')
export const fichar = callable('fichar')
export const ficharEnPuesto = callable('ficharEnPuesto')
export const guardarPinFichaje = callable('guardarPinFichaje')
export const crearFichajeManual = callable('crearFichajeManual')
export const corregirFichaje = callable('corregirFichaje')
export const cerrarFichajeOlvidado = callable('cerrarFichajeOlvidado')
export const anularFichaje = callable('anularFichaje')
export const informeHoras = callable('informeHoras')
export const exportarMisFichajes = callable('exportarMisFichajes')
export const guardarTurno = callable('guardarTurno')
export const borrarTurno = callable('borrarTurno')
export const publicarCuadrante = callable('publicarCuadrante')
export const copiarSemanaCuadrante = callable('copiarSemanaCuadrante')
export const horasParaPropinas = callable('horasParaPropinas')
export const guardarConfiguracionInventario = callable('guardarConfiguracionInventario')
export const guardarIngrediente = callable('guardarIngrediente')
export const guardarReceta = callable('guardarReceta')
export const registrarMerma = callable('registrarMerma')
export const ajustarStock = callable('ajustarStock')
export const iniciarRecuento = callable('iniciarRecuento')
export const guardarRecuento = callable('guardarRecuento')
export const aplicarRecuento = callable('aplicarRecuento')
export const cancelarRecuento = callable('cancelarRecuento')
export const reconocerAvisoStock = callable('reconocerAvisoStock')
export const guardarProveedor = callable('guardarProveedor')
export const guardarFormatoProveedor = callable('guardarFormatoProveedor')
export const guardarPedidoProveedor = callable('guardarPedidoProveedor')
export const cambiarEstadoPedidoProveedor = callable('cambiarEstadoPedidoProveedor')
export const recibirPedidoProveedor = callable('recibirPedidoProveedor')
export const sugerirPedidos = callable('sugerirPedidos')
export const margenPlatos = callable('margenPlatos')
export { names }
export { consumirPorLinea, reconciliarConsumos } from './consumo'
export { revisarFichajesAbiertos } from './procesos'
