import type { PoolClient } from 'pg'
import type { z } from 'zod'
import * as core from '@llenamos/core'
import { ApiError } from '../../errors.js'
import { registerSyncEntities, registerSyncExecutor } from '../sync/index.js'
import type { EntityState, SyncActor } from '../sync/registry.js'
import { runStaff } from './execute.js'

/**
 * Cola sin conexión de sala y cocina (servicio `sync`, V1): los cinco ejecutores y el proveedor de versiones.
 * Mismo contrato que `functions/src/fase6-sync` del original: la versión de una entidad es una huella de su revisión,
 * su contenido y el de las líneas que cuelgan de ella, así un cambio de otro dispositivo (o de un escritor que no emita
 * revisión) invalida la intención guardada.
 */
const SALA_ROLES = ['owner', 'manager', 'waiter', 'kitchen', 'bar'] as const
type Kind = EntityState['kind']
const TABLE = { session: 'sala_table_sessions', takeaway: 'sala_takeaways', line: 'sala_order_lines', task: 'sala_floor_tasks', item: 'sala_menu_items' } as const satisfies Record<Kind, string>
const SCHEMA: Record<Kind, z.ZodType> = { session: core.TableSessionSchema, takeaway: core.TakeawaySchema, line: core.OrderLineSchema, task: core.FloorTaskSchema, item: core.MenuItemSchema }
type Row = { id: string; doc: Record<string, any>; revision: number }
const denied = (): never => { throw new ApiError(403, 'permission-denied', 'No tienes permiso para esta operación.') }

async function rows(client: PoolClient, scope: core.SyncScope, kind: Kind, ids: readonly string[]): Promise<Map<string, Row>> {
  if (!ids.length) return new Map()
  const { rows } = await client.query<{ id: string; doc: Record<string, any>; revision: string }>(
    `SELECT id,doc,revision FROM llenamos.${TABLE[kind]} WHERE restaurant_id=$1 AND location_id=$2 AND id=ANY($3)`, [scope.restaurantId, scope.locationId, ids])
  return new Map(rows.map(r => [r.id, { id: r.id, doc: r.doc, revision: Number(r.revision) }]))
}
/** Solo lo que el rol puede ver: cocina y barra, las líneas de su estación y los platos que prepara. */
async function authorize(client: PoolClient, scope: core.SyncScope, actor: SyncActor, kind: Kind, found: Map<string, Row>) {
  if (actor.role === 'kitchen' || actor.role === 'bar') {
    const station = actor.role === 'bar' ? 'bar' : 'kitchen'
    if (kind === 'line') { for (const r of found.values()) if (r.doc.stationKind !== station) denied() }
    else if (kind === 'item') {
      const settings = (await client.query<{ doc: { defaultStationId?: string | null } }>("SELECT doc FROM llenamos.sala_settings WHERE restaurant_id=$1 AND location_id=$2 AND kind='floor'", [scope.restaurantId, scope.locationId])).rows[0]?.doc
      const stationIds = [...new Set([...found.values()].map(r => String(r.doc.stationId ?? settings?.defaultStationId ?? '')))].filter(Boolean)
      const stations = stationIds.length ? (await client.query<{ id: string; doc: { kind: string } }>('SELECT id,doc FROM llenamos.sala_stations WHERE restaurant_id=$1 AND location_id=$2 AND id=ANY($3)', [scope.restaurantId, scope.locationId, stationIds])).rows : []
      for (const r of found.values()) {
        const id = String(r.doc.stationId ?? settings?.defaultStationId ?? '')
        if (stations.find(s => s.id === id)?.doc.kind !== station) denied()
      }
    } else if (found.size) denied()
  } else if (!core.can(actor.role as core.Role, 'comandas.tomar')) denied()
}
/** Un documento antiguo que ya no cumple el esquema no tumba todo el lote: se versiona tal cual está. */
const parsed = (kind: Kind, row: Row) => { const r = SCHEMA[kind].safeParse(row.doc); return { ...(r.success ? r.data as object : row.doc), id: row.id } }

export async function readEntities(client: PoolClient, scope: core.SyncScope, entities: ReadonlyArray<Pick<EntityState, 'kind' | 'id'>>, actor: SyncActor): Promise<Array<EntityState | null>> {
  const byKind = new Map<Kind, Map<string, Row>>()
  for (const kind of new Set(entities.map(e => e.kind))) {
    const found = await rows(client, scope, kind, entities.filter(e => e.kind === kind).map(e => e.id))
    await authorize(client, scope, actor, kind, found)
    byKind.set(kind, found)
  }
  // Líneas enlazadas de todas las sesiones y recogidas pedidas, en una sola consulta por tipo (sin una por entidad).
  const linkedBy = new Map<string, Row[]>()
  for (const [kind, column] of [['session', 'session_id'], ['takeaway', 'takeaway_id']] as const) {
    const ids = entities.filter(e => e.kind === kind && byKind.get(kind)!.has(e.id)).map(e => e.id)
    if (!ids.length) continue
    const found = await client.query<{ id: string; doc: Record<string, any>; revision: string; owner: string }>(
      `SELECT id,doc,revision,${column} AS owner FROM llenamos.sala_order_lines WHERE restaurant_id=$1 AND location_id=$2 AND ${column}=ANY($3) ORDER BY id`, [scope.restaurantId, scope.locationId, ids])
    for (const r of found.rows) linkedBy.set(`${kind}:${r.owner}`, [...(linkedBy.get(`${kind}:${r.owner}`) ?? []), { id: r.id, doc: r.doc, revision: Number(r.revision) }])
  }
  const taskLines = await rows(client, scope, 'line', [...new Set(entities.filter(e => e.kind === 'task').flatMap(e => { const l = byKind.get('task')!.get(e.id)?.doc.lineIds; return Array.isArray(l) ? l as string[] : [] }))])
  const out: Array<EntityState | null> = []
  for (const entity of entities) {
    const row = byKind.get(entity.kind)!.get(entity.id)
    if (!row) { out.push(null); continue }
    const doc = parsed(entity.kind, row)
    let linked: Row[] = linkedBy.get(`${entity.kind}:${entity.id}`) ?? []
    if (entity.kind === 'task') linked = (Array.isArray(row.doc.lineIds) ? row.doc.lineIds as string[] : []).map(id => taskLines.get(id)).filter((r): r is Row => !!r)
    const version = core.sha256Hex(core.canonicalJson(JSON.parse(JSON.stringify([row.revision, doc, linked.map(l => [parsed('line', l), l.revision])]))))
    out.push({ kind: entity.kind, id: entity.id, version, hash: core.sha256Hex(core.canonicalJson(JSON.parse(JSON.stringify(doc)))) })
  }
  return out
}

/** Registra los ejecutores y el proveedor al cargar el módulo de sala. */
export function registerSalaSync(): void {
  registerSyncEntities({ read: readEntities })
  for (const operation of core.OFFLINE_OPERATIONS) registerSyncExecutor(operation, {
    module: 'floor', roles: SALA_ROLES,
    // Misma ruta que la operación en línea: permisos, módulo, contexto acotado, idempotencia por `requestId` y emisión de eventos.
    execute: (client, command, actor) => runStaff(operation, client, core.CALLABLE_SCHEMAS_FASE2[operation].input.parse(command.payload), actor.uid),
  })
}
