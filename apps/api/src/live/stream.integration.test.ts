import { randomUUID } from 'node:crypto'
import { afterAll,beforeAll,describe,expect,it } from 'vitest'
import { Pool } from 'pg'
import { z } from 'zod'
import { migrationSql } from '../test-migrations.js'
import { apiServer } from '../server.js'
import { emitEvent } from '../events.js'
import { withIdentity } from '../database.js'
import type { IdentityToken } from '../auth.js'
import type { ModuleDefinition } from '../modules/types.js'

const source=process.env.TEST_POSTGRES_URL
const enabled=process.env.TEST_POSTGRES_API==='1'&&!!source
const token=(uid:string,version:string):IdentityToken=>({uid,sessionVersion:version.repeat(32),authTime:100,platformClaim:false})
const input=z.object({restaurantId:z.string()})
const fixture:ModuleDefinition={name:'pruebas',operations:[],liveQueries:[
  {name:'localesPrueba',roles:['owner','manager'],input,output:z.object({names:z.array(z.string())}),restaurantId:value=>input.parse(value).restaurantId,topics:()=>['pruebas.local','ajuste.*'],
    snapshot:async client=>({names:(await client.query<{name:string}>('SELECT name FROM llenamos.locations ORDER BY name')).rows.map(row=>row.name)})},
  {name:'rotaPrueba',roles:['owner'],input,output:z.object({names:z.array(z.string())}),restaurantId:value=>input.parse(value).restaurantId,topics:()=>['pruebas.local'],snapshot:async()=>({names:[1]})},
]}
interface Frame { id?:string;event?:string;data?:string;comment?:string }
/** Cliente SSE mínimo por fetch, igual que el del navegador. */
async function open(base:string,name:string,bearer:string|null,body:unknown,headers:Record<string,string>={}) {
  const controller=new AbortController()
  const response=await fetch(`${base}/v1/live/${name}`,{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json',...(bearer?{Authorization:`Bearer ${bearer}`}:{}),...headers},body:JSON.stringify({data:body})})
  const frames:Frame[]=[]
  let ended=false
  const waiters:(()=>void)[]=[]
  const done=(async()=>{
    if(!response.body||response.status!==200){ended=true;return}
    const reader=response.body.getReader(),decoder=new TextDecoder()
    let buffer=''
    try {
      for(;;) {
        const {value,done:finished}=await reader.read()
        if(finished)break
        buffer+=decoder.decode(value,{stream:true})
        for(let at=buffer.indexOf('\n\n');at>=0;at=buffer.indexOf('\n\n')) {
          const frame:Frame={}
          for(const line of buffer.slice(0,at).split('\n')) {
            if(line.startsWith(':'))frame.comment=line.slice(1).trim()
            else if(line.startsWith('id: '))frame.id=line.slice(4)
            else if(line.startsWith('event: '))frame.event=line.slice(7)
            else if(line.startsWith('data: '))frame.data=line.slice(6)
          }
          buffer=buffer.slice(at+2)
          frames.push(frame);waiters.splice(0).forEach(wake=>wake())
        }
      }
    } catch { /* abortado */ }
    ended=true;waiters.splice(0).forEach(wake=>wake())
  })()
  async function until(test:()=>boolean,ms=4000) {
    const limit=Date.now()+ms
    while(!test()) {
      if(Date.now()>limit)throw new Error(`Tiempo agotado; tramas: ${JSON.stringify(frames)}`)
      await new Promise<void>(resolve=>{waiters.push(resolve);setTimeout(resolve,50)})
    }
  }
  return { response,frames,controller,done,get ended(){return ended},
    snapshots:()=>frames.filter(frame=>frame.event==='snapshot'),
    until,close:async()=>{controller.abort();await done} }
}
describe.skipIf(!enabled)('Tiempo real SSE sobre PostgreSQL real',()=>{
  let bootstrap:Pool,admin:Pool,app:Pool,owned=false,server:ReturnType<typeof apiServer>,base:string
  const suffix=randomUUID().replaceAll('-','').slice(0,12),database=`llenamos_api_test_live_${suffix}`,runtime=`llenamos_api_live_${suffix}`
  const identities:Record<string,IdentityToken>={}
  const emit=(rid:string,topic:string)=>withIdentity(app,identities[rid==='tenant-a'?'owner-a':'owner-b']!,rid,async client=>emitEvent(client,{restaurantId:rid,topic}))
  const addLocation=(rid:string,id:string)=>admin.query('INSERT INTO llenamos.locations(restaurant_id,id,name,slug) VALUES($1,$2,$2,$2)',[rid,id])
  beforeAll(async()=>{
    const url=new URL(source!)
    if(!['localhost','127.0.0.1'].includes(url.hostname)||!url.pathname.startsWith('/llenamos_api_test_'))throw new Error('Solo PostgreSQL temporal loopback de pruebas.')
    bootstrap=new Pool({connectionString:source,max:1})
    await bootstrap.query(`CREATE DATABASE ${database}`);owned=true
    url.pathname=`/${database}`
    admin=new Pool({connectionString:url.toString(),max:4})
    for(const sql of migrationSql())await admin.query(sql)
    await admin.query(`CREATE ROLE ${runtime} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD 'fixture-only' IN ROLE llenamos_app`)
    url.username=runtime;url.password='fixture-only'
    app=new Pool({connectionString:url.toString(),max:8,statement_timeout:5000})
    for(const [uid,version] of [['owner-a','a'],['owner-b','b'],['waiter-a','c'],['limited','d']] as const) {
      await admin.query('INSERT INTO llenamos.identities(uid,session_version,tokens_valid_after,locked) VALUES($1,$2,to_timestamp(100),false)',[uid,version.repeat(32)])
      identities[uid]=token(uid,version)
    }
    for(const rid of ['tenant-a','tenant-b'])await admin.query('INSERT INTO llenamos.restaurants(id,name,slug) VALUES($1,$2,$1)',[rid,`Restaurante ${rid}`])
    for(const [rid,uid,role] of [['tenant-a','owner-a','owner'],['tenant-b','owner-b','owner'],['tenant-a','waiter-a','waiter'],['tenant-a','limited','manager']])
      await admin.query('INSERT INTO llenamos.memberships(restaurant_id,uid,role,active,display_name,email) VALUES($1,$2::text,$3,true,$2::text,$4)',[rid,uid,role,`${uid}@example.test`])
    await addLocation('tenant-a','a-uno');await addLocation('tenant-b','b-uno')
    server=apiServer(app,async value=>{const found=identities[value];if(!found)throw Object.assign(new Error('no'),{status:401});return found},()=>{},{},
      {modules:[fixture],live:{listenUrl:url.toString(),pollMs:300,backupPollMs:300,wakeJitterMs:20,heartbeatMs:200,maxPerIdentity:3}})
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
    const address=server.address();if(!address||typeof address==='string')throw new Error('address')
    base=`http://127.0.0.1:${address.port}`
  },30_000)
  afterAll(async()=>{
    await new Promise<void>(resolve=>{server?.close(()=>resolve());server?.closeAllConnections?.()})
    for(const pool of [app,admin])pool?.on('error',error=>{if((error as {code?:string}).code!=='57P01')throw error})
    await app?.end();await admin?.end()
    if(owned){await bootstrap.query(`DROP DATABASE ${database} WITH(FORCE)`);await bootstrap.query(`DROP ROLE IF EXISTS ${runtime}`)}
    await bootstrap?.end()
  })
  it('manda la foto inicial y refresca solo con eventos de sus temas, con latido y sin datos de otro restaurante',async()=>{
    const live=await open(base,'localesPrueba','owner-a',{restaurantId:'tenant-a'})
    expect(live.response.status).toBe(200)
    expect(live.response.headers.get('content-type')).toContain('text/event-stream')
    await live.until(()=>live.snapshots().length===1)
    expect(JSON.parse(live.snapshots()[0]!.data!)).toEqual({names:['a-uno']})
    await addLocation('tenant-b','b-dos');await emit('tenant-b','pruebas.local')
    await addLocation('tenant-a','a-dos');await emit('tenant-a','otro.tema')
    await live.until(()=>live.frames.some(frame=>frame.comment==='ping'))
    expect(live.snapshots()).toHaveLength(1)
    await emit('tenant-a','pruebas.local')
    await live.until(()=>live.snapshots().length===2)
    expect(JSON.parse(live.snapshots()[1]!.data!)).toEqual({names:['a-dos','a-uno']})
    await addLocation('tenant-a','a-tres');await emit('tenant-a','ajuste.horarios')
    await live.until(()=>live.snapshots().length===3)
    expect(JSON.parse(live.snapshots()[2]!.data!).names).toContain('a-tres')
    await live.close()
  })
  it('reanuda con Last-Event-ID: sin eventos nuevos no repite la foto y con eventos la envía',async()=>{
    const first=await open(base,'localesPrueba','owner-a',{restaurantId:'tenant-a'})
    await first.until(()=>first.snapshots().length===1)
    const id=first.snapshots()[0]!.id!
    expect(id).toMatch(/^\d+$/)
    await first.close()
    const again=await open(base,'localesPrueba','owner-a',{restaurantId:'tenant-a'},{'Last-Event-ID':id})
    await again.until(()=>again.frames.some(frame=>frame.event==='ready'))
    expect(again.snapshots()).toHaveLength(0)
    await addLocation('tenant-a','a-cuatro');await emit('tenant-a','pruebas.local')
    await again.until(()=>again.snapshots().length===1)
    expect(JSON.parse(again.snapshots()[0]!.data!).names).toContain('a-cuatro')
    await again.close()
    const stale=await open(base,'localesPrueba','owner-a',{restaurantId:'tenant-a'},{'Last-Event-ID':id})
    await stale.until(()=>stale.snapshots().length===1)
    await stale.close()
  })
  it('un evento de una transacción lenta no se pierde aunque otra posterior ya se haya confirmado',async()=>{
    const live=await open(base,'localesPrueba','owner-a',{restaurantId:'tenant-a'})
    await live.until(()=>live.snapshots().length===1)
    const before=live.snapshots().length
    const slow=await admin.connect(),fast=await admin.connect()
    try {
      await slow.query('BEGIN')
      await slow.query("INSERT INTO llenamos.locations(restaurant_id,id,name,slug) VALUES('tenant-a','lenta','lenta','lenta')")
      await slow.query("INSERT INTO llenamos.events(restaurant_id,topic) VALUES('tenant-a','pruebas.local')")
      await fast.query("INSERT INTO llenamos.locations(restaurant_id,id,name,slug) VALUES('tenant-a','rapida','rapida','rapida')")
      await fast.query("INSERT INTO llenamos.events(restaurant_id,topic) VALUES('tenant-a','pruebas.local')")
      await new Promise(resolve=>setTimeout(resolve,900))
      expect(live.snapshots()).toHaveLength(before)
      await slow.query('COMMIT')
      await live.until(()=>live.snapshots().length>before)
      const names=JSON.parse(live.snapshots().at(-1)!.data!).names as string[]
      expect(names).toEqual(expect.arrayContaining(['lenta','rapida']))
    } finally { slow.release();fast.release();await live.close() }
  })
  it('exige Bearer válido (nunca en query), rol permitido y pertenencia al restaurante',async()=>{
    expect((await open(base,'localesPrueba',null,{restaurantId:'tenant-a'})).response.status).toBe(401)
    const query=await fetch(`${base}/v1/live/localesPrueba?access_token=owner-a`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:{restaurantId:'tenant-a'}})})
    expect(query.status).toBe(401)
    expect((await open(base,'localesPrueba','owner-b',{restaurantId:'tenant-a'})).response.status).toBe(403)
    expect((await open(base,'localesPrueba','waiter-a',{restaurantId:'tenant-a'})).response.status).toBe(403)
    expect((await open(base,'rotaPrueba','limited',{restaurantId:'tenant-a'})).response.status).toBe(403)
    expect((await open(base,'localesPrueba','owner-a',{restaurantId:123})).response.status).toBe(400)
    expect((await open(base,'inexistente','owner-a',{restaurantId:'tenant-a'})).response.status).toBe(404)
    const get=await fetch(`${base}/v1/live/localesPrueba`,{headers:{Authorization:'Bearer owner-a'}})
    expect(get.status).toBe(405)
  })
  it('limita las conexiones por identidad y libera el cupo al cerrar',async()=>{
    const open3=await Promise.all([1,2,3].map(()=>open(base,'localesPrueba','owner-a',{restaurantId:'tenant-a'})))
    for(const live of open3)expect(live.response.status).toBe(200)
    const excess=await open(base,'localesPrueba','owner-a',{restaurantId:'tenant-a'})
    expect(excess.response.status).toBe(429)
    await open3[0]!.close()
    const limit=Date.now()+3000
    let retry=429
    while(retry===429&&Date.now()<limit){const next=await open(base,'localesPrueba','owner-a',{restaurantId:'tenant-a'});retry=next.response.status;if(retry===200)open3.push(next);else await new Promise(resolve=>setTimeout(resolve,100))}
    expect(retry).toBe(200)
    for(const live of open3)await live.close()
    // owner-b no comparte cupo con owner-a
    const other=await open(base,'localesPrueba','owner-b',{restaurantId:'tenant-b'})
    expect(other.response.status).toBe(200)
    await other.close()
  })
  it('cierra el flujo al revocar la sesión o desactivar al miembro',async()=>{
    const session=await open(base,'localesPrueba','owner-b',{restaurantId:'tenant-b'})
    await session.until(()=>session.snapshots().length===1)
    await admin.query("UPDATE llenamos.identities SET tokens_valid_after=to_timestamp(101) WHERE uid='owner-b'")
    await session.until(()=>session.ended)
    expect(session.frames.some(frame=>frame.event==='error'&&JSON.parse(frame.data!).code==='unauthenticated')).toBe(true)
    await admin.query("UPDATE llenamos.identities SET tokens_valid_after=to_timestamp(100) WHERE uid='owner-b'")
    const member=await open(base,'localesPrueba','owner-b',{restaurantId:'tenant-b'})
    await member.until(()=>member.snapshots().length===1)
    await admin.query("UPDATE llenamos.memberships SET active=false WHERE uid='owner-b'")
    await member.until(()=>member.ended)
    expect(member.frames.some(frame=>frame.event==='error'&&JSON.parse(frame.data!).code==='permission-denied')).toBe(true)
    await admin.query("UPDATE llenamos.memberships SET active=true WHERE uid='owner-b'")
  })
  it('una foto que incumple su contrato no se entrega y cierra con error',async()=>{
    const live=await open(base,'rotaPrueba','owner-a',{restaurantId:'tenant-a'})
    expect(live.response.status).toBe(500)
    await live.close()
  })
  it('el apagado cierra los flujos abiertos con un aviso para reconectar',async()=>{
    const extra=apiServer(app,async value=>identities[value]!,()=>{},{},{modules:[fixture],live:{pollMs:300}})
    await new Promise<void>(resolve=>extra.listen(0,'127.0.0.1',resolve))
    const address=extra.address();if(!address||typeof address==='string')throw new Error('address')
    const live=await open(`http://127.0.0.1:${address.port}`,'localesPrueba','owner-a',{restaurantId:'tenant-a'})
    await live.until(()=>live.snapshots().length===1)
    const closed=new Promise<void>(resolve=>extra.close(()=>resolve()))
    await live.until(()=>live.ended)
    await closed
    expect(live.frames.at(-1)).toMatchObject({event:'end'})
  })
})
