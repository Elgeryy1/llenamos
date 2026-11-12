import type { Pool, PoolClient } from 'pg'
import type { z } from 'zod'
import * as core from '@llenamos/core'
import { ApiError } from '../../errors.js'
import { type Actor, type Context, type Focus, type Input, type LoadOptions, type Name, type Scope, denied, fail, loadContext, requireFloor, restaurantView } from './context.js'
import { reconcile } from './service.js'
import * as push from './push.js'
import * as catalog from './catalog.js'
import * as sessions from './sessions.js'
import * as orders from './orders.js'
import * as tasks from './tasks.js'
import * as publicTable from './public.js'
import * as takeaways from './takeaways.js'

type Handler = (c: Context, d: never) => unknown
const all = { ...push, ...catalog, ...sessions, ...orders, ...tasks, ...publicTable, ...takeaways } as Record<string, unknown>
export const handlers = Object.fromEntries(Object.keys(core.CALLABLES_FASE2).map(name => {
  if (typeof all[name] !== 'function') throw new Error(`Falta el manejador de sala ${name}`)
  return [name, all[name] as Handler]
})) as Record<Name, Handler>

/** Consultas: no reconcilian ni escriben nada. */
const readOnly = new Set<string>(['configuracionPush', 'verMesaPublica', 'consultarRecogida', 'verParaLlevarPublico', 'recuperarQrMesa'])
/** Opciones de lectura de cada operación: solo carga los secretos que usa y comparte el bloqueo si no escribe. */
export function loadOptions(name: Name, input: unknown): LoadOptions {
  const d = input as { tableId?: string; tableIds?: string[] }
  const tables = d.tableIds ?? (d.tableId ? [d.tableId] : [])
  const guests = (input as { guests?: number }).guests
  const validatesTables = ['abrirMesa', 'moverMesa', 'juntarMesas', 'separarMesas', 'cambiarEstadoMesa'].includes(name) || (name === 'editarMesa' && guests !== undefined)
  return { focus: focusOf(input), pickupDay: pickupWindow(input), readOnly: readOnly.has(name), validatesTables, tableIds: tables,
    secrets: { tableTokens: ['regenerarQrMesa', 'recuperarQrMesa', 'revocarQrMesa', 'importarQrMesa', 'verMesaPublica', 'pedirDesdeMesa', 'avisarDesdeMesa'].includes(name) ? tables : [], push: name === 'configuracionPush' || name === 'guardarSuscripcionPush' } }
}
export const isPublic = (name: Name) => core.FASE2_ACCESS[name].permission === 'public'

export function focusOf(data: unknown): Focus {
  const d = data as { sessionId?: string | null; takeawayId?: string | null; orderId?: string; taskId?: string; lineIds?: string[] }
  return {
    sessionIds: d.sessionId ? [d.sessionId] : [], takeawayIds: d.takeawayId ? [d.takeawayId] : [],
    orderIds: d.orderId ? [d.orderId] : [], taskIds: d.taskId ? [d.taskId] : [], lineIds: d.lineIds ?? [],
  }
}

/** Traduce los fallos de SQL que son del contrato (referencia repetida) y deja pasar el resto. */
export function translate(error: unknown): never {
  const code = (error as { code?: string })?.code
  if (code === '23505') throw new ApiError(409, 'aborted', 'Otra operación llegó primero. Repite la operación.')
  if (code === '40P01' || code === '40001') throw new ApiError(409, 'aborted', 'El servicio estaba ocupado. Repite la operación.')
  throw error
}

/**
 * Ejecuta el manejador dentro de la transacción abierta y valida su salida. El recibo de los
 * envíos con `requestId` se guarda con la comanda, así que un reintento devuelve el mismo resultado.
 */
export async function executeInContext<N extends Name>(name: N, d: Input<N>, c: Context) {
  const schema = core.CALLABLE_SCHEMAS_FASE2[name]
  const sub = d as { requestId?: string; token?: string }
  const keyed = (name === 'enviarPedido' || name === 'pedirDesdeMesa') && sub.requestId
  const key = keyed ? core.sha256Hex(JSON.stringify([name, c.uid ?? core.sha256Hex(sub.token!), sub.requestId])) : null
  const fingerprint = key ? core.sha256Hex(JSON.stringify(d)) : null
  if (key) {
    // Un reintento tampoco vale con la mesa desactivada o el enlace rotado.
    if (name === 'pedirDesdeMesa') publicTable.requireReplayLink(c, sub as { token: string; tableId: string })
    const { rows } = await c.client.query<{ fingerprint: string; result: unknown }>('SELECT fingerprint,result FROM llenamos.sala_submissions WHERE restaurant_id=$1 AND location_id=$2 AND key=$3', [c.rid, c.lid, key])
    if (rows[0]) {
      if (rows[0].fingerprint !== fingerprint) fail('Este envío ya se utilizó con otro contenido. Recupera primero su resultado.')
      return schema.output.parse(rows[0].result) as z.output<(typeof schema)['output']>
    }
  }
  const result = schema.output.parse(await (handlers[name] as (c: Context, d: Input<N>) => unknown)(c, d)) as { status?: string }
  const rejected = result.status === 'rejected'
  if (!rejected && !readOnly.has(name)) reconcile(c)
  if (key && !rejected) {
    await c.client.query('INSERT INTO llenamos.sala_submissions(restaurant_id,location_id,key,fingerprint,result) VALUES($1,$2,$3,$4,$5)', [c.rid, c.lid, key, fingerprint, JSON.stringify(result)])
    // Un recibo solo sirve para recuperar la respuesta de un reintento reciente.
    await c.client.query("DELETE FROM llenamos.sala_submissions WHERE (restaurant_id,location_id,key) IN (SELECT restaurant_id,location_id,key FROM llenamos.sala_submissions WHERE restaurant_id=$1 AND location_id=$2 AND created_at<now()-interval '7 days' LIMIT 50)", [c.rid, c.lid])
  }
  if (!readOnly.has(name)) await c.flush()
  return result as z.output<(typeof schema)['output']>
}

/** Operación de personal: identidad ya verificada por el servidor, permisos y módulo aquí. */
export async function runStaff(name: Name, client: PoolClient, input: unknown, uid: string) {
  try { return await staffOperation(name, client, input, uid) } catch (error) { return translate(error) }
}
/** Restaurante, local y miembro activo del local, con el contexto de sala cargado. La identidad ya la verificó el servidor. */
export async function staffContext(client: PoolClient, d: { restaurantId: string; locationId: string }, uid: string, options: LoadOptions = {}, check?: (actor: Actor, view: { plan: any; activeModules: any; moduleOverrides: any; entitlementVersion: any; accessValidUntil: any }) => void) {
  const restaurant = (await client.query('SELECT * FROM llenamos.restaurants WHERE id=$1', [d.restaurantId])).rows[0]
  const location = (await client.query('SELECT * FROM llenamos.locations WHERE restaurant_id=$1 AND id=$2', [d.restaurantId, d.locationId])).rows[0]
  if (!restaurant || !location) return denied()
  const member = (await client.query('SELECT * FROM llenamos.sala_members($1)', [d.restaurantId])).rows.find(m => m.uid === uid)
  if (!member?.active || (member.location_ids.length > 0 && !member.location_ids.includes(d.locationId))) return denied()
  const actor: Actor = { uid, role: member.role, displayName: member.display_name, locationIds: member.location_ids, active: true }
  const view = { plan: restaurant.plan, activeModules: restaurant.active_modules, moduleOverrides: restaurant.module_overrides,
    entitlementVersion: restaurant.entitlement_version, accessValidUntil: restaurant.access_valid_until }
  // Permiso y módulo se comprueban antes de tomar ningún bloqueo del local.
  check?.(actor, view)
  return { actor, view, c: await loadContext(client, { restaurant, location }, d.locationId, actor, options) }
}
async function staffOperation(name: Name, client: PoolClient, input: unknown, uid: string) {
  const d = input as { restaurantId: string; locationId: string }
  const access = core.FASE2_ACCESS[name]
  const { c } = await staffContext(client, d, uid, loadOptions(name, input), (actor, view) => {
    if (access.permission !== 'public' && access.permission !== 'per_line' && !core.can(actor.role, access.permission)) denied()
    if (!core.hasModule(view, access.module)) fail('El módulo necesario está desactivado.')
    if ((actor.role === 'kitchen' || actor.role === 'bar') && !core.hasModule(view, 'kitchen')) denied()
  })
  return executeInContext(name, input as never, c)
}

export function pickupWindow(input: unknown) {
  const date = (input as { date?: string }).date
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined
  const base = Date.parse(`${date}T00:00:00Z`)
  return Number.isFinite(base) ? { from: base - 15 * 3_600_000, to: base + 39 * 3_600_000 } : undefined
}

const bucket = (...parts: string[]) => core.sha256Hex(JSON.stringify(parts))
async function limit(pool: Pool, key: string, max: number, seconds: number) {
  const { rows } = await pool.query<{ ok: boolean }>('SELECT llenamos.sala_rate_limit($1,$2,$3) AS ok', [key, max, seconds])
  if (!rows[0]?.ok) throw new ApiError(429, 'resource-exhausted', 'Demasiadas solicitudes. Espera un momento antes de volver a intentarlo.')
}
/**
 * Antiabuso antes de abrir transacción (los intentos fallidos también cuentan). Cubos por IP verificada
 * del servidor y por credencial (hash del token o del teléfono): quien adivina tokens o rellena
 * formularios agota lo suyo, nunca el cupo de todos los clientes de un restaurante. Un slug que no
 * existe solo consume el cubo de su IP.
 */
export async function publicLimits(pool: Pool, name: Name, d: Record<string, any>, ip?: string | null) {
  // Sin IP verificada (no debería ocurrir tras el servidor) comparten un cubo amplio, no uno por restaurante.
  await limit(pool, bucket('ip', ip ?? 'sin-ip'), ip ? 120 : 600, 60)
  if (!(await pool.query<{ ok: boolean }>('SELECT llenamos.sala_slug_exists($1) AS ok', [d.slug])).rows[0]?.ok) throw new ApiError(404, 'not-found', 'No se encuentra el restaurante.')
  const token = d.token ? core.sha256Hex(String(d.token)) : ''
  if (d.tableId) await limit(pool, bucket('table-credential', d.slug, d.locationId, d.tableId, token), 60, 60)
  if (name === 'pedirDesdeMesa') await limit(pool, bucket('order', d.slug, d.locationId, d.tableId, token), 20, 600)
  if (name === 'avisarDesdeMesa') await limit(pool, bucket('notice', d.slug, d.locationId, d.tableId, token), 12, 600)
  if (name === 'pedirParaLlevar') {
    await limit(pool, bucket('phone', d.slug, d.phone), 4, 3600)
    if (d.email) await limit(pool, bucket('email', d.slug, String(d.email).toLowerCase()), 4, 3600)
    if (ip) await limit(pool, bucket('ip-takeaway', d.slug, ip), 10, 3600)
  }
  if (name === 'verParaLlevarPublico') await limit(pool, bucket('reference', d.slug, d.reference, token), 60, 60)
}

/** Operación sin sesión: QR de mesa o recogida. El alcance (restaurante y local) se abre solo tras resolverlo. */
export async function runPublic(name: Name, input: unknown, pool: Pool, ip?: string | null) {
  const d = input as Record<string, any>
  await publicLimits(pool, name, d, ip)
  const client = await pool.connect()
  let broken = false
  try {
    await client.query('BEGIN')
    const open = async (location: string | null) => (await client.query<{ s: Scope | null }>('SELECT llenamos.sala_public_scope($1,$2) AS s', [d.slug, location])).rows[0]?.s
    let scope = await open(name === 'verParaLlevarPublico' ? null : d.locationId)
    if (!scope) throw new ApiError(404, 'not-found', 'No se encuentra el restaurante.')
    let lid = d.locationId as string, focus: Focus = {}
    if (name === 'verParaLlevarPublico') {
      const ref = (await client.query<{ r: { id: string; locationId: string; hash: string } | null }>('SELECT llenamos.sala_takeaway_locate($1) AS r', [d.reference])).rows[0]?.r
      if (!ref || !publicTable.tokenMatches(ref.hash, d.token)) throw new ApiError(403, 'permission-denied', 'El enlace de seguimiento no es válido.')
      lid = ref.locationId; focus = { takeawayIds: [ref.id] }
      scope = await open(lid)
      if (!scope) throw new ApiError(404, 'not-found', 'No se encuentra el local.')
    }
    if (d.tableId) {
      // Se valida la credencial antes de cargar el contexto del local.
      const token = (await client.query<{ doc: { tokenHash?: string } }>("SELECT doc FROM llenamos.sala_private WHERE restaurant_id=$1 AND location_id=$2 AND kind='tableTokens' AND id=$3", [(scope.restaurant as { id: string }).id, lid, d.tableId])).rows[0]
      if (!publicTable.tokenMatches(token?.doc.tokenHash, d.token)) throw new ApiError(403, 'permission-denied', 'El enlace de esta mesa no es válido.')
    }
    const c = await loadContext(client, scope, lid, null, { ...loadOptions(name, input), focus })
    if (name !== 'verParaLlevarPublico') requireFloor(c)
    const result = await executeInContext(name, input as never, c)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { broken = true }
    return translate(error)
  } finally { client.release(broken) }
}
