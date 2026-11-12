import type { Input } from './context'
import { randomBytes } from 'node:crypto'
import { Timestamp } from 'firebase-admin/firestore'
import * as core from '@llenamos/core'
import { type Context, get, newId, fail, denied } from './context'
import { tokenMatches } from './public'

export function guardarCategoriaCarta(c: Context, d: Input<'guardarCategoriaCarta'>) {
  const id = d.categoryId ?? newId(c, 'menuCategories')
  if (d.categoryId) get(c, 'menuCategories', id)
  c.put('menuCategories', { ...d.category, id }, !d.categoryId)
  return { ok: true, categoryId: id }
}
export function guardarPlato(c: Context, d: Input<'guardarPlato'>) {
  const id = d.itemId ?? newId(c, 'menuItems')
  const old = d.itemId ? get(c, 'menuItems', id) : null
  get(c, 'menuCategories', d.item.categoryId)
  if (d.item.stationId) get(c, 'stations', d.item.stationId)
  if (d.item.photoPath && !d.item.photoPath.startsWith(`${c.local.path}/menu/${id}/`)) fail('La foto debe pertenecer a este plato y local.')
  const version = core.nextItemVersion(old, d.item)
  c.put('menuItems', { ...d.item, id, soldOut: old?.soldOut ?? false, ...(old?.portions !== undefined ? { portions: old.portions } : {}), version }, !old)
  return { ok: true, itemId: id, version, priceChanged: !!old && old.version !== version }
}
export function guardarMenuDia(c: Context, d: Input<'guardarMenuDia'>) {
  const id = d.dailyMenuId ?? newId(c, 'dailyMenus')
  const old = d.dailyMenuId ? get(c, 'dailyMenus', id) : null
  for (const section of d.menu.sections) for (const choice of section.choices) {
    const item = get(c, 'menuItems', choice.itemId)
    if (choice.variantId && !item.variants.some(v => v.id === choice.variantId)) fail('La variante no pertenece al plato del menú.')
  }
  const version = core.nextDailyMenuVersion(old, d.menu)
  c.put('dailyMenus', { ...d.menu, id, version }, !old)
  return { ok: true, dailyMenuId: id, version, priceChanged: !!old && old.version !== version }
}
export function ordenarCarta(c: Context, d: Input<'ordenarCarta'>) {
  for (const row of d.categories ?? []) c.put('menuCategories', { ...get(c, 'menuCategories', row.id), sortOrder: row.sortOrder })
  for (const row of d.items ?? []) {
    get(c, 'menuCategories', row.categoryId)
    c.put('menuItems', { ...get(c, 'menuItems', row.id), categoryId: row.categoryId, sortOrder: row.sortOrder })
  }
  return { ok: true }
}
export function marcarAgotado(c: Context, d: Input<'marcarAgotado'>) {
  const item = get(c, 'menuItems', d.itemId)
  if (c.actor?.role === 'kitchen' || c.actor?.role === 'bar') {
    const station = core.resolveStation(item.stationId, Object.fromEntries(c.rows.stations), c.settings.defaultStationId)
    if (!station || station.station.kind !== c.actor.role) denied()
  }
  if (d.variantId) {
    if (!item.variants.some(v => v.id === d.variantId)) fail('La variante no pertenece a este plato.')
    c.put('menuItems', { ...item, variants: item.variants.map(v => v.id === d.variantId ? { ...v, soldOut: d.soldOut } : v) })
  } else if (d.optionId) {
    if (!item.modifierGroups.some(g => g.options.some(o => o.id === d.optionId))) fail('El extra no pertenece a este plato.')
    c.put('menuItems', { ...item, modifierGroups: item.modifierGroups.map(g => ({ ...g, options: g.options.map(o => o.id === d.optionId ? { ...o, soldOut: d.soldOut } : o) })) })
  } else {
    if (!d.soldOut && item.portions && (item.portions.date !== core.horaLocal(c.now, c.reservationSettings.timezone).fecha || item.portions.remaining === 0)) fail('Guarda primero un recuento de hoy con raciones disponibles.')
    c.put('menuItems', { ...item, soldOut: d.soldOut })
  }
  return { ok: true, soldOut: d.soldOut }
}
export function guardarEstacion(c: Context, d: Input<'guardarEstacion'>) {
  const id = d.stationId ?? newId(c, 'stations')
  if (d.stationId) get(c, 'stations', id)
  c.put('stations', { ...d.station, id }, !d.stationId)
  return { ok: true, stationId: id }
}
export function guardarConfiguracionSala(c: Context, d: Input<'guardarConfiguracionSala'>) {
  if (d.settings.defaultStationId) get(c, 'stations', d.settings.defaultStationId)
  c.settings = d.settings
  c.stage(`${c.local.path}/settings/floor`, d.settings, !c.floorExists)
  return { ok: true }
}
export function regenerarQrMesa(c: Context, d: Input<'regenerarQrMesa'>) {
  const tokens = d.tableIds.map(tableId => {
    if (!get(c, 'tables', tableId).enabled) fail('La mesa está desactivada.')
    const token = core.linkToken(randomBytes(32))
    c.secret('tableTokens', tableId, { tokenHash: core.sha256Hex(token), tokenSecret: token, revokedAt: null, rotatedAt: Timestamp.fromMillis(c.now) })
    return { tableId, token, path: core.tableQrPath(c.restaurant.slug, c.lid, tableId, token) }
  })
  return { tokens }
}

/** No se infieren raciones nuevas de la fecha: el primer recuento del día abre otro lote. */
export function guardarRaciones(c: Context, d: Input<'guardarRaciones'>) {
  const item = get(c, 'menuItems', d.itemId)
  if (c.actor?.role === 'kitchen' || c.actor?.role === 'bar') {
    const station = core.resolveStation(item.stationId, Object.fromEntries(c.rows.stations), c.settings.defaultStationId)
    if (!station || station.station.kind !== c.actor.role) denied()
  }
  if (d.variantId && !item.variants.some(v => v.id === d.variantId)) fail('La variante no pertenece al plato.')
  const date = core.horaLocal(c.now, c.reservationSettings.timezone).fecha
  const old = item.portions?.date === date ? item.portions : { date, remaining: item.portions?.remaining === null || item.portions?.remaining === undefined ? null : 0, variants: Object.fromEntries(Object.keys(item.portions?.variants ?? {}).map(v => [v, 0])) }
  const variants = { ...old.variants }
  if (d.variantId) {
    if (d.remaining === null) delete variants[d.variantId]
    else variants[d.variantId] = d.remaining
  }
  const remaining = d.variantId ? old.remaining : d.remaining
  c.put('menuItems', { ...item, portions: remaining === null && !Object.keys(variants).length ? null : { date, remaining, variants },
    soldOut: remaining === 0 || (d.variantId ? item.soldOut : false) })
  return { ok: true }
}
/** El secreto queda bajo custodia del servidor, sin lectura directa de cliente. */
export function recuperarQrMesa(c: Context, d: Input<'recuperarQrMesa'>) {
  const tokens: core.CallableOutput<'regenerarQrMesa'>['tokens'] = []
  const unavailable: core.CallableOutput<'recuperarQrMesa'>['unavailable'] = []
  for (const tableId of d.tableIds) {
    get(c, 'tables', tableId)
    const row = c.privateRows.tableTokens.get(tableId)
    if (!row || row.revokedAt || !row.tokenSecret) {
      unavailable.push({ tableId, reason: !row ? 'missing' : row.revokedAt ? 'revoked' : 'legacy' })
      continue
    }
    if (!tokenMatches(row.tokenHash, row.tokenSecret)) fail('El secreto guardado no coincide con el QR vigente.')
    tokens.push({ tableId, token: row.tokenSecret, path: core.tableQrPath(c.restaurant.slug, c.lid, tableId, row.tokenSecret) })
  }
  return { tokens, unavailable }
}
export function revocarQrMesa(c: Context, d: Input<'revocarQrMesa'>) {
  for (const tableId of d.tableIds) {
    get(c, 'tables', tableId)
    const row = c.privateRows.tableTokens.get(tableId)
    if (row) c.secret('tableTokens', tableId, { ...row, tokenHash: null, tokenSecret: null, revokedAt: Timestamp.fromMillis(c.now) })
  }
  return { ok: true }
}
export function importarQrMesa(c: Context, d: Input<'importarQrMesa'>) {
  get(c, 'tables', d.tableId)
  const row = c.privateRows.tableTokens.get(d.tableId)
  if (!row || row.revokedAt || !tokenMatches(row.tokenHash, d.token)) fail('El enlace no coincide con el QR vigente de esta mesa.')
  c.secret('tableTokens', d.tableId, { ...row, tokenSecret: d.token })
  return { tokens: [{ tableId: d.tableId, token: d.token, path: core.tableQrPath(c.restaurant.slug, c.lid, d.tableId, d.token) }] }
}
