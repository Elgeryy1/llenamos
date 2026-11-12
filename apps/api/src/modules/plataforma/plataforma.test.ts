import { createHmac } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe,expect,it } from 'vitest'
import { ApiError } from '../../errors.js'
import { seal,signCursor,unseal,useCustodyKey,verifyCursor } from './custody.js'
import { assertIntegrationDestination,isPublicAddress } from './destination.js'
import { stripeBillingProvider } from './provider.js'
import { verifyStripeSignature } from './webhook.js'

describe('Destinos de webhooks',()=>{
  it('solo admite direcciones públicas',()=>{
    for(const address of ['127.0.0.1','10.0.0.5','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','224.0.0.1','::1','fe80::1','fd00::1','2001:db8::1','3fff::1','3fff:fff::1','3fff:0abc::2'])
      expect(isPublicAddress(address),address).toBe(false)
    expect(isPublicAddress('93.184.216.34')).toBe(true)
    expect(isPublicAddress('2606:2800:220:1::1')).toBe(true)
  })
  it('exige HTTPS, sin puerto, credenciales ni DNS privado',async()=>{
    const resolve=async(host:string)=>[{address:host==='interno.test'?'10.1.2.3':'93.184.216.34',family:4}]
    await expect(assertIntegrationDestination('https://receptor.test/hook',resolve)).resolves.toMatchObject({address:{address:'93.184.216.34'}})
    for(const bad of ['http://receptor.test/hook','https://receptor.test:8443/hook','https://u:p@receptor.test/hook','https://receptor.test/hook#x','https://interno.test/hook','https://127.0.0.1/hook','no-es-url'])
      await expect(assertIntegrationDestination(bad,resolve),bad).rejects.toBeInstanceOf(ApiError)
  })
})
describe('Custodia',()=>{
  const key=Buffer.alloc(32,5)
  it('cifra ligando el secreto a su contexto',()=>{
    const sealed=seal({token:'secreto'},'webhook:a:b:1',key)
    expect(sealed).not.toContain('secreto')
    expect(unseal(sealed,'webhook:a:b:1',key)).toEqual({token:'secreto'})
    expect(()=>unseal(sealed,'webhook:c:b:1',key)).toThrow()
    expect(()=>unseal(sealed,'webhook:a:b:1',Buffer.alloc(32,6))).toThrow()
  })
  it('falla cerrado sin clave configurada',()=>{
    useCustodyKey(null)
    try {expect(()=>seal('x','c')).toThrow(/custodia/)}finally{useCustodyKey(undefined)}
  })
  it('cursores firmados: caducan y no se pueden mover de consulta',()=>{
    useCustodyKey(key)
    try {
      const cursor=signCursor({rid:'a',lid:'l'},{id:'x'},1000)
      expect(verifyCursor(cursor,{rid:'a',lid:'l'},2000)).toEqual({id:'x'})
      expect(()=>verifyCursor(cursor,{rid:'b',lid:'l'},2000)).toThrow(ApiError)
      expect(()=>verifyCursor(cursor,{rid:'a',lid:'l'},1000+3_600_001)).toThrow(ApiError)
      expect(()=>verifyCursor(cursor.replace(/.$/,'0'),{rid:'a',lid:'l'},2000)).toThrow(ApiError)
    }finally{useCustodyKey(undefined)}
  })
})
describe('Stripe Billing',()=>{
  it('sin clave u origen HTTPS no está configurado y no sale ninguna llamada',async()=>{
    let calls=0
    const provider=stripeBillingProvider({},(async()=>{calls++;return new Response('{}')}) as typeof fetch)
    expect(provider.configured).toBe(false)
    await expect(provider.portal('cus_1','k')).rejects.toThrow()
    expect(calls).toBe(0)
  })
  it('firma del webhook con ventana de cinco minutos',()=>{
    const raw=Buffer.from('{"id":"evt_1"}'),secret='whsec_prueba',t=Math.floor(Date.now()/1000)
    const sign=(time:number,body=raw)=>`t=${time},v1=${createHmac('sha256',secret).update(`${time}.`).update(body).digest('hex')}`
    expect(verifyStripeSignature(raw,sign(t),secret)).toBe(true)
    expect(verifyStripeSignature(raw,sign(t),'otro')).toBe(false)
    expect(verifyStripeSignature(Buffer.from('{"id":"evt_2"}'),sign(t),secret)).toBe(false)
    expect(verifyStripeSignature(raw,sign(t-301),secret)).toBe(false)
    expect(verifyStripeSignature(raw,'',secret)).toBe(false)
  })
  it('crea sesiones con clave de idempotencia y datos del servidor',async()=>{
    const seen:{url:string;init?:RequestInit}[]=[]
    const { writeFileSync,mkdtempSync } = await import('node:fs')
    const dir=mkdtempSync(join(tmpdir(),'llenamos-stripe-')),keyFile=`${dir}/key`
    writeFileSync(keyFile,'sk_test_fixture\n')
    const provider=stripeBillingProvider({STRIPE_BILLING_SECRET_KEY_FILE:keyFile,STRIPE_BILLING_RETURN_ORIGIN:'https://app.example.test'},(async(url:string|URL|Request,init?:RequestInit)=>{
      seen.push({url:String(url),init});return new Response(JSON.stringify({id:'cs_test_1',url:'https://checkout.stripe.com/c/pay/cs_test_1'}),{status:200})
    }) as typeof fetch)
    expect(provider.configured).toBe(true)
    const plan={id:'sala',stripeMonthlyPriceId:'price_m',stripeAnnualPriceId:'price_y'} as never
    const subscription={stripeCustomerId:null,stripeSubscriptionId:null} as never
    const link=await provider.start({restaurantId:'r1',intentId:'i1',plan,interval:'month',subscription,key:'clave-estable'})
    expect(link.url).toMatch(/^https:\/\/checkout\.stripe\.com\//)
    const headers=seen[0]!.init!.headers as Record<string,string>
    expect(headers['Idempotency-Key']).toBe('clave-estable')
    expect(String(seen[0]!.init!.body)).toContain('line_items%5B0%5D%5Bprice%5D=price_m')
    expect(String(seen[0]!.init!.body)).toContain('metadata%5BrestaurantId%5D=r1')
  })
})
