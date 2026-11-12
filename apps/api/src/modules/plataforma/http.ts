import type { IncomingMessage,ServerResponse } from 'node:http'
import type { Pool } from 'pg'

/** Misma forma que `HttpRoute` de `src/http.ts` (V2): se monta con `services.routes` sin tocar el servidor. */
export interface RouteContext {
  req:IncomingMessage
  res:ServerResponse
  path:string
  pool:Pool
  respond:(status:number,value:unknown)=>void
}
export type PlatformRoute=(context:RouteContext)=>Promise<boolean>
