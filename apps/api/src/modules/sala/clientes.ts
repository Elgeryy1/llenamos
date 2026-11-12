import type { PoolClient } from 'pg'
import * as core from '@llenamos/core'

export interface CustomerDraft { name: string; phone: string; email: string | null; language: core.Language }

/**
 * Ficha del cliente al abrir una mesa o pedir para llevar (la crea sala como el original; antes quedaba solo el id).
 * Solo alta: si ya existe no se toca (sus notas y estadísticas son de reservas). Un teléfono que no es válido no
 * crea ficha, pero tampoco impide servir la mesa.
 */
export async function ensureCustomer(client: PoolClient, rid: string, id: string, draft: CustomerDraft, canRead: boolean): Promise<void> {
  const parsed = core.CustomerSchema.safeParse({ name: draft.name, phone: draft.phone, email: draft.email, language: draft.language,
    notes: '', allergies: '', tags: [], visits: 0, noShows: 0, cancellations: 0, lastVisitAt: null })
  if (!parsed.success) return
  const text = JSON.stringify(parsed.data)
  if (canRead) {
    // El personal puede leer fichas: la repetida se descarta sin provocar un error.
    await client.query('INSERT INTO llenamos.customers(restaurant_id,id,data) VALUES($1,$2,$3) ON CONFLICT(restaurant_id,id) DO NOTHING', [rid, id, text])
    return
  }
  // Alta pública: la política no deja leer fichas y `ON CONFLICT` exige poder leerlas; la repetida se descarta con un punto de guardado.
  await client.query('SAVEPOINT sala_customer')
  try {
    await client.query('INSERT INTO llenamos.customers(restaurant_id,id,data) VALUES($1,$2,$3)', [rid, id, text])
    await client.query('RELEASE SAVEPOINT sala_customer')
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT sala_customer')
    if ((error as { code?: string }).code !== '23505') throw error
  }
}

export interface SpendTarget { kind: 'session' | 'takeaway'; id: string; customerId: string | null; amountCents: number }

/**
 * Cada destino aporta una cantidad absoluta al gasto del cliente (mesa cerrada o recogida entregada, con el **total de la
 * mesa**: sin descuentos ni devoluciones de caja, como el original). Reintentar aplica una diferencia de cero; reabrir o
 * cambiar de cliente resta lo aportado antes. Las diferencias de un destino se aplican solo si existen todas las fichas y
 * ninguna quedaría negativa: si no (ficha borrada por privacidad, descuadre), no se toca nada, se registra el error y el
 * servicio sigue. Nunca se esconde un descuadre con un mínimo de cero.
 */
export async function reconcileSpend(client: PoolClient, rid: string, lid: string, targets: readonly SpendTarget[]): Promise<void> {
  for (const target of targets) {
    const old = (await client.query<{ customer_id: string; amount_cents: string }>(
      'SELECT customer_id,amount_cents FROM llenamos.sala_spend WHERE restaurant_id=$1 AND target_kind=$2 AND target_id=$3 FOR UPDATE', [rid, target.kind, target.id])).rows[0]
    const next = target.customerId ? target.amountCents : 0, before = old ? Number(old.amount_cents) : 0
    if ((old?.customer_id ?? null) === target.customerId && before === next) continue
    if (!old && next === 0) continue
    const deltas = new Map<string, number>()
    if (old) deltas.set(old.customer_id, -before)
    if (target.customerId) deltas.set(target.customerId, (deltas.get(target.customerId) ?? 0) + next)
    const ids = [...deltas.keys()]
    const found = new Map((await client.query<{ id: string; spent: string }>(
      "SELECT id,coalesce(data->>'spentCents','0') AS spent FROM llenamos.customers WHERE restaurant_id=$1 AND id=ANY($2) ORDER BY id FOR UPDATE", [rid, ids])).rows.map(r => [r.id, Number(r.spent)]))
    const problem = ids.find(id => !found.has(id)) ? 'ficha_inexistente' : ids.find(id => !Number.isSafeInteger(found.get(id)! + deltas.get(id)!) || found.get(id)! + deltas.get(id)! < 0) ? 'gasto_fuera_de_rango' : null
    if (problem) {
      console.error(JSON.stringify({ level: 'error', event: 'sala_gasto_no_aplicado', reason: problem, restaurantId: rid, locationId: lid, targetKind: target.kind, targetId: target.id }))
      continue
    }
    for (const [customerId, delta] of deltas) {
      if (delta) await client.query(`UPDATE llenamos.customers SET data=jsonb_set(data,'{spentCents}',to_jsonb($3::bigint),true),updated_at=now() WHERE restaurant_id=$1 AND id=$2`, [rid, customerId, found.get(customerId)! + delta])
    }
    const customerId = target.customerId ?? old!.customer_id
    await client.query(`INSERT INTO llenamos.sala_spend(restaurant_id,target_kind,target_id,location_id,customer_id,amount_cents) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(restaurant_id,target_kind,target_id) DO UPDATE SET customer_id=EXCLUDED.customer_id,amount_cents=EXCLUDED.amount_cents,updated_at=now()`, [rid, target.kind, target.id, lid, customerId, next])
  }
}
