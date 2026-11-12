import { isIP } from 'node:net'
import type { IncomingMessage } from 'node:http'

/**
 * IP verificada del cliente. Solo se confía en la cabecera del conector (p. ej. `cf-connecting-ip`)
 * si la conexión TCP llega de una dirección de proxy listada; en cualquier otro caso manda el socket.
 * `TRUSTED_IP_HEADER` y `TRUSTED_PROXY_ADDRESSES` (separadas por comas; por defecto, solo loopback).
 */
export function clientIp(req:IncomingMessage,env:NodeJS.ProcessEnv=process.env):string|null {
  const remote=(req.socket.remoteAddress??'').replace(/^::ffff:/,'')
  const header=env.TRUSTED_IP_HEADER?.toLowerCase()
  if(header) {
    const proxies=(env.TRUSTED_PROXY_ADDRESSES??'127.0.0.1,::1').split(',').map(v=>v.trim()).filter(Boolean)
    const raw=req.headers[header]
    const value=(Array.isArray(raw)?raw[0]:raw)?.trim()
    if(proxies.includes(remote)&&value&&isIP(value))return value
  }
  return isIP(remote)?remote:null
}
