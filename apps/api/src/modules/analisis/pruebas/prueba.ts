import type { PoolClient } from 'pg'
import type { Fixture } from '../../comun/fixture.js'

/** SQL extra del fixture: `lim` es un encargado limitado al local a-main. */
export const EXTRA_SQL = `
  INSERT INTO llenamos.identities(uid,session_version,tokens_valid_after,locked) VALUES('lim','${'e'.repeat(32)}',to_timestamp(100),false);
  INSERT INTO llenamos.memberships(restaurant_id,uid,role,active,display_name,email,location_ids) VALUES('a','lim','manager',true,'lim','lim@example.test',ARRAY['a-main']);
`

/** Transacción de un restaurante como un miembro (o el worker: la RLS solo exige restaurante y miembro activo). */
export async function tenant<T>(f: Fixture, fn: (client: PoolClient) => Promise<T>, rid = 'a', uid = 'alice'): Promise<T> {
  const client = await f.app.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('app.actor_uid',$1,true),set_config('app.platform','false',true),set_config('app.restaurant_id',$2,true)", [uid, rid])
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

export const rejects = async (p: Promise<unknown>) => { try { await p } catch (error) { return error as { status?: number; code?: string; message: string } } throw new Error('Debía fallar') }
