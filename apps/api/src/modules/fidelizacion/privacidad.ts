import * as core from '@llenamos/core'
import type { PoolClient } from 'pg'
import type { PrivacyContributor } from '../../privacy/types.js'
import { randomBytes } from 'node:crypto'
import { enqueueRepite, reopenRepite } from './repite.js'

/** Tablas de fidelización con el identificador de un cliente: cuenta y libro de puntos, canjes, promociones usadas y tarjeta de Repite. */
export const LOYALTY_PERSONAL_DATA = ['loyalty_accounts', 'loyalty_movements', 'loyalty_lots', 'loyalty_redemptions', 'promotion_customer_uses', 'bill_promotions', 'repite_cards', 'repite_queue'] as const

const rows = async (client: PoolClient, sql: string, params: unknown[]) => (await client.query(sql, params)).rows as Record<string, unknown>[]

export const fidelizacionPrivacy: PrivacyContributor = {
  exportData: async (client, rid, subject) => ({
    fidelizacion_cuenta: await rows(client, 'SELECT status,balance,earned,redeemed,expired,terms_version,enrolled_at FROM llenamos.loyalty_accounts WHERE restaurant_id=$1 AND customer_id=$2', [rid, subject]),
    fidelizacion_movimientos: await rows(client, 'SELECT kind,points,balance_after,at_ms,expires_at_ms,location_id,bill_id,reason FROM llenamos.loyalty_movements WHERE restaurant_id=$1 AND customer_id=$2 ORDER BY at_ms DESC,id DESC LIMIT 5000', [rid, subject]),
    fidelizacion_canjes: await rows(client, 'SELECT reward_id,location_id,bill_id,points,discount_cents,status,at_ms FROM llenamos.loyalty_redemptions WHERE restaurant_id=$1 AND customer_id=$2 ORDER BY at_ms DESC LIMIT 1000', [rid, subject]),
    repite_tarjeta: await rows(client, 'SELECT merchant_id,card_id,status,created_at_ms FROM llenamos.repite_cards WHERE restaurant_id=$1 AND customer_id=$2', [rid, subject]),
  }),
  // Solo comprobaciones sin efectos: una llamada a Repite en curso no se puede deshacer.
  blockers: async (client, rid, subject) => (await client.query(
    "SELECT 1 FROM llenamos.repite_queue WHERE restaurant_id=$1 AND customer_id=$2 AND status='leased' AND lease_until_ms>$3 LIMIT 1", [rid, subject, Date.now()])).rowCount
    ? ['Hay una llamada a Repite en curso. Inténtalo de nuevo en unos minutos.'] : [],
  // Con efectos, y solo si ningún otro módulo bloquea (así una reserva abierta no deja la tarjeta retirada con la persona sin borrar). Mientras la tarjeta siga
  // activa en Repite no se borra: encola su `remove_card` (o reabre la que no salió) y bloquea; cuando la cola la termina hay que VERIFICAR la solicitud otra vez a
  // mano (nada la repite sola). Para que la supresión no quede bloqueada para siempre: tras 3 verificaciones con la retirada sin poder hacerse (Repite sin configurar o error
  // definitivo), la tarjeta se da por retirada en local y se deja una baja pendiente (`repite_pending_removals`, con comercio y tarjeta) para que plataforma la pida a Repite.
  prepare: async (client, rid, subject) => {
    const card = (await client.query<{ merchant_id: string; card_id: string }>("SELECT merchant_id,card_id FROM llenamos.repite_cards WHERE restaurant_id=$1 AND customer_id=$2 AND status='active' FOR UPDATE", [rid, subject])).rows[0]
    if (!card) return []
    const id = core.repiteOperationId.remove(subject)
    const op = (await client.query<{ status: string; result: { checks?: number } | null }>('SELECT status,result FROM llenamos.repite_queue WHERE restaurant_id=$1 AND id=$2 FOR UPDATE', [rid, id])).rows[0]
    const checks = Number(op?.result?.checks ?? 0)
    if (op && (op.status === 'done' || op.status === 'duplicate')) {
      await client.query("UPDATE llenamos.repite_cards SET status='removed' WHERE restaurant_id=$1 AND customer_id=$2", [rid, subject])
      return []
    }
    if (op && (op.status === 'failed' || op.status === 'not_configured') && checks >= 3) {
      const reason = op.status === 'not_configured' ? 'repite_no_configurado' : 'retirada_fallida'
      // La baja se registra con la tarjeta todavía activa (la función la lee de la ficha) y después se da por retirada.
      await client.query('SELECT llenamos.repite_register_removal($1,$2,$3)', [rid, subject, reason])
      await client.query("UPDATE llenamos.repite_cards SET status='removed' WHERE restaurant_id=$1 AND customer_id=$2", [rid, subject])
      await client.query("UPDATE llenamos.repite_queue SET status='skipped' WHERE restaurant_id=$1 AND id=$2", [rid, id])
      console.error(JSON.stringify({ level: 'warn', event: 'repite_tarjeta_retirada_local', restaurantId: rid, reason }))
      return []
    }
    if (!op) await enqueueRepite(client, rid, { id, kind: 'remove_card', customerId: subject, merchantId: card.merchant_id })
    else if (op.status === 'failed' || op.status === 'not_configured') {
      await client.query("UPDATE llenamos.repite_queue SET result=jsonb_set(coalesce(result,'{}'::jsonb),'{checks}',to_jsonb($3::int)) WHERE restaurant_id=$1 AND id=$2", [rid, id, checks + 1])
      await reopenRepite(client, rid, id)
    }
    return ['La tarjeta de Repite se está retirando. Verifica de nuevo en unos minutos.']
  },
  erase: async (client, rid, subject) => {
    let touched = 0
    touched += (await client.query("UPDATE llenamos.repite_queue SET status='skipped',lease_until_ms=NULL,lease_owner=NULL WHERE restaurant_id=$1 AND customer_id=$2 AND status='queued' AND kind<>'remove_card'", [rid, subject])).rowCount ?? 0
    touched += (await client.query("UPDATE llenamos.repite_queue SET result=NULL,last_error=NULL WHERE restaurant_id=$1 AND customer_id=$2 AND kind<>'remove_card' AND (result IS NOT NULL OR last_error IS NOT NULL)", [rid, subject])).rowCount ?? 0
    touched += (await client.query("UPDATE llenamos.loyalty_accounts SET status='closed' WHERE restaurant_id=$1 AND customer_id=$2 AND status<>'closed'", [rid, subject])).rowCount ?? 0
    touched += (await client.query('SELECT llenamos.loyalty_anonymize($1,$2) AS n', [rid, subject])).rows[0].n as number
    touched += (await client.query('UPDATE llenamos.bill_promotions SET customer_id=NULL WHERE restaurant_id=$1 AND customer_id=$2', [rid, subject])).rowCount ?? 0
    return touched
  },
  // Paso final del gestor (después del `erase` de TODOS los contribuyentes, en cualquier orden de módulos): el id viejo sale del teléfono sin sal, así que lo
  // anónimo que queda en V7 pasa a un id aleatorio y los ids derivados del viejo se reescriben (`marketing_rekey`). Quien reserve de nuevo con ese teléfono
  // no recupera historial ni tarjeta.
  finalize: async (client, rid, subject) => (await client.query('SELECT llenamos.marketing_rekey($1,$2,$3) AS n', [rid, subject, randomBytes(10).toString('hex')])).rows[0].n as number,
}
