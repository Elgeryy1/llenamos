import type { PoolClient } from 'pg'
import * as core from '@llenamos/core'
import { clientIp } from '../../client-ip.js'
import { ApiError } from '../../errors.js'
import type { PlatformRoute } from './http.js'

export interface ApiReadScope {restaurantId:string;locationId:string;keyId:string}
/**
 * Lectores de la API pública. Los aporta quien tenga los datos (V4: carta y pedidos) con `registerApiReaders`.
 * La petición no tiene sesión ni restaurante en el contexto de la transacción: un lector debe llamar a una función
 * SQL `SECURITY DEFINER` estrecha que reciba restaurante y local y no devuelva nada fuera de ellos, nunca ampliar la RLS.
 * Para paginar puede usar `signCursor`/`verifyCursor` de `custody.ts`, ligados a restaurante, local y clave.
 */
export interface ApiReaders {
  menu?(client:PoolClient,scope:ApiReadScope):Promise<unknown>
  orders?(client:PoolClient,scope:ApiReadScope & {limit:number;cursor:string|null}):Promise<{orders:unknown[];nextCursor:string|null}>
}
let readers:ApiReaders={}
export function registerApiReaders(next:ApiReaders) {readers={...readers,...next}}
/** Pruebas. */
export function resetApiReaders() {readers={}}

const route=/^\/v1\/restaurants\/([^/]+)\/locations\/([^/]+)\/(menu|orders)$/
const KEY_LIMIT=60,RESTAURANT_LIMIT=300,IP_LIMIT=300
const FAILURES:Record<string,[number,string,string]>={
  api_key_invalid:[401,'unauthenticated','La clave de API no es válida o ha caducado.'],
  api_key_scope:[403,'permission-denied','La clave no permite consultar este recurso.'],
  api_key_module:[403,'permission-denied','El módulo de sala no está activo.'],
  api_key_service:[403,'permission-denied','El servicio de este restaurante no está activo.'],
  api_rate:[429,'resource-exhausted','Se ha alcanzado el límite de peticiones. Espera un minuto.'],
}
/**
 * `GET /v1/restaurants/:rid/locations/:lid/{menu,orders}` con `Authorization: Bearer <clave>`. Solo lectura.
 * La clave se comprueba por hash en SQL (nunca se guarda ni se registra); alcance, local, módulo y suscripción
 * se validan allí mismo, y el límite por minuto (60 por clave, 300 por restaurante) se cuenta en la misma llamada.
 */
export function publicApiRoute(options:{now?:()=>number;ipPerMinute?:number}={}):PlatformRoute {
  const now=options.now??Date.now,ipLimit=options.ipPerMinute??IP_LIMIT,gate=new Map<string,{minute:number;count:number}>()
  // Freno por IP verificada antes de tocar la base: con una clave inventada nadie puede agotar el límite de otros.
  // El límite por clave y por restaurante solo cuenta peticiones con clave válida y vive en `api_key_authenticate`.
  const allowed=(ip:string)=>{
    const minute=Math.floor(now()/60_000),entry=gate.get(ip)
    if(!entry||entry.minute!==minute) {
      if(gate.size>=10_000) {
        // Primero se retiran las ventanas vencidas; si aun así está lleno, la más antigua. Nunca se reinicia todo.
        for(const [name,value] of gate)if(value.minute!==minute)gate.delete(name)
        if(gate.size>=10_000)gate.delete(gate.keys().next().value!)
      }
      gate.delete(ip);gate.set(ip,{minute,count:1});return true
    }
    return ++entry.count<=ipLimit
  }
  return async({req,res,path,pool})=>{
    const match=route.exec(path)
    if(!match)return false
    const send=(status:number,value:unknown,headers:Record<string,string>={})=>{
      res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',...headers})
      res.end(JSON.stringify(value))
    }
    try {
      req.resume()
      if(req.method!=='GET'){send(405,{error:'Método no permitido.'},{Allow:'GET'});return true}
      const url=new URL(req.url??'/','http://api.invalid')
      if([...url.searchParams.keys()].some(key=>!['cursor','limit'].includes(key)))throw new ApiError(400,'invalid-argument','Filtro no admitido.')
      const rid=decodeURIComponent(match[1]!),lid=decodeURIComponent(match[2]!),resource=match[3] as 'menu'|'orders'
      const limitRaw=url.searchParams.get('limit')
      const data=core.ApiReadInputSchema.safeParse({restaurantId:rid,locationId:lid,cursor:url.searchParams.get('cursor'),limit:limitRaw===null?50:Number(limitRaw)})
      if(!data.success||!/^[A-Za-z0-9_-]{1,128}$/.test(rid)||!/^[A-Za-z0-9_-]{1,128}$/.test(lid))throw new ApiError(400,'invalid-argument','La petición no es válida.')
      if(!allowed(clientIp(req)??'desconocida')){send(429,{error:'Se ha alcanzado el límite de peticiones. Espera un minuto.'},{'Retry-After':'60'});return true}
      const bearer=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(String(req.headers.authorization??''))
      if(!bearer){send(401,{error:'La clave de API no es válida.'},{'WWW-Authenticate':'Bearer'});return true}
      const reader=readers[resource]
      const client=await pool.connect()
      try {
        await client.query('BEGIN')
        let keyId:string
        try {
          keyId=(await client.query<{id:string}>('SELECT llenamos.api_key_authenticate($1,$2,$3,$4,$5,$6) AS id',[core.sha256Hex(bearer[1]!),rid,lid,resource==='menu'?'menu.read':'orders.read',KEY_LIMIT,RESTAURANT_LIMIT])).rows[0]!.id
        }catch(error) {
          const failure=FAILURES[(error as {message?:string}).message??'']
          await client.query('ROLLBACK')
          if(!failure)throw error
          send(failure[0],{error:failure[2]},failure[0]===401?{'WWW-Authenticate':'Bearer'}:failure[0]===429?{'Retry-After':'60'}:{})
          return true
        }
        // Sin lector registrado la ruta existe pero no devuelve datos inventados.
        if(!reader){await client.query('COMMIT');send(501,{error:'Este recurso todavía no está disponible en el servidor.'});return true}
        const scope={restaurantId:rid,locationId:lid,keyId}
        const body=resource==='menu'
          ? core.ApiMenuOutputSchema.parse({menu:await readers.menu!(client,scope)})
          : core.ApiOrdersOutputSchema.parse(await readers.orders!(client,{...scope,limit:data.data.limit,cursor:data.data.cursor}))
        await client.query('COMMIT')
        send(200,body)
      }catch(error){
        try{await client.query('ROLLBACK')}catch{/* ya cerrada */}
        throw error
      }finally{client.release()}
    }catch(error) {
      if(error instanceof ApiError)send(error.status,{error:error.message})
      else send(500,{error:'No se ha podido consultar el recurso.'})
    }
    return true
  }
}
