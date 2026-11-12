import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { z } from 'zod'
import { bearer, type IdentityToken } from './auth.js'
import { checkReadiness, withIdentity } from './database.js'
import { ApiError } from './errors.js'
import { clientIp } from './client-ip.js'
import { jsonBody } from './http.js'
import { requireMember } from './access.js'
import { createOperations, restaurantContext } from './operations.js'
import { createLiveService, type LiveOptions } from './live/stream.js'
import { MODULES } from './modules/index.js'
import type { ModuleDefinition } from './modules/types.js'
import type { PlatformServices } from './platform/service.js'

const envelope=z.strictObject({data:z.unknown()}).refine(value=>Object.hasOwn(value,'data'))

export function apiServer(pool: Pool, verify: (token: string) => Promise<IdentityToken>, log: (entry: object) => void = entry => console.error(JSON.stringify(entry)),services:PlatformServices={},options:{modules?:readonly ModuleDefinition[];live?:LiveOptions;rehearsal?:boolean}={}) {
  const operations=createOperations(services)
  const live=createLiveService(pool,verify,options.modules??MODULES,options.live,log)
  function respond(res: ServerResponse, status: number, value: unknown) {
    res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer' })
    res.end(JSON.stringify(value))
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const requestId = randomUUID()
    let operationName:string|undefined
    res.setHeader('X-Request-ID',requestId)
    try {
      // No Host/URL proporcionados por el cliente como base de confianza.
      const path = new URL(req.url ?? '/', 'http://api.invalid').pathname
      const operationMatch=/^\/v1\/operations\/([A-Za-z][A-Za-z0-9]*)$/.exec(path)
      if(operationMatch) {
        const operation=operations.get(operationMatch[1]!)
        if(!operation)throw new ApiError(404,'not-deployed','Operación no disponible.')
        operationName=operationMatch[1]
        if(req.method!=='POST'){res.setHeader('Allow','POST');throw new ApiError(405,'method-not-allowed','Método no permitido.')}
        const token=operation.access==='public'?null:await verify(bearer(req.headers.authorization))
        const body=envelope.safeParse(await jsonBody(req))
        if(!body.success)throw new ApiError(400,'invalid-argument','La petición debe contener únicamente data.')
        const data=operation.input.safeParse(body.data.data)
        if(!data.success)throw new ApiError(400,'invalid-argument','Parámetros no válidos.')
        if(operation.access==='public')return respond(res,200,{result:operation.output.parse(await operation.runPublic(data.data,{pool,clientIp:clientIp(req)}))})
        const rid=operation.restaurantId?.(data.data)??null
        const tasks:((output:unknown)=>Promise<unknown>)[]=[]
        let result=await withIdentity(pool,token!,rid,async(client,platform)=>{
          if(operation.access==='platform'&&!platform)throw new ApiError(403,'permission-denied','Solo el equipo autorizado de plataforma.')
          if(operation.access==='member') {
            if(platform||!rid)throw new ApiError(403,'permission-denied','No tienes acceso al restaurante.')
            await requireMember(client,token!.uid,rid,operation.roles)
          }
          if(operation.access==='account') {
            if(platform)throw new ApiError(403,'permission-denied','Las cuentas de plataforma no usan esta operación.')
            if(rid) {
              const {rows}=await client.query('SELECT role FROM llenamos.memberships WHERE uid=$1 AND restaurant_id=$2 AND active',[token!.uid,rid])
              if(!operation.roles?.includes(rows[0]?.role))throw new ApiError(403,'permission-denied','Permisos insuficientes.')
            }
          }
          // Validar antes de COMMIT evita confirmar un handler que incumple su contrato.
          return operation.output.parse(await operation.run(client,data.data,{uid:token!.uid,afterCommit:task=>tasks.push(task),integrationVault:services.integrationVault}))
        })
        for(const task of tasks)result=operation.output.parse(await task(result))
        return respond(res,200,{result})
      }
      const liveMatch=/^\/v1\/live\/([A-Za-z][A-Za-z0-9]*)$/.exec(path)
      if(liveMatch){operationName=`live:${liveMatch[1]}`;return await live.handle(req,res,liveMatch[1]!)}
      for(const route of services.routes??[])if(await route({req,res,path,pool,verify,respond:(status,value)=>respond(res,status,value)}))return
      if (req.method !== 'GET') { res.setHeader('Allow','GET'); throw new ApiError(405,'method-not-allowed','Método no permitido.') }
      if (path === '/healthz') return respond(res,200,{ status:'ok' })
      if (path === '/readyz') {
        try { await checkReadiness(pool,!!services.invitations,Boolean(options.rehearsal)); return respond(res,200,{ status:'ready' }) }
        catch { throw new ApiError(503,'unavailable','Servicio no preparado.') }
      }
      const contextMatch=/^\/v1\/restaurants\/([A-Za-z0-9_-]{1,128})\/context$/.exec(path)
      if (!contextMatch&&!['/v1/session','/v1/admin/restaurants'].includes(path)) throw new ApiError(404,'not-found','No existe esta ruta.')
      const token = await verify(bearer(req.headers.authorization))
      const result = await withIdentity(pool,token,contextMatch?.[1]??null,async (client,platform) => {
        if(contextMatch) {
          if(platform)throw new ApiError(403,'permission-denied','La plataforma no accede al interior de restaurantes.')
          return restaurantContext(client,token.uid,contextMatch[1]!)
        }
        if (path === '/v1/admin/restaurants') {
          if (!platform) throw new ApiError(403,'permission-denied','Solo el equipo autorizado de plataforma.')
          const operation=operations.get('listarRestaurantesAdministracion')!
          if(operation.access==='public')throw new Error('Invalid administrative registry')
          return operation.output.parse(await operation.run(client,operation.input.parse({}),{uid:token.uid,afterCommit:()=>{}}))
        }
        if (platform) return { uid:token.uid, access:'platform', memberships:[] }
        const { rows } = await client.query(`SELECT m.restaurant_id,m.role,m.location_ids,r.name,r.slug
          FROM llenamos.memberships m JOIN llenamos.restaurants r ON r.id=m.restaurant_id
          WHERE m.uid=$1 AND m.active ORDER BY m.restaurant_id LIMIT 100`,[token.uid])
        return { uid:token.uid, access:'restaurant', memberships:rows.map(row=>({restaurantId:row.restaurant_id,
          role:row.role,locationIds:row.location_ids,name:row.name,slug:row.slug})) }
      })
      respond(res,200,result)
    } catch (error) {
      req.resume()
      const known = error instanceof ApiError
      if (!known) {
        const raw=(error as {code?:unknown})?.code
        log({ level:'error',requestId,event:'request_failed',...(operationName?{operationName}:{}),errorCode:typeof raw==='string'&&/^[0-9A-Z]{5}$/.test(raw)?raw:'unexpected' })
      }
      respond(res,known ? error.status : 500,{ error:{ code:known ? error.code : 'internal', message:known ? error.message : 'No se pudo completar la operación.',requestId } })
    }
  }
  const server = createServer({ maxHeaderSize:16_384, requestTimeout:15_000, headersTimeout:10_000 },(req,res) => { void handle(req,res) })
  server.keepAliveTimeout=5000
  const close=server.close.bind(server)
  // Los flujos en vivo no terminan solos: se cierran para que el apagado ordenado no espere.
  server.close=(callback?:(error?:Error)=>void)=>{live.closeAll();void live.stop();return close(callback)}
  return server
}
