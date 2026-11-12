import { createCipheriv,createDecipheriv,createHmac,randomBytes,timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { canonicalJson } from '@llenamos/core'
import { ApiError } from '../../errors.js'

let override:Buffer|null|undefined
let cached:Buffer|undefined
/** Pruebas: fija la clave sin tocar el entorno. `null` simula una custodia sin configurar. */
export function useCustodyKey(key:Buffer|null|undefined) {override=key;cached=undefined}
/** La misma clave de integraciones que usan la API y el worker (`PLATFORM_INTEGRATION_KEY_FILE`). Sin ella, falla cerrado. */
export function custodyKey(env:NodeJS.ProcessEnv=process.env):Buffer {
  if(override)return override
  if(override!==null&&cached)return cached
  const file=override===null?undefined:env.PLATFORM_INTEGRATION_KEY_FILE
  const value=file?readFileSync(file,'utf8').trim():''
  if(!/^[a-f0-9]{64}$/.test(value))throw new ApiError(503,'failed-precondition','La custodia de las integraciones no está configurada.')
  cached=Buffer.from(value,'hex')
  return cached
}
const derive=(purpose:string,key=custodyKey())=>createHmac('sha256',key).update(`llenamos-platform-api:${purpose}`).digest()
/** AES-256-GCM con el contexto como dato autenticado: un valor no se puede mover a otro restaurante o endpoint. */
export function seal(value:unknown,context:string,key?:Buffer):string {
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',derive('secrets:v1',key),iv)
  cipher.setAAD(Buffer.from(context))
  const body=Buffer.concat([cipher.update(canonicalJson(value),'utf8'),cipher.final()])
  return `v1.${Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64url')}`
}
export function unseal<T>(ciphertext:string,context:string,key?:Buffer):T {
  try {
    if(!ciphertext.startsWith('v1.'))throw new Error()
    const bytes=Buffer.from(ciphertext.slice(3),'base64url')
    const decipher=createDecipheriv('aes-256-gcm',derive('secrets:v1',key),bytes.subarray(0,12))
    decipher.setAAD(Buffer.from(context));decipher.setAuthTag(bytes.subarray(12,28))
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8')) as T
  }catch{throw new ApiError(503,'unavailable','No se pudo abrir el secreto guardado.')}
}
/** Cursores firmados y con caducidad, ligados a la consulta: para lectores de la API pública. */
export function signCursor(binding:unknown,after:unknown,now=Date.now()):string {
  const body=Buffer.from(canonicalJson({binding,after,expiresAt:now+3_600_000})).toString('base64url')
  return `${body}.${createHmac('sha256',derive('cursors:v1')).update(body).digest('hex')}`
}
export function verifyCursor<T>(cursor:string|null,binding:unknown,now=Date.now()):T|null {
  if(!cursor)return null
  try {
    const [body,signature,extra]=cursor.split('.')
    const expected=createHmac('sha256',derive('cursors:v1')).update(body!).digest()
    if(extra||!signature||!/^[a-f0-9]{64}$/.test(signature)||!timingSafeEqual(Buffer.from(signature,'hex'),expected))throw new Error()
    const decoded=JSON.parse(Buffer.from(body!,'base64url').toString('utf8')) as {binding:unknown;after:T;expiresAt:number}
    if(decoded.expiresAt<=now||canonicalJson(decoded.binding)!==canonicalJson(binding))throw new Error()
    return decoded.after
  }catch{throw new ApiError(400,'invalid-argument','El cursor ha caducado o no corresponde a esta consulta.')}
}
