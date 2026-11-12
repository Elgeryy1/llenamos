import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest'
import { httpRepite } from './http'
const input={merchantId:'demo-lumbre',externalRef:'opaco_1234567890123456',displayName:'Ana',language:'es' as const,idempotencyKey:'card.abc'}
beforeEach(()=>{vi.stubEnv('GCLOUD_PROJECT','demo-llenamos');vi.stubEnv('FIRESTORE_EMULATOR_HOST','127.0.0.1:8096')})
afterEach(()=>vi.unstubAllEnvs())
describe('Repite · HTTP sin servicios reales',()=>{
 it('sin URL y con URL remota no hace ninguna petición',async()=>{
  const fetcher=vi.fn()
  for(const url of [undefined,'https://repite.logiqd.me/api/v1']) expect(await httpRepite(url,'token',fetcher).createCard(input)).toMatchObject({ok:false,error:{code:'not_configured'}})
  expect(fetcher).not.toHaveBeenCalled()
 })
 it('minimiza datos, envía autorización y clave estable, valida la respuesta',async()=>{
  const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({cardId:'local',saveUrl:null}),{status:201}))
  expect(await httpRepite('http://127.0.0.1:5012/api/v1','local',fetcher).createCard(input)).toEqual({ok:true,value:{cardId:'local',saveUrl:null}})
  const [url,req]=fetcher.mock.calls[0]!
  expect(url).toBe('http://127.0.0.1:5012/api/v1/merchants/demo-lumbre/cards')
  expect(req.headers).toMatchObject({Authorization:'Bearer local','Idempotency-Key':'card.abc'})
  expect(JSON.parse(req.body)).toEqual({externalRef:input.externalRef,displayName:'Ana',language:'es'})
 })
 for(const [status,code,retryable] of [[400,'invalid',false],[401,'unauthorized',false],[403,'unauthorized',false],[404,'not_found',false],[409,'conflict',false],[429,'rate_limited',true],[503,'unavailable',true]] as const) it(`traduce ${status}`,async()=>{
  const fetcher=vi.fn().mockResolvedValue(new Response('{}',{status}))
  expect(await httpRepite('http://localhost:5012','local',fetcher).createCard(input)).toMatchObject({ok:false,error:{code,retryable}})
 })
 it('un timeout y una respuesta mal formada no inventan tarjeta',async()=>{
  for(const fetcher of [vi.fn().mockRejectedValue(new Error('timeout')),vi.fn().mockResolvedValue(new Response('{}'))]) expect(await httpRepite('http://127.0.0.1:5012','local',fetcher).createCard(input)).toMatchObject({ok:false,error:{code:'unavailable',retryable:true}})
 })
})
