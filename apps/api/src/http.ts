import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Pool } from 'pg'
import type { IdentityToken } from './auth.js'

export interface RouteContext {
  req: IncomingMessage
  res: ServerResponse
  path: string
  pool: Pool
  verify: (token: string) => Promise<IdentityToken>
  respond: (status: number, value: unknown) => void
}
/**
 * Ruta HTTP fuera del envelope de operaciones (binarios, webhooks). Devuelve true si atendió la petición;
 * puede lanzar `ApiError`, que el servidor convierte en el error JSON habitual.
 */
export type HttpRoute = (context: RouteContext) => Promise<boolean>

import { ApiError } from './errors.js'

const bodyLimit=65_536

/** Lectura acotada sin concatenar cuerpos ilimitados ni registrar datos del cliente. */
export function jsonBody(req:IncomingMessage):Promise<unknown> {
  if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']??'')) {
    req.resume()
    throw new ApiError(415,'unsupported-media-type','Usa application/json.')
  }
  const length=req.headers['content-length']
  if(length && (!/^\d+$/.test(length)||Number(length)>bodyLimit)) {
    req.resume()
    throw new ApiError(413,'resource-exhausted','El cuerpo supera el límite permitido.')
  }
  return new Promise((resolve,reject)=>{
    let size=0
    const chunks:Buffer[]=[]
    const cleanup=()=>{req.off('data',onData);req.off('end',onEnd);req.off('error',onError);req.off('aborted',onAbort)}
    const fail=(error:Error)=>{cleanup();req.resume();reject(error)}
    const onData=(chunk:Buffer)=>{
      size+=chunk.length
      if(size>bodyLimit)return fail(new ApiError(413,'resource-exhausted','El cuerpo supera el límite permitido.'))
      chunks.push(chunk)
    }
    const onEnd=()=>{
      cleanup()
      try {resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))}
      catch {reject(new ApiError(400,'invalid-argument','JSON no válido.'))}
    }
    const onError=()=>fail(new ApiError(400,'invalid-argument','No se pudo leer la petición.'))
    const onAbort=()=>fail(new ApiError(400,'invalid-argument','Petición incompleta.'))
    req.on('data',onData);req.once('end',onEnd);req.once('error',onError);req.once('aborted',onAbort)
  })
}
