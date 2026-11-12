import type { PoolClient } from 'pg'
import type { z } from 'zod'
import * as core from '@llenamos/core'
import { ApiError } from '../../errors.js'
import { assertLocation, denied, memberOperation, type Scope } from '../comun/acceso.js'
import { failed, hashId, notFound, notify, restaurantTimezone, revisionConflict } from './util.js'
import { bills, now, type BillView } from './ports.js'

const S = core.CALLABLE_SCHEMAS_FASE5_FIDELIZACION
type In<N extends keyof typeof S> = z.output<(typeof S)[N]['input']>
type Out<N extends keyof typeof S> = z.output<(typeof S)[N]['output']>
/** Tope de promociones activas que se evalúan sobre una cuenta. */
export const MAX_ACTIVE_PROMOTIONS = 200

/**
 * Una promoción sin locales vale para todos: solo quien no tiene locales limitados la toca. Las demás, solo si TODOS sus locales
 * (los de ahora y los que tenía antes de editarla) están dentro del alcance de quien opera.
 */
export async function assertPromotionScope(client: PoolClient, rid: string, scope: Scope, locationIds: readonly string[]) {
  if (!locationIds.length) { if (scope.locationIds.length) throw denied(); return }
  for (const lid of locationIds) await assertLocation(client, rid, scope, lid)
}
/** Condición SQL equivalente para listados: `$n` es el alcance de locales de quien consulta (vacío = todos). */
export const promotionInScopeSql = (param: number) => `(cardinality($${param}::text[])=0 OR (jsonb_array_length(definition->'locationIds')>0
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(definition->'locationIds') l WHERE l<>ALL($${param}::text[]))))`

const promotionOf = (r: any): core.PromotionWithId => ({ ...core.PromotionSchema.parse({ ...r.definition, status: r.status, uses: r.uses, revision: r.revision }), id: r.id as string })
export const promotionRow = promotionOf

export const guardarPromocion = memberOperation('guardarPromocion', {
  permission: 'promociones.gestionar', modules: ['loyalty'], input: S.guardarPromocion.input as z.ZodType<In<'guardarPromocion'>>, output: S.guardarPromocion.output as z.ZodType<Out<'guardarPromocion'>>,
  run: async (client, d, scope) => {
    const rid = d.restaurantId
    let old: any = null
    if (d.promotionId) {
      old = (await client.query('SELECT * FROM llenamos.promotions WHERE restaurant_id=$1 AND id=$2 FOR UPDATE', [rid, d.promotionId])).rows[0]
      if (!old) throw notFound()
      if (old.revision !== d.expectedRevision) throw revisionConflict()
      if (old.status === 'archived') throw failed('La promoción está archivada.')
    } else if (d.expectedRevision !== null) throw failed('La promoción no existe.')
    if (old) await assertPromotionScope(client, rid, scope, old.definition.locationIds as string[])
    if (scope.locationIds.length && !d.promotion.locationIds.length) throw failed('Elige los locales de la promoción.')
    await assertPromotionScope(client, rid, scope, d.promotion.locationIds)
    const revision = (old?.revision ?? 0) + 1
    const id = d.promotionId ?? hashId(scope.uid, d.requestId, 'promocion').slice(0, 20)
    if (old) await client.query('UPDATE llenamos.promotions SET definition=$3,revision=$4,updated_at=now() WHERE restaurant_id=$1 AND id=$2', [rid, id, JSON.stringify(d.promotion), revision])
    else await client.query("INSERT INTO llenamos.promotions(restaurant_id,id,definition,status,revision) VALUES($1,$2,$3,'draft',1)", [rid, id, JSON.stringify(d.promotion)])
    await notify(client, rid, 'fidelizacion.promocion', id)
    return { promotionId: id, revision, status: (old?.status ?? 'draft') as core.PromotionStatus }
  },
})

export const cambiarEstadoPromocion = memberOperation('cambiarEstadoPromocion', {
  permission: 'promociones.gestionar', modules: ['loyalty'], input: S.cambiarEstadoPromocion.input as z.ZodType<In<'cambiarEstadoPromocion'>>, output: S.cambiarEstadoPromocion.output as z.ZodType<Out<'cambiarEstadoPromocion'>>,
  run: async (client, d, scope) => {
    const rid = d.restaurantId
    const row = (await client.query('SELECT * FROM llenamos.promotions WHERE restaurant_id=$1 AND id=$2 FOR UPDATE', [rid, d.promotionId])).rows[0]
    if (!row) throw notFound()
    if (row.revision !== d.expectedRevision) throw revisionConflict()
    await assertPromotionScope(client, rid, scope, row.definition.locationIds as string[])
    if (row.status === 'archived') throw failed('La promoción está archivada.')
    await client.query('UPDATE llenamos.promotions SET status=$3,revision=revision+1,updated_at=now() WHERE restaurant_id=$1 AND id=$2', [rid, d.promotionId, d.to])
    await notify(client, rid, 'fidelizacion.promocion', d.promotionId)
    return { status: d.to, revision: row.revision + 1 }
  },
})

async function evaluationContext(client: PoolClient, rid: string, lid: string, bill: BillView, code: string | null) {
  return {
    now: now(), timezone: await restaurantTimezone(client, rid), locationId: lid, channel: bill.channel, customerId: bill.customerId, code,
    lines: bill.lines.map(({ lineId, itemId, categoryId, balanceCents }) => ({ lineId, itemId, categoryId, balanceCents })),
    billBalanceCents: bill.totalCents, hasLoyaltyRedemption: bill.adjustments.some(a => !!a.redemptionId),
  }
}
async function customerUses(client: PoolClient, rid: string, customerId: string | null, ids: string[]): Promise<Map<string, number>> {
  if (!customerId || !ids.length) return new Map()
  const { rows } = await client.query('SELECT promotion_id,uses FROM llenamos.promotion_customer_uses WHERE restaurant_id=$1 AND customer_id=$2 AND promotion_id=ANY($3)', [rid, customerId, ids])
  return new Map(rows.map(r => [r.promotion_id as string, r.uses as number]))
}

export const promocionesAplicables = memberOperation('promocionesAplicables', {
  permission: 'promociones.aplicar', modules: ['loyalty', 'pos'], input: S.promocionesAplicables.input as z.ZodType<In<'promocionesAplicables'>>, output: S.promocionesAplicables.output as z.ZodType<Out<'promocionesAplicables'>>,
  run: async (client, d, scope) => {
    const rid = d.restaurantId
    await assertLocation(client, rid, scope, d.locationId)
    const bill = await bills().openBill(client, { restaurantId: rid, locationId: d.locationId, billId: d.billId, expectedRevision: null })
    const rows = (await client.query("SELECT * FROM llenamos.promotions WHERE restaurant_id=$1 AND status='active' ORDER BY id LIMIT $2", [rid, MAX_ACTIVE_PROMOTIONS + 1])).rows
    // Evaluar solo las primeras 200 daría un «mejor descuento» falso sin avisar: se dice claro.
    if (rows.length > MAX_ACTIVE_PROMOTIONS) throw failed(`Hay más de ${MAX_ACTIVE_PROMOTIONS} promociones activas. Archiva o pausa alguna para poder evaluarlas.`)
    const promotions = rows.map(promotionOf)
    const uses = await customerUses(client, rid, bill.customerId, promotions.map(p => p.id))
    const ctx = await evaluationContext(client, rid, d.locationId, bill, d.code)
    const { best, evaluations } = core.bestPromotion(promotions, ctx, id => ({ total: promotions.find(p => p.id === id)!.uses, byCustomer: uses.get(id) ?? 0 }))
    const name = (id: string) => promotions.find(p => p.id === id)!.name
    return {
      channel: bill.channel,
      best: best ? { promotionId: best.promotionId, name: name(best.promotionId), discountCents: best.discountCents } : null,
      evaluations: evaluations.map(e => ({ promotionId: e.promotionId, name: name(e.promotionId), eligible: e.eligible, discountCents: e.eligible ? e.discountCents : null, reason: e.eligible ? null : e.reason })),
    }
  },
})

export const aplicarPromocion = memberOperation('aplicarPromocion', {
  permission: 'promociones.aplicar', modules: ['loyalty', 'pos'], input: S.aplicarPromocion.input as z.ZodType<In<'aplicarPromocion'>>, output: S.aplicarPromocion.output as z.ZodType<Out<'aplicarPromocion'>>,
  run: async (client, d, scope) => {
    const rid = d.restaurantId
    await assertLocation(client, rid, scope, d.locationId)
    const bill = await bills().openBill(client, { restaurantId: rid, locationId: d.locationId, billId: d.billId, expectedRevision: d.expectedBillRevision })
    const current = (await client.query('SELECT status FROM llenamos.bill_promotions WHERE restaurant_id=$1 AND location_id=$2 AND bill_id=$3 FOR UPDATE', [rid, d.locationId, d.billId])).rows[0]
    if (current?.status === 'applied') throw failed('Quita primero la promoción de esta cuenta.')
    // Bloquear la promoción serializa los cupos (total y por cliente) de todas las cuentas que la usan.
    const row = (await client.query('SELECT * FROM llenamos.promotions WHERE restaurant_id=$1 AND id=$2 FOR UPDATE', [rid, d.promotionId])).rows[0]
    if (!row) throw notFound()
    const promotion = promotionOf(row)
    const own = (await customerUses(client, rid, bill.customerId, [promotion.id])).get(promotion.id) ?? 0
    const ctx = await evaluationContext(client, rid, d.locationId, bill, d.code)
    const evaluation = core.evaluatePromotion(promotion, { ...ctx, usage: { total: promotion.uses, byCustomer: own } })
    if (!evaluation.eligible) return { status: 'rejected' as const, reason: evaluation.reason, message: core.PROMOTION_REJECTION_LABEL[evaluation.reason] }
    const t = ctx.now
    const adjustments = core.discountAdjustments({ lines: bill.lines.filter(l => evaluation.lineIds.includes(l.lineId)), amountCents: evaluation.discountCents, kind: 'promotion', sourceId: promotion.id, reason: promotion.name, at: t, by: scope.uid })
    const next = await bills().replaceAdjustments(client, { restaurantId: rid, locationId: d.locationId, billId: d.billId, expectedRevision: bill.revision, actorUid: scope.uid, adjustments: [...bill.adjustments, ...adjustments] })
    await client.query('UPDATE llenamos.promotions SET uses=uses+1 WHERE restaurant_id=$1 AND id=$2', [rid, promotion.id])
    if (bill.customerId) await client.query(`INSERT INTO llenamos.promotion_customer_uses(restaurant_id,promotion_id,customer_id,uses) VALUES($1,$2,$3,1)
      ON CONFLICT(restaurant_id,promotion_id,customer_id) DO UPDATE SET uses=llenamos.promotion_customer_uses.uses+1`, [rid, promotion.id, bill.customerId])
    const written = await client.query(`INSERT INTO llenamos.bill_promotions(restaurant_id,location_id,bill_id,promotion_id,customer_id,discount_cents,adjustment_ids,status,at_ms,by_uid)
      VALUES($1,$2,$3,$4,$5,$6,$7,'applied',$8,$9)
      ON CONFLICT(restaurant_id,location_id,bill_id) DO UPDATE SET promotion_id=EXCLUDED.promotion_id,customer_id=EXCLUDED.customer_id,discount_cents=EXCLUDED.discount_cents,
        adjustment_ids=EXCLUDED.adjustment_ids,status='applied',at_ms=EXCLUDED.at_ms,by_uid=EXCLUDED.by_uid WHERE llenamos.bill_promotions.status='removed'`,
    [rid, d.locationId, d.billId, promotion.id, bill.customerId, evaluation.discountCents, adjustments.map(a => a.id), t, scope.uid])
    // Dos aplicaciones a la vez sobre la misma cuenta: la segunda no inserta nada (la fila ya está aplicada) y debe fallar entera.
    if (!written.rowCount) throw new ApiError(409, 'aborted', 'Otra persona acaba de aplicar una promoción a esta cuenta. Recarga e inténtalo de nuevo.')
    await notify(client, rid, 'fidelizacion.promocion', promotion.id)
    return { status: 'applied' as const, discountCents: evaluation.discountCents, billRevision: next.revision, totalCents: next.totalCents }
  },
})

export const quitarPromocion = memberOperation('quitarPromocion', {
  permission: 'promociones.aplicar', modules: ['loyalty', 'pos'], input: S.quitarPromocion.input as z.ZodType<In<'quitarPromocion'>>, output: S.quitarPromocion.output as z.ZodType<Out<'quitarPromocion'>>,
  run: async (client, d, scope) => {
    const rid = d.restaurantId
    await assertLocation(client, rid, scope, d.locationId)
    const bill = await bills().openBill(client, { restaurantId: rid, locationId: d.locationId, billId: d.billId, expectedRevision: d.expectedBillRevision })
    const applied = (await client.query('SELECT * FROM llenamos.bill_promotions WHERE restaurant_id=$1 AND location_id=$2 AND bill_id=$3 FOR UPDATE', [rid, d.locationId, d.billId])).rows[0]
    if (!applied) throw notFound()
    if (applied.status !== 'applied') throw failed('No hay ninguna promoción aplicada.')
    await client.query('SELECT 1 FROM llenamos.promotions WHERE restaurant_id=$1 AND id=$2 FOR UPDATE', [rid, applied.promotion_id])
    await client.query('UPDATE llenamos.promotions SET uses=greatest(0,uses-1) WHERE restaurant_id=$1 AND id=$2', [rid, applied.promotion_id])
    if (applied.customer_id) await client.query('UPDATE llenamos.promotion_customer_uses SET uses=greatest(0,uses-1) WHERE restaurant_id=$1 AND promotion_id=$2 AND customer_id=$3', [rid, applied.promotion_id, applied.customer_id])
    await client.query("UPDATE llenamos.bill_promotions SET status='removed' WHERE restaurant_id=$1 AND location_id=$2 AND bill_id=$3", [rid, d.locationId, d.billId])
    const ids = new Set<string>(applied.adjustment_ids)
    const next = await bills().replaceAdjustments(client, { restaurantId: rid, locationId: d.locationId, billId: d.billId, expectedRevision: bill.revision, actorUid: scope.uid, adjustments: bill.adjustments.filter(a => !ids.has(a.id)) })
    await notify(client, rid, 'fidelizacion.promocion', applied.promotion_id)
    return { billRevision: next.revision, totalCents: next.totalCents }
  },
})
