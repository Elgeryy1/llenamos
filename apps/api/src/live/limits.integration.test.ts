import { afterAll,beforeAll,describe,expect,it } from 'vitest'
import { Pool,type PoolClient } from 'pg'
import { z } from 'zod'
import { apiServer } from '../server.js'
import { createPool } from '../database.js'
import { emitEvent } from '../events.js'
import { withIdentity } from '../database.js'
import type { IdentityToken } from '../auth.js'
import type { ModuleDefinition } from '../modules/types.js'
import { createTestDatabase,openStream } from '../test-support.js'

const enabled=process.env.TEST_POSTGRES_API==='1'&&!!process.env.TEST_POSTGRES_URL
const token=(uid:string,version:string,exp?:number):IdentityToken=>({uid,sessionVersion:version.repeat(32),authTime:100,platformClaim:false,...(exp?{exp}:{})})
const scope=z.object({restaurantId:z.string()})
const local=z.object({restaurantId:z.string(),locationId:z.string()})
const out=z.object({names:z.array(z.string())})
const names=async(client:PoolClient)=>({names:(await client.query<{name:string}>('SELECT name FROM llenamos.locations ORDER BY name')).rows.map(row=>row.name)})
const fixture:ModuleDefinition={name:'limites',operations:[],liveQueries:[
  {name:'soloOwner',roles:['owner'],input:scope,output:out,restaurantId:value=>scope.parse(value).restaurantId,topics:()=>['pruebas.local'],snapshot:names},
  {name:'porLocal',roles:['owner','manager','waiter'],input:local,output:out,restaurantId:value=>local.parse(value).restaurantId,locationId:value=>local.parse(value).locationId,topics:()=>['pruebas.local'],snapshot:names},
  {name:'enorme',roles:['owner'],input:scope,output:z.object({text:z.string()}),restaurantId:value=>scope.parse(value).restaurantId,topics:()=>['pruebas.local'],snapshot:async()=>({text:'x'.repeat(2_000)})},
]}
describe.skipIf(!enabled)('Tiempo real: capacidad, cursor, caducidad y local asignado',()=>{
  let db:Awaited<ReturnType<typeof createTestDatabase>>,app:Pool,server:ReturnType<typeof apiServer>,base:string
  const identities:Record<string,IdentityToken>={}
  const checkedOut={now:0,max:0},scanFroms:string[]=[],logs:Array<Record<string,unknown>>=[]
  /** Observa el uso real del pool y los cursores de las lecturas. */
  function instrument(pool:Pool) {
    const connect=pool.connect.bind(pool) as () => Promise<PoolClient>
    ;(pool as unknown as {connect:()=>Promise<PoolClient>}).connect=async()=>{
      const client=await connect()
      checkedOut.now+=1;checkedOut.max=Math.max(checkedOut.max,checkedOut.now)
      const release=client.release.bind(client)
      client.release=(error?:boolean|Error)=>{checkedOut.now-=1;client.release=release;release(error)}
      const query=client.query.bind(client) as (...args:unknown[])=>unknown
      ;(client as unknown as {query:(...args:unknown[])=>unknown}).query=(...args)=>{
        if(typeof args[0]==='string'&&args[0].includes('pg_snapshot_xmin')&&Array.isArray(args[1])&&typeof args[1][1]==='string')scanFroms.push(args[1][1])
        return query(...args)
      }
      return client
    }
  }
  const call=async(name:string,actor:string,data:unknown)=>{
    const response=await fetch(`${base}/v1/operations/${name}`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${actor}`},body:JSON.stringify({data})})
    return response.status
  }
  async function start(live:Record<string,unknown>) {
    const next=apiServer(app,async value=>{const found=identities[value];if(!found)throw Object.assign(new Error('no'),{status:401});return found},entry=>logs.push(entry as Record<string,unknown>),{},{modules:[fixture],live})
    await new Promise<void>(resolve=>next.listen(0,'127.0.0.1',resolve))
    return {server:next,base:`http://127.0.0.1:${(next.address() as {port:number}).port}`}
  }
  const stop=async(s:ReturnType<typeof apiServer>)=>{await new Promise<void>(resolve=>{s.close(()=>resolve());s.closeAllConnections?.()})}
  beforeAll(async()=>{
    db=await createTestDatabase('limits')
    app=createPool(db.appUrl)
    instrument(app)
    for(const [uid,version] of [['owner-a','a'],['manager-a','b'],['waiter-a','c'],['owner-b','d'],['short','e']] as const) {
      await db.admin.query('INSERT INTO llenamos.identities(uid,session_version,tokens_valid_after,locked) VALUES($1,$2,to_timestamp(100),false)',[uid,version.repeat(32)])
      identities[uid]=token(uid,version)
    }
    for(const rid of ['tenant-a','tenant-b']) {
      await db.admin.query('INSERT INTO llenamos.restaurants(id,name,slug) VALUES($1,$2,$1)',[rid,`Restaurante ${rid}`])
      for(const l of ['main','other'])await db.admin.query('INSERT INTO llenamos.locations(restaurant_id,id,name,slug) VALUES($1,$2,$2,$2)',[rid,`${rid}-${l}`])
    }
    for(const [rid,uid,role] of [['tenant-a','owner-a','owner'],['tenant-a','manager-a','manager'],['tenant-a','waiter-a','waiter'],['tenant-b','owner-b','owner'],['tenant-a','short','owner']])
      await db.admin.query('INSERT INTO llenamos.memberships(restaurant_id,uid,role,active,display_name,email) VALUES($1,$2::text,$3,true,$2::text,$4)',[rid,uid,role,`${uid}@example.test`])
    const first=await start({pollMs:150,backupPollMs:150,wakeJitterMs:10,heartbeatMs:500})
    server=first.server;base=first.base
  },30_000)
  afterAll(async()=>{await stop(server);await app?.end();await db.drop()})
  const emit=(rid:string,topic:string,uid=rid==='tenant-a'?'owner-a':'owner-b')=>withIdentity(app,identities[uid]!,rid,client=>emitEvent(client,{restaurantId:rid,topic}))

  it('límite global y por restaurante con ráfagas simultáneas; la base nunca usa más de las vueltas permitidas y las operaciones normales siguen atendidas',async()=>{
    const limited=await start({maxTotal:5,maxPerIdentity:100,maxPerRestaurant:4,maxConcurrentDb:2,pollMs:150})
    try {
      checkedOut.max=0
      const burst=await Promise.all(Array.from({length:12},()=>openStream(limited.base,'soloOwner','owner-a',{restaurantId:'tenant-a'})))
      const statuses=burst.map(stream=>stream.response.status).sort()
      expect(statuses.filter(status=>status===200)).toHaveLength(4) // tope por restaurante
      expect(statuses.filter(status=>status===429)).toHaveLength(8)
      expect(checkedOut.max).toBeLessThanOrEqual(2+1) // semáforo de tiempo real (+1 de la petición normal posterior no cuenta aquí)
      const other=await openStream(limited.base,'soloOwner','owner-b',{restaurantId:'tenant-b'})
      expect(other.response.status).toBe(200) // otro restaurante no se ve afectado
      const started=Date.now()
      expect((await fetch(`${limited.base}/v1/operations/listarPlanesDisponibles`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"data":{}}'})).status).toBe(200)
      expect(Date.now()-started).toBeLessThan(2000)
      for(const stream of [...burst,other])await stream.close()
    } finally { await stop(limited.server) }
    const global=await start({maxTotal:3,maxPerIdentity:100,maxPerRestaurant:100,maxConcurrentDb:2})
    try {
      const burst=await Promise.all(Array.from({length:10},()=>openStream(global.base,'soloOwner','owner-a',{restaurantId:'tenant-a'})))
      expect(burst.filter(stream=>stream.response.status===200)).toHaveLength(3)
      expect(burst.filter(stream=>stream.response.status===429)).toHaveLength(7)
      for(const stream of burst)await stream.close()
    } finally { await stop(global.server) }
  })
  it('el cursor avanza al horizonte aunque no lleguen eventos de sus temas',async()=>{
    const live=await openStream(base,'soloOwner','owner-a',{restaurantId:'tenant-a'})
    await live.until(()=>live.snapshots().length===1)
    for(let i=0;i<30;i++)await emit('tenant-a','otro.tema')
    const horizon=BigInt((await db.admin.query('SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS h')).rows[0].h)
    scanFroms.length=0
    await new Promise(resolve=>setTimeout(resolve,700))
    expect(scanFroms.length).toBeGreaterThan(1)
    // Tras absorber el horizonte, las vueltas siguientes parten de él, no de la apertura.
    expect(BigInt(scanFroms.at(-1)!)).toBeGreaterThanOrEqual(horizon)
    expect(live.snapshots()).toHaveLength(1)
    await live.close()
  })
  it('un Last-Event-ID manipulado no recorre el historial: parte del horizonte y un id futuro equivale a abrir de nuevo',async()=>{
    await db.admin.query("INSERT INTO llenamos.events(restaurant_id,topic) SELECT 'tenant-a','historial.ruido' FROM generate_series(1,3000)")
    const horizon=BigInt((await db.admin.query('SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS h')).rows[0].h)
    const started=Date.now()
    const old=await openStream(base,'soloOwner','owner-a',{restaurantId:'tenant-a'},{'Last-Event-ID':'1'})
    await old.until(()=>old.frames.some(frame=>frame.event==='ready'))
    expect(Date.now()-started).toBeLessThan(2000)
    expect(BigInt(old.frames.find(frame=>frame.event==='ready')!.id!)).toBeGreaterThanOrEqual(horizon-1n)
    scanFroms.length=0
    await new Promise(resolve=>setTimeout(resolve,500))
    expect(scanFroms.length).toBeGreaterThan(0)
    expect(BigInt(scanFroms[0]!)).toBeGreaterThanOrEqual(horizon)
    await old.close()
    const future=await openStream(base,'soloOwner','owner-a',{restaurantId:'tenant-a'},{'Last-Event-ID':'99999999999999999999'})
    await future.until(()=>future.snapshots().length===1)
    expect(BigInt(future.snapshots()[0]!.id!)).toBeLessThan(10n**15n)
    await future.close()
    const junk=await openStream(base,'soloOwner','owner-a',{restaurantId:'tenant-a'},{'Last-Event-ID':'abc'})
    await junk.until(()=>junk.snapshots().length===1)
    await junk.close()
  })
  it('rebajar el rol a mitad de flujo en una lectura solo de owner cierra el flujo con permission-denied',async()=>{
    await db.admin.query("UPDATE llenamos.memberships SET role='owner' WHERE uid='manager-a'")
    const live=await openStream(base,'soloOwner','manager-a',{restaurantId:'tenant-a'})
    await live.until(()=>live.snapshots().length===1)
    await db.admin.query("UPDATE llenamos.memberships SET role='manager' WHERE uid='manager-a'")
    await live.until(()=>live.ended)
    expect(live.errors()).toEqual([expect.objectContaining({code:'permission-denied'})])
    expect((await openStream(base,'soloOwner','manager-a',{restaurantId:'tenant-a'})).response.status).toBe(403)
  })
  it('un token a punto de caducar abre un flujo corto y uno caducado no abre',async()=>{
    identities.short=token('short','e',Math.floor(Date.now()/1000)+2)
    const live=await openStream(base,'soloOwner','short',{restaurantId:'tenant-a'})
    expect(live.response.status).toBe(200)
    const started=Date.now()
    await live.until(()=>live.ended,5000)
    expect(Date.now()-started).toBeLessThan(3500)
    expect(live.frames.at(-1)).toMatchObject({event:'end'})
    expect(JSON.parse(live.frames.at(-1)!.data!)).toEqual({reason:'renew'})
    identities.short=token('short','e',Math.floor(Date.now()/1000)-5)
    expect((await openStream(base,'soloOwner','short',{restaurantId:'tenant-a'})).response.status).toBe(401)
  })
  it('el local asignado se comprueba al abrir y en cada vuelta, también con locationId declarado por la lectura',async()=>{
    await db.admin.query("UPDATE llenamos.memberships SET location_ids='{tenant-a-main}' WHERE uid='waiter-a'")
    expect((await openStream(base,'porLocal','waiter-a',{restaurantId:'tenant-a',locationId:'tenant-a-other'})).response.status).toBe(403)
    const mine=await openStream(base,'porLocal','waiter-a',{restaurantId:'tenant-a',locationId:'tenant-a-main'})
    expect(mine.response.status).toBe(200)
    await mine.until(()=>mine.snapshots().length===1)
    await db.admin.query("UPDATE llenamos.memberships SET location_ids='{tenant-a-other}' WHERE uid='waiter-a'")
    await mine.until(()=>mine.ended)
    expect(mine.errors()).toEqual([expect.objectContaining({code:'permission-denied'})])
    await db.admin.query("UPDATE llenamos.memberships SET location_ids='{}' WHERE uid='waiter-a'")
    const all=await openStream(base,'porLocal','waiter-a',{restaurantId:'tenant-a',locationId:'tenant-a-other'})
    expect(all.response.status).toBe(200)
    await all.close()
  })
  it('una foto demasiado grande cierra con error fatal para que el cliente no reintente sin fin',async()=>{
    const small=await start({maxSnapshotBytes:500,pollMs:150})
    try {
      const live=await openStream(small.base,'enorme','owner-a',{restaurantId:'tenant-a'})
      await live.until(()=>live.ended)
      expect(live.errors()).toEqual([expect.objectContaining({code:'resource-exhausted',fatal:true})])
    } finally { await stop(small.server) }
  })
  it('dos fotos grandes seguidas no cierran a un cliente sano como lento',async()=>{
    const big=await start({maxSnapshotBytes:50_000,pollMs:100,backupPollMs:100,wakeJitterMs:5})
    try {
      const live=await openStream(big.base,'soloOwner','owner-a',{restaurantId:'tenant-a'})
      await live.until(()=>live.snapshots().length===1)
      for(let i=0;i<3;i++){await emit('tenant-a','pruebas.local');await new Promise(resolve=>setTimeout(resolve,150))}
      await live.until(()=>live.snapshots().length>=3)
      expect(live.ended).toBe(false)
      await live.close()
    } finally { await stop(big.server) }
  })
  it('una transacción abierta e inactiva se corta por tiempo, y mientras tanto el retraso del horizonte se registra',async()=>{
    const quick=createPool(db.appUrl,{idleInTransactionMs:700,transactionMs:60_000})
    const lagging=await start({pollMs:100,backupPollMs:100,wakeJitterMs:5,lagWarnMs:200})
    try {
      const live=await openStream(lagging.base,'soloOwner','owner-a',{restaurantId:'tenant-a'})
      await live.until(()=>live.snapshots().length===1)
      const stuck=await quick.connect()
      const killed=new Promise<{code?:string}>(resolve=>stuck.once('error',resolve))
      await stuck.query('BEGIN')
      await stuck.query("SELECT set_config('app.actor_uid','owner-a',true),set_config('app.restaurant_id','tenant-a',true)")
      await stuck.query("INSERT INTO llenamos.events(restaurant_id,topic) VALUES('tenant-a','pruebas.local')")
      // Otro hecho confirmado después queda retenido detrás de la transacción abierta.
      await emit('tenant-a','pruebas.local')
      const before=live.snapshots().length
      await new Promise(resolve=>setTimeout(resolve,500))
      expect(live.snapshots()).toHaveLength(before)
      expect(logs.some(entry=>entry.event==='live_horizon_lag')).toBe(true)
      // El servidor corta la sesión inactiva: el horizonte vuelve a avanzar sin intervención.
      expect((await killed).code).toBe('25P03')
      await live.until(()=>live.snapshots().length>before)
      stuck.release(true)
      await live.close()
    } finally { await stop(lagging.server);await quick.end().catch(()=>undefined) }
    const absolute=createPool(db.appUrl,{idleInTransactionMs:60_000,transactionMs:600})
    try {
      const client=await absolute.connect()
      await client.query('BEGIN')
      const killed=new Promise<{code?:string}>(resolve=>client.once('error',resolve))
      await client.query('SELECT 1')
      expect((await killed).code).toBe('25P04')
      client.release(true)
    } finally { await absolute.end().catch(()=>undefined) }
  },20_000)
})
