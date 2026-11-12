import { randomUUID } from 'node:crypto'
import { afterAll,afterEach,beforeAll,beforeEach,describe,expect,it } from 'vitest'
import { Pool } from 'pg'
import * as core from '@llenamos/core'
import { migrationSql } from '../../test-migrations.js'
import { apiServer } from '../../server.js'
import { ApiError } from '../../errors.js'
import { withIdentity } from '../../database.js'
import type { IdentityToken } from '../../auth.js'
import { registerSyncEntities,registerSyncExecutor } from './index.js'
import { resetSyncRegistry } from './registry.js'

const source=process.env.TEST_POSTGRES_URL
const enabled=process.env.TEST_POSTGRES_API==='1'&&!!source
const token=(uid:string,version:string):IdentityToken=>({uid,sessionVersion:version.repeat(32),authTime:100,platformClaim:false})
describe.skipIf(!enabled)('Sincronización sin conexión sobre PostgreSQL real',()=>{
  let bootstrap:Pool,admin:Pool,app:Pool,owned=false,server:ReturnType<typeof apiServer>,base:string
  const suffix=randomUUID().replaceAll('-','').slice(0,12),database=`llenamos_api_test_sync_${suffix}`,runtime=`llenamos_api_sync_${suffix}`
  const identities:Record<string,IdentityToken>={}
  const device=(n:number)=>`tablet_0000000000${n}`.slice(0,18)
  let failWith:Error|null=null
  const call=async(name:string,actor:string,data:unknown)=>{
    const response=await fetch(`${base}/v1/operations/${name}`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${actor}`},body:JSON.stringify({data})})
    return {status:response.status,body:await response.json() as {result?:any;error?:{code:string}}}
  }
  const command=(overrides:{rid?:string;uid?:string;device?:string;sequence?:number;task?:string;version?:string;action?:string;commandId?:string;clientCreatedAt?:number}={})=>{
    const rid=overrides.rid??'tenant-a',uid=overrides.uid??'waiter-a',task=overrides.task??'tarea1'
    return core.OfflineCommandSchema.parse({actorUid:uid,restaurantId:rid,locationId:`${rid}-main`,deviceId:overrides.device??device(1),commandId:overrides.commandId??randomUUID(),sequence:overrides.sequence??1,
      clientCreatedAt:overrides.clientCreatedAt??Date.now(),operation:'cambiarEstadoTarea',payload:{restaurantId:rid,locationId:`${rid}-main`,taskId:task,action:overrides.action??'claim'},
      preconditions:[{kind:'task',id:task,version:overrides.version??'v1'}]})
  }
  const effects=async(rid='tenant-a')=>Number((await admin.query('SELECT count(*) FROM llenamos.test_effects WHERE restaurant_id=$1',[rid])).rows[0].count)
  beforeAll(async()=>{
    const url=new URL(source!)
    if(!['localhost','127.0.0.1'].includes(url.hostname)||!url.pathname.startsWith('/llenamos_api_test_'))throw new Error('Solo PostgreSQL temporal loopback de pruebas.')
    bootstrap=new Pool({connectionString:source,max:1})
    await bootstrap.query(`CREATE DATABASE ${database}`);owned=true
    url.pathname=`/${database}`
    admin=new Pool({connectionString:url.toString(),max:4})
    for(const sql of migrationSql())await admin.query(sql)
    await admin.query(`CREATE ROLE ${runtime} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD 'fixture-only' IN ROLE llenamos_app`)
    await admin.query(`CREATE TABLE llenamos.test_tasks(restaurant_id varchar(128) NOT NULL,id text NOT NULL,status text NOT NULL,claimed_by text,version integer NOT NULL DEFAULT 1,PRIMARY KEY(restaurant_id,id));
      CREATE TABLE llenamos.test_effects(restaurant_id varchar(128) NOT NULL,command_id text NOT NULL);
      ALTER TABLE llenamos.test_tasks ENABLE ROW LEVEL SECURITY;ALTER TABLE llenamos.test_effects ENABLE ROW LEVEL SECURITY;
      CREATE POLICY t ON llenamos.test_tasks USING(llenamos.can_access_restaurant(restaurant_id)) WITH CHECK(llenamos.can_access_restaurant(restaurant_id));
      CREATE POLICY t ON llenamos.test_effects USING(llenamos.can_access_restaurant(restaurant_id)) WITH CHECK(llenamos.can_access_restaurant(restaurant_id));
      GRANT SELECT,INSERT,UPDATE ON llenamos.test_tasks,llenamos.test_effects TO llenamos_app`)
    url.username=runtime;url.password='fixture-only'
    app=new Pool({connectionString:url.toString(),max:8,statement_timeout:5000})
    for(const [uid,version] of [['owner-a','a'],['waiter-a','b'],['kitchen-a','c'],['waiter-b','d'],['bar-a','e']] as const) {
      await admin.query('INSERT INTO llenamos.identities(uid,session_version,tokens_valid_after,locked) VALUES($1,$2,to_timestamp(100),false)',[uid,version.repeat(32)])
      identities[uid]=token(uid,version)
    }
    for(const rid of ['tenant-a','tenant-b']) {
      await admin.query('INSERT INTO llenamos.restaurants(id,name,slug,plan,active_modules) VALUES($1,$2,$1,$3,$4)',[rid,`Restaurante ${rid}`,'sala',['floor','kitchen']])
      await admin.query('INSERT INTO llenamos.locations(restaurant_id,id,name,slug) VALUES($1,$2,$2,$2)',[rid,`${rid}-main`])
    }
    for(const [rid,uid,role] of [['tenant-a','owner-a','owner'],['tenant-a','waiter-a','waiter'],['tenant-a','kitchen-a','kitchen'],['tenant-b','waiter-b','waiter'],['tenant-a','bar-a','bar']])
      await admin.query('INSERT INTO llenamos.memberships(restaurant_id,uid,role,active,display_name,email) VALUES($1,$2::text,$3,true,$2::text,$4)',[rid,uid,role,`${uid}@example.test`])
    server=apiServer(app,async value=>{const found=identities[value];if(!found)throw Object.assign(new Error('no'),{status:401});return found},()=>{})
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
    const address=server.address();if(!address||typeof address==='string')throw new Error('address')
    base=`http://127.0.0.1:${address.port}`
  },30_000)
  beforeEach(async()=>{
    // Sala registra sus ejecutores al cargar los módulos; esta prueba usa los suyos.
    resetSyncRegistry()
    await admin.query('TRUNCATE llenamos.sync_activity,llenamos.sync_resolutions,llenamos.sync_receipts,llenamos.sync_streams,llenamos.sync_devices,llenamos.test_tasks,llenamos.test_effects')
    await admin.query("INSERT INTO llenamos.test_tasks(restaurant_id,id,status) VALUES('tenant-a','tarea1','open'),('tenant-a','tarea2','open'),('tenant-b','tarea1','open')")
    failWith=null
    registerSyncEntities({read:async(client,scope,entities)=>{
      const out=[]
      for(const entity of entities) {
        const {rows}=await client.query('SELECT status,claimed_by,version FROM llenamos.test_tasks WHERE restaurant_id=$1 AND id=$2',[scope.restaurantId,entity.id])
        out.push(rows[0]?{kind:entity.kind,id:entity.id,version:`v${rows[0].version}`,hash:core.sha256Hex(core.canonicalJson(rows[0]))}:null)
      }
      return out
    }})
    registerSyncExecutor('cambiarEstadoTarea',{module:'floor',roles:['owner','manager','waiter','kitchen','bar'],execute:async(client,cmd,actor)=>{
      const payload=cmd.payload as {taskId:string;action:string;restaurantId:string}
      if(payload.action==='cancel'&&actor.role==='kitchen')throw new ApiError(403,'permission-denied','Cocina no cancela tareas.')
      const {rows}=await client.query('SELECT status,claimed_by FROM llenamos.test_tasks WHERE restaurant_id=$1 AND id=$2 FOR UPDATE',[payload.restaurantId,payload.taskId])
      if(!rows[0])throw new ApiError(404,'not-found','No existe.')
      if(payload.action==='claim'&&rows[0].status==='claimed')return {result:'taken',claimedBy:rows[0].claimed_by,claimedByName:null}
      await client.query('INSERT INTO llenamos.test_effects(restaurant_id,command_id) VALUES($1,$2)',[payload.restaurantId,cmd.commandId])
      await client.query("UPDATE llenamos.test_tasks SET status=$3,claimed_by=$4,version=version+1 WHERE restaurant_id=$1 AND id=$2",[payload.restaurantId,payload.taskId,payload.action==='claim'?'claimed':'done',actor.uid])
      if(failWith)throw failWith
      return {result:'ok',status:payload.action==='claim'?'claimed':'done',claimedBy:actor.uid,claimedByName:null}
    }})
  })
  afterEach(()=>resetSyncRegistry())
  afterAll(async()=>{
    await new Promise<void>(resolve=>{server?.close(()=>resolve());server?.closeAllConnections?.()})
    for(const pool of [app,admin])pool?.on('error',error=>{if((error as {code?:string}).code!=='57P01')throw error})
    await app?.end();await admin?.end()
    if(owned){await bootstrap.query(`DROP DATABASE ${database} WITH(FORCE)`);await bootstrap.query(`DROP ROLE IF EXISTS ${runtime}`)}
    await bootstrap?.end()
  })
  it('una respuesta perdida y dos pestañas ejecutan el efecto una vez con un solo recibo; otro contenido con el mismo id se rechaza',async()=>{
    const c=command()
    const [a,b]=await Promise.all([call('sincronizarComando','waiter-a',{command:c}),call('sincronizarComando','waiter-a',{command:c})])
    expect(a.status,JSON.stringify(a.body)).toBe(200);expect(b.status).toBe(200)
    expect(a.body.result.receipt).toEqual(b.body.result.receipt)
    expect(a.body.result.receipt.result.status).toBe('applied')
    expect(await effects()).toBe(1)
    expect(Number((await admin.query('SELECT count(*) FROM llenamos.sync_receipts')).rows[0].count)).toBe(1)
    const recovered=await call('recuperarComando','waiter-a',{actorUid:'waiter-a',restaurantId:'tenant-a',locationId:'tenant-a-main',deviceId:device(1),commandId:c.commandId})
    expect(recovered.body.result.receipt).toEqual(a.body.result.receipt)
    const altered=await call('sincronizarComando','waiter-a',{command:{...c,payload:{...c.payload,action:'done'}}})
    expect(altered.status).toBe(409);expect(altered.body.error?.code).toBe('already-exists')
    expect(await effects()).toBe(1)
  })
  it('dos tablets compiten: la segunda queda en conflicto, bloquea lo posterior hasta descartar con autor y no repite el efecto',async()=>{
    const first=command({device:device(1)}),second=command({device:device(2)})
    expect((await call('sincronizarComando','waiter-a',{command:first})).body.result.receipt.result.status).toBe('applied')
    const lost=await call('sincronizarComando','waiter-a',{command:second})
    expect(lost.body.result.receipt.result).toMatchObject({status:'conflict',code:'stale_version'})
    const next=command({device:device(2),sequence:2,task:'tarea2',version:'v1'})
    const blocked=await call('sincronizarComando','waiter-a',{command:next})
    expect(blocked.status).toBe(503);expect(blocked.body.error?.code).toBe('unavailable')
    const discarded=await call('descartarComando','owner-a',{command:second,requestId:randomUUID(),reason:'Otra tablet ya la cogió. Revisado en sala.'})
    expect(discarded.status,JSON.stringify(discarded.body)).toBe(403) // otro uid no puede descartar la intención de waiter-a
    const ok=await call('descartarComando','waiter-a',{command:second,requestId:randomUUID(),reason:'Otra tablet ya la cogió. Revisado en sala.'})
    expect(ok.body.result.receipt.result.status).toBe('discarded')
    const resolution=await admin.query('SELECT updated_by,reason FROM llenamos.sync_resolutions')
    expect(resolution.rows).toEqual([{updated_by:'waiter-a',reason:'Otra tablet ya la cogió. Revisado en sala.'}])
    expect((await call('sincronizarComando','waiter-a',{command:next})).body.result.receipt.result.status).toBe('applied')
    expect(await effects()).toBe(2)
  })
  it('permisos: uid ajeno, otro restaurante, rol sin permiso del ejecutor, módulo apagado y dispositivo revocado',async()=>{
    expect((await call('sincronizarComando','waiter-a',{command:command({uid:'owner-a'})})).status).toBe(403)
    expect((await call('sincronizarComando','waiter-b',{command:command({uid:'waiter-b'})})).status).toBe(403)
    const rejected=await call('sincronizarComando','kitchen-a',{command:command({uid:'kitchen-a',action:'cancel',device:device(3)})})
    expect(rejected.body.result.receipt.result).toMatchObject({status:'rejected',code:'permission_denied'})
    expect(await effects()).toBe(0)
    await admin.query("UPDATE llenamos.sync_devices SET active=false WHERE device_id=$1",[device(3)])
    expect((await call('sincronizarComando','kitchen-a',{command:command({uid:'kitchen-a',device:device(3),sequence:2,task:'tarea2'})})).status).toBe(403)
    await admin.query("UPDATE llenamos.restaurants SET active_modules='{reservations}' WHERE id='tenant-a'")
    expect((await call('sincronizarComando','waiter-a',{command:command({device:device(4)})})).status).toBe(403)
    await admin.query("UPDATE llenamos.restaurants SET active_modules='{floor,kitchen}' WHERE id='tenant-a'")
  })
  it('aislamiento: un restaurante no ve ni recupera recibos de otro, ni siquiera sin WHERE',async()=>{
    await call('sincronizarComando','waiter-a',{command:command()})
    const other=await call('sincronizarComando','waiter-b',{command:command({rid:'tenant-b',uid:'waiter-b'})})
    expect(other.body.result.receipt.result.status).toBe('applied')
    await withIdentity(app,identities['waiter-b']!,'tenant-b',async client=>{
      expect((await client.query('SELECT restaurant_id FROM llenamos.sync_receipts')).rows).toEqual([{restaurant_id:'tenant-b'}])
      expect((await client.query('SELECT restaurant_id FROM llenamos.sync_streams')).rows).toEqual([{restaurant_id:'tenant-b'}])
    })
    const stolen=await call('recuperarComando','waiter-b',{actorUid:'waiter-b',restaurantId:'tenant-a',locationId:'tenant-a-main',deviceId:device(1),commandId:randomUUID()})
    expect(stolen.status).toBe(403)
  })
  it('un fallo de dominio revierte el efecto y se registra como conflicto; un fallo inesperado no consume la secuencia',async()=>{
    failWith=new ApiError(412,'failed-precondition','Servicio bloqueado.')
    const locked=await call('sincronizarComando','waiter-a',{command:command({device:device(5)})})
    expect(locked.body.result.receipt.result).toMatchObject({status:'conflict',code:'service_locked'})
    expect(await effects()).toBe(0)
    failWith=new Error('caída inesperada')
    const c=command({device:device(6)})
    expect((await call('sincronizarComando','waiter-a',{command:c})).status).toBe(500)
    expect(await effects()).toBe(0)
    expect(Number((await admin.query('SELECT count(*) FROM llenamos.sync_receipts WHERE command_id=$1',[c.commandId])).rows[0].count)).toBe(0)
    failWith=null
    expect((await call('sincronizarComando','waiter-a',{command:c})).body.result.receipt.result.status).toBe('applied')
  })
  it('comandos caducados o con reloj adelantado piden revisión; un hueco de secuencia espera',async()=>{
    const old=await call('sincronizarComando','waiter-a',{command:command({device:device(7),clientCreatedAt:Date.now()-2*86_400_000})})
    expect(old.body.result.receipt.result).toMatchObject({status:'conflict',code:'expired'})
    const gap=await call('sincronizarComando','waiter-a',{command:command({device:device(8),sequence:3})})
    expect(gap.status).toBe(503)
  })
  it('prepararSinConexion entrega versión y huella; una entidad inexistente falla sin inventar versión',async()=>{
    const scope={actorUid:'waiter-a',restaurantId:'tenant-a',locationId:'tenant-a-main',deviceId:device(1)}
    const ok=await call('prepararSinConexion','waiter-a',{...scope,entities:[{kind:'task',id:'tarea1'}]})
    expect(ok.body.result.versions).toEqual([{kind:'task',id:'tarea1',version:'v1'}])
    expect(ok.body.result.contentHashes[0].hash).toMatch(/^[a-f0-9]{64}$/)
    expect((await call('prepararSinConexion','waiter-a',{...scope,entities:[{kind:'task',id:'no-existe'}]})).status).toBe(404)
    expect((await call('prepararSinConexion','waiter-a',{...scope,actorUid:'owner-a',entities:[{kind:'task',id:'tarea1'}]})).status).toBe(403)
  })
  it('sin ejecutor registrado la operación no está desplegada y no guarda nada ni consume secuencia',async()=>{
    resetSyncRegistry()
    const c=command()
    const response=await call('sincronizarComando','waiter-a',{command:c})
    expect(response.status).toBe(404);expect(response.body.error?.code).toBe('not-deployed')
    expect(Number((await admin.query('SELECT count(*) FROM llenamos.sync_receipts')).rows[0].count)).toBe(0)
    expect(Number((await admin.query('SELECT count(*) FROM llenamos.sync_streams')).rows[0].count)).toBe(0)
  })
  it('deja auditoría equivalente a la de Firestore: lo aplicado y el descarte con autor, nombre y motivo',async()=>{
    const first=command({device:device(1)}),second=command({device:device(2)})
    await call('sincronizarComando','waiter-a',{command:first})
    await call('sincronizarComando','waiter-a',{command:second})
    await call('descartarComando','waiter-a',{command:second,requestId:randomUUID(),reason:'Otra tablet ya la cogió. Revisado en sala.'})
    const rows=(await admin.query('SELECT action,summary,actor_uid,actor_name,command_id FROM llenamos.sync_activity ORDER BY id')).rows
    expect(rows).toEqual([
      {action:'sync.cambiarEstadoTarea',summary:'Intención del dispositivo sincronizada.',actor_uid:'waiter-a',actor_name:'waiter-a',command_id:first.commandId},
      {action:'sync.discarded',summary:'Otra tablet ya la cogió. Revisado en sala.',actor_uid:'waiter-a',actor_name:'waiter-a',command_id:second.commandId},
    ])
    await withIdentity(app,identities['waiter-b']!,'tenant-b',async client=>expect((await client.query('SELECT 1 FROM llenamos.sync_activity')).rowCount).toBe(0))
  })
  it('un predecesor suprimido por privacidad no hace fallar con 412 al comando actual; el propio comando suprimido sí',async()=>{
    const predecessor=command({device:device(1)})
    await call('sincronizarComando','waiter-a',{command:predecessor})
    await admin.query('UPDATE llenamos.sync_receipts SET privacy_redacted=true')
    const next=core.OfflineCommandSchema.parse({...command({device:device(1),sequence:2,task:'tarea2',version:'v1'}),preconditions:[{kind:'task',id:'tarea2',version:'v1',afterCommandId:predecessor.commandId}]})
    const response=await call('sincronizarComando','waiter-a',{command:next})
    expect(response.status,JSON.stringify(response.body)).toBe(200)
    expect(response.body.result.receipt.result).toMatchObject({status:'conflict',code:'stale_version'})
    const again=await call('sincronizarComando','waiter-a',{command:predecessor})
    expect(again.status).toBe(412)
  })
})
