/**
 * Entradas de otros módulos. Personal e inventario no son dueños de la carta (V4), de las líneas de pedido (V4) ni de las
 * cajas (V5): las leen de sus tablas reales (`sala_menu_items`, `sala_order_lines` de 008 y `pos_cash_sessions` de 009) con su
 * RLS, dentro de la transacción de quien llama. Un plato, una línea o una caja que no existen en el local dan «no existe»;
 * nunca datos inventados. Quien integre otra fuente (o las pruebas) puede sustituirlas con `register*`.
 */
import type { PoolClient } from 'pg'
import * as core from '@llenamos/core'
import type { Scoped } from './contexto.js'

/** Carta del local (V4): lo que necesita una receta y el margen teórico. */
export interface MenuCatalog {
  item(client: PoolClient, scope: Scoped, itemId: string): Promise<core.MenuItem | null>
  items(client: PoolClient, scope: Scoped, itemIds: readonly string[]): Promise<Map<string, core.MenuItem>>
  /** Platos del local (acotado) para elegir al montar una receta. */
  list(client: PoolClient, scope: Scoped, limit: number): Promise<{ id: string; item: core.MenuItem }[]>
}
/** Ventana de una caja (V5) para repartir propinas por horas fichadas. */
export interface CashWindowSource {
  session(client: PoolClient, scope: Scoped, cashSessionId: string): Promise<core.CashSession | null>
}
/** Líneas de pedido (V4) que se descuentan al vender. */
export interface LineSource {
  /** Estado actual de la línea. Debe leerse `FOR SHARE` en la transacción de quien llama: nunca una foto antigua. */
  line(client: PoolClient, scope: Scoped, lineId: string): Promise<core.OrderLine | null>
  /** Líneas puestas desde `since` (ms), paginadas por id, para la reconciliación. */
  recent(client: PoolClient, scope: Scoped, since: number, after: string | null, limit: number): Promise<{ id: string; line: core.OrderLine }[]>
}

const defaultMenu: MenuCatalog = {
  async item(client, scope, itemId) { return (await this.items(client, scope, [itemId])).get(itemId) ?? null },
  async items(client, scope, ids) {
    if (!ids.length) return new Map()
    const rows = (await client.query<{ id: string; doc: unknown }>('SELECT id,doc FROM llenamos.sala_menu_items WHERE restaurant_id=$1 AND location_id=$2 AND id=ANY($3::text[])', [scope.restaurantId, scope.locationId, [...new Set(ids)]])).rows
    return new Map(rows.map(r => [r.id, core.MenuItemSchema.parse(r.doc)]))
  },
  async list(client, scope, limit) {
    const rows = (await client.query<{ id: string; doc: unknown }>('SELECT id,doc FROM llenamos.sala_menu_items WHERE restaurant_id=$1 AND location_id=$2 ORDER BY id LIMIT $3', [scope.restaurantId, scope.locationId, limit])).rows
    return rows.map(r => ({ id: r.id, item: core.MenuItemSchema.parse(r.doc) }))
  },
}
const defaultCash: CashWindowSource = {
  async session(client, scope, id) {
    const row = (await client.query<{ data: unknown }>('SELECT data FROM llenamos.pos_cash_sessions WHERE restaurant_id=$1 AND location_id=$2 AND id=$3', [scope.restaurantId, scope.locationId, id])).rows[0]
    return row ? core.CashSessionSchema.parse(row.data) : null
  },
}
const defaultLines: LineSource = {
  async line(client, scope, id) {
    const row = (await client.query<{ doc: unknown }>('SELECT doc FROM llenamos.sala_order_lines WHERE restaurant_id=$1 AND location_id=$2 AND id=$3 FOR SHARE', [scope.restaurantId, scope.locationId, id])).rows[0]
    return row ? core.OrderLineSchema.parse(row.doc) : null
  },
  async recent(client, scope, since, after, limit) {
    const rows = (await client.query<{ id: string; doc: unknown }>(
      `SELECT id,doc FROM llenamos.sala_order_lines WHERE restaurant_id=$1 AND location_id=$2 AND (doc->>'placedAt')::bigint>=$3 AND ($4::text IS NULL OR id>$4) ORDER BY id LIMIT $5`,
      [scope.restaurantId, scope.locationId, since, after, limit])).rows
    return rows.map(r => ({ id: r.id, line: core.OrderLineSchema.parse(r.doc) }))
  },
}

let menu: MenuCatalog = defaultMenu, cash: CashWindowSource = defaultCash, lines: LineSource = defaultLines
export const registerMenuCatalog = (next: MenuCatalog | null) => { menu = next ?? defaultMenu }
export const registerCashWindowSource = (next: CashWindowSource | null) => { cash = next ?? defaultCash }
export const registerLineSource = (next: LineSource | null) => { lines = next ?? defaultLines }
export const menuCatalog = () => menu
export const cashWindowSource = () => cash
export const lineSource = () => lines
