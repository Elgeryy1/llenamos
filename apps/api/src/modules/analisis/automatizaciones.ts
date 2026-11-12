import { randomBytes } from 'node:crypto'
import type { PoolClient } from 'pg'
import * as core from '@llenamos/core'
import { emitEvent } from '../../events.js'
import { assertLocation, denied, failed, missing, visibleLocations, type Scope } from '../comun/acceso.js'
import { segmentsPort } from './puertos.js'
import { restaurantInfo } from './util.js'

export const MAX_RULES = 100
const SIMULATION_MAX_EVENTS = 5000

/** Un encargado limitado a locales solo toca reglas con locales y todos suyos. */
const withinScope = (scope: Scope, locationIds: readonly string[]) => !scope.locationIds.length || (locationIds.length > 0 && locationIds.every(id => scope.locationIds.includes(id)))
const conflict = () => failed('El documento ha cambiado. Recarga antes de continuar.')

export async function saveRule(client: PoolClient, rid: string, scope: Scope, d: core.CallableInput<'guardarAutomatizacion'>): Promise<{ ruleId: string; revision: number }> {
  if (d.rule.locationIds.length) await visibleLocations(client, rid, scope, d.rule.locationIds)
  if (!withinScope(scope, d.rule.locationIds)) throw denied()
  const segmentId = d.rule.recommendation.segmentId
  if (segmentId && !(await segmentsPort().exists(client, rid, segmentId))) throw missing('El segmento de la campaña no existe.')
  let ruleId = d.ruleId, revision = 1
  if (ruleId) {
    const { rows } = await client.query('SELECT revision,location_ids FROM llenamos.automation_rules WHERE restaurant_id=$1 AND id=$2 FOR UPDATE', [rid, ruleId])
    if (!rows[0]) throw missing('La regla no existe.')
    if (rows[0].revision !== d.expectedRevision) throw conflict()
    if (!withinScope(scope, rows[0].location_ids)) throw denied()
    revision = rows[0].revision + 1
    // El cursor vuelve al principio: una regla cambiada se evalúa de nuevo contra los eventos de los últimos 92 días.
    await client.query('UPDATE llenamos.automation_rules SET name=$3,revision=$4,rule=$5,location_ids=$6,cursor_at=NULL,updated_at=now(),updated_by=$7 WHERE restaurant_id=$1 AND id=$2',
      [rid, ruleId, d.rule.name, revision, JSON.stringify(d.rule), d.rule.locationIds, scope.uid])
  } else {
    if (d.expectedRevision !== null) throw failed('La regla no existe.')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`analisis.reglas:${rid}`])
    const count = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM llenamos.automation_rules WHERE restaurant_id=$1', [rid])
    if (count.rows[0]!.n >= MAX_RULES) throw failed(`Hay ${MAX_RULES} reglas, el máximo. Borra alguna antes de crear otra.`)
    ruleId = randomBytes(10).toString('hex')
    await client.query('INSERT INTO llenamos.automation_rules(restaurant_id,id,name,revision,rule,location_ids,updated_by) VALUES($1,$2,$3,1,$4,$5,$6)',
      [rid, ruleId, d.rule.name, JSON.stringify(d.rule), d.rule.locationIds, scope.uid])
  }
  await emitEvent(client, { restaurantId: rid, topic: 'analisis.regla', entityId: ruleId, payload: { action: 'saved' } })
  return { ruleId, revision }
}

export async function deleteRule(client: PoolClient, rid: string, scope: Scope, d: core.CallableInput<'borrarAutomatizacion'>): Promise<{ ok: true }> {
  const { rows } = await client.query('SELECT revision,location_ids FROM llenamos.automation_rules WHERE restaurant_id=$1 AND id=$2 FOR UPDATE', [rid, d.ruleId])
  if (!rows[0]) throw missing('La regla no existe.')
  if (rows[0].revision !== d.expectedRevision) throw conflict()
  for (const lid of rows[0].location_ids as string[]) await assertLocation(client, rid, scope, lid)
  if (!withinScope(scope, rows[0].location_ids)) throw denied()
  await client.query('DELETE FROM llenamos.automation_rules WHERE restaurant_id=$1 AND id=$2', [rid, d.ruleId])
  await emitEvent(client, { restaurantId: rid, topic: 'analisis.regla', entityId: d.ruleId, payload: { action: 'deleted' } })
  return { ok: true }
}

/** Prueba una regla contra los eventos guardados del periodo (como mucho 92 días y 5000 eventos). No escribe nada. */
export async function simulateRule(client: PoolClient, rid: string, scope: Scope, d: core.CallableInput<'simularAutomatizacion'>) {
  const ids = await visibleLocations(client, rid, scope, null)
  const { timezone } = await restaurantInfo(client, rid)
  const start = core.instanteDeHoraLocal(d.from, 0, timezone) ?? Date.parse(d.from), end = core.instanteDeHoraLocal(core.sumarDias(d.to, 1), 0, timezone) ?? Date.parse(core.sumarDias(d.to, 1))
  const { rows } = await client.query(`SELECT id,type,location_id,subject,at,data FROM llenamos.automation_events
    WHERE restaurant_id=$1 AND NOT redacted AND at>=$2 AND at<$3 AND (location_id=ANY($4) OR ($5 AND location_id IS NULL)) ORDER BY at,id LIMIT $6`,
  [rid, new Date(start), new Date(end), ids, !scope.locationIds.length, SIMULATION_MAX_EVENTS + 1])
  if (rows.length > SIMULATION_MAX_EVENTS) throw failed(`Hay más de ${SIMULATION_MAX_EVENTS} eventos en ese periodo. Elige menos días.`)
  const events = rows.map(r => core.AutomationEventInstanceSchema.parse({ id: r.id, type: r.type, locationId: r.location_id, subject: r.subject, at: r.at.getTime(), data: r.data }))
  const plan = core.simulateRule(d.rule as core.AutomationRuleInput, events)
  return { events: events.length, fired: plan.fired.slice(0, 500), skipped: plan.skipped, sample: events.slice(0, 20) }
}

export async function resolveRecommendation(client: PoolClient, rid: string, scope: Scope, d: core.CallableInput<'resolverRecomendacion'>, now = Date.now()) {
  const { rows } = await client.query('SELECT location_id,status,expires_at,kind FROM llenamos.recommendations WHERE restaurant_id=$1 AND id=$2 FOR UPDATE', [rid, d.recommendationId])
  const r = rows[0]
  if (!r) throw missing('No se encuentra la recomendación.')
  if (r.location_id) await assertLocation(client, rid, scope, r.location_id)
  else if (scope.locationIds.length) throw denied()
  if (r.status !== 'open' || r.expires_at.getTime() <= now) throw failed('Esta recomendación ya no está pendiente.')
  await client.query('UPDATE llenamos.recommendations SET status=$3,decided_by=$4,decided_at=$5,note=$6 WHERE restaurant_id=$1 AND id=$2', [rid, d.recommendationId, d.decision, scope.uid, new Date(now), d.note])
  await emitEvent(client, { restaurantId: rid, locationId: r.location_id, topic: 'analisis.recomendacion', payload: { status: d.decision } })
  return { status: d.decision, kind: r.kind as core.RecommendationKind }
}
