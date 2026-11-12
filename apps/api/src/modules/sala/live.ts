import type { PoolClient } from 'pg'
import * as core from '@llenamos/core'
import { ApiError } from '../../errors.js'
import type { LiveQuery } from '../types.js'
import { restaurantView } from './context.js'

const Scope = core.SalaAlcanceSchema
const ALL = ['owner', 'manager', 'waiter', 'kitchen', 'bar'] as const
const LIMIT = { sessions: 500, takeaways: 500, tasks: 500, lines: 5000, history: 200 }
type Where = { restaurantId: string; locationId: string }
interface Rights { role: core.Role; floor: boolean; kitchen: boolean }

/**
 * Misma regla que `firebase/firestore.rules` (floorStaff, floorReader, stationReader): miembro activo del
 * local, módulo activo y rol. RLS solo filtra por restaurante, así que cada lectura lo comprueba aquí.
 */
async function rights(client: PoolClient, uid: string, input: Where): Promise<Rights> {
  const denied = () => new ApiError(403, 'permission-denied', 'No tienes permiso para leer esto en este local.')
  const restaurant = (await client.query('SELECT * FROM llenamos.restaurants WHERE id=$1', [input.restaurantId])).rows[0]
  const location = (await client.query('SELECT 1 FROM llenamos.locations WHERE restaurant_id=$1 AND id=$2', [input.restaurantId, input.locationId])).rows[0]
  const member = (await client.query('SELECT * FROM llenamos.sala_members($1)', [input.restaurantId])).rows.find(m => m.uid === uid)
  if (!restaurant || !location || !member?.active || (member.location_ids.length > 0 && !member.location_ids.includes(input.locationId))) throw denied()
  const view = restaurantView(restaurant)
  return { role: member.role, floor: core.hasModule(view, 'floor'), kitchen: core.hasModule(view, 'kitchen') }
}
const floorStaff = (r: Rights) => r.floor && ['owner', 'manager', 'waiter'].includes(r.role)
const floorReader = (r: Rights) => floorStaff(r) || (r.floor && r.kitchen && ['kitchen', 'bar'].includes(r.role))
const stationReader = (r: Rights) => r.kitchen && (['owner', 'manager'].includes(r.role) || (r.floor && ['waiter', 'kitchen', 'bar'].includes(r.role)))
function require(ok: boolean) { if (!ok) throw new ApiError(403, 'permission-denied', 'No tienes permiso para leer esto en este local.') }

/** Devuelve hasta `limit` filas y si había más (se pide una de más para saberlo). */
async function rows(client: PoolClient, table: string, input: Where, where = '', params: unknown[] = [], limit = 2000) {
  const found = (await client.query<{ id: string; doc: object }>(`SELECT id,doc FROM llenamos.${table} WHERE restaurant_id=$1 AND location_id=$2 ${where} ORDER BY id LIMIT ${limit + 1}`, [input.restaurantId, input.locationId, ...params])).rows
  return { rows: found.slice(0, limit).map(r => ({ ...r.doc, id: r.id })), more: found.length > limit }
}
const base = (input: unknown) => Scope.parse(input)

async function destinationData(client: PoolClient, input: Where, sessions: { id: string }[], takeaways: { id: string }[]) {
  const lines = await rows(client, 'sala_order_lines', input, 'AND (session_id=ANY($3) OR takeaway_id=ANY($4))', [sessions.map(s => s.id), takeaways.map(t => t.id)], LIMIT.lines)
  const orderIds = [...new Set(lines.rows.map(l => (l as unknown as { orderId: string }).orderId))]
  const orders = await rows(client, 'sala_orders', input, 'AND id=ANY($3)', [orderIds], LIMIT.lines)
  return { lines, orders }
}

/** Mesas, pedidos, líneas, tareas y recogidas vivos. Las cerradas llegan por `salaHistorial`. */
export const servicio: LiveQuery = {
  name: core.SALA_LIVE.servicio, roles: ALL, input: Scope, output: core.SalaServicioVivoSchema,
  restaurantId: input => base(input).restaurantId,
  topics: () => ['sala.sesion', 'sala.pedido', 'sala.linea', 'sala.tarea', 'sala.recogida'],
  async snapshot(client, raw, context) {
    const input = base(raw)
    require(floorStaff(await rights(client, context.uid, input)))
    const sessions = await rows(client, 'sala_table_sessions', input, "AND status IN ('open','bill_requested')", [], LIMIT.sessions)
    const takeaways = await rows(client, 'sala_takeaways', input, "AND status IN ('pending','accepted','ready')", [], LIMIT.takeaways)
    const { lines, orders } = await destinationData(client, input, sessions.rows as { id: string }[], takeaways.rows as { id: string }[])
    const tasks = await rows(client, 'sala_floor_tasks', input, "AND status IN ('open','claimed')", [], LIMIT.tasks)
    return core.SalaServicioVivoSchema.parse({ sessions: sessions.rows, takeaways: takeaways.rows, lines: lines.rows, orders: orders.rows, tasks: tasks.rows,
      truncated: sessions.more || takeaways.more || lines.more || orders.more || tasks.more })
  },
}

/** Lo cerrado en las últimas horas (mesas cerradas o anuladas, recogidas entregadas o canceladas) para reabrir o repasar. */
export const historial: LiveQuery = {
  name: core.SALA_LIVE.historial, roles: ALL, input: Scope, output: core.SalaServicioVivoSchema,
  restaurantId: input => base(input).restaurantId,
  topics: () => ['sala.sesion', 'sala.recogida'],
  async snapshot(client, raw, context) {
    const input = base(raw)
    require(floorStaff(await rights(client, context.uid, input)))
    const since = Date.now() - core.SALA_HISTORIAL_HORAS * 3_600_000
    const sessions = await rows(client, 'sala_table_sessions', input, "AND status IN ('closed','cancelled','merged') AND closed_at>=$3", [since], LIMIT.history)
    const takeaways = await rows(client, 'sala_takeaways', input, "AND status IN ('picked_up','cancelled') AND pickup_at>=$3", [since], LIMIT.history)
    const { lines, orders } = await destinationData(client, input, sessions.rows as { id: string }[], takeaways.rows as { id: string }[])
    return core.SalaServicioVivoSchema.parse({ sessions: sessions.rows, takeaways: takeaways.rows, lines: lines.rows, orders: orders.rows, tasks: [],
      truncated: sessions.more || takeaways.more || lines.more || orders.more })
  },
}

/** Carta, estaciones y ajustes de sala: cambian poco, caben enteros. Las estaciones solo las ve quien puede. */
export const carta: LiveQuery = {
  name: core.SALA_LIVE.carta, roles: ALL, input: Scope, output: core.SalaCartaVivaSchema,
  restaurantId: input => base(input).restaurantId,
  topics: () => ['carta.categoria', 'carta.plato', 'carta.menu', 'cocina.estacion', 'sala.ajustes'],
  async snapshot(client, raw, context) {
    const input = base(raw)
    const access = await rights(client, context.uid, input)
    require(floorReader(access))
    const saved = (await client.query<{ doc: unknown }>("SELECT doc FROM llenamos.sala_settings WHERE restaurant_id=$1 AND location_id=$2 AND kind='floor'", [input.restaurantId, input.locationId])).rows[0]
    return core.SalaCartaVivaSchema.parse({
      categories: (await rows(client, 'sala_menu_categories', input)).rows, items: (await rows(client, 'sala_menu_items', input)).rows, menus: (await rows(client, 'sala_daily_menus', input)).rows,
      stations: stationReader(access) ? (await rows(client, 'sala_stations', input)).rows : [], settings: saved ? saved.doc : core.defaultFloorSettings(), settingsSaved: !!saved,
    })
  },
}

/** Pantalla de una estación (cocina o barra): solo sus líneas visibles; cocina y barra, solo las de su estación. */
export const estacion: LiveQuery = {
  name: core.SALA_LIVE.estacion, roles: ALL, input: core.CocinaLineasInputSchema, output: core.CocinaLineasVivasSchema,
  restaurantId: input => core.CocinaLineasInputSchema.parse(input).restaurantId,
  topics: () => ['sala.linea'],
  async snapshot(client, raw, context) {
    const input = core.CocinaLineasInputSchema.parse(raw)
    const access = await rights(client, context.uid, input)
    require(floorStaff(access) || (access.floor && access.kitchen && ['kitchen', 'bar'].includes(access.role) && input.kind === access.role))
    const lines = await rows(client, 'sala_order_lines', input, "AND station_id=$3 AND station_kind=$4 AND status IN ('held','fired','preparing','ready')", [input.stationId, input.kind], 1000)
    return core.CocinaLineasVivasSchema.parse({ lines: lines.rows })
  },
}
export const liveQueries: LiveQuery[] = [servicio, historial, carta, estacion]
