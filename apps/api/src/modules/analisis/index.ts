import * as core from '@llenamos/core'
import type { Module, Permission } from '@llenamos/core'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import { loadScope, memberOperation, requireModules, rolesFor } from '../comun/acceso.js'
import type { LiveQuery, ModuleDefinition } from '../types.js'
import { deleteRule, resolveRecommendation, saveRule, simulateRule } from './automatizaciones.js'
import { exportCsv, buildPanel, forecastFor } from './panel.js'
import { loadSettings, saveSettings, viewSummary } from './resumen.js'
import { ANALYTICS_PERSONAL_DATA, analisisPrivacy } from './privacidad.js'
import { connectClientesModules } from '../comun/conexion.js'


type Name = keyof typeof core.CALLABLES_FASE5_ANALISIS
const access = (name: Name) => core.FASE5_ANALISIS_ACCESS[name] as { permission: Permission; modules: readonly Module[] }
const op = <N extends Name>(name: N, run: (client: PoolClient, input: core.CallableInput<N>, scope: Awaited<ReturnType<typeof loadScope>>) => Promise<unknown>) => {
  const schemas = core.CALLABLE_SCHEMAS_FASE5_ANALISIS[name]
  return memberOperation(name, { permission: access(name).permission, modules: access(name).modules, input: schemas.input as z.ZodType<{ restaurantId: string }>, output: schemas.output as z.ZodType<unknown>, run: run as never })
}

const operations: ModuleDefinition['operations'] = [
  op('panelAnalisis', (client, d, scope) => buildPanel(client, d.restaurantId, scope, d).then(r => r.output)),
  op('exportarAnalisis', (client, d, scope) => exportCsv(client, d.restaurantId, scope, d)),
  op('guardarConfiguracionAnalisis', (client, d, scope) => saveSettings(client, d.restaurantId, scope.uid, d.settings)),
  op('previsionOcupacion', (client, d, scope) => forecastFor(client, d.restaurantId, scope, d)),
  op('verResumenDiario', (client, d, scope) => viewSummary(client, d.restaurantId, scope, d)),
  op('guardarAutomatizacion', (client, d, scope) => saveRule(client, d.restaurantId, scope, d)),
  op('borrarAutomatizacion', (client, d, scope) => deleteRule(client, d.restaurantId, scope, d)),
  op('simularAutomatizacion', (client, d, scope) => simulateRule(client, d.restaurantId, scope, d)),
  op('resolverRecomendacion', (client, d, scope) => resolveRecommendation(client, d.restaurantId, scope, d)),
]

/* Lecturas en vivo (formas de apps/web/src/lib/analisis/datos.ts) ------------------------------------------------- */

const RidInput = z.strictObject({ restaurantId: core.DocIdSchema })
const rid = (input: unknown) => (input as { restaurantId: string }).restaurantId
export const ReglaGuardada = z.object({ id: z.string(), revision: z.number().int().min(1), rule: core.AutomationRuleInputSchema })
export const RecomendacionEnVivo = core.RecommendationSchema.extend({ id: z.string() })

async function prepare(client: PoolClient, input: unknown, uid: string) {
  await requireModules(client, rid(input), ['analytics'])
  const scope = await loadScope(client, rid(input), uid)
  const { rows } = await client.query<{ id: string }>('SELECT id FROM llenamos.locations WHERE restaurant_id=$1', [rid(input)])
  // Locales que puede ver; null = todos (membresía sin location_ids).
  return { scope, allowed: scope.locationIds.length ? rows.map(r => r.id).filter(id => scope.locationIds.includes(id)) : null }
}

const live = (name: string, output: z.ZodType, topic: string, snapshot: LiveQuery['snapshot']): LiveQuery => ({
  name, roles: rolesFor('analisis.ver'), input: RidInput, output, restaurantId: rid, topics: () => [topic], snapshot,
})

export const liveQueries: LiveQuery[] = [
  live('analisis.ajustes', core.AnalyticsSettingsSchema.nullable(), 'analisis.ajustes', async (client, input, { uid }) => {
    await prepare(client, input, uid)
    const { rows } = await client.query('SELECT 1 FROM llenamos.analytics_settings WHERE restaurant_id=$1', [rid(input)])
    // Sin ajustes guardados la web enseña null (no hay documento), no los valores por defecto.
    return rows[0] ? loadSettings(client, rid(input)) : null
  }),
  live('analisis.reglas', z.array(ReglaGuardada).max(100), 'analisis.regla', async (client, input, { uid }) => {
    const { allowed } = await prepare(client, input, uid)
    const { rows } = await client.query(`SELECT id,revision,rule FROM llenamos.automation_rules WHERE restaurant_id=$1
      AND ($2::text[] IS NULL OR (cardinality(location_ids)>0 AND location_ids<@$2::text[])) ORDER BY name,id LIMIT 100`, [rid(input), allowed])
    return rows.map(r => ({ id: r.id, revision: r.revision, rule: r.rule }))
  }),
  live('analisis.recomendaciones', z.array(RecomendacionEnVivo).max(100), 'analisis.recomendacion', async (client, input, { uid }) => {
    const { allowed } = await prepare(client, input, uid)
    const { rows } = await client.query(`SELECT * FROM llenamos.recommendations WHERE restaurant_id=$1
      AND ($2::text[] IS NULL OR location_id=ANY($2::text[])) ORDER BY created_at DESC,id LIMIT 100`, [rid(input), allowed])
    return rows.map(r => ({
      id: r.id, ruleId: r.rule_id, eventId: r.event_id, eventType: r.event_type, locationId: r.location_id, subject: r.subject, kind: r.kind, text: r.text, evidence: r.evidence,
      status: r.status, createdAt: r.created_at.getTime(), expiresAt: r.expires_at.getTime(), decidedBy: r.decided_by, decidedAt: r.decided_at ? r.decided_at.getTime() : null, note: r.note,
    }))
  }),
  // Fecha del último resumen guardado: evita que la web pruebe hasta 92 fechas con `verResumenDiario`. El resumen es global,
  // así que quien tiene locales limitados recibe null (como el permiso de `verResumenDiario`).
  live('analisis.ultimoResumen', z.object({ date: core.FechaSchema }).nullable(), 'analisis.resumen', async (client, input, { uid }) => {
    const { allowed } = await prepare(client, input, uid)
    if (allowed) return null
    const { rows } = await client.query<{ date: string }>('SELECT date::text AS date FROM llenamos.daily_summaries WHERE restaurant_id=$1 ORDER BY date DESC LIMIT 1', [rid(input)])
    return rows[0] ?? null
  }),
]

export const analisisModule: ModuleDefinition = { name: 'analisis', operations, liveQueries, personalData: ANALYTICS_PERSONAL_DATA, privacy: analisisPrivacy }

export * from './puertos.js'
export { aggregateDay, aggregateRecentDays, backfillDays, missingDays } from './dias.js'
export { sendDailySummary, MESSAGE_KIND } from './resumen.js'
export { evaluateAutomations, expireRecommendations, dailyEvents, purgeAutomationEvents, recordReservationEvent, recordStockLowEvent } from './procesos.js'

// Conecta los puertos entre fidelización, campañas, análisis, caja, reservas y sala en cuanto se carga cualquiera de los tres módulos.
connectClientesModules()
