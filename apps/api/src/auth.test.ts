import { beforeAll,describe,expect,it } from 'vitest'
import { createLocalJWKSet,exportJWK,generateKeyPair,SignJWT,type CryptoKey } from 'jose'
import { assertCurrentIdentity,bearer,firebaseVerifier } from './auth.js'

let privateKey:CryptoKey,verify:ReturnType<typeof firebaseVerifier>
beforeAll(async()=>{
  const pair=await generateKeyPair('RS256')
  privateKey=pair.privateKey
  verify=firebaseVerifier('llenamos-logiqd',createLocalJWKSet({keys:[{...await exportJWK(pair.publicKey),kid:'fixture',alg:'RS256'}]}))
})
async function token(changes:Record<string,unknown>={}) {
  const now=Math.floor(Date.now()/1000)
  return new SignJWT({sub:'alice',iss:'https://securetoken.google.com/llenamos-logiqd',aud:'llenamos-logiqd',exp:now+3600,iat:now,auth_time:now,sessionVersion:'a'.repeat(32),...changes})
    .setProtectedHeader({alg:'RS256',kid:'fixture'}).sign(privateKey)
}
describe('Solo identidad Firebase firmada y sesiones SQL actuales',()=>{
  it('verifica IDtoken del proyecto autorizado sin red ni credenciales reales',async()=>{
    expect(await verify(await token())).toMatchObject({uid:'alice',sessionVersion:'a'.repeat(32),platformClaim:false})
  })
  for(const changes of [{aud:'other-project'},{aud:['llenamos-logiqd','other-project']},{iss:'https://securetoken.google.com/other-project'},{exp:1},{auth_time:Date.now()},{auth_time:100,iat:99},{sub:''},{sub:'a'.repeat(129)}])
    it(`rechaza claim inválido ${Object.keys(changes)[0]}`,async()=>expect(verify(await token(changes))).rejects.toMatchObject({status:401}))
  it('no acepta JWT sin firma ni con otra clave',async()=>{
    const now=Math.floor(Date.now()/1000)
    const raw=Buffer.from(JSON.stringify({sub:'alice',aud:'llenamos-logiqd',exp:now+100,iat:now,auth_time:now})).toString('base64url')
    await expect(verify(`${Buffer.from('{"alg":"none"}').toString('base64url')}.${raw}.`)).rejects.toMatchObject({status:401})
    const other=await generateKeyPair('RS256')
    const signed=await new SignJWT({sub:'alice'}).setProtectedHeader({alg:'RS256',kid:'fixture'}).sign(other.privateKey)
    await expect(verify(signed)).rejects.toMatchObject({status:401})
  })
  it('deniega sesión antigua, identidad ausente/bloqueada/desactivada y version sin bootstrap',()=>{
    const current={uid:'alice',authTime:100,sessionVersion:'a'.repeat(32),platformClaim:false}
    const state={sessionVersion:'a'.repeat(32),tokensValidAfter:100_000,locked:false,disabled:false}
    expect(()=>assertCurrentIdentity(current,state)).not.toThrow()
    for(const next of [null,{...state,sessionVersion:'b'.repeat(32)},{...state,tokensValidAfter:101_000},{...state,locked:true},{...state,disabled:true},{...state,sessionVersion:''}])
      expect(()=>assertCurrentIdentity(current,next)).toThrow()
  })
  it('solo lee un Bearer del header, no rutas/query ni formatos ambiguos',()=>{
    expect(bearer('Bearer aa.bb.cc')).toBe('aa.bb.cc')
    for(const header of [undefined,'Basic x','Bearer x y',['Bearer a','Bearer b']])expect(()=>bearer(header)).toThrow()
  })
})
