import { createHash } from 'node:crypto'
import type { Pool,PoolClient } from 'pg'
import { ApiError } from '../../errors.js'

const hash=(...parts:string[])=>createHash('sha256').update(parts.join('\u0000')).digest('hex')
/** Ajustables en pruebas. Ventanas fijas en segundos; límites por ventana. */
export const limits={
  /** Antes de resolver el slug: protege el propio resolvedor de un barrido de slugs. */
  preResolve:{window:600,max:600},
  availability:{ipRestaurant:{window:600,max:120}},
  // IP: se cuenta siempre (también lo rechazado). Restaurante y destinatario: solo lo aceptado, dentro de la transacción.
  create:{ipRestaurant:{window:3600,max:8},restaurant:{window:3600,max:300},recipient:{window:3600,max:5}},
  waitlist:{ipRestaurant:{window:3600,max:10},restaurant:{window:3600,max:300},recipient:{window:3600,max:5}},
  accept:{window:3600,max:10},
  projection:{window:600,max:1200},
  link:{ipRestaurant:{window:600,max:60},failedIp:{window:600,max:15},failedReference:{window:3600,max:10}},
}
const memory=new Map<string,{until:number;hits:number}>()
/** Límite en memoria por proceso, previo a cualquier consulta (el slug aún no está validado). */
export function guardBeforeResolve(ip:string|null,now=Date.now()) {
  const {window,max}=limits.preResolve,key=hash('pre',ip??'unknown')
  const entry=memory.get(key)
  if(!entry||entry.until<=now){
    if(memory.size>50_000)for(const [k,v] of memory)if(v.until<=now)memory.delete(k)
    memory.set(key,{until:now+window*1000,hits:1});return
  }
  if(++entry.hits>max)throw tooMany()
}
/** Límite en memoria con clave propia (la proyección pública la lee también el servidor de Next, que comparte IP). */
export function guardKeyed(scope:string,ip:string|null,rule:{window:number;max:number},now=Date.now()) {
  const key=hash(scope,ip??'unknown'),entry=memory.get(key)
  if(!entry||entry.until<=now){memory.set(key,{until:now+rule.window*1000,hits:1});return}
  if(++entry.hits>rule.max)throw tooMany()
}
export const resetMemoryLimits=()=>memory.clear()
const tooMany=()=>new ApiError(429,'resource-exhausted','Demasiados intentos. Vuelve a intentarlo más tarde.')
/** Cada comprobación se confirma en su propia transacción: un rechazo (o un error posterior) también cuenta. */
export async function hit(pool:Pool,rid:string,scope:string,key:string,rule:{window:number;max:number}) {
  const {rows}=await pool.query<{ok:boolean}>('SELECT llenamos.abuse_hit($1,$2,$3,$4,$5) AS ok',[rid,scope,hash(scope,key),rule.window,rule.max])
  if(!rows[0]?.ok)throw tooMany()
}
/** Mira el contador sin sumar: un bloqueo por fallos debe impedir también el intento correcto. */
export async function assertBelow(pool:Pool,rid:string,scope:string,key:string,rule:{window:number;max:number}) {
  const {rows}=await pool.query<{n:number}>('SELECT llenamos.abuse_count($1,$2,$3,$4) AS n',[rid,scope,hash(scope,key),rule.window])
  if((rows[0]?.n??0)>=rule.max)throw tooMany()
}
/** Suma dentro de la transacción del hecho: si la operación falla, la cuenta se revierte (solo cuenta lo aceptado). */
export async function txHit(client:PoolClient,rid:string,scope:string,key:string,rule:{window:number;max:number}) {
  const {rows}=await client.query<{ok:boolean}>('SELECT llenamos.abuse_hit($1,$2,$3,$4,$5) AS ok',[rid,scope,hash(scope,key),rule.window,rule.max])
  return !!rows[0]?.ok
}
export const ipKey=(ip:string|null)=>{
  if(!ip)return 'unknown'
  // IPv6: un cliente controla todo su /64, así que no puede esquivar el límite cambiando de dirección.
  return ip.includes(':')?ip.split(':').slice(0,4).join(':'):ip
}
export const recipients=(phone:string|null,email:string|null)=>[phone?`tel:${phone}`:null,email?`mail:${email}`:null].filter((v):v is string=>!!v)
