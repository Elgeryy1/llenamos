import { randomUUID } from 'node:crypto'
import { afterAll,beforeAll,describe,expect,it } from 'vitest'
import { Pool } from 'pg'
import { migrationSql } from '../../test-migrations.js'
import { apiServer } from '../../server.js'
import { withIdentity } from '../../database.js'
import { createInvitationService } from '../../invitations/service.js'
import type { InvitationAuthAdmin } from '../../invitations/auth-admin.js'
import type { IdentityToken } from '../../auth.js'

const source=process.env.TEST_POSTGRES_URL
const enabled=process.env.TEST_POSTGRES_API==='1'&&!!source
const token=(uid:string,version:string):IdentityToken=>({uid,sessionVersion:version.repeat(32),authTime:100,platformClaim:false})
describe.skipIf(!enabled)('Panel: ajustes y contexto en vivo sobre PostgreSQL real',()=>{
  let bootstrap:Pool,admin:Pool,app:Pool,owned=false,server:ReturnType<typeof apiServer>,base:string
  const suffix=randomUUID().replaceAll('-','').slice(0,12),database=`llenamos_api_test_panel_${suffix}`,runtime=`llenamos_api_panel_${suffix}`
  const identities:Record<string,IdentityToken>={}
  const call=async(name:string,actor:string,data:unknown)=>{
    const response=await fetch(`${base}/v1/operations/${name}`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${actor}`},body:JSON.stringify({data})})
    return {status:response.status,body:await response.json() as {result?:any;error?:{code:string}}}
  }
  /** Lee tramas SSE hasta tener las pedidas. */
  async function stream(actor:string,rid:string,count:number,trigger:()=>Promise<unknown>) {
    const controller=new AbortController()
    const response=await fetch(`${base}/v1/live/contextoRestaurante`,{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json',Authorization:`Bearer ${actor}`},body:JSON.stringify({data:{restaurantId:rid}})})
    const reader=response.body!.getReader(),decoder=new TextDecoder(),snapshots:any[]=[]
    let buffer='',fired=false
    const limit=Date.now()+8000
    while(snapshots.length<count&&Date.now()<limit) {
      const {value,done}=await reader.read()
      if(done)break
      buffer+=decoder.decode(value,{stream:true})
      for(let at=buffer.indexOf('\n\n');at>=0;at=buffer.indexOf('\n\n')) {
        const block=buffer.slice(0,at);buffer=buffer.slice(at+2)
        if(block.includes('event: snapshot'))snapshots.push(JSON.parse(block.split('\n').find(line=>line.startsWith('data: '))!.slice(6)))
      }
      if(!fired&&snapshots.length>=1){fired=true;await trigger()}
    }
    controller.abort()
    return snapshots
  }
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
    for(const [uid,version] of [['owner-a','a'],['manager-a','b'],['waiter-a','c'],['owner-b','d']] as const) {
      await admin.query('INSERT INTO llenamos.identities(uid,session_version,tokens_valid_after,locked) VALUES($1,$2,to_timestamp(100),false)',[uid,version.repeat(32)])
      identities[uid]=token(uid,version)
    }
    for(const rid of ['tenant-a','tenant-b']) {
      await admin.query('INSERT INTO llenamos.restaurants(id,name,slug) VALUES($1,$2,$1)',[rid,`Restaurante ${rid}`])
      await admin.query('INSERT INTO llenamos.locations(restaurant_id,id,name,slug) VALUES($1,$2,$2,$2)',[rid,`${rid}-main`])
    }
    for(const [rid,uid,role] of [['tenant-a','owner-a','owner'],['tenant-a','manager-a','manager'],['tenant-a','waiter-a','waiter'],['tenant-b','owner-b','owner']])
      await admin.query('INSERT INTO llenamos.memberships(restaurant_id,uid,role,active,display_name,email) VALUES($1,$2::text,$3,true,$2::text,$4)',[rid,uid,role,`${uid}@example.test`])
    const auth:InvitationAuthAdmin={resolveAccount:async()=>{throw new Error('no usado')},account:async()=>{throw new Error('no usado')},proveMailbox:async()=>Date.now()}
    const invitations=createInvitationService(app,auth,{encryptionKey:Buffer.alloc(32,9)})
    server=apiServer(app,async value=>{const found=identities[value];if(!found)throw Object.assign(new Error('no'),{status:401});return found},()=>{},{invitations},{live:{pollMs:200,refreshMs:60_000}})
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
  it('owner y manager cambian nombre, color e idioma; el equipo lo ve al momento en su contexto en vivo',async()=>{
    const snapshots=await stream('waiter-a','tenant-a',2,async()=>{
      const saved=await call('guardarAjustesRestaurante','owner-a',{restaurantId:'tenant-a',name:'Taberna nueva',brandColor:'#AABBCC',locale:'ca'})
      expect(saved.status,JSON.stringify(saved.body)).toBe(200)
    })
    expect(snapshots).toHaveLength(2)
    expect(snapshots[0].restaurant.name).toBe('Restaurante tenant-a')
    expect(snapshots[1].restaurant).toMatchObject({id:'tenant-a',name:'Taberna nueva',brandColor:'#aabbcc',locale:'ca'})
    expect(snapshots[1].member.role).toBe('waiter')
    expect((await call('guardarAjustesRestaurante','manager-a',{restaurantId:'tenant-a',locale:'es'})).status).toBe(200)
  })
  it('camarero, otro restaurante y datos inválidos se rechazan; el rol HTTP no escribe restaurants',async()=>{
    expect((await call('guardarAjustesRestaurante','waiter-a',{restaurantId:'tenant-a',name:'Intruso'})).status).toBe(403)
    expect((await call('guardarAjustesRestaurante','owner-b',{restaurantId:'tenant-a',name:'Intruso'})).status).toBe(403)
    expect((await call('guardarAjustesRestaurante','owner-a',{restaurantId:'tenant-a',brandColor:'rojo'})).status).toBe(400)
    expect((await call('guardarAjustesRestaurante','owner-a',{restaurantId:'tenant-a'})).status).toBe(400)
    expect((await call('guardarAjustesRestaurante','owner-a',{restaurantId:'tenant-a',name:'X',slug:'otro'})).status).toBe(400)
    await expect(withIdentity(app,identities['owner-a']!,'tenant-a',client=>client.query("UPDATE llenamos.restaurants SET name='directo'"))).rejects.toThrow(/permission denied/)
    expect((await admin.query("SELECT name FROM llenamos.restaurants WHERE id='tenant-b'")).rows[0].name).toBe('Restaurante tenant-b')
    expect((await admin.query("SELECT name FROM llenamos.restaurants WHERE id='tenant-a'")).rows[0].name).toBe('Taberna nueva')
  })
  it('un cambio que no pasa por eventos (plan/módulos desde plataforma) llega por la relectura periódica',async()=>{
    const quick=apiServer(app,async value=>identities[value]!,()=>{},{},{live:{pollMs:200,refreshMs:400}})
    await new Promise<void>(resolve=>quick.listen(0,'127.0.0.1',resolve))
    const address=quick.address() as {port:number},previous=base
    base=`http://127.0.0.1:${address.port}`
    try {
      const snapshots=await stream('owner-a','tenant-a',2,()=>admin.query("UPDATE llenamos.restaurants SET plan='completo' WHERE id='tenant-a'"))
      expect(snapshots).toHaveLength(2)
      expect(snapshots[1].restaurant.plan).toBe('completo')
    } finally { base=previous;quick.closeAllConnections();await new Promise<void>(resolve=>quick.close(()=>resolve())) }
  })
  it('cambiar el rol de un miembro se ve en su contexto y perder la membresía cierra su flujo',async()=>{
    const changed=await stream('waiter-a','tenant-a',2,async()=>{
      expect((await call('cambiarRolMiembro','owner-a',{restaurantId:'tenant-a',uid:'waiter-a',role:'kitchen'})).status).toBe(200)
    })
    expect(changed[1].member.role).toBe('kitchen')
    const controller=new AbortController()
    const response=await fetch(`${base}/v1/live/contextoRestaurante`,{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json',Authorization:'Bearer waiter-a'},body:JSON.stringify({data:{restaurantId:'tenant-a'}})})
    const reader=response.body!.getReader(),decoder=new TextDecoder()
    let text='',deactivated=false
    const limit=Date.now()+8000
    while(Date.now()<limit) {
      const {value,done}=await reader.read()
      if(done)break
      text+=decoder.decode(value,{stream:true})
      if(!deactivated&&text.includes('event: snapshot')){deactivated=true;await admin.query("UPDATE llenamos.memberships SET active=false WHERE uid='waiter-a'")}
    }
    controller.abort()
    expect(text).toContain('event: error')
    expect(text).toContain('permission-denied')
  })
  it('desactivar a un miembro cierra su flujo en vivo y no filtra datos de otro restaurante',async()=>{
    expect((await call('guardarAjustesRestaurante','owner-b',{restaurantId:'tenant-b',name:'Otra casa'})).status).toBe(200)
    const own=await stream('owner-a','tenant-a',1,async()=>undefined)
    expect(own[0].restaurant.id).toBe('tenant-a')
    expect(JSON.stringify(own)).not.toContain('Otra casa')
    const denied=await fetch(`${base}/v1/live/contextoRestaurante`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer owner-a'},body:JSON.stringify({data:{restaurantId:'tenant-b'}})})
    expect(denied.status).toBe(403)
  })
  it('la función SQL de ajustes se defiende sola: camarero y otro restaurante reciben 42501 sin pasar por la API; nombre, color e idioma se validan y se guarda el autor',async()=>{
    const save=(uid:string,rid:string,name:string|null,color:string|null=null,locale:string|null=null)=>withIdentity(app,identities[uid]!,rid,client=>client.query('SELECT llenamos.restaurant_settings_save($1,$2,$3,$4)',[rid,name,color,locale]))
    await expect(save('waiter-a','tenant-a','Intruso')).rejects.toMatchObject({code:'42501'})
    await expect(save('owner-b','tenant-a','Intruso')).rejects.toMatchObject({code:'42501'})
    await expect(save('owner-a','tenant-a','X')).rejects.toMatchObject({code:'22023'})
    await expect(save('owner-a','tenant-a','   Y   ')).rejects.toMatchObject({code:'22023'})
    await expect(save('owner-a','tenant-a','n'.repeat(81))).rejects.toMatchObject({code:'22023'})
    await expect(save('owner-a','tenant-a',null,'rojo')).rejects.toMatchObject({code:'22023'})
    await expect(save('owner-a','tenant-a',null,null,'fr')).rejects.toMatchObject({code:'22023'})
    await save('manager-a','tenant-a','  Casa Mar  ','#ABCDEF')
    expect((await admin.query("SELECT name,brand_color,updated_by,updated_at IS NOT NULL AS dated FROM llenamos.restaurants WHERE id='tenant-a'")).rows[0]).toEqual({name:'Casa Mar',brand_color:'#abcdef',updated_by:'manager-a',dated:true})
    expect((await call('guardarAjustesRestaurante','owner-a',{restaurantId:'tenant-a',name:' '})).status).toBe(400)
  })
})
