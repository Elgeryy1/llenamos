import type { Pool, PoolClient } from 'pg'

const restaurantPattern = /^[A-Za-z0-9_-]{1,128}$/

/** Transacción del worker para un restaurante concreto. `app.restaurant_id` limita RLS a ese negocio. */
export async function withTenant<T>(pool: Pool, restaurantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!restaurantPattern.test(restaurantId)) throw new Error('Restaurante no válido.')
  const client = await pool.connect()
  let broken = false
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('app.actor_uid','worker',true),set_config('app.platform','false',true),set_config('app.restaurant_id',$1,true)", [restaurantId])
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { broken = true }
    throw error
  } finally { client.release(broken) }
}
