import type { Pool } from 'pg'
import { loadContext } from './engine.js'
import { resolveTenantById,withPublicScope } from './scope.js'
import { expireOffers } from './waitlist.js'

/** Trabajo `reservas.caducar_oferta` del worker: caduca ofertas vencidas y ofrece el hueco a la siguiente. */
export async function expireWaitlistOffers(pool:Pool,restaurantId:string,locationId:string,now=Date.now()):Promise<number> {
  const tenant=await resolveTenantById(pool,restaurantId,locationId)
  return withPublicScope(pool,tenant.rid,async client=>expireOffers(await loadContext(client,tenant,locationId,[now],{now,requireModule:false})))
}
