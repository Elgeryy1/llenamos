import type { z } from 'zod'
import * as core from '@llenamos/core'
import { assertLocation, memberOperation, rolesFor } from '../comun/acceso.js'
import { available, asMovements, expireLapsed, liveLots, openLedger, readAccount, writeMovement } from './puntos.js'
import { customerRow, failed, hashId, loyaltySettings, notFound, notify, revisionConflict } from './util.js'
import { now } from './ports.js'

const S = core.CALLABLE_SCHEMAS_FASE5_FIDELIZACION
type In<N extends keyof typeof S> = z.output<(typeof S)[N]['input']>
type Out<N extends keyof typeof S> = z.output<(typeof S)[N]['output']>
export { rolesFor, assertLocation }

const rewardOf = (r: any) => ({ id: r.id as string, name: r.name as string, pointsCost: r.points_cost as number, kind: r.kind as 'amount' | 'item', valueCents: Number(r.value_cents), itemId: (r.item_id ?? null) as string | null, active: r.active as boolean, revision: r.revision as number })

export const guardarConfiguracionFidelizacion = memberOperation('guardarConfiguracionFidelizacion', {
  permission: 'fidelizacion.gestionar', modules: ['loyalty'], input: S.guardarConfiguracionFidelizacion.input as z.ZodType<In<'guardarConfiguracionFidelizacion'>>, output: S.guardarConfiguracionFidelizacion.output as z.ZodType<Out<'guardarConfiguracionFidelizacion'>>,
  run: async (client, d, scope) => {
    await client.query(`INSERT INTO llenamos.loyalty_settings(restaurant_id,settings,updated_by) VALUES($1,$2,$3)
      ON CONFLICT(restaurant_id) DO UPDATE SET settings=EXCLUDED.settings,updated_by=EXCLUDED.updated_by,updated_at=now()`, [d.restaurantId, JSON.stringify(d.settings), scope.uid])
    await notify(client, d.restaurantId, 'fidelizacion.ajustes', 'loyalty')
    return { ok: true as const }
  },
})

export const guardarPremio = memberOperation('guardarPremio', {
  permission: 'fidelizacion.gestionar', modules: ['loyalty'], input: S.guardarPremio.input as z.ZodType<In<'guardarPremio'>>, output: S.guardarPremio.output as z.ZodType<Out<'guardarPremio'>>,
  run: async (client, d, scope) => {
    const r = d.reward
    let id: string, revision: number
    if (d.rewardId) {
      const { rows } = await client.query('SELECT revision FROM llenamos.loyalty_rewards WHERE restaurant_id=$1 AND id=$2 FOR UPDATE', [d.restaurantId, d.rewardId])
      if (!rows[0]) throw notFound()
      if (rows[0].revision !== d.expectedRevision) throw revisionConflict()
      id = d.rewardId; revision = rows[0].revision + 1
      await client.query('UPDATE llenamos.loyalty_rewards SET name=$3,points_cost=$4,kind=$5,value_cents=$6,item_id=$7,active=$8,revision=$9,updated_at=now() WHERE restaurant_id=$1 AND id=$2',
        [d.restaurantId, id, r.name, r.pointsCost, r.kind, r.valueCents, r.itemId, r.active, revision])
    } else {
      if (d.expectedRevision !== null) throw failed('El premio todavía no existe.')
      id = hashId(scope.uid, d.requestId, 'premio').slice(0, 20); revision = 1
      await client.query('INSERT INTO llenamos.loyalty_rewards(restaurant_id,id,name,points_cost,kind,value_cents,item_id,active,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1)',
        [d.restaurantId, id, r.name, r.pointsCost, r.kind, r.valueCents, r.itemId, r.active])
    }
    await notify(client, d.restaurantId, 'fidelizacion.premio', id)
    return { rewardId: id, revision }
  },
})

export const altaFidelizacion = memberOperation('altaFidelizacion', {
  permission: 'fidelizacion.operar', modules: ['loyalty'], input: S.altaFidelizacion.input as z.ZodType<In<'altaFidelizacion'>>, output: S.altaFidelizacion.output as z.ZodType<Out<'altaFidelizacion'>>,
  run: async (client, d, scope) => {
    const customer = await customerRow(client, d.restaurantId, d.customerId)
    if (!customer) throw notFound()
    const settings = await loyaltySettings(client, d.restaurantId)
    if (!settings.enabled || settings.termsVersion !== d.acceptedTermsVersion) throw failed('Confirma las condiciones vigentes del programa.')
    const at = now()
    const inserted = await client.query(`INSERT INTO llenamos.loyalty_accounts(restaurant_id,customer_id,status,terms_version,enrolled_at,enrolled_by)
      VALUES($1,$2,'active',$3,$4,$5) ON CONFLICT DO NOTHING`, [d.restaurantId, d.customerId, settings.termsVersion, at, scope.uid])
    const account = (await readAccount(client, d.restaurantId, d.customerId))!
    if (account.status === 'closed') throw failed('Esta cuenta está cerrada por privacidad.')
    if (inserted.rowCount) await notify(client, d.restaurantId, 'fidelizacion.cuenta', d.customerId)
    return { balance: account.balance, enrolledAt: account.enrolledAt, alreadyEnrolled: !inserted.rowCount }
  },
})

export const verCuentaFidelizacion = memberOperation('verCuentaFidelizacion', {
  permission: 'fidelizacion.ver', modules: ['loyalty'], input: S.verCuentaFidelizacion.input as z.ZodType<In<'verCuentaFidelizacion'>>, output: S.verCuentaFidelizacion.output as z.ZodType<Out<'verCuentaFidelizacion'>>,
  run: async (client, d) => {
    const t = now()
    const found = await readAccount(client, d.restaurantId, d.customerId)
    // Una cuenta cerrada (persona borrada) no devuelve ni saldo ni historial.
    const account = found?.status === 'closed' ? null : found
    // Solo las tandas vivas y los últimos 50 movimientos: el libro entero no se lee nunca.
    const lots = account ? await liveLots(client, d.restaurantId, d.customerId) : []
    const moves = account ? await client.query(`SELECT id,kind,points,balance_after,at_ms,reason FROM llenamos.loyalty_movements WHERE restaurant_id=$1 AND customer_id=$2 ORDER BY at_ms DESC,id DESC LIMIT 50`, [d.restaurantId, d.customerId]) : { rows: [] as any[] }
    const rewards = await client.query('SELECT * FROM llenamos.loyalty_rewards WHERE restaurant_id=$1 AND active ORDER BY points_cost,id LIMIT 200', [d.restaurantId])
    const free = available(lots, t)
    return {
      enrolled: account?.status === 'active', available: free,
      expiringIn30Days: core.pointsExpiringBefore(asMovements(lots), t, t + 30 * 86_400_000),
      earned: account?.earned ?? 0, redeemed: account?.redeemed ?? 0, expired: account?.expired ?? 0,
      movements: moves.rows.map(m => ({ id: m.id, kind: m.kind, points: m.points, balanceAfter: Number(m.balance_after), at: Number(m.at_ms), reason: m.reason })),
      rewards: rewards.rows.map(rewardOf).map(r => ({ rewardId: r.id, name: r.name, pointsCost: r.pointsCost, affordable: free >= r.pointsCost })),
    }
  },
})

export const ajustarPuntos = memberOperation('ajustarPuntos', {
  permission: 'fidelizacion.gestionar', modules: ['loyalty'], input: S.ajustarPuntos.input as z.ZodType<In<'ajustarPuntos'>>, output: S.ajustarPuntos.output as z.ZodType<Out<'ajustarPuntos'>>,
  run: async (client, d, scope) => {
    const state = await openLedger(client, d.restaurantId, d.customerId)
    if (!state) throw notFound()
    if (state.account.status !== 'active') throw failed('Esta cuenta de puntos está cerrada.')
    const t = now(), settings = await loyaltySettings(client, d.restaurantId)
    if (d.points < 0 && available(state.lots, t) < -d.points) throw failed('No hay puntos suficientes.')
    await expireLapsed(client, d.restaurantId, state, t)
    const id = `adjust.${hashId(scope.uid, d.requestId).slice(0, 32)}`
    await writeMovement(client, d.restaurantId, state, { id, kind: 'adjust', points: d.points, reason: d.reason, by: scope.uid, expiresAt: d.points > 0 ? core.lotExpiresAt(t, settings) : null }, t)
    await notify(client, d.restaurantId, 'fidelizacion.cuenta', d.customerId)
    return { movementId: id, available: available(state.lots, t) }
  },
})
