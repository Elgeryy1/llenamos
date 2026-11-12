import { mkdtempSync,readFileSync,writeFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe,expect,it } from 'vitest'
import { clientIp } from './client-ip.js'
import { configuration } from './config.js'
import { ipKey } from './modules/reservas/abuse.js'

const request=(remote:string,headers:Record<string,string>={})=>({socket:{remoteAddress:remote},headers}) as unknown as IncomingMessage
const env={TRUSTED_IP_HEADER:'cf-connecting-ip',TRUSTED_PROXY_ADDRESSES:'10.0.0.5'}
describe('IP verificada del cliente',()=>{
  it('sin cabecera de confianza manda la conexión TCP y nunca X-Forwarded-For',()=>{
    expect(clientIp(request('203.0.113.7',{'x-forwarded-for':'1.2.3.4'}),{})).toBe('203.0.113.7')
    expect(clientIp(request('::ffff:203.0.113.7'),{})).toBe('203.0.113.7')
  })
  it('acepta la cabecera del conector solo si la conexión viene de un proxy listado',()=>{
    expect(clientIp(request('10.0.0.5',{'cf-connecting-ip':'198.51.100.2'}),env)).toBe('198.51.100.2')
    expect(clientIp(request('203.0.113.7',{'cf-connecting-ip':'198.51.100.2'}),env)).toBe('203.0.113.7')
  })
  it('descarta valores que no son una IP',()=>{
    expect(clientIp(request('10.0.0.5',{'cf-connecting-ip':'no-es-ip, 1.1.1.1'}),env)).toBe('10.0.0.5')
    expect(clientIp({socket:{remoteAddress:undefined},headers:{}} as unknown as IncomingMessage,{})).toBeNull()
  })
  it('agrupa IPv6 por /64 para que cambiar de dirección no esquive el límite',()=>{
    expect(ipKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe(ipKey('2001:db8:1:2:1::9'))
    expect(ipKey('2001:db8:1:3::1')).not.toBe(ipKey('2001:db8:1:2::1'))
    expect(ipKey(null)).toBe('unknown')
  })
})

describe('configuración real del despliegue',()=>{
  const root=new URL('../../../deploy/vps/',import.meta.url)
  const compose=(name:string)=>readFileSync(new URL(name,root),'utf8')
  it('el compose da a la API la cabecera de nginx y la IP fija del gateway en la red de aplicación',()=>{
    const api=compose('compose.api.yaml'),main=compose('compose.yaml'),nginx=readFileSync(new URL('nginx.conf',root),'utf8')
    const header=/TRUSTED_IP_HEADER:\s*(\S+)/.exec(api)?.[1],proxy=/TRUSTED_PROXY_ADDRESSES:\s*(\S+)/.exec(api)?.[1]
    expect(header).toBe('x-real-ip')
    expect(nginx).toMatch(/location \/api\/[\s\S]*proxy_set_header X-Real-IP \$remote_addr;/)
    expect(main).toMatch(new RegExp(`application:\\s*\\n\\s*#[^\\n]*\\n\\s*ipv4_address: ${proxy!.replaceAll('.','\\.')}`))
    // Un cliente que dice ser otra IP con la cabecera del conector no la consigue; el gateway sí.
    const env={TRUSTED_IP_HEADER:header,TRUSTED_PROXY_ADDRESSES:proxy}
    expect(clientIp(request(proxy!,{'x-real-ip':'198.51.100.77'}),env)).toBe('198.51.100.77')
    expect(clientIp(request('172.30.43.9',{'x-real-ip':'198.51.100.77'}),env)).toBe('172.30.43.9')
    expect(clientIp(request(proxy!,{'cf-connecting-ip':'198.51.100.77'}),env)).toBe(proxy)
  })
  it('en producción la API no arranca sin cabecera y proxy de confianza',()=>{
    const dir=mkdtempSync(join(tmpdir(),'cfg-')),file=join(dir,'db');writeFileSync(file,'postgresql://app:x@db:5432/llenamos')
    const base={FIREBASE_PROJECT_ID:'llenamos-logiqd',DATABASE_URL_FILE:file,NODE_ENV:'production'}
    expect(()=>configuration(base)).toThrow('TRUSTED_IP_HEADER')
    expect(()=>configuration({...base,TRUSTED_IP_HEADER:'x-real-ip'})).toThrow('TRUSTED_PROXY_ADDRESSES')
    expect(()=>configuration({...base,TRUSTED_IP_HEADER:'x-real-ip',TRUSTED_PROXY_ADDRESSES:'gateway'})).toThrow('TRUSTED_PROXY_ADDRESSES')
    expect(()=>configuration({...base,TRUSTED_IP_HEADER:'x-real-ip',TRUSTED_PROXY_ADDRESSES:'172.30.43.3'})).not.toThrow()
    expect(()=>configuration({...base,NODE_ENV:'test'})).not.toThrow()
  })
})
