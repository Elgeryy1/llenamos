import { onCall, HttpsError, type CallableRequest } from '../identity-call'
import { z } from 'zod'
import * as core from '@llenamos/core'
import { db, options, parse, safe } from '../shared'
import { type Name, type Context, context, resolveRestaurant } from './context'
import * as push from './push-subscriptions'
import * as catalog from './catalog'
import * as sessions from './sessions'
import * as orders from './orders'
import * as tasks from './tasks'
import * as publicTable from './public'
import * as takeaways from './takeaways'
import { reconcile } from './service'

const handlers = { ...push, ...catalog, ...sessions, ...orders, ...tasks, ...publicTable, ...takeaways }
const actions: Record<Name, [string, string]> = {
  guardarCategoriaCarta: ['menu.categorySaved', 'Categoría de carta guardada.'], guardarPlato: ['menu.itemSaved', 'Plato de carta guardado.'],
  guardarMenuDia: ['menu.dailyMenuSaved', 'Menú del día guardado.'], ordenarCarta: ['menu.sorted', 'Carta ordenada.'],
  configuracionPush: ['push.configurationViewed', 'Configuración de avisos consultada.'],
  guardarSuscripcionPush: ['push.subscriptionChanged', 'Suscripción de avisos actualizada.'],
  guardarRaciones: ['menu.portionsChanged', 'Recuento de raciones actualizado.'],
  marcarAgotado: ['menu.soldOutChanged', 'Agotados de carta actualizados.'], guardarEstacion: ['station.saved', 'Estación guardada.'],
  guardarConfiguracionSala: ['floor.settingsChanged', 'Configuración de sala guardada.'], regenerarQrMesa: ['table.qrRotated', 'Enlaces de mesa renovados.'],
  recuperarQrMesa: ['table.qrRetrieved', 'Enlaces vigentes de mesa recuperados.'],
  revocarQrMesa: ['table.qrRevoked', 'Enlaces de mesa revocados.'],
  importarQrMesa: ['table.qrImported', 'Secreto del QR vigente recuperado desde su enlace.'],
  abrirMesa: ['tableSession.opened', 'Mesa abierta.'], cambiarEstadoMesa: ['tableSession.statusChanged', 'Estado de mesa actualizado.'],
  editarMesa: ['tableSession.edited', 'Mesa actualizada.'], moverMesa: ['tableSession.moved', 'Mesa movida.'], juntarMesas: ['tableSession.merged', 'Mesas juntadas.'], separarMesas: ['tableSession.split', 'Mesas separadas.'],
  enviarPedido: ['order.placed', 'Pedido enviado.'], decidirPedido: ['order.decided', 'Pedido decidido.'], marcharPase: ['orderLine.statusChanged', 'Pase marchado.'], cambiarEstadoLineas: ['orderLine.statusChanged', 'Estado de platos actualizado.'],
  crearTarea: ['floorTask.created', 'Tarea de sala creada.'], cambiarEstadoTarea: ['floorTask.completed', 'Tarea de sala actualizada.'],
  verMesaPublica: ['table.viewed', 'Mesa consultada.'], pedirDesdeMesa: ['order.placed', 'Pedido recibido desde la mesa.'], avisarDesdeMesa: ['floorTask.created', 'Aviso recibido desde la mesa.'],
  consultarRecogida: ['takeaway.slotsViewed', 'Horas de recogida consultadas.'], pedirParaLlevar: ['takeaway.created', 'Pedido para llevar recibido.'],
  verParaLlevarPublico: ['takeaway.viewed', 'Recogida consultada.'], crearParaLlevar: ['takeaway.created', 'Pedido para llevar creado.'], cambiarEstadoParaLlevar: ['takeaway.statusChanged', 'Estado de recogida actualizado.'],
}

/** Se exporta también para probar exactamente el mismo camino que usan las callables. */
export async function execute<N extends Name>(name: N, data: unknown, request: CallableRequest<unknown>) {
  const schema = core.CALLABLE_SCHEMAS_FASE2[name]
  type Input = z.output<(typeof core.CALLABLE_SCHEMAS_FASE2)[N]['input']>
  const d = parse(schema.input as unknown as z.ZodType<Input>, data)
  const input = d as Input & { restaurantId?: string; slug?: string; locationId?: string; reference?: string; token?: string; phone?: string }
  const isPublic = core.FASE2_ACCESS[name].permission === 'public'
  // Los intentos fallidos también consumen su límite, aunque la operación principal se revierta.
  if (isPublic) await db.runTransaction(async tx => {
    const rid = await resolveRestaurant(tx, input.slug!)
    await publicTable.rateLimit(tx, rid, request, input.token ?? input.phone ?? null)
  })
  return db.runTransaction(async tx => {
    const rid = isPublic ? await resolveRestaurant(tx, input.slug!) : input.restaurantId!
    let lid = input.locationId
    if (name === 'verParaLlevarPublico') {
      const ref = (await tx.get(db.doc(`restaurants/${rid}/takeawayReferences/${input.reference}`))).data()
      if (!ref) throw new HttpsError('permission-denied', 'El enlace de seguimiento no es válido.')
      lid = ref.locationId
    }
    const c = await context(tx, rid, lid!, isPublic ? undefined : request, name)
    return executeInContext(name, d, c)
  })
}
/** Servicio compartido: el llamante conserva efecto y recibo en la misma transacción. */
export async function executeInContext<N extends Name>(name: N, data: unknown, c: Context, flush = true) {
  const schema = core.CALLABLE_SCHEMAS_FASE2[name]
  type Input = z.output<(typeof core.CALLABLE_SCHEMAS_FASE2)[N]['input']>
  const d = parse(schema.input as unknown as z.ZodType<Input>, data)
  const tx = c.tx
    // La respuesta se guarda en la misma transacción que la comanda. El reintento
    // recupera el resultado incluso si desde entonces se cerró o movió la mesa.
    const submission = d as Input & { requestId?: string; token?: string; tableId?: string }
    const keyed = (name === 'enviarPedido' || name === 'pedirDesdeMesa') && submission.requestId
    const key = keyed ? core.sha256Hex(JSON.stringify([name, c.uid ?? core.sha256Hex(submission.token!), submission.requestId])) : null
    const fingerprint = key ? core.sha256Hex(JSON.stringify(d)) : null
    if (key) {
      if (name === 'pedirDesdeMesa') { publicTable.requireReplayLink(c, submission as { token: string; tableId: string }) }
      const previous = (await tx.get(c.local.collection('orderSubmissions').doc(key))).data()
      if (previous) {
        if (previous.privacyRedacted === true) throw new HttpsError('failed-precondition', 'Este envío se suprimió por privacidad. No se volverá a ejecutar.')
        if (previous.fingerprint !== fingerprint) throw new HttpsError('failed-precondition', 'Este envío ya se utilizó con otro contenido. Recupera primero su resultado.')
        return schema.output.parse(previous.result)
      }
    }
    const handle = handlers[name] as unknown as (c: Context, d: Input) => unknown
    const result = schema.output.parse(await handle(c, d))
    if (key && !('status' in result && result.status === 'rejected')) c.stage(`${c.local.path}/orderSubmissions/${key}`, { fingerprint, result }, true)
    if (!('status' in result && result.status === 'rejected') && !['configuracionPush', 'verMesaPublica', 'consultarRecogida', 'verParaLlevarPublico', 'recuperarQrMesa'].includes(name)) reconcile(c)
    const action = name === 'cambiarEstadoTarea' && (d as core.CallableInput<'cambiarEstadoTarea'>).action === 'claim' ? 'floorTask.claimed' : actions[name][0]
    if (flush) c.flush(['configuracionPush', 'verMesaPublica', 'consultarRecogida', 'verParaLlevarPublico', 'recuperarQrMesa'].includes(name) || ('status' in result && result.status === 'rejected') ? null : action, actions[name][1])
    return result
}

function callable(name: Name) { return onCall(options, request => safe(() => execute(name, request.data, request))) }
export const guardarCategoriaCarta = callable('guardarCategoriaCarta')
export const guardarPlato = callable('guardarPlato')
export const guardarMenuDia = callable('guardarMenuDia')
export const ordenarCarta = callable('ordenarCarta')
export const marcarAgotado = callable('marcarAgotado')
export const guardarEstacion = callable('guardarEstacion')
export const guardarConfiguracionSala = callable('guardarConfiguracionSala')
export const regenerarQrMesa = callable('regenerarQrMesa')
export const abrirMesa = callable('abrirMesa')
export const cambiarEstadoMesa = callable('cambiarEstadoMesa')
export const editarMesa = callable('editarMesa')
export const moverMesa = callable('moverMesa')
export const juntarMesas = callable('juntarMesas')
export const separarMesas = callable('separarMesas')
export const enviarPedido = callable('enviarPedido')
export const decidirPedido = callable('decidirPedido')
export const marcharPase = callable('marcharPase')
export const cambiarEstadoLineas = callable('cambiarEstadoLineas')
export const crearTarea = callable('crearTarea')
export const cambiarEstadoTarea = callable('cambiarEstadoTarea')
export const verMesaPublica = callable('verMesaPublica')
export const pedirDesdeMesa = callable('pedirDesdeMesa')
export const avisarDesdeMesa = callable('avisarDesdeMesa')
export const consultarRecogida = callable('consultarRecogida')
export const pedirParaLlevar = callable('pedirParaLlevar')
export const verParaLlevarPublico = callable('verParaLlevarPublico')
export const crearParaLlevar = callable('crearParaLlevar')
export const cambiarEstadoParaLlevar = callable('cambiarEstadoParaLlevar')

export const guardarRaciones = callable('guardarRaciones')

export const configuracionPush = callable('configuracionPush')
export const guardarSuscripcionPush = callable('guardarSuscripcionPush')
export const recuperarQrMesa = callable('recuperarQrMesa')

export const revocarQrMesa = callable('revocarQrMesa')

export const importarQrMesa = callable('importarQrMesa')
