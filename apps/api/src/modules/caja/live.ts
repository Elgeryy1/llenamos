import { z } from 'zod'
import type { PoolClient } from 'pg'
import * as core from '@llenamos/core'
import { ApiError } from '../../errors.js'
import type { LiveQuery } from '../types.js'

const Scope = z.strictObject({ restaurantId: core.DocIdSchema, locationId: core.DocIdSchema })
const withId = <T extends z.ZodRawShape>(schema: z.ZodObject<T>) => schema.extend({ id: core.DocIdSchema })
const roles = (permission: core.Permission) => core.ROLES.filter(role => core.can(role, permission))
type Input = z.infer<typeof Scope>

/** Mismo contrato que la operación: miembro activo, permiso, módulo `pos` y acceso al local. */
async function allow(client: PoolClient, uid: string, input: Input, permission: core.Permission, floor: boolean) {
  const m = (await client.query<{ role: core.Role; active: boolean; location_ids: string[] }>('SELECT role,active,location_ids FROM llenamos.memberships WHERE restaurant_id=$1 AND uid=$2', [input.restaurantId, uid])).rows[0]
  if (!m?.active || !core.can(m.role, permission) || (m.location_ids.length && !m.location_ids.includes(input.locationId))) throw new ApiError(403, 'permission-denied', 'No tienes permiso para esta lectura en este local.')
  const r = (await client.query('SELECT plan,active_modules,module_overrides,entitlement_version,access_valid_until FROM llenamos.restaurants WHERE id=$1', [input.restaurantId])).rows[0]
  const modules = { plan: r?.plan, moduleOverrides: r?.module_overrides, activeModules: r?.active_modules,
    ...(r?.entitlement_version ? { entitlementVersion: r.entitlement_version, accessValidUntil: r.access_valid_until?.getTime() ?? 0 } : {}) }
  if (!r || !core.hasModule(modules, 'pos') || (floor && !core.hasModule(modules, 'floor'))) throw new ApiError(412, 'failed-precondition', 'El módulo necesario está desactivado.')
}
const list = async <T>(client: PoolClient, schema: { parse: (v: unknown) => T }, sql: string, params: unknown[]) =>
  (await client.query<{ id: string; data: unknown }>(sql, params)).rows.map(r => ({ ...schema.parse(r.data), id: r.id }))

function live<I extends z.ZodType<Input>, O extends z.ZodType>(name: string, permission: core.Permission, input: I, output: O, topics: string[], floor: boolean,
  snapshot: (client: PoolClient, input: z.infer<I>) => Promise<z.infer<O>>): LiveQuery {
  return { name, roles: roles(permission), input, output, restaurantId: i => (i as Input).restaurantId, topics: () => topics,
    snapshot: async (client, raw, context) => { const i = input.parse(raw) as z.infer<I>; await allow(client, context.uid, i, permission, floor); return output.parse(await snapshot(client, i)) } }
}
const Limit = (max: number, fallback: number) => z.number().int().min(1).max(max).default(fallback)
const BillRow = withId(core.BillSchema)

export const cajaLiveQueries: LiveQuery[] = [
  live('cajaCuentas', 'caja.ver', Scope, z.object({ bills: z.array(BillRow) }), ['caja.cuenta'], true,
    async (c, i) => ({ bills: await list(c, core.BillSchema, 'SELECT id,data FROM llenamos.pos_bills WHERE restaurant_id=$1 AND location_id=$2 AND status IN (\'open\',\'locked\') ORDER BY opened_at DESC LIMIT 200', [i.restaurantId, i.locationId]) })),
  live('cajaCuenta', 'caja.ver', Scope.extend({ billId: core.DocIdSchema }), z.object({ bill: BillRow.nullable(), parts: z.array(withId(core.BillPartSchema)), payments: z.array(withId(core.PaymentSchema)) }), ['caja.cuenta', 'caja.cobro'], true,
    async (c, i) => ({
      bill: (await list(c, core.BillSchema, 'SELECT id,data FROM llenamos.pos_bills WHERE restaurant_id=$1 AND location_id=$2 AND id=$3', [i.restaurantId, i.locationId, i.billId]))[0] ?? null,
      parts: await list(c, core.BillPartSchema, 'SELECT id,data FROM llenamos.pos_bill_parts WHERE restaurant_id=$1 AND location_id=$2 AND bill_id=$3 ORDER BY id', [i.restaurantId, i.locationId, i.billId]),
      payments: await list(c, core.PaymentSchema, 'SELECT id,data FROM llenamos.pos_payments WHERE restaurant_id=$1 AND location_id=$2 AND bill_id=$3 ORDER BY at,id', [i.restaurantId, i.locationId, i.billId]) })),
  live('cajaTurnos', 'caja.gestionar', Scope.extend({ limit: Limit(50, 30) }), z.object({ sessions: z.array(withId(core.CashSessionSchema)) }), ['caja.turno'], false,
    async (c, i) => ({ sessions: await list(c, core.CashSessionSchema, 'SELECT id,data FROM llenamos.pos_cash_sessions WHERE restaurant_id=$1 AND location_id=$2 ORDER BY opened_at DESC LIMIT $3', [i.restaurantId, i.locationId, i.limit]) })),
  live('cajaTurno', 'caja.gestionar', Scope.extend({ cashSessionId: core.DocIdSchema }),
    z.object({ payments: z.array(withId(core.PaymentSchema)), movements: z.array(withId(core.CashMovementSchema)), distributions: z.array(withId(core.TipDistributionSchema)) }), ['caja.turno', 'caja.cobro'], false,
    async (c, i) => ({
      payments: await list(c, core.PaymentSchema, 'SELECT id,data FROM llenamos.pos_payments WHERE restaurant_id=$1 AND location_id=$2 AND cash_session_id=$3 ORDER BY at,id LIMIT 2000', [i.restaurantId, i.locationId, i.cashSessionId]),
      movements: await list(c, core.CashMovementSchema, 'SELECT id,data FROM llenamos.pos_cash_movements WHERE restaurant_id=$1 AND location_id=$2 AND cash_session_id=$3 ORDER BY id LIMIT 1000', [i.restaurantId, i.locationId, i.cashSessionId]),
      distributions: await list(c, core.TipDistributionSchema, 'SELECT id,data FROM llenamos.pos_tip_distributions WHERE restaurant_id=$1 AND location_id=$2 AND cash_session_id=$3', [i.restaurantId, i.locationId, i.cashSessionId]) })),
  live('cajaHistorial', 'caja.ver', Scope.extend({ limit: Limit(100, 30) }), z.object({ payments: z.array(withId(core.PaymentSchema)), invoices: z.array(withId(core.InvoiceSchema)) }), ['caja.cobro', 'caja.factura'], false,
    async (c, i) => ({
      payments: await list(c, core.PaymentSchema, 'SELECT id,data FROM llenamos.pos_payments WHERE restaurant_id=$1 AND location_id=$2 ORDER BY at DESC,id LIMIT $3', [i.restaurantId, i.locationId, i.limit]),
      invoices: await list(c, core.InvoiceSchema, 'SELECT id,data FROM llenamos.pos_invoices WHERE restaurant_id=$1 AND location_id=$2 ORDER BY created_at DESC,id LIMIT $3', [i.restaurantId, i.locationId, i.limit]) })),
  live('cajaImpresion', 'caja.ver', Scope.extend({ sourceId: core.DocIdSchema.nullable().default(null), limit: Limit(100, 40) }),
    z.object({ statuses: z.array(withId(core.PrintStatusSchema)) }), ['caja.impresion'], false,
    async (c, i) => ({
      statuses: (await c.query<{ id: string; printer_id: string; source_id: string; kind: string; status: string; attempts: number; last_error: string | null }>(
        `SELECT id,printer_id,source_id,kind,status,attempts,last_error FROM llenamos.pos_print_statuses WHERE restaurant_id=$1 AND location_id=$2 AND ($3::text IS NULL OR source_id=$3) ORDER BY updated_at DESC,id LIMIT $4`, [i.restaurantId, i.locationId, i.sourceId, i.limit]))
        .rows.map(r => ({ id: r.id, printerId: r.printer_id, sourceId: r.source_id, kind: r.kind as 'invoice', status: r.status as 'queued', attempts: r.attempts, lastError: r.last_error })) })),
  // Impresoras (con su puente) solo para quien gestiona la impresión; incluye las inactivas para poder reactivarlas.
  live('cajaImpresoras', 'impresion.gestionar', Scope, z.object({ printers: z.array(withId(core.PrinterSchema)) }), ['caja.impresion'], false,
    async (c, i) => ({ printers: await list(c, core.PrinterSchema, 'SELECT id,data FROM llenamos.pos_printers WHERE restaurant_id=$1 AND location_id=$2 ORDER BY id', [i.restaurantId, i.locationId]) })),
  live('cajaRevisiones', 'caja.rectificar', Scope.extend({ limit: Limit(100, 50) }),
    z.object({ reviews: z.array(z.object({ id: z.string(), paymentId: z.string(), billId: z.string(), partId: z.string(), amountCents: z.number().int(), reason: z.string(), status: z.enum(['requires_fiscal_correction', 'corrected']) })) }), ['caja.devolucion', 'caja.factura'], false,
    async (c, i) => ({ reviews: (await c.query<{ id: string; payment_id: string; bill_id: string; part_id: string; amount_cents: string; reason: string; status: 'corrected' }>(
      'SELECT id,payment_id,bill_id,part_id,amount_cents,reason,status FROM llenamos.pos_refund_reviews WHERE restaurant_id=$1 AND location_id=$2 ORDER BY (status=\'requires_fiscal_correction\') DESC,created_at DESC LIMIT $3', [i.restaurantId, i.locationId, i.limit]))
      .rows.map(r => ({ id: r.id, paymentId: r.payment_id, billId: r.bill_id, partId: r.part_id, amountCents: Number(r.amount_cents), reason: r.reason, status: r.status })) })),
  // Cobros móviles que necesitan revisión de una persona (cobro con Stripe que no cuadra con la caja).
  live('cajaIncidencias', 'caja.gestionar', Scope.extend({ limit: Limit(50, 30) }),
    z.object({ incidents: z.array(z.object({ id: z.string(), summary: z.string(), status: z.string() })) }), ['caja.movil'], false,
    async (c, i) => ({ incidents: (await c.query<{ id: string; summary: string; status: string }>(
      "SELECT id,summary,status FROM llenamos.pos_mobile_incidents WHERE restaurant_id=$1 AND location_id=$2 AND status='open' ORDER BY created_at DESC LIMIT $3", [i.restaurantId, i.locationId, i.limit])).rows })),
  // Equipo activo del local para repartir propinas. Los miembros cambian desde plataforma (sin evento de caja): se relee cada minuto.
  { ...live('cajaEquipo', 'caja.gestionar', Scope, z.object({ members: z.array(z.object({ id: z.string(), displayName: z.string() })) }), ['caja.turno'], false,
    async (c, i) => ({ members: (await c.query<{ uid: string; display_name: string }>(
      "SELECT uid,display_name FROM llenamos.memberships WHERE restaurant_id=$1 AND active AND (cardinality(location_ids)=0 OR $2=ANY(location_ids)) ORDER BY display_name,uid LIMIT 500", [i.restaurantId, i.locationId])).rows
      .map(r => ({ id: r.uid, displayName: r.display_name })) })), refreshMs: 60_000 },
]
