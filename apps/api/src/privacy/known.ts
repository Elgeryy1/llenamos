import type { PoolClient } from 'pg'
import type { ModuleDefinition } from '../modules/types.js'

/**
 * Tablas con datos personales que el núcleo conoce aunque su módulo aún no tenga adaptador de privacidad. Si una
 * tiene filas de la persona y ningún módulo declara `privacy` sobre ella (en `personalData`), la solicitud queda
 * bloqueada: exportar o borrar «completado» con datos sin tocar sería mentir. Columna = la que identifica a la persona.
 */
export const KNOWN_PERSONAL_TABLES: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'customer_marketing', column: 'customer_id' },
  { table: 'marketing_consents', column: 'customer_id' },
  { table: 'marketing_campaign_recipients', column: 'customer_id' },
  { table: 'marketing_send_log', column: 'customer_id' },
  { table: 'marketing_unsubscribe_tokens', column: 'customer_id' },
  { table: 'loyalty_accounts', column: 'customer_id' },
  { table: 'loyalty_movements', column: 'customer_id' },
  { table: 'loyalty_lots', column: 'customer_id' },
  { table: 'loyalty_redemptions', column: 'customer_id' },
  { table: 'promotion_customer_uses', column: 'customer_id' },
  { table: 'bill_promotions', column: 'customer_id' },
  { table: 'repite_cards', column: 'customer_id' },
  { table: 'repite_queue', column: 'customer_id' },
  { table: 'sala_spend', column: 'customer_id' },
  { table: 'automation_events', column: 'subject' },
  { table: 'recommendations', column: 'subject' },
]

/** Tablas conocidas con filas de la persona que ningún módulo con adaptador declara cubrir. */
export async function uncoveredTables(client: PoolClient, rid: string, subject: string, modules: readonly ModuleDefinition[]): Promise<string[]> {
  const covered = new Set(modules.filter(module => module.privacy).flatMap(module => module.personalData ?? []))
  const found: string[] = []
  for (const { table, column } of KNOWN_PERSONAL_TABLES) {
    if (covered.has(table)) continue
    const { rowCount } = await client.query(`SELECT 1 FROM llenamos.${table} WHERE restaurant_id=$1 AND ${column}=$2 LIMIT 1`, [rid, subject])
    if (rowCount) found.push(table)
  }
  return found
}
