import type { z } from 'zod'
import * as core from '@llenamos/core'
import { assertLocation, memberOperation } from '../comun/acceso.js'
import { available, asMovements, expireLapsed, openLedger, writeMovement } from './puntos.js'
import { failed, hashId, loyaltySettings, notFound, notify } from './util.js'
import { bills, now } from './ports.js'

const S = core.CALLABLE_SCHEMAS_FASE5_FIDELIZACION
type In<N extends keyof typeof S> = z.output<(typeof S)[N]['input']>
type Out<N extends keyof typeof S> = z.output<(typeof S)[N]['output']>

export const canjearPuntos = memberOperation('canjearPuntos', {
  permission: 'fidelizacion.operar', modules: ['loyalty', 'pos'], input: S.canjearPuntos.input as z.ZodType<In<'canjearPuntos'>>, output: S.canjearPuntos.output as z.ZodType<Out<'canjearPuntos'>>,
  run: async (client, d, scope) => {
    const rid = d.restaurantId
    await assertLocation(client, rid, scope, d.locationId)
    const bill = await bills().openBill(client, { restaurantId: rid, locationId: d.locationId, billId: d.billId, expectedRevision: d.expectedBillRevision })
    if (bill.customerId !== d.customerId) throw failed('El cliente no corresponde a esta cuenta.')
    const state = await openLedger(client, rid, d.customerId)
    if (!state) throw notFound()
    if (state.account.status !== 'active') throw failed('La cuenta de puntos está cerrada.')
    const settings = await loyaltySettings(client, rid)
    if (!settings.enabled) throw failed('El programa de puntos está apagado.')
    const rewardRow = (await client.query('SELECT * FROM llenamos.loyalty_rewards WHERE restaurant_id=$1 AND id=$2', [rid, d.rewardId])).rows[0]
    if (!rewardRow) throw notFound()
    if (!rewardRow.active) throw failed('Este premio está desactivado.')
    const applied = (await client.query(`SELECT p.definition FROM llenamos.bill_promotions b JOIN llenamos.promotions p ON p.restaurant_id=b.restaurant_id AND p.id=b.promotion_id
      WHERE b.restaurant_id=$1 AND b.location_id=$2 AND b.bill_id=$3 AND b.status='applied'`, [rid, d.locationId, d.billId])).rows[0]
    if (applied && applied.definition.stacking === 'exclusive') throw failed('La promoción no admite canjes de puntos.')
    const t = now()
    const cost: number = rewardRow.points_cost
    const plan = core.planRedemption(asMovements(state.lots), cost, t)
    if (!plan.ok) return { status: 'insufficient' as const, available: plan.available, pointsCost: cost }
    const discount = core.planRewardDiscount({ kind: rewardRow.kind, valueCents: Number(rewardRow.value_cents), itemId: rewardRow.item_id }, bill.lines)
    if (!discount.amountCents) throw failed('El premio no descuenta ningún plato de esta cuenta.')
    const id = hashId(scope.uid, d.requestId, 'canje').slice(0, 32)
    await expireLapsed(client, rid, state, t)
    await writeMovement(client, rid, state, { id: core.loyaltyMovementId.redeem(id), kind: 'redeem', points: -cost, redemptionId: id, billId: d.billId, locationId: d.locationId, by: scope.uid }, t)
    await client.query(`INSERT INTO llenamos.loyalty_redemptions(restaurant_id,id,customer_id,reward_id,location_id,bill_id,points,discount_cents,status,at_ms,by_uid)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'applied',$9,$10)`, [rid, id, d.customerId, d.rewardId, d.locationId, d.billId, cost, discount.amountCents, t, scope.uid])
    const adjustments = core.discountAdjustments({ lines: discount.lines, amountCents: discount.amountCents, kind: 'reward', sourceId: id, reason: rewardRow.name, at: t, by: scope.uid })
    const next = await bills().replaceAdjustments(client, { restaurantId: rid, locationId: d.locationId, billId: d.billId, expectedRevision: bill.revision, actorUid: scope.uid, adjustments: [...bill.adjustments, ...adjustments] })
    await notify(client, rid, 'fidelizacion.cuenta', d.customerId)
    return { status: 'applied' as const, redemptionId: id, points: cost, discountCents: discount.amountCents, available: plan.balanceAfter, billRevision: next.revision }
  },
})

export const anularCanje = memberOperation('anularCanje', {
  permission: 'fidelizacion.operar', modules: ['loyalty', 'pos'], input: S.anularCanje.input as z.ZodType<In<'anularCanje'>>, output: S.anularCanje.output as z.ZodType<Out<'anularCanje'>>,
  run: async (client, d, scope) => {
    const rid = d.restaurantId
    await assertLocation(client, rid, scope, d.locationId)
    const redemption = (await client.query('SELECT * FROM llenamos.loyalty_redemptions WHERE restaurant_id=$1 AND id=$2 FOR UPDATE', [rid, d.redemptionId])).rows[0]
    if (!redemption) throw notFound()
    if (redemption.location_id !== d.locationId || redemption.status !== 'applied') throw failed('El canje no está aplicado en este local.')
    const bill = await bills().openBill(client, { restaurantId: rid, locationId: d.locationId, billId: redemption.bill_id, expectedRevision: d.expectedBillRevision })
    const settings = await loyaltySettings(client, rid)
    const state = await openLedger(client, rid, redemption.customer_id)
    if (!state) throw notFound()
    const t = now()
    await expireLapsed(client, rid, state, t)
    await writeMovement(client, rid, state, {
      id: core.loyaltyMovementId.redeemReversal(d.redemptionId), kind: 'redeem_reversal', points: redemption.points, redemptionId: d.redemptionId,
      billId: redemption.bill_id, locationId: d.locationId, reason: d.reason, by: scope.uid, expiresAt: core.lotExpiresAt(t, settings),
    }, t)
    await client.query("UPDATE llenamos.loyalty_redemptions SET status='reversed' WHERE restaurant_id=$1 AND id=$2", [rid, d.redemptionId])
    const next = await bills().replaceAdjustments(client, { restaurantId: rid, locationId: d.locationId, billId: redemption.bill_id, expectedRevision: bill.revision, actorUid: scope.uid, adjustments: bill.adjustments.filter(a => a.redemptionId !== d.redemptionId) })
    await notify(client, rid, 'fidelizacion.cuenta', redemption.customer_id)
    return { available: available(state.lots, t), billRevision: next.revision }
  },
})
