import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import * as core from '@llenamos/core'
import { ApiError } from '../../errors.js'
import { emitEvent } from '../../events.js'

export function fail(message: string): never { throw new ApiError(412, 'failed-precondition', message) }
export function notFound(message = 'No se encuentra el documento en este local.'): never { throw new ApiError(404, 'not-found', message) }
export function deny(message = 'No tienes permiso para esta operación en este local.'): never { throw new ApiError(403, 'permission-denied', message) }
/** JSON con claves ordenadas (admite null, a diferencia de `canonicalJson`): la misma carga da el mismo hash. */
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, stable(v)])) : value
export const sha = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(stable(value))).digest('hex')
export const newId = () => randomUUID().replaceAll('-', '')
export type Name = keyof typeof core.CALLABLES_FASE3
export type Scope = { restaurantId: string; locationId: string }

/** Roles con el permiso que exige cada operación; el servidor los comprueba antes de abrir el handler. */
export const rolesFor = (name: Name): readonly string[] => {
  const permission = core.FASE3_ACCESS[name].permission
  return core.ROLES.filter(role => core.can(role, permission as core.Permission))
}

export interface Pos {
  client: PoolClient
  rid: string
  lid: string
  uid: string
  now: number
  restaurant: { timezone: string; isDemo: boolean }
  settings: core.PosSettings | null
}

/**
 * Abre el contexto de un local dentro de la transacción de la petición. El cerrojo consultivo por
 * local serializa todas las operaciones de caja del local: sustituye a `reservationLocks/current`
 * y garantiza que saldo, cierre, correlativo y cadena fiscal se leen y escriben sin carreras.
 */
export async function openPos(client: PoolClient, uid: string, name: Name, scope: Scope): Promise<Pos> {
  const access = core.FASE3_ACCESS[name]
  const member = (await client.query<{ role: core.Role; active: boolean; location_ids: string[]; display_name: string }>(
    'SELECT role,active,location_ids,display_name FROM llenamos.memberships WHERE restaurant_id=$1 AND uid=$2', [scope.restaurantId, uid])).rows[0]
  if (!member?.active || (member.location_ids.length && !member.location_ids.includes(scope.locationId)) || !core.can(member.role, access.permission as core.Permission)) deny()
  return loadPos(client, uid, scope, access.modules)
}
/**
 * Contexto de sistema para hechos ya ocurridos fuera de la caja (un pago confirmado por el proveedor): mismos cerrojos y
 * comprobaciones del local, sin miembro. Solo lo usa el worker, tras verificar el evento firmado del restaurante.
 */
export const openSystemPos = (client: PoolClient, actor: string, scope: Scope, modules: readonly core.Module[] = ['pos']) => loadPos(client, actor, scope, modules)

async function loadPos(client: PoolClient, uid: string, scope: Scope, required: readonly core.Module[]): Promise<Pos> {
  const restaurant = (await client.query('SELECT plan,active_modules,module_overrides,entitlement_version,access_valid_until,timezone,is_demo FROM llenamos.restaurants WHERE id=$1', [scope.restaurantId])).rows[0]
  const location = (await client.query('SELECT 1 FROM llenamos.locations WHERE restaurant_id=$1 AND id=$2', [scope.restaurantId, scope.locationId])).rows[0]
  if (!restaurant || !location) notFound('No se encuentra el restaurante o el local.')
  const modules = { plan: restaurant.plan, moduleOverrides: restaurant.module_overrides, activeModules: restaurant.active_modules,
    ...(restaurant.entitlement_version ? { entitlementVersion: restaurant.entitlement_version, accessValidUntil: restaurant.access_valid_until?.getTime() ?? 0 } : {}) }
  if (required.some(module => !core.hasModule(modules, module))) fail('El módulo necesario está desactivado.')
  // Orden de bloqueos único: reservas, sala y caja. Los dos primeros en compartido: sala (que escribe pedidos con su
  // cerrojo exclusivo) no puede añadir consumo a una cuenta que esta operación está bloqueando, ni al revés, y la señal
  // (que lee la reserva) no se cruza con sentar o terminar reservas.
  for (const lock of ['reservas', 'sala']) await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [`${lock}:${scope.restaurantId}:${scope.locationId}`])
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`pos:${scope.restaurantId}:${scope.locationId}`])
  const settings = (await client.query('SELECT settings FROM llenamos.pos_settings WHERE restaurant_id=$1 AND location_id=$2', [scope.restaurantId, scope.locationId])).rows[0]
  return { client, rid: scope.restaurantId, lid: scope.locationId, uid, now: Date.now(), restaurant: { timezone: restaurant.timezone, isDemo: restaurant.is_demo },
    settings: settings ? core.PosSettingsSchema.parse(settings.settings) : null }
}

/** Evento de dominio sin datos personales ni importes: solo lo necesario para refrescar. */
export const event = (pos: Pos, topic: string, entityId: string | null) =>
  emitEvent(pos.client, { restaurantId: pos.rid, locationId: pos.lid, topic, entityId })

const ts = (ms: number | null) => (ms === null ? null : new Date(ms))
export { ts }

// ---- Lecturas acotadas: siempre por clave o por cuenta/caja, nunca el histórico completo. ----
type Row = { data: unknown }
const rows = async <T>(pos: Pos, sql: string, params: unknown[], schema: { parse: (v: unknown) => T }) =>
  (await pos.client.query<Row & { id: string }>(sql, [pos.rid, pos.lid, ...params])).rows.map(r => ({ ...schema.parse(r.data), id: r.id }))

export async function getBill(pos: Pos, id: string, forUpdate = false) {
  const row = (await pos.client.query<Row & { revision: number; status: string }>(
    `SELECT data FROM llenamos.pos_bills WHERE restaurant_id=$1 AND location_id=$2 AND id=$3${forUpdate ? ' FOR UPDATE' : ''}`, [pos.rid, pos.lid, id])).rows[0]
  if (!row) return notFound()
  return core.BillSchema.parse(row.data)
}
export async function putBill(pos: Pos, id: string, bill: core.Bill) {
  const parsed = core.BillSchema.parse(bill)
  await pos.client.query(
    `INSERT INTO llenamos.pos_bills(restaurant_id,location_id,id,target_kind,target_id,status,revision,opened_at,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT(restaurant_id,location_id,id) DO UPDATE SET status=EXCLUDED.status,revision=EXCLUDED.revision,data=EXCLUDED.data`,
    [pos.rid, pos.lid, id, parsed.target.kind, parsed.target.id, parsed.status, parsed.revision, new Date(parsed.openedAt), parsed])
  await event(pos, 'caja.cuenta', id)
  return parsed
}
export const getParts = (pos: Pos, billId: string) =>
  rows(pos, 'SELECT id,data FROM llenamos.pos_bill_parts WHERE restaurant_id=$1 AND location_id=$2 AND bill_id=$3 ORDER BY id', [billId], core.BillPartSchema)
export async function getPart(pos: Pos, id: string) {
  const row = (await pos.client.query<Row>('SELECT data FROM llenamos.pos_bill_parts WHERE restaurant_id=$1 AND location_id=$2 AND id=$3 FOR UPDATE', [pos.rid, pos.lid, id])).rows[0]
  if (!row) return notFound()
  return core.BillPartSchema.parse(row.data)
}
export async function putPart(pos: Pos, id: string, part: core.BillPart) {
  const parsed = core.BillPartSchema.parse(part)
  await pos.client.query(
    `INSERT INTO llenamos.pos_bill_parts(restaurant_id,location_id,id,bill_id,data) VALUES($1,$2,$3,$4,$5)
     ON CONFLICT(restaurant_id,location_id,id) DO UPDATE SET data=EXCLUDED.data`, [pos.rid, pos.lid, id, parsed.billId, parsed])
  await event(pos, 'caja.cuenta', parsed.billId)
}
export async function getCash(pos: Pos, id: string) {
  const row = (await pos.client.query<Row>('SELECT data FROM llenamos.pos_cash_sessions WHERE restaurant_id=$1 AND location_id=$2 AND id=$3', [pos.rid, pos.lid, id])).rows[0]
  if (!row) return notFound()
  return core.CashSessionSchema.parse(row.data)
}
export async function cashOpen(pos: Pos, id: string) {
  const cash = await getCash(pos, id)
  if (cash.status !== 'open') fail('Abre una caja antes de registrar el movimiento.')
  return cash
}
export async function putCash(pos: Pos, id: string, cash: core.CashSession) {
  const parsed = core.CashSessionSchema.parse(cash)
  await pos.client.query(
    `INSERT INTO llenamos.pos_cash_sessions(restaurant_id,location_id,id,register_id,status,opened_at,data) VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT(restaurant_id,location_id,id) DO UPDATE SET status=EXCLUDED.status,data=EXCLUDED.data`,
    [pos.rid, pos.lid, id, parsed.registerId, parsed.status, new Date(parsed.openedAt), parsed])
  await event(pos, 'caja.turno', id)
}
export const getPayment = async (pos: Pos, id: string) => {
  const row = (await pos.client.query<Row>('SELECT data FROM llenamos.pos_payments WHERE restaurant_id=$1 AND location_id=$2 AND id=$3', [pos.rid, pos.lid, id])).rows[0]
  if (!row) return notFound()
  return core.PaymentSchema.parse(row.data)
}
export const paymentsOf = (pos: Pos, column: 'bill_id' | 'cash_session_id' | 'original_payment_id', id: string) =>
  rows(pos, `SELECT id,data FROM llenamos.pos_payments WHERE restaurant_id=$1 AND location_id=$2 AND ${column}=$3 ORDER BY at,id`, [id], core.PaymentSchema)
export async function putPayment(pos: Pos, id: string, payment: core.Payment) {
  const p = core.PaymentSchema.parse(payment)
  await pos.client.query(
    `INSERT INTO llenamos.pos_payments(restaurant_id,location_id,id,bill_id,part_id,cash_session_id,original_payment_id,kind,status,method,external_id,at,data)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [pos.rid, pos.lid, id, p.billId, p.partId, p.cashSessionId, p.originalPaymentId, p.kind, p.status, p.method, p.externalId, new Date(p.at), p])
}
export const movementsOf = (pos: Pos, cashSessionId: string) =>
  rows(pos, 'SELECT id,data FROM llenamos.pos_cash_movements WHERE restaurant_id=$1 AND location_id=$2 AND cash_session_id=$3 ORDER BY id', [cashSessionId], core.CashMovementSchema)

// ---- Idempotencia por local, actor, operación y requestId. ----
export async function replay<T>(pos: Pos, name: string, requestId: string, input: unknown, output: { parse: (v: unknown) => T }): Promise<{ value: T } | null> {
  const key = `${pos.lid}:${requestId}`
  const old = (await pos.client.query<{ request_hash: string; result: unknown }>(
    'SELECT request_hash,result FROM llenamos.idempotency WHERE restaurant_id=$1 AND actor_uid=$2 AND operation=$3 AND request_key=$4', [pos.rid, pos.uid, name, key])).rows[0]
  if (!old) return null
  if (old.request_hash !== sha(input)) throw new ApiError(409, 'already-exists', 'Esta petición ya se usó con otros datos.')
  return { value: output.parse(old.result) }
}
export async function remember(pos: Pos, name: string, requestId: string, input: unknown, result: unknown) {
  await pos.client.query('INSERT INTO llenamos.idempotency(restaurant_id,actor_uid,operation,request_key,request_hash,result) VALUES($1,$2,$3,$4,$5,$6)',
    [pos.rid, pos.uid, name, `${pos.lid}:${requestId}`, sha(input), result])
}

/** Cuenta con revisión esperada: evita actuar sobre una pantalla desfasada. */
export async function account(pos: Pos, d: { billId: string; expectedRevision: number }) {
  const bill = await getBill(pos, d.billId, true)
  if (bill.revision !== d.expectedRevision) fail('La cuenta ha cambiado. Recarga antes de continuar.')
  return bill
}

/** Saldo reservado por intentos de pago móvil en curso de una parte (sustituye a `paymentReservations`). `own` excluye el cobro que se confirma. */
export async function reservedByMobile(pos: Pos, partId: string, own: string | null = null) {
  const { rows } = await pos.client.query<{ n: string }>(
    `SELECT coalesce(sum(amount_cents),0) AS n FROM llenamos.pos_mobile_checkouts WHERE restaurant_id=$1 AND location_id=$2 AND part_id=$3 AND status='pending' AND start_request IS NOT NULL AND ($4::text IS NULL OR id<>$4)`, [pos.rid, pos.lid, partId, own])
  return Number(rows[0]!.n)
}
/** ¿Algún intento de pago móvil sigue vivo en la cuenta? Impide dividir, desbloquear o dar la cuenta por saldada. */
export async function mobileInFlight(pos: Pos, billId: string, own: string | null = null) {
  return !!(await pos.client.query(
    `SELECT 1 FROM llenamos.pos_mobile_checkouts WHERE restaurant_id=$1 AND location_id=$2 AND bill_id=$3 AND status='pending' AND start_request IS NOT NULL AND ($4::text IS NULL OR id<>$4) LIMIT 1`, [pos.rid, pos.lid, billId, own])).rowCount
}
