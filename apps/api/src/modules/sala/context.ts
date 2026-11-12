import { randomBytes } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { z } from 'zod'
import * as core from '@llenamos/core'
import { ApiError } from '../../errors.js'
import { emitEvent } from '../../events.js'
import { enqueueOutbox } from '../../outbox.js'
import { runLineStateHooks } from './hooks.js'
import { ensureCustomer, reconcileSpend, type SpendTarget } from './clientes.js'

export const fail = (message: string): never => { throw new ApiError(412, 'failed-precondition', message) }
export const denied = (): never => { throw new ApiError(403, 'permission-denied', 'No tienes permiso para esta operación en este local.') }
export const missing = (): never => { throw new ApiError(404, 'not-found', 'No se encuentra el documento en este local.') }
export type Row<T> = T & { id: string }
export type Name = keyof typeof core.CALLABLE_SCHEMAS_FASE2
export type Input<N extends Name> = z.output<(typeof core.CALLABLE_SCHEMAS_FASE2)[N]['input']>

const schemas = {
  menuCategories: core.MenuCategorySchema, menuItems: core.MenuItemSchema, dailyMenus: core.DailyMenuSchema,
  stations: core.StationSchema, tables: core.TableSchema, tableSessions: core.TableSessionSchema,
  orders: core.OrderSchema, orderLines: core.OrderLineSchema, floorTasks: core.FloorTaskSchema, takeaways: core.TakeawaySchema,
} as const
export type Collection = keyof typeof schemas
export type Collections = { [K in Collection]: Map<string, Row<z.output<(typeof schemas)[K]>>> }
/** El plano (	ables) no es de sala: lo edita reservas (guardarPlano) y vive en dining_tables; sala solo lo lee. */
const tableOf: Record<Exclude<Collection, 'tables'>, string> = {
  menuCategories: 'sala_menu_categories', menuItems: 'sala_menu_items', dailyMenus: 'sala_daily_menus', stations: 'sala_stations',
  tableSessions: 'sala_table_sessions', orders: 'sala_orders', orderLines: 'sala_order_lines',
  floorTasks: 'sala_floor_tasks', takeaways: 'sala_takeaways',
}
const topicOf: Partial<Record<Collection, string>> = {
  menuCategories: 'carta.categoria', menuItems: 'carta.plato', dailyMenus: 'carta.menu', stations: 'cocina.estacion',
  tableSessions: 'sala.sesion', orders: 'sala.pedido', orderLines: 'sala.linea', floorTasks: 'sala.tarea', takeaways: 'sala.recogida',
}
export type PrivateKind = 'tableTokens' | 'taskKeys' | 'takeawaySecrets' | 'pushSubscriptions'
export interface Actor { uid: string; role: core.Role; displayName: string; locationIds: string[]; active: boolean }
/** Ids que la operación necesita aunque ya no estén vivos (una mesa cerrada que se reabre). */
export interface Focus { sessionIds?: string[]; takeawayIds?: string[]; orderIds?: string[]; lineIds?: string[]; taskIds?: string[] }
export interface Scope { restaurant: Record<string, unknown>; location: Record<string, unknown> }
export type Context = Awaited<ReturnType<typeof loadContext>>

/** Reservas que sala carga para validar mesas (ventana de 48 h). */
export const MAX_RESERVATIONS = 500
export const newId = () => randomBytes(15).toString('base64url')
/** UUID estable derivado de una clave: repetir el hecho no genera un segundo aviso. */
export function stableUuid(key: string) {
  const h = core.sha256Hex(key)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

async function docs(client: PoolClient, table: string, rid: string, lid: string, where = '', params: unknown[] = []) {
  const { rows } = await client.query<{ id: string; doc: unknown }>(`SELECT id,doc FROM llenamos.${table} WHERE restaurant_id=$1 AND location_id=$2 ${where}`, [rid, lid, ...params])
  return rows
}
function parsed<K extends Collection>(name: K, rows: { id: string; doc: unknown }[]) {
  return new Map(rows.map(r => [r.id, { ...schemas[name].parse(r.doc), id: r.id }])) as Collections[K]
}

/**
 * Lectura acotada del servicio vivo del local: catálogo, plano, mesas abiertas, sus líneas,
 * tareas activas y recogidas vigentes. Nunca se lee el histórico completo.
 */
export interface LoadOptions {
  focus?: Focus; pickupDay?: { from: number; to: number }
  /** Solo lectura: bloqueo compartido, no espera a otras lecturas. */
  readOnly?: boolean
  /** La operación valida mesas contra reservas (abrir, mover, juntar, separar, comensales, reabrir o cerrar): toma el cerrojo de reservas y carga sus reservas. */
  validatesTables?: boolean
  /** Mesas que la operación va a ocupar o validar (sus reservas son las únicas que importan). Se suman a las de las mesas enfocadas. */
  tableIds?: readonly string[]
  /** Secretos que la operación necesita: enlaces de esas mesas y/o las suscripciones push del local. */
  secrets?: { tableTokens?: string[]; push?: boolean }
}
export async function loadContext(client: PoolClient, scope: Scope, lid: string, actor: Actor | null, options: LoadOptions = {}) {
  const restaurant = scope.restaurant as Record<string, unknown> & { id: string }
  const rid = restaurant.id, focus = options.focus ?? {}
  // Un único escritor por local: serializa aperturas, pedidos y reparto de raciones. Las lecturas
  // comparten el bloqueo entre sí y solo esperan a una escritura en curso.
  // Orden de bloqueos único: reservas, sala y caja. Sentar o terminar una reserva toca reservas y sala, y caja los toma en
  // compartido antes del suyo, así que nadie espera en orden contrario. Solo las operaciones que validan mesas contra
  // reservas toman el de reservas; cocina, barra y pedidos no lo necesitan.
  if (actor && !options.readOnly && options.validatesTables) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`reservas:${rid}:${lid}`])
  await client.query(`SELECT pg_advisory_xact_lock${options.readOnly ? '_shared' : ''}(hashtextextended($1,0))`, [`sala:${rid}:${lid}`])
  // La hora de la operación se toma con todos los cerrojos ya en la mano, no antes de esperarlos.
  const now = Date.now()
  const read = (table: string, where = '', params: unknown[] = []) => docs(client, table, rid, lid, where, params)
  const rows = {} as Collections
  for (const name of ['menuCategories', 'menuItems', 'dailyMenus', 'stations'] as const) Object.assign(rows, { [name]: parsed(name, await read(tableOf[name])) })
  rows.tables = parsed('tables', (await client.query<{ id: string; doc: unknown }>('SELECT id,data AS doc FROM llenamos.dining_tables WHERE restaurant_id=$1 AND location_id=$2', [rid, lid])).rows)

  const sessionIds = new Set(focus.sessionIds ?? []), takeawayIds = new Set(focus.takeawayIds ?? [])
  const orderIds = new Set(focus.orderIds ?? [])
  if (focus.lineIds?.length) for (const r of await read('sala_order_lines', 'AND id=ANY($3)', [focus.lineIds]))
    { const d = r.doc as { sessionId?: string | null; takeawayId?: string | null }; if (d.sessionId) sessionIds.add(d.sessionId); if (d.takeawayId) takeawayIds.add(d.takeawayId) }
  if (focus.orderIds?.length) for (const r of await read('sala_orders', 'AND id=ANY($3)', [focus.orderIds]))
    { const d = r.doc as { sessionId?: string | null; takeawayId?: string | null }; if (d.sessionId) sessionIds.add(d.sessionId); if (d.takeawayId) takeawayIds.add(d.takeawayId) }
  if (focus.taskIds?.length) for (const r of await read('sala_floor_tasks', 'AND id=ANY($3)', [focus.taskIds]))
    { const d = r.doc as { sessionId?: string | null; takeawayId?: string | null; orderId?: string | null }; if (d.sessionId) sessionIds.add(d.sessionId); if (d.takeawayId) takeawayIds.add(d.takeawayId); if (d.orderId) orderIds.add(d.orderId) }

  const sessionRows = new Map((await read('sala_table_sessions', "AND (status IN ('open','bill_requested') OR id=ANY($3))", [[...sessionIds]])).map(r => [r.id, r]))
  // Las mesas juntadas siguen representadas por la sesión destino: se cargan sus fuentes.
  for (let pending = [...sessionRows.keys()]; pending.length;) {
    const merged = (await read('sala_table_sessions', 'AND merged_into=ANY($3)', [pending])).filter(r => !sessionRows.has(r.id))
    for (const r of merged) sessionRows.set(r.id, r)
    pending = merged.map(r => r.id)
  }
  rows.tableSessions = parsed('tableSessions', [...sessionRows.values()])
  const pickup = options.pickupDay
  const takeawayRows = await read('sala_takeaways', `AND (status IN ('pending','accepted','ready') OR id=ANY($3)${pickup ? ' OR (pickup_at>=$4 AND pickup_at<$5)' : ''})`, pickup ? [[...takeawayIds], pickup.from, pickup.to] : [[...takeawayIds]])
  rows.takeaways = parsed('takeaways', takeawayRows)
  const lineRows = await read('sala_order_lines', 'AND (session_id=ANY($3) OR takeaway_id=ANY($4))', [[...rows.tableSessions.keys()], [...rows.takeaways.keys()]])
  rows.orderLines = parsed('orderLines', lineRows)
  for (const l of rows.orderLines.values()) orderIds.add(l.orderId)
  for (const t of rows.takeaways.values()) for (const id of t.orderIds) orderIds.add(id)
  rows.orders = parsed('orders', await read('sala_orders', 'AND id=ANY($3)', [[...orderIds]]))
  rows.floorTasks = parsed('floorTasks', await read('sala_floor_tasks', "AND (status IN ('open','claimed') OR id=ANY($3))", [focus.taskIds ?? []]))

  const settingsRows = (await client.query<{ kind: string; doc: unknown }>('SELECT kind,doc FROM llenamos.sala_settings WHERE restaurant_id=$1 AND location_id=$2 AND kind=\'floor\'', [rid, lid])).rows
  const floor = settingsRows[0]
  // Horarios y duraciones: la misma fuente que reservas (`reservation_settings`), no una copia propia.
  const reservations = (await client.query<{ data: unknown }>('SELECT data FROM llenamos.reservation_settings WHERE restaurant_id=$1 AND location_id=$2', [rid, lid])).rows[0]
  // Reservas que pueden ocupar mesas ahora, acotadas por fecha (−12 h, +36 h), estado y, sobre todo, por las MESAS que la
  // operación valida (las suyas y las de las sesiones enfocadas): una mesa no tiene cientos de reservas en 48 horas, así
  // que el volumen total de la agenda no puede tumbar abrir, mover, juntar ni separar. Solo las carga la operación que valida mesas.
  const candidateTables = [...new Set([...(options.tableIds ?? []), ...[...rows.tableSessions.values()].flatMap(s => (focus.sessionIds ?? []).includes(s.id) ? s.tableIds : [])])]
  const reservationRows: core.ReservationWithId[] = []
  if (actor && !options.readOnly && options.validatesTables && candidateTables.length) {
    const found = (await client.query<{ id: string; data: unknown }>(
      `SELECT id,data FROM llenamos.reservations WHERE restaurant_id=$1 AND location_id=$2 AND status IN ('pending','confirmed','seated') AND NOT privacy_redacted
         AND start_at>=$3 AND start_at<$4 AND table_ids && $5::text[] ORDER BY start_at,id LIMIT $6`,
      [rid, lid, new Date(now - 12 * 3_600_000), new Date(now + 36 * 3_600_000), candidateTables, MAX_RESERVATIONS + 1])).rows
    if (found.length > MAX_RESERVATIONS) fail('Estas mesas tienen un número anómalo de reservas en las próximas horas. Revisa la agenda de reservas.')
    for (const r of found) {
      const parsedReservation = core.ReservationSchema.safeParse(r.data)
      // Una reserva mal formada no debe romper todas las escrituras del local: se salta y se registra.
      if (parsedReservation.success) reservationRows.push({ id: r.id, ...parsedReservation.data })
      else console.error(JSON.stringify({ level: 'error', event: 'sala_reserva_mal_formada', restaurantId: rid, locationId: lid, reservationId: r.id }))
    }
  }
  const privateRows = { tableTokens: new Map(), taskKeys: new Map(), takeawaySecrets: new Map(), pushSubscriptions: new Map() } as Record<PrivateKind, Map<string, Record<string, any>>>
  const privateOriginal = new Map<string, string>()
  const destinations = [...rows.tableSessions.keys(), ...rows.takeaways.keys(), ...rows.tables.keys()]
  for (const r of (await client.query<{ id: string; doc: Record<string, any> }>('SELECT id,doc FROM llenamos.sala_task_keys WHERE restaurant_id=$1 AND location_id=$2 AND dest=ANY($3)', [rid, lid, destinations])).rows) {
    privateRows.taskKeys.set(r.id, r.doc); privateOriginal.set(`taskKeys/${r.id}`, JSON.stringify(r.doc))
  }
  const wantedTokens = options.secrets?.tableTokens ?? []
  if (wantedTokens.length || options.secrets?.push) for (const r of (await client.query<{ kind: PrivateKind; id: string; doc: Record<string, any> }>(
    `SELECT kind,id,doc FROM llenamos.sala_private WHERE restaurant_id=$1 AND location_id=$2 AND ((kind='tableTokens' AND id=ANY($3)) OR (kind='pushSubscriptions' AND $4))`,
    [rid, lid, wantedTokens, !!options.secrets?.push])).rows) {
    privateRows[r.kind].set(r.id, r.doc); privateOriginal.set(`${r.kind}/${r.id}`, JSON.stringify(r.doc))
  }
  // Estado de la cuenta de caja de cada destino cargado: congela cambios sobre cuentas en cobro o saldadas.
  const bills = new Map<string, string>()
  if (core.hasModule(restaurantView(restaurant), 'pos')) {
    const dests = [...rows.tableSessions.keys(), ...rows.takeaways.keys()]
    if (dests.length) for (const r of (await client.query<{ target_kind: string; target_id: string; status: string }>(
      'SELECT target_kind,target_id,status FROM llenamos.pos_bills WHERE restaurant_id=$1 AND location_id=$2 AND target_id=ANY($3)', [rid, lid, dests])).rows)
      bills.set(`${r.target_kind}:${r.target_id}`, r.status)
  }
  const members = new Map<string, Actor>()
  if (actor) for (const m of (await client.query('SELECT * FROM llenamos.sala_members($1)', [rid])).rows)
    members.set(m.uid, { uid: m.uid, role: m.role, displayName: m.display_name, locationIds: m.location_ids, active: m.active })

  const original = new Map<string, string>()
  for (const name of Object.keys(rows) as Collection[]) for (const [id, v] of rows[name]) { const { id: _id, ...doc } = v as Row<object>; original.set(`${name}/${id}`, JSON.stringify(doc)) }
  const location = scope.location as Record<string, unknown>
  const view = {
    ...restaurantView(restaurant),
    id: rid, slug: String(restaurant.slug), name: String(restaurant.name), brandColor: String(restaurant.brand_color), timezone: String(restaurant.timezone),
  }
  const staged = new Map<string, { collection: Collection; row: Row<object> }>()
  const staging = new Map<string, { kind: PrivateKind; id: string; doc: Record<string, any> }>()
  const touched = new Set<string>()
  const posOn = core.hasModule(view, 'pos')
  const frozen = (kind: 'session' | 'takeaway', id: string) => { const st = bills.get(`${kind}:${id}`); return !!st && st !== 'open' && st !== 'cancelled' }
  /** Caja manda sobre la cuenta: con la cuenta en cobro o saldada no se cambia su consumo ni su destino. */
  function guardBills(name: Collection, row: Row<object>) {
    if (!posOn) return
    const next = row as Record<string, any>
    if (name === 'orderLines') {
      const old = rows.orderLines.get(row.id) as Record<string, any> | undefined
      const changed = !old || ['sessionId', 'takeawayId', 'totalCents', 'taxRate', 'quantity', 'parentLineId'].some(k => old[k] !== next[k]) || ((old.status === 'cancelled') !== (next.status === 'cancelled'))
      if (changed && [old, next].filter(Boolean).some(l => l!.sessionId ? frozen('session', l!.sessionId) : l!.takeawayId && frozen('takeaway', l!.takeawayId)))
        fail('La cuenta está bloqueada para cobrar. No se puede cambiar el consumo ni su destino.')
    }
    if (name === 'tableSessions') {
      const old = rows.tableSessions.get(row.id) as Record<string, any> | undefined
      if (old && frozen('session', row.id) && (JSON.stringify(old.tableIds) !== JSON.stringify(next.tableIds) || old.label !== next.label || (old.status === 'closed' && next.status !== 'closed') || next.status === 'merged' || next.status === 'cancelled'))
        fail('La cuenta está bloqueada o saldada. No se puede mover, juntar, separar ni reabrir la mesa.')
      if (next.status === 'closed' && old?.status !== 'closed') {
        const owed = [...rows.orderLines.values()].filter(l => l.sessionId === row.id && l.status !== 'cancelled')
        if (owed.some(l => l.totalCents > 0 || l.status === 'pending') && bills.get(`session:${row.id}`) !== 'settled') fail('Salda la cuenta antes de cerrar la mesa.')
      }
    }
    if (name === 'takeaways') {
      const old = rows.takeaways.get(row.id) as Record<string, any> | undefined
      if (old && frozen('takeaway', row.id) && (next.status === 'cancelled' || (old.status === 'picked_up' && next.status !== old.status)))
        fail('La cuenta está bloqueada o saldada. No se puede cancelar ni reabrir el pedido.')
      if (next.status === 'picked_up' && old?.status !== 'picked_up') {
        const owed = [...rows.orderLines.values()].filter(l => l.takeawayId === row.id && l.status !== 'cancelled')
        if (owed.some(l => l.totalCents > 0 || l.status === 'pending') && bills.get(`takeaway:${row.id}`) !== 'settled') fail('Salda la cuenta antes de recoger el pedido para llevar.')
      }
    }
  }
  const state = {
    client, rid, lid, now, actor, uid: actor?.uid ?? null, rows, privateRows, members,
    restaurant: view, location: { id: lid, name: String(location.name), address: String(location.address ?? ''), phone: String(location.phone ?? '') },
    floorExists: !!floor,
    settings: floor ? core.FloorSettingsSchema.parse(floor.doc) : core.defaultFloorSettings(),
    reservationSettings: reservations ? core.ReservationSettingsSchema.parse(reservations.data) : core.defaultReservationSettings(view.timezone),
    reservations: reservationRows,
    reservationsLoaded: !!(actor && !options.readOnly && options.validatesTables),
    customerDrafts: new Map<string, { name: string; phone: string; email: string | null; language: core.Language }>(),
    flags: { settingsChanged: false },
    put<K extends Collection>(name: K, value: Collections[K] extends Map<string, infer V> ? V : never, _fresh = false) {
      const row = value as Row<object>
      if (name === 'tables') throw new Error('El plano lo guarda reservas (guardarPlano), no sala.')
      guardBills(name, row)
      ;(rows[name] as Map<string, unknown>).set(row.id, value)
      staged.set(`${name}/${row.id}`, { collection: name, row })
    },
    secret(kind: PrivateKind, id: string, doc: Record<string, any>) {
      privateRows[kind].set(id, doc)
      staging.set(`${kind}/${id}`, { kind, id, doc })
    },
    touch(topic: string, entityId: string | null = null) { touched.add(JSON.stringify([topic, entityId])) },
    /** Persiste solo lo que cambió, deja los eventos y los avisos en la misma transacción. */
    async flush() {
      const changed: { collection: Collection; id: string; before: Record<string, any> | null }[] = []
      for (const [key, { collection, row }] of staged) {
        const { id, ...doc } = row, text = JSON.stringify(doc), previous = original.get(key)
        if (previous === text) continue
        const table = tableOf[collection as Exclude<Collection, 'tables'>]
        await client.query(`INSERT INTO llenamos.${table}(restaurant_id,location_id,id,doc,updated_by) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(restaurant_id,location_id,id) DO UPDATE SET doc=EXCLUDED.doc,revision=${table}.revision+1,updated_at=now(),updated_by=EXCLUDED.updated_by`,
          [rid, lid, id, text, actor?.uid ?? null])
        original.set(key, text)
        changed.push({ collection, id, before: previous ? JSON.parse(previous) : null })
      }
      for (const { kind, id, doc } of staging.values()) {
        const text = JSON.stringify(doc)
        if (privateOriginal.get(`${kind}/${id}`) === text) continue
        if (kind === 'taskKeys') await client.query(`INSERT INTO llenamos.sala_task_keys(restaurant_id,location_id,id,doc) VALUES($1,$2,$3,$4)
          ON CONFLICT(restaurant_id,location_id,id) DO UPDATE SET doc=EXCLUDED.doc,revision=sala_task_keys.revision+1,updated_at=now()`, [rid, lid, id, text])
        else await client.query(`INSERT INTO llenamos.sala_private(restaurant_id,location_id,kind,id,doc) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(restaurant_id,location_id,kind,id) DO UPDATE SET doc=EXCLUDED.doc,updated_at=now()`, [rid, lid, kind, id, text])
        privateOriginal.set(`${kind}/${id}`, text)
        if (kind === 'tableTokens') touched.add(JSON.stringify(['sala.qr', id]))
      }
      for (const [customerId, draft] of state.customerDrafts) await ensureCustomer(client, rid, customerId, draft, !!actor)
      state.customerDrafts.clear()
      const spend: SpendTarget[] = []
      for (const { collection, id } of changed) {
        if (collection === 'tableSessions') { const s = rows.tableSessions.get(id)!; spend.push({ kind: 'session', id, customerId: s.customerId, amountCents: s.status === 'closed' ? s.totalCents : 0 }) }
        if (collection === 'takeaways') { const t = rows.takeaways.get(id)!; spend.push({ kind: 'takeaway', id, customerId: t.customerId, amountCents: t.status === 'picked_up' ? t.totalCents : 0 }) }
      }
      await reconcileSpend(client, rid, lid, spend)
      if (state.flags.settingsChanged) {
        await client.query(`INSERT INTO llenamos.sala_settings(restaurant_id,location_id,kind,doc,updated_by) VALUES($1,$2,'floor',$3,$4)
          ON CONFLICT(restaurant_id,location_id,kind) DO UPDATE SET doc=EXCLUDED.doc,updated_at=now(),updated_by=EXCLUDED.updated_by`, [rid, lid, JSON.stringify(state.settings), actor?.uid ?? null])
        touched.add(JSON.stringify(['sala.ajustes', null]))
      }
      // Descuento de stock (inventario) en la misma transacción: líneas nuevas o con otro estado, ya escritas.
      await runLineStateHooks(client, { restaurantId: rid, locationId: lid }, changed.filter(x => x.collection === 'orderLines' && x.before?.status !== (rows.orderLines.get(x.id) as { status?: string } | undefined)?.status).map(x => x.id), now, view)
      for (const { collection, id, before } of changed) {
        const topic = topicOf[collection]
        if (!topic) continue
        const status = (rows[collection].get(id) as { status?: string } | undefined)?.status
        await emitEvent(client, { restaurantId: rid, locationId: lid, topic, entityId: id, payload: status ? { status } : {} })
        // Hechos para la API pública de eventos (webhooks de plataforma); sin datos personales.
        const fact = collection === 'orders' && !before ? { type: 'order.placed', key: 'placed' }
          : collection === 'orderLines' && before && before.status !== status ? { type: 'orderLine.statusChanged', key: `${before.status}>${status}:${(rows.orderLines.get(id)?.history ?? []).length}` } : null
        if (fact) await enqueueOutbox(client, { id: stableUuid(`platform:${rid}:${lid}:${fact.type}:${id}:${fact.key}`), restaurantId: rid, kind: 'plataforma.evento',
          payload: { type: fact.type, version: 1, locationId: lid, occurredAt: now, data: { entityId: id, status: status ?? null } } })
      }
      for (const entry of touched) {
        const [topic, entityId] = JSON.parse(entry) as [string, string | null]
        await emitEvent(client, { restaurantId: rid, locationId: lid, topic, entityId })
      }
      touched.clear(); staged.clear(); staging.clear(); state.flags.settingsChanged = false
      for (const { collection, id } of changed) if (collection === 'takeaways') await queueTakeawayNotices(state, rows.takeaways.get(id)!)
    },
  }
  return state
}

/** Avisos al cliente de una recogida: una sola vez por estado y canal; envía el worker. */
async function queueTakeawayNotices(c: { client: PoolClient; rid: string; lid: string }, t: Row<core.Takeaway>) {
  if (!['accepted', 'ready'].includes(t.status)) return
  const templates = t.status === 'ready' ? ['takeaway_accepted', 'takeaway_ready'] as const : ['takeaway_accepted'] as const
  for (const template of templates) for (const channel of ['email', 'whatsapp'] as const) {
    if (!(channel === 'email' ? t.email : t.phone)) continue
    // El worker lee el contacto y el enlace de seguimiento; el evento no lleva datos personales.
    await enqueueOutbox(c.client, { id: stableUuid(`takeaway:${c.lid}:${t.id}:${template}:${channel}`), restaurantId: c.rid, kind: 'aviso.recogida', payload: { locationId: c.lid, takeawayId: t.id, template, channel } })
  }
}

/** Lo que hace falta del restaurante para resolver sus módulos (misma regla que las reglas de Firestore). */
export function restaurantView(restaurant: Record<string, unknown>) {
  return {
    plan: restaurant.plan as core.Plan, activeModules: restaurant.active_modules as core.Module[], moduleOverrides: restaurant.module_overrides as core.ModuleOverrides,
    entitlementVersion: (restaurant.entitlement_version ?? null) as number | null, accessValidUntil: restaurant.access_valid_until ? new Date(String(restaurant.access_valid_until)).getTime() : null,
  }
}
export function get<K extends Collection>(c: Context, collection: K, id: string): Collections[K] extends Map<string, infer V> ? V : never {
  const value = c.rows[collection].get(id)
  if (!value) return missing()
  return value as Collections[K] extends Map<string, infer V> ? V : never
}
export function permission(c: Context, p: core.Permission) { return !!c.actor && core.can(c.actor.role, p) }
export function requireFloor(c: Context) {
  if (!core.hasModule(c.restaurant, 'floor')) fail('El módulo de sala está desactivado.')
}
export function checkLine(c: Context, line: core.OrderLine, status: core.LineStatus, reason: string | null = null) {
  if (line.kind === 'menu') fail('El estado del menú lo determinan sus platos.')
  if (line.status === status) return
  if (line.status === 'pending') fail('Decide primero el pedido pendiente.')
  const allowed = (p: core.Permission) => permission(c, p) && (!['cocina.preparar', 'barra.preparar'].includes(p) || core.hasModule(c.restaurant, 'kitchen'))
  const result = core.checkLineTransition(line, status, allowed, reason)
  if (!result.ok) { if (!core.lineTransitionPermissions(line.status, status, line.stationKind).some(allowed)) denied(); fail(result.reason) }
}
export function publicMenu(c: Context) {
  return core.buildPublicMenu({ restaurantId: c.rid, locationId: c.lid, restaurantName: c.restaurant.name, locationName: c.location.name,
    brandColor: c.restaurant.brandColor, timezone: c.reservationSettings.timezone, settings: c.settings,
    categories: Object.fromEntries(c.rows.menuCategories), items: Object.fromEntries(c.rows.menuItems), dailyMenus: Object.fromEntries(c.rows.dailyMenus), floorModule: core.hasModule(c.restaurant, 'floor') })
}
