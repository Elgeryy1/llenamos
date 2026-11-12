import { describe,it,expect } from 'vitest'
import { credentialsStatus,integrationVault,mergeCredentials } from './integrations.js'

describe('Custodia de APIs por restaurante',()=>{
  it('las APIs vacías no necesitan clave y no anuncian servicio operativo',()=>{
    const empty=mergeCredentials({}, {stripe:{secretKey:''},email:{apiKey:' '}})
    expect(empty).toEqual({})
    expect(integrationVault().seal('a',empty)).toBeNull()
    expect(credentialsStatus(empty).stripe).toEqual({configured:false,status:'not_configured'})
    expect(()=>integrationVault().seal('a',{email:{apiKey:'secret'}})).toThrow('custodia')
  })
  it('vacío conserva; retirada explícita borra incluso una configuración parcial',()=>{
    const previous={stripe:{secretKey:'secret',webhookSecret:'hook'},email:{apiKey:'partial'}}
    expect(mergeCredentials(previous,{stripe:{secretKey:''}})).toEqual(previous)
    expect(mergeCredentials(previous,{},['email'])).toEqual({stripe:previous.stripe})
    expect(credentialsStatus(previous).stripe).toEqual({configured:true,status:'configured'})
    expect(credentialsStatus({email:{apiKey:'k',from:'a@example.test'}}).email).toEqual({configured:true,status:'configured'})
  })
  it('cifra con nonce aleatorio y autentica restaurante, versión y clave',()=>{
    const vault=integrationVault(Buffer.alloc(32,1)),value={email:{apiKey:'secret',from:'Llenamos <mail@example.test>'}}
    const first=vault.seal('a',value)!,second=vault.seal('a',value)!
    expect(first).not.toBe(second)
    expect(first).not.toContain('secret')
    expect(vault.open('a',first)).toEqual(value)
    for(const open of [()=>vault.open('b',first),()=>vault.open('a',first.slice(0,-4)+'xxxx'),()=>integrationVault(Buffer.alloc(32,2)).open('a',first)])expect(open).toThrow()
  })
})
