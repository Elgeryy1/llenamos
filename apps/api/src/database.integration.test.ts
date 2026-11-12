import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { afterAll,beforeAll,describe,expect,it } from 'vitest'
import { Pool } from 'pg'
import { checkRuntimeRole,withIdentity } from './database.js'
import { apiServer } from './server.js'
import type { IdentityToken } from './auth.js'

const source=process.env.TEST_POSTGRES_URL
const enabled=process.env.TEST_POSTGRES_API==='1' && !!source
const identity=(uid:string,version:string,platformClaim=false):IdentityToken=>({uid,sessionVersion:version.repeat(32),authTime:100,platformClaim})
describe.skipIf(!enabled)('PostgreSQL real: RLS, sesiones y aislamiento del pool',()=>{
  let admin:Pool,app:Pool
  beforeAll(async()=>{
    const url=new URL(source!)
    if(!['localhost','127.0.0.1'].includes(url.hostname)||!url.pathname.startsWith('/llenamos_api_test_'))throw new Error('Estas pruebas solo aceptan la base temporal loopback llenamos_api_test_*.')
    admin=new Pool({connectionString:source,max:1})
    await admin.query(readFileSync(new URL('../migrations/001_foundation.sql',import.meta.url),'utf8'))
    await admin.query(readFileSync(new URL('../migrations/002_platform.sql',import.meta.url),'utf8'))
    await admin.query("DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'llenamos_api_test') THEN CREATE ROLE llenamos_api_test LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD 'fixture-only' IN ROLE llenamos_app; END IF; END $$;")
    url.username='llenamos_api_test';url.password='fixture-only'
    app=new Pool({connectionString:url.toString(),max:1})
    for(const [uid,version,platform] of [['alice','a',false],['bob','b',false],['operator','c',true],['staff','d',false]] as const)
      await admin.query('INSERT INTO llenamos.identities(uid,session_version,tokens_valid_after,locked,platform_operator) VALUES($1,$2,to_timestamp(100),false,$3)',[uid,version.repeat(32),platform])
    for(const id of ['a','b','c'])await admin.query('INSERT INTO llenamos.restaurants(id,name,slug) VALUES($1,$2,$1)',[id,`Restaurante ${id}`])
    for(const [rid,uid,role,locations] of [['a','alice','owner',[]],['c','alice','manager',[]],['b','bob','owner',[]],['a','operator','owner',[]],['a','staff','waiter',['a-main']],['c','staff','waiter',[]]] as const)
      await admin.query('INSERT INTO llenamos.memberships(restaurant_id,uid,role,active,display_name,email,location_ids) VALUES($1,$2::text,$3,true,$2::text,$4,$5)',[rid,uid,role,`${uid}@example.test`,locations])
    for(const id of ['a','b'])await admin.query('INSERT INTO llenamos.platform_restaurants(restaurant_id,name,slug,plan_id,owner_email) VALUES($1,$2,$1,$3,$4)',[id,`Restaurante ${id}`,'sala',`${id}@example.test`])
    for(const [rid,id] of [['a','a-main'],['a','a-private'],['b','b-main'],['c','c-main']])
      await admin.query('INSERT INTO llenamos.locations(restaurant_id,id,name,slug) VALUES($1,$2,$2,$2)',[rid,id])
    for(const id of ['a','b'])await admin.query('INSERT INTO llenamos.outbox(id,restaurant_id,kind,payload) VALUES($1,$2,$3,$4)',[randomUUID(),id,'fixture',JSON.stringify({source:id})])
  },30_000)
  afterAll(async()=>{await app?.end();await admin?.end()})
  it('rechaza usar bootstrap/superusuario y acepta runtime sin propiedad',async()=>{
    await expect(checkRuntimeRole(admin)).rejects.toThrow('rol de ejecución')
    await expect(checkRuntimeRole(app)).resolves.toBeUndefined()
  })
  it('RLS impide lecturas e inserciones de otro restaurante aunque la consulta omita WHERE',async()=>{
    await withIdentity(app,identity('alice','a'),'a',async client=>{
      expect((await client.query('SELECT restaurant_id FROM llenamos.outbox')).rows).toEqual([{restaurant_id:'a'}])
    })
    await expect(withIdentity(app,identity('alice','a'),'b',client=>client.query('INSERT INTO llenamos.outbox(id,restaurant_id,kind,payload) VALUES($1,$2,$3,$4)',[randomUUID(),'b','forbidden','{}']))).rejects.toThrow(/row-level security/)
  })
  it('LogiQD no accede al interior aunque haya membresía owner; sí metadata administrativa',async()=>{
    await withIdentity(app,identity('operator','c',true),'a',async(client,platform)=>{
      expect(platform).toBe(true)
      for(const table of ['memberships','restaurants','locations','outbox'])expect((await client.query(`SELECT * FROM llenamos.${table}`)).rows).toEqual([])
      expect((await client.query('SELECT restaurant_id FROM llenamos.platform_restaurants ORDER BY restaurant_id')).rows).toEqual([{restaurant_id:'a'},{restaurant_id:'b'}])
    })
  })
  it('el claim no concede acceso administrativo si SQL no lo autoriza',async()=>{
    await expect(withIdentity(app,identity('alice','a',true),null,async()=>null)).rejects.toMatchObject({status:403})
  })
  it('deniega sesiones antiguas/desactivadas por estado SQL en cada petición',async()=>{
    await expect(withIdentity(app,identity('alice','b'),'a',async()=>null)).rejects.toMatchObject({status:401})
    await admin.query("UPDATE llenamos.identities SET tokens_valid_after=to_timestamp(101) WHERE uid='alice'")
    await expect(withIdentity(app,identity('alice','a'),'a',async()=>null)).rejects.toMatchObject({status:401})
    await admin.query("UPDATE llenamos.identities SET tokens_valid_after=to_timestamp(100) WHERE uid='alice'")
  })
  it('COMMIT y ROLLBACK limpian el contexto al reutilizar una sola conexión',async()=>{
    await withIdentity(app,identity('alice','a'),'a',async()=>null)
    expect((await app.query("SELECT nullif(current_setting('app.actor_uid',true),'') AS actor")).rows[0].actor).toBeNull()
    await expect(withIdentity(app,identity('alice','a'),'a',async()=>{throw new Error('fixture rollback')})).rejects.toThrow('fixture rollback')
    await withIdentity(app,identity('bob','b'),'b',async client=>expect((await client.query('SELECT restaurant_id FROM llenamos.outbox')).rows).toEqual([{restaurant_id:'b'}]))
    expect((await app.query('SELECT * FROM llenamos.outbox')).rows).toEqual([])
  })
  it('el contexto elegido y las restricciones por local se aplican también si falta WHERE',async()=>{
    await withIdentity(app,identity('staff','d'),'a',async client=>{
      expect((await client.query('SELECT id FROM llenamos.locations')).rows).toEqual([{id:'a-main'}])
    })
    await withIdentity(app,identity('staff','d'),'b',async client=>{
      expect((await client.query('SELECT id FROM llenamos.locations')).rows).toEqual([])
    })
  })
  it('HTTP exige Bearer y no devuelve claves/estado de sesión ni datos operativos a plataforma',async()=>{
    const server=apiServer(app,async value=>value==='operator'?identity('operator','c',true):identity('alice','a'))
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
    const address=server.address();if(!address||typeof address==='string')throw new Error('server address')
    const base=`http://127.0.0.1:${address.port}`
    try {
      expect((await fetch(`${base}/healthz`)).status).toBe(200)
      expect((await fetch(`${base}/v1/session`)).status).toBe(401)
      const response=await fetch(`${base}/v1/session`,{headers:{Authorization:'Bearer operator'}})
      expect(await response.json()).toEqual({uid:'operator',access:'platform',memberships:[]})
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect((await fetch(`${base}/v1/admin/restaurants`,{headers:{Authorization:'Bearer alice'}})).status).toBe(403)
      const profile=await (await fetch(`${base}/v1/session`,{headers:{Authorization:'Bearer alice'}})).json() as {memberships:{restaurantId:string}[]}
      expect(profile.memberships.map(row=>row.restaurantId)).toEqual(['a','c'])
    } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
  })
  it('HTTP sirve contexto real, deniega otro restaurante y no permite entrar a LogiQD',async()=>{
    const server=apiServer(app,async value=>value==='operator'?identity('operator','c',true):value==='staff'?identity('staff','d'):identity('alice','a'))
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
    const address=server.address();if(!address||typeof address==='string')throw new Error('server address')
    const base=`http://127.0.0.1:${address.port}`
    try {
      const response=await fetch(`${base}/v1/restaurants/a/context`,{headers:{Authorization:'Bearer alice'}})
      expect(response.status).toBe(200)
      const context=await response.json() as {restaurant:{id:string;isDemo:boolean};member:{uid:string};locations:{id:string}[]}
      expect(context.restaurant).toMatchObject({id:'a',name:'Restaurante a',isDemo:false,currency:'EUR'})
      expect(context.member.uid).toBe('alice')
      expect(context.locations.map(row=>row.id)).toEqual(['a-main','a-private'])
      const staff=await(await fetch(`${base}/v1/restaurants/a/context`,{headers:{Authorization:'Bearer staff'}})).json() as {locations:{id:string}[]}
      expect(staff.locations.map(row=>row.id)).toEqual(['a-main'])
      for(const [rid,token] of [['b','alice'],['a','operator']])expect((await fetch(`${base}/v1/restaurants/${rid}/context`,{headers:{Authorization:`Bearer ${token}`}})).status).toBe(403)
    } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
  })
  it('el registry solo ejecuta operaciones registradas con parámetros y rol válidos',async()=>{
    const server=apiServer(app,async value=>value==='operator'?identity('operator','c',true):identity('alice','a'))
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
    const address=server.address();if(!address||typeof address==='string')throw new Error('server address')
    const base=`http://127.0.0.1:${address.port}/v1/operations`
    const headers={Authorization:'Bearer operator','Content-Type':'application/json'}
    const call=(data:unknown,token='operator')=>fetch(`${base}/listarRestaurantesAdministracion`,{method:'POST',headers:{...headers,Authorization:`Bearer ${token}`},body:JSON.stringify({data})})
    try {
      expect((await fetch(`${base}/operacionInexistente`,{method:'POST',headers,body:'{"data":{}}'})).status).toBe(404)
      expect((await fetch(`${base}/listarRestaurantesAdministracion`,{headers})).status).toBe(405)
      expect((await fetch(`${base}/listarRestaurantesAdministracion`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"data":{}}'})).status).toBe(401)
      expect((await call({},'alice')).status).toBe(403)
      expect((await call({limit:101})).status).toBe(400)
      expect((await call({uid:'operator'})).status).toBe(400)
      const first=await call({limit:1})
      expect(first.status).toBe(200)
      expect(await first.json()).toEqual({result:{restaurants:[{restaurantId:'a',name:'Restaurante a',slug:'a',ownerEmail:'a@example.test',planId:'sala',planVersion:1,status:'trialing',activeModules:[],moduleOverrides:{},revision:1}],nextCursor:'a'}})
      const second=await(await call({limit:1,cursor:'a'})).json() as {result:{restaurants:{restaurantId:string}[];nextCursor:string|null}}
      expect(second.result.restaurants.map(row=>row.restaurantId)).toEqual(['b'])
      expect(second.result.nextCursor).toBeNull()
    } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
  })
  it('HTTP limita bytes, formato JSON y envelope sin exponer cuerpos en errores',async()=>{
    const server=apiServer(app,async()=>identity('operator','c',true))
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
    const address=server.address();if(!address||typeof address==='string')throw new Error('server address')
    const url=`http://127.0.0.1:${address.port}/v1/operations/listarRestaurantesAdministracion`
    try {
      for(const [contentType,body,status] of [['text/plain','{}',415],['application/json','{',400],['application/json','{}',400],['application/json','{"data":{},"uid":"operator"}',400],['application/json','x'.repeat(65_537),413]] as const) {
        const response=await fetch(url,{method:'POST',headers:{Authorization:'Bearer operator','Content-Type':contentType},body})
        expect(response.status).toBe(status)
        expect(await response.json()).toHaveProperty('error.requestId')
      }
      // Sin Content-Length: el límite también se comprueba durante el streaming.
      const status=await new Promise<number>((resolve,reject)=>{
        const request=httpRequest(url,{method:'POST',headers:{Authorization:'Bearer operator','Content-Type':'application/json','Transfer-Encoding':'chunked'}},response=>{response.resume();resolve(response.statusCode!)})
        request.on('error',reject);request.write('x'.repeat(40_000));request.end('x'.repeat(40_000))
      })
      expect(status).toBe(413)
    } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
  })
})
