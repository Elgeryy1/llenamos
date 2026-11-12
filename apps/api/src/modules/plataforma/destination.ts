import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request as httpsRequest } from 'node:https'
import { ApiError } from '../../errors.js'

/** Solo se admiten direcciones globales. IPv6 se limita a unicast global sin túneles. */
export function isPublicAddress(address:string):boolean {
  if(isIP(address)===4) {
    const [a=0,b=0]=address.split('.').map(Number)
    return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&[0,168].includes(b))||
      (a===192&&b===88)||(a===198&&[18,19,51].includes(b))||(a===203&&b===0))
  }
  if(isIP(address)===6) {
    const v=address.toLowerCase()
    // Unicast global (2000::/3) sin documentación, túneles ni 3fff::/20 (documentación, RFC 9637).
    const doc=/^3fff:([0-9a-f]{0,4})(?::|$)/.exec(v)
    if(doc&&(doc[1]===''||parseInt(doc[1]!,16)<=0x0fff))return false
    return /^[23][a-f0-9]{3}:/.test(v)&&!/^(2001:(0*:|db8:|10:|20:)|2002:)/.test(v)
  }
  return false
}
export type Resolver=(host:string)=>Promise<{address:string;family:number}[]>
const DNS_TIMEOUT_MS=3000
/** La resolución tiene tiempo límite: un DNS colgado no retiene la petición ni al worker. */
const system:Resolver=host=>Promise.race([lookup(host,{all:true,verbatim:true}),new Promise<never>((_resolve,reject)=>setTimeout(()=>reject(new Error('dns_timeout')),DNS_TIMEOUT_MS).unref())])
let resolver:Resolver=system
/** Pruebas: resolución DNS sin red. */
export function useDestinationResolver(next:Resolver|undefined) {resolver=next??system}
const rejected=()=>new ApiError(400,'invalid-argument','El webhook necesita un destino HTTPS público, sin credenciales ni redirecciones.')
export async function assertIntegrationDestination(raw:string,resolve:Resolver=resolver) {
  let url:URL
  try {url=new URL(raw)}catch{throw rejected()}
  if(url.protocol!=='https:'||(url.port&&url.port!=='443')||url.username||url.password||url.hash)throw rejected()
  const host=url.hostname.replace(/^\[|\]$/g,'')
  let addresses:{address:string;family:number}[]
  try {addresses=isIP(host)?[{address:host,family:isIP(host)}]:await resolve(host)}catch{throw rejected()}
  if(!addresses.length||addresses.some(a=>!isPublicAddress(a.address)))throw rejected()
  return {url,address:addresses[0]!}
}
export type WebhookTransport=(url:string,body:string,signature:string)=>Promise<number>
/** DNS verificado en cada envío y dirección fijada al socket; nunca sigue `Location`. */
export const sendWebhook:WebhookTransport=async(raw,body,signature)=>{
  const destination=await assertIntegrationDestination(raw)
  return new Promise<number>((resolve,reject)=>{
    const req=httpsRequest(destination.url,{method:'POST',agent:false,family:destination.address.family,
      lookup:(_host,_options,cb)=>cb(null,destination.address.address,destination.address.family) as never,
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),'Llenamos-Signature':signature},
    },res=>{const status=res.statusCode??500;res.destroy();resolve(status)})
    const deadline=setTimeout(()=>req.destroy(new Error('timeout')),10_000)
    req.on('close',()=>clearTimeout(deadline));req.on('error',reject);req.end(body)
  })
}
