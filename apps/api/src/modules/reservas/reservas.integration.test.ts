import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest'
import { Pool } from 'pg'
import * as core from '@llenamos/core'
import { migrationSql } from '../../test-migrations.js'
import { withIdentity } from '../../database.js'
import { apiServer } from '../../server.js'
import type { IdentityToken } from '../../auth.js'
import { limits,resetMemoryLimits } from './abuse.js'
import { registerOccupancySource,unregisterOccupancySource } from './engine.js'
import { applyDepositPayment,recordCheckoutSession } from './deposit.js'
import { expireWaitlistOffers } from './jobs.js'
import { reservasLiveQueries } from './reads.js'
import { withPublicScope } from './scope.js'
import { configureStripeVault } from '../../payments/credentials.js'
import { integrationVault } from '../../platform/integrations.js'

const source=process.env.TEST_POSTGRES_URL
const enabled=process.env.TEST_POSTGRES_API==='1'&&!!source
const token=(uid:string,version:string):IdentityToken=>({uid,sessionVersion:version.repeat(32),authTime:100,platformClaim:false})
/** Primer miércoles (hay comida y cena) con antelación suficiente para las reglas por defecto. */
function nextWednesday() {
  const d=new Date(Date.now()+6*86_400_000)
  while(d.getUTCDay()!==3)d.setUTCDate(d.getUTCDate()+1)
  return d.toISOString().slice(0,10)
}
const DATE=nextWednesday()
const day=(k:number)=>{const d=new Date(`${DATE}T00:00:00Z`);d.setUTCDate(d.getUTCDate()+7*k);return d.toISOString().slice(0,10)}
const phone=(n:number)=>`+346000${String(n).padStart(5,'0')}`

describe.skipIf(!enabled)('Reservas en PostgreSQL: aforo, tokens, antiabuso y aislamiento',()=>{
  let bootstrap:Pool,admin:Pool,app:Pool,server:ReturnType<typeof apiServer>,base:string,owned=false
  const suffix=randomUUID().replaceAll('-','').slice(0,12),database=`llenamos_api_test_reservas_${suffix}`,runtime=`llenamos_api_reservas_${suffix}`
  const identities:Record<string,IdentityToken>={'owner-a':token('owner-a','a'),'waiter-a':token('waiter-a','b'),'cook-a':token('cook-a','c'),'owner-b':token('owner-b','d'),'waiter-la':token('waiter-la','e')}
  let ipCounter=0
  /** Cada petición simula un cliente distinto salvo que se fije `ip` (el conector confiable envía la cabecera). */
  const call=async(name:string,data:unknown,actor?:string,ip?:string)=>{
    const response=await fetch(`${base}/v1/operations/${name}`,{method:'POST',headers:{'Content-Type':'application/json','x-test-ip':ip??`198.51.100.${(++ipCounter%250)+1}`,...(actor?{Authorization:`Bearer ${actor}`}:{})},body:JSON.stringify({data})})
    const body=await response.json() as {result?:any;error?:{code:string}}
    return {status:response.status,body,result:body.result,code:body.error?.code}
  }
  const pub=(over:Record<string,unknown>={})=>({slug:'resta',locationId:'la',date:DATE,time:'20:00',partySize:4,guestName:'Ana Pruebas',phone:phone(1),email:null,language:'es',guestNotes:'',acceptPolicy:true,source:'web',website:'',...over})
  const settings=(over:Record<string,unknown>={})=>({...core.defaultReservationSettings('Europe/Madrid'),publicBooking:true,autoConfirm:true,minNoticeMinutes:0,maxAdvanceDays:700,...over})
  const count=async(sql:string,values:unknown[]=[])=>Number((await admin.query(sql,values)).rows[0].count)
  const configure=(over:Record<string,unknown>={},restaurantId='ra',locationId='la',actor='owner-a')=>call('guardarConfiguracionReservas',{restaurantId,locationId,settings:settings(over)},actor)

  beforeAll(async()=>{
    const url=new URL(source!)
    if(!['localhost','127.0.0.1'].includes(url.hostname)||!url.pathname.startsWith('/llenamos_api_test_'))throw new Error('Solo PostgreSQL temporal loopback de pruebas.')
    process.env.PUBLIC_APP_URL='https://app.example.test'
    process.env.TRUSTED_IP_HEADER='x-test-ip'
    process.env.TRUSTED_PROXY_ADDRESSES='127.0.0.1,::1'
    bootstrap=new Pool({connectionString:source,max:1})
    await bootstrap.query(`CREATE DATABASE ${database}`);owned=true
    url.pathname=`/${database}`
    admin=new Pool({connectionString:url.toString(),max:2})
    for(const sql of migrationSql())await admin.query(sql)
    await admin.query(`CREATE ROLE ${runtime} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD 'fixture-only' IN ROLE llenamos_app`)
    url.username=runtime;url.password='fixture-only';app=new Pool({connectionString:url.toString(),max:12,statement_timeout:8000})
    const versions:Array<[string,string]>=[['owner-a','a'],['waiter-a','b'],['cook-a','c'],['owner-b','d'],['waiter-la','e']]
    for(const [uid,v] of versions)await admin.query('INSERT INTO llenamos.identities(uid,session_version,tokens_valid_after,locked) VALUES($1,$2,to_timestamp(100),false)',[uid,v.repeat(32)])
    for(const [rid,slug] of [['ra','resta'],['rb','restb']])await admin.query("INSERT INTO llenamos.restaurants(id,name,slug,plan,active_modules) VALUES($1,$2,$3,'reservas','{reservations}')",[rid,`Restaurante ${rid}`,slug])
    for(const [rid,lid] of [['ra','la'],['ra','lb2'],['rb','lb']])await admin.query('INSERT INTO llenamos.locations(restaurant_id,id,name,slug) VALUES($1,$2,$2,$2)',[rid,lid])
    for(const [rid,uid,role,locs] of [['ra','owner-a','owner',[]],['ra','waiter-a','waiter',[]],['ra','cook-a','kitchen',[]],['rb','owner-b','owner',[]],['ra','waiter-la','waiter',['la']]] as const)
      await admin.query('INSERT INTO llenamos.memberships(restaurant_id,uid,role,active,display_name,email,location_ids) VALUES($1,$2::text,$3,true,$2::text,$4,$5)',[rid,uid,role,`${uid}@example.test`,locs])
    server=apiServer(app,async value=>identities[value]??(()=>{throw new Error('sin identidad')})())
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
    base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`
    // Plano: una zona con tres mesas de 4 plazas en cada restaurante.
    for(const [actor,rid,lid] of [['owner-a','ra','la'],['owner-b','rb','lb']]) {
      const area={id:'sala',name:'Sala',sortOrder:0}
      const tables=['T1','T2','T3'].map((name,i)=>({id:`${lid}-${name}`,name,areaId:'sala',seats:4,shape:'rect',x:5+i*20,y:5,w:10,h:10,joinableWith:[],enabled:true}))
      const saved=await call('guardarPlano',{restaurantId:rid,locationId:lid,createAreas:[area],createTables:tables},actor)
      expect(saved.status,JSON.stringify(saved.body)).toBe(200)
      expect((await configure({},rid,lid,actor)).status).toBe(200)
    }
  },60_000)
  afterAll(async()=>{
    server?.closeAllConnections();if(server)await new Promise<void>(resolve=>server.close(()=>resolve()))
    await app?.end();await admin?.end()
    // DROP ... WITH(FORCE) cierra conexiones que el pool aún no ha soltado; solo ese aviso es esperable.
    for(const pool of [app,admin])pool?.on('error',error=>{if((error as {code?:string}).code!=='57P01')throw error})
    if(owned){await bootstrap.query(`DROP DATABASE ${database} WITH(FORCE)`);await bootstrap.query(`DROP ROLE IF EXISTS ${runtime}`)}
    await bootstrap?.end()
  })
  beforeEach(()=>{resetMemoryLimits()})

  it('consulta disponibilidad pública y marca cerrado el lunes',async()=>{
    const open=await call('consultarDisponibilidad',{slug:'resta',locationId:'la',date:DATE,partySize:4})
    expect(open.status,JSON.stringify(open.body)).toBe(200)
    expect(open.result.status).toBe('open')
    expect(open.result.slots.some((s:{time:string;available:boolean})=>s.time==='20:00'&&s.available)).toBe(true)
    const monday=new Date(`${DATE}T00:00:00Z`);monday.setUTCDate(monday.getUTCDate()+5)
    const closed=await call('consultarDisponibilidad',{slug:'resta',locationId:'la',date:monday.toISOString().slice(0,10),partySize:4})
    expect(closed.result.status).toBe('closed')
  })

  it('guarda solo el hash del token, encola avisos con ID estable y emite eventos sin datos personales',async()=>{
    const out=await call('crearReservaPublica',pub({phone:phone(10),email:'ana@example.test',time:'13:00'}))
    expect(out.status,JSON.stringify(out.body)).toBe(200)
    const {manageToken,reference}=out.result
    expect(out.result.status).toBe('confirmed')
    const stored=await admin.query('SELECT manage_token_hash,data::text AS raw FROM llenamos.reservations WHERE restaurant_id=$1 AND reference=$2',['ra',reference])
    expect(stored.rows[0].manage_token_hash).toBe(core.sha256Hex(manageToken))
    expect(stored.rows[0].raw).not.toContain(manageToken)
    const notices=await admin.query("SELECT id,payload FROM llenamos.outbox WHERE restaurant_id='ra' AND payload->>'reservationId'=(SELECT id FROM llenamos.reservations WHERE reference=$1)",[reference])
    expect(notices.rows.length).toBe(2) // correo y WhatsApp
    expect(new Set(notices.rows.map(r=>r.id)).size).toBe(2)
    expect(notices.rows.every(r=>r.payload.data.manageUrl.startsWith('https://app.example.test/r/resta/reserva/'))).toBe(true)
    const events=await admin.query("SELECT payload::text AS p FROM llenamos.events WHERE restaurant_id='ra' AND topic='reservas.reserva' AND entity_id=(SELECT id FROM llenamos.reservations WHERE reference=$1)",[reference])
    expect(events.rows.length).toBeGreaterThan(0)
    expect(events.rows[0].p).not.toMatch(/ana|example|\+34/i)
    const customer=await admin.query("SELECT data FROM llenamos.customers WHERE restaurant_id='ra' AND id=$1",[core.customerIdFor('ra',phone(10))])
    expect(customer.rows[0].data.name).toBe('Ana Pruebas')
  })

  it('no sobrevende con 14 peticiones concurrentes sobre 3 mesas',async()=>{
    const results=await Promise.all(Array.from({length:14},(_,i)=>call('crearReservaPublica',pub({phone:phone(100+i),guestName:`Cliente ${i}`,time:'21:00'}))))
    const ok=results.filter(r=>r.status===200),rejected=results.filter(r=>r.status!==200)
    expect(ok.length,JSON.stringify(rejected.map(r=>r.body))).toBe(3)
    expect(rejected.every(r=>r.status===412)).toBe(true)
    const mesas=await admin.query("SELECT count(*) FROM llenamos.reservations WHERE restaurant_id='ra' AND data->>'guestName' LIKE 'Cliente %'")
    expect(Number(mesas.rows[0].count)).toBe(3)
  })

  it('personal y público compiten por el mismo hueco sin pasar de aforo',async()=>{
    await configure({maxGuestsPerSlot:8})
    const date=day(1)
    const mixed=await Promise.all([
      ...Array.from({length:5},(_,i)=>call('crearReservaPublica',pub({date,time:'20:30',phone:phone(200+i),guestName:`Mixto ${i}`}))),
      ...Array.from({length:5},(_,i)=>call('crearReserva',{restaurantId:'ra',locationId:'la',date,time:'20:30',partySize:4,guestName:`Staff ${i}`,phone:phone(300+i),source:'phone'},'waiter-a')),
    ])
    const guests=await admin.query("SELECT coalesce(sum((data->>'partySize')::int),0) AS n FROM llenamos.reservations WHERE restaurant_id='ra' AND (data->>'guestName' LIKE 'Mixto %' OR data->>'guestName' LIKE 'Staff %')")
    expect(Number(guests.rows[0].n)).toBeLessThanOrEqual(8)
    expect(mixed.filter(r=>r.status===200).length).toBeLessThanOrEqual(2)
    await configure()
  })

  it('rechaza duplicados exactos, campo trampa y datos extra',async()=>{
    const first=await call('crearReservaPublica',pub({date:day(2),phone:phone(20),time:'13:30'}))
    expect(first.status).toBe(200)
    const dup=await call('crearReservaPublica',pub({date:day(2),phone:phone(20),time:'13:30'}))
    expect(dup.status).toBe(409)
    expect(dup.code).toBe('already-exists')
    expect((await call('crearReservaPublica',pub({date:day(2),phone:phone(21),website:'http://spam'}))).status).toBe(400)
    expect((await call('crearReservaPublica',{...pub({date:day(2),phone:phone(22)}),restaurantId:'rb'})).status).toBe(400)
  })

  it('tokens privados: falso, de otro restaurante y bloqueo por intentos fallidos',async()=>{
    const mine=await call('crearReservaPublica',pub({date:day(3),phone:phone(30),time:'14:00'}))
    const ref=mine.result.reference,tok=mine.result.manageToken
    const ok=await call('verReservaPublica',{slug:'resta',reference:ref,token:tok})
    expect(ok.status,JSON.stringify(ok.body)).toBe(200)
    expect(ok.result.canCancel).toBe(true)
    expect(JSON.stringify(ok.result)).not.toMatch(/manageTokenHash|phone|tableIds|notes/)
    const fake='A'.repeat(43)
    expect((await call('verReservaPublica',{slug:'resta',reference:ref,token:fake})).status).toBe(404)
    // El mismo enlace en otro restaurante no existe: la referencia es por restaurante.
    expect((await call('verReservaPublica',{slug:'restb',reference:ref,token:tok})).status).toBe(404)
    expect((await call('gestionarReservaPublica',{slug:'resta',reference:ref,token:fake,action:'cancel',website:''})).status).toBe(404)
    expect((await admin.query('SELECT status FROM llenamos.reservations WHERE reference=$1 AND restaurant_id=$2',[ref,'ra'])).rows[0].status).toBe('confirmed')
    // Adivinar referencias desde una IP se corta con 429 antes de acabar con el espacio de referencias.
    const attacker='203.0.113.9'
    const codes:number[]=[]
    for(let i=0;i<20;i++)codes.push((await call('verReservaPublica',{slug:'resta',reference:`ABC${String(200+i)}`.slice(0,6).replace(/[01OIL]/g,'2'),token:fake},undefined,attacker)).status)
    expect(codes).toContain(429)
    expect(codes.slice(0,10).every(c=>c===404)).toBe(true)
  })

  it('el cliente gestiona su reserva por enlace: confirma y cancela, y se anulan los avisos pendientes',async()=>{
    await configure({autoConfirm:false})
    const created=await call('crearReservaPublica',pub({date:day(4),phone:phone(40),email:'cli@example.test',time:'13:15'}))
    expect(created.result.status).toBe('pending')
    const link={slug:'resta',reference:created.result.reference,token:created.result.manageToken,website:''}
    const confirmed=await call('gestionarReservaPublica',{...link,action:'confirm'})
    expect(confirmed.result.status).toBe('confirmed')
    const cancelled=await call('gestionarReservaPublica',{...link,action:'cancel',reason:'Imprevisto'})
    expect(cancelled.result.status).toBe('cancelled')
    const states=await admin.query("SELECT status,count(*)::int AS n FROM llenamos.outbox WHERE restaurant_id='ra' AND payload->>'reservationId'=(SELECT id FROM llenamos.reservations WHERE reference=$1) GROUP BY status",[created.result.reference])
    const byStatus=Object.fromEntries(states.rows.map(r=>[r.status,r.n]))
    expect(byStatus.cancelled).toBeGreaterThan(0) // pendiente y confirmación anuladas
    expect(byStatus.pending).toBe(2) // solo el aviso de cancelación (correo y WhatsApp)
    expect((await call('gestionarReservaPublica',{...link,action:'confirm'})).status).toBe(412)
    await configure()
  })

  it('el personal necesita rol y local: cocina, otro restaurante y local no asignado quedan fuera',async()=>{
    const body={restaurantId:'ra',locationId:'la',date:day(5),time:'13:45',partySize:2,guestName:'Mesa personal',phone:phone(50),source:'phone'}
    expect((await call('crearReserva',body,'cook-a')).status).toBe(403)
    expect((await call('crearReserva',body,'owner-b')).status).toBe(403)
    expect((await call('crearReserva',{...body,locationId:'lb2'},'waiter-la')).status).toBe(403)
    expect((await call('crearReserva',body)).status).toBe(401)
    expect((await call('guardarConfiguracionReservas',{restaurantId:'ra',locationId:'la',settings:settings()},'waiter-a')).status).toBe(403)
    expect((await call('guardarPlano',{restaurantId:'ra',locationId:'la',deleteTables:['la-T1']},'waiter-a')).status).toBe(403)
    const ok=await call('crearReserva',body,'waiter-a')
    expect(ok.status,JSON.stringify(ok.body)).toBe(200)
    expect(ok.result.suggestedTableIds.length).toBeGreaterThan(0)
  })

  it('estados, mesas y movimientos: cliente con visitas, conflictos y propuesta del motor',async()=>{
    const date=day(6)
    const book=(time:string,n:number,tables:string[]=[])=>call('crearReserva',{restaurantId:'ra',locationId:'la',date,time,partySize:4,guestName:`Estado ${n}`,phone:phone(60+n),source:'phone',tableIds:tables},'owner-a')
    const a=await book('20:00',1,['la-T1']),b=await book('20:00',2,['la-T1'])
    expect(a.status,JSON.stringify(a.body)).toBe(200)
    expect(b.status).toBe(412) // misma mesa y hora
    const move=await call('moverReserva',{restaurantId:'ra',locationId:'la',reservationId:a.result.reservationId,date,time:'21:00'},'waiter-a')
    expect(move.status,JSON.stringify(move.body)).toBe(200)
    const assign=await call('asignarMesas',{restaurantId:'ra',locationId:'la',reservationId:a.result.reservationId,tableIds:['la-T2']},'waiter-a')
    expect(assign.result.tableIds).toEqual(['la-T2'])
    const proposals=await call('proponerMesasReserva',{restaurantId:'ra',locationId:'la',reservationId:a.result.reservationId},'waiter-a')
    expect(proposals.status,JSON.stringify(proposals.body)).toBe(200)
    for(const status of ['seated','finished'])expect((await call('cambiarEstadoReserva',{restaurantId:'ra',locationId:'la',reservationId:a.result.reservationId,status},'waiter-a')).status).toBe(200)
    expect((await call('cambiarEstadoReserva',{restaurantId:'ra',locationId:'la',reservationId:a.result.reservationId,status:'confirmed'},'waiter-a')).status).toBe(412)
    const customer=await admin.query("SELECT data FROM llenamos.customers WHERE restaurant_id='ra' AND id=$1",[core.customerIdFor('ra',phone(61))])
    expect(customer.rows[0].data.visits).toBe(1)
    // Otra cuenta no ve ni modifica reservas ajenas por ID.
    expect((await call('cambiarEstadoReserva',{restaurantId:'rb',locationId:'lb',reservationId:a.result.reservationId,status:'cancelled'},'owner-b')).status).toBe(404)
  })

  it('importa filas con SAVEPOINT: las buenas entran y las malas se informan; dryRun no escribe',async()=>{
    const date=day(8)
    const row=(n:number,extra:Record<string,unknown>={})=>({date,time:'13:00',partySize:2,guestName:`Importada ${n}`,phone:phone(80+n),...extra})
    const rows=[row(1),row(2,{tables:'NoExiste'}),row(3,{time:'99:99'}),row(4,{time:'20:00'})]
    const dry=await call('importarReservas',{restaurantId:'ra',locationId:'la',rows,dryRun:true},'owner-a')
    expect(dry.status,JSON.stringify(dry.body)).toBe(200)
    expect(dry.result.created).toBe(0)
    expect(await count("SELECT count(*) FROM llenamos.reservations WHERE data->>'guestName' LIKE 'Importada %'")).toBe(0)
    const real=await call('importarReservas',{restaurantId:'ra',locationId:'la',rows,dryRun:false},'owner-a')
    expect(real.result.created).toBe(2)
    expect(real.result.errors.length).toBe(2)
    expect((await call('importarReservas',{restaurantId:'ra',locationId:'la',rows,dryRun:false},'waiter-a')).status).toBe(403)
  })

  it('lista de espera: se apunta, recibe la oferta al liberarse el hueco y la acepta una sola vez',async()=>{
    await configure({waitlist:{enabled:true,offerMinutes:30}})
    const date=day(9)
    const filled=await Promise.all(['T1','T2','T3'].map((t,i)=>call('crearReserva',{restaurantId:'ra',locationId:'la',date,time:'20:00',partySize:4,guestName:`Lleno ${i}`,phone:phone(400+i),source:'phone',tableIds:[`la-${t}`],durationMinutes:240},'owner-a')))
    expect(filled.every(r=>r.status===200)).toBe(true)
    const join=await call('apuntarseListaEspera',{slug:'resta',locationId:'la',date,from:'20:00',to:'20:30',partySize:4,guestName:'Espera Uno',phone:phone(410),email:null,language:'es',source:'web',website:''})
    expect(join.status,JSON.stringify(join.body)).toBe(200)
    expect((await admin.query('SELECT status FROM llenamos.waitlist WHERE id=$1',[join.result.waitlistId])).rows[0].status).toBe('waiting')
    // Nadie ha liberado nada: aceptar sin oferta no existe.
    expect((await call('aceptarOfertaListaEspera',{slug:'resta',waitlistId:join.result.waitlistId,token:'B'.repeat(43),website:''})).status).toBe(404)
    // Se libera una mesa: la oferta sale dentro de la misma transacción.
    expect((await call('cambiarEstadoReserva',{restaurantId:'ra',locationId:'la',reservationId:filled[0]!.result.reservationId,status:'cancelled'},'owner-a')).status).toBe(200)
    const offered=await admin.query('SELECT status,data FROM llenamos.waitlist WHERE id=$1',[join.result.waitlistId])
    expect(offered.rows[0].status).toBe('offered')
    const notice=await admin.query("SELECT payload FROM llenamos.outbox WHERE restaurant_id='ra' AND payload->>'waitlistId'=$1 AND payload->>'template'='waitlist_offer' LIMIT 1",[join.result.waitlistId])
    const offerToken=new URL(notice.rows[0].payload.data.offerUrl).searchParams.get('t')!
    // El hueco ofrecido cuenta como ocupado hasta que caduque.
    const blocked=await call('crearReservaPublica',pub({date,time:'20:00',phone:phone(420)}))
    expect(blocked.status).toBe(412)
    const accepted=await call('aceptarOfertaListaEspera',{slug:'resta',waitlistId:join.result.waitlistId,token:offerToken,website:''})
    expect(accepted.status,JSON.stringify(accepted.body)).toBe(200)
    expect(accepted.result.reference).toMatch(/^[A-Z0-9]{6}$/)
    expect((await call('aceptarOfertaListaEspera',{slug:'resta',waitlistId:join.result.waitlistId,token:offerToken,website:''})).status).toBe(412)
    expect(await count("SELECT count(*) FROM llenamos.reservations WHERE data->>'source'='waitlist' AND restaurant_id='ra' AND start_at=(SELECT start_at FROM llenamos.reservations WHERE id=$1)",[filled[1]!.result.reservationId])).toBe(1)
    await configure()
  })

  it('caduca ofertas vencidas con el trabajo del worker y ofrece a la siguiente persona',async()=>{
    await configure({waitlist:{enabled:true,offerMinutes:5}})
    const date=day(10)
    const made=await Promise.all(['T1','T2','T3'].map((t,i)=>call('crearReserva',{restaurantId:'ra',locationId:'la',date,time:'13:00',partySize:4,guestName:`Cad ${i}`,phone:phone(500+i),source:'phone',tableIds:[`la-${t}`],durationMinutes:240},'owner-a')))
    expect(made.every(r=>r.status===200)).toBe(true)
    const waiting=[]
    for(const i of [0,1])waiting.push(await call('apuntarseListaEspera',{slug:'resta',locationId:'la',date,from:'13:00',to:'13:30',partySize:4,guestName:`Espera ${i}`,phone:phone(510+i),email:null,language:'es',source:'web',website:''}))
    expect((await call('cambiarEstadoReserva',{restaurantId:'ra',locationId:'la',reservationId:made[0]!.result.reservationId,status:'cancelled'},'owner-a')).status).toBe(200)
    const [first,second]=waiting.map(w=>w.result.waitlistId)
    expect((await admin.query('SELECT status FROM llenamos.waitlist WHERE id=$1',[first])).rows[0].status).toBe('offered')
    expect((await admin.query('SELECT status FROM llenamos.waitlist WHERE id=$1',[second])).rows[0].status).toBe('waiting')
    expect(await count("SELECT count(*) FROM llenamos.jobs WHERE restaurant_id='ra' AND kind='reservas.caducar_oferta'")).toBeGreaterThan(0)
    expect(await expireWaitlistOffers(app,'ra','la')).toBe(0) // aún vigente
    expect(await expireWaitlistOffers(app,'ra','la',Date.now()+10*60_000)).toBe(1)
    expect((await admin.query('SELECT status FROM llenamos.waitlist WHERE id=$1',[first])).rows[0].status).toBe('expired')
    expect((await admin.query('SELECT status FROM llenamos.waitlist WHERE id=$1',[second])).rows[0].status).toBe('offered')
    await configure()
  })

  it('señal: exige pago, no simula Stripe y aplica el cobro una sola vez',async()=>{
    const date=day(11)
    await configure({deposit:{mode:'perPerson',amountCents:500,fromPartySize:2}})
    const noStripe=await call('crearReservaPublica',pub({date,phone:phone(600),time:'14:00'}))
    expect(noStripe.result.status).toBe('pending')
    expect(noStripe.result.deposit).toEqual({status:'not_configured',amountCents:2000})
    const link={slug:'resta',reference:noStripe.result.reference,token:noStripe.result.manageToken}
    expect((await call('iniciarPagoSenal',link)).result.status).toBe('not_configured')
    expect((await call('gestionarReservaPublica',{...link,action:'confirm',website:''})).status).toBe(412)
    await admin.query("INSERT INTO llenamos.platform_restaurants(restaurant_id,name,slug,plan_id,owner_email,integration_status) VALUES('ra','Restaurante ra','resta','sala','o@example.test','{\"stripe\":{\"configured\":true,\"status\":\"configured\"}}') ON CONFLICT(restaurant_id) DO UPDATE SET integration_status=EXCLUDED.integration_status")
    const withStripe=await call('crearReservaPublica',pub({date,phone:phone(601),time:'14:00'}))
    expect(withStripe.result.deposit.status).toBe('required')
    const stripeLink={slug:'resta',reference:withStripe.result.reference,token:withStripe.result.manageToken}
    // Sin la clave de Stripe en la bóveda del restaurante no hay sesión ni redirección simulada (la sesión real se prueba en caja/movil).
    configureStripeVault(integrationVault(Buffer.alloc(32,3)))
    const started=await call('iniciarPagoSenal',stripeLink)
    expect(started.result.status).toBe('not_configured')
    const row=(await admin.query('SELECT id FROM llenamos.reservations WHERE restaurant_id=$1 AND reference=$2',['ra',withStripe.result.reference])).rows[0]
    expect(await recordCheckoutSession(app,'ra','la',row.id,'cs_test_1')).toBe(true)
    const pay={restaurantId:'ra',locationId:'la',reservationId:row.id,checkoutSessionId:'cs_test_1',amountCents:2000,currency:'eur'}
    await expect(applyDepositPayment(app,{...pay,amountCents:1})).rejects.toThrow('no corresponde')
    expect(await applyDepositPayment(app,pay)).toBe('paid')
    expect(await applyDepositPayment(app,pay)).toBe('already_paid')
    const paid=(await admin.query('SELECT status,data FROM llenamos.reservations WHERE id=$1',[row.id])).rows[0]
    expect(paid.status).toBe('confirmed')
    expect(paid.data.deposit.status).toBe('paid')
    expect((await call('iniciarPagoSenal',stripeLink)).result.status).toBe('already_paid')
    configureStripeVault(null)
    await admin.query("UPDATE llenamos.platform_restaurants SET integration_status=NULL WHERE restaurant_id='ra'")
    await configure()
  })

  it('antiabuso con carga: IP, restaurante y destinatario cortan antes de encolar avisos',async()=>{
    const date=day(12)
    const before=await count("SELECT count(*) FROM llenamos.outbox WHERE restaurant_id='ra'")
    const same='192.0.2.77'
    const burst=await Promise.all(Array.from({length:40},(_,i)=>call('crearReservaPublica',pub({date,time:'13:00',phone:phone(700+i),guestName:`Carga ${i}`}),undefined,same)))
    const accepted=burst.filter(r=>r.status===200).length,limited=burst.filter(r=>r.status===429).length
    expect(accepted).toBeLessThanOrEqual(limits.create.ipRestaurant.max)
    expect(accepted+limited+burst.filter(r=>r.status===412).length).toBe(40)
    expect(limited).toBeGreaterThanOrEqual(40-limits.create.ipRestaurant.max-3)
    const queued=await count("SELECT count(*) FROM llenamos.outbox WHERE restaurant_id='ra'")-before
    expect(queued).toBeLessThanOrEqual(accepted*2) // sin avisos para las peticiones rechazadas
    // Mismo destinatario desde IPs distintas: al sexto intento se corta.
    const target=phone(799)
    const attempts:number[]=[]
    for(const time of ['13:00','13:30','14:00','14:30','15:00','15:30','20:00'])attempts.push((await call('crearReservaPublica',pub({date:day(24),time,phone:target,guestName:'Acoso'}))).status)
    expect(attempts.filter(s=>s===429).length).toBeGreaterThanOrEqual(1)
    expect(await count("SELECT count(*) FROM llenamos.reservations WHERE restaurant_id='ra' AND customer_id=$1",[core.customerIdFor('ra',target)])).toBeLessThanOrEqual(limits.create.recipient.max)
  })

  it('proyección pública: locales con reserva web y módulo apagado sin filtrar datos privados',async()=>{
    const open=await call('verRestaurantePublico',{slug:'resta'})
    expect(open.status,JSON.stringify(open.body)).toBe(200)
    expect(open.result).toMatchObject({restaurantId:'ra',bookingEnabled:true,bookingDisabledReason:null,locations:[{id:'la'}]})
    expect(JSON.stringify(open.result)).not.toMatch(/owner|email|@example/)
    expect((await call('verRestaurantePublico',{slug:'no-existe'})).status).toBe(404)
    await configure({publicBooking:false})
    expect((await call('verRestaurantePublico',{slug:'resta'})).result).toMatchObject({bookingEnabled:false,bookingDisabledReason:'public_booking_off',locations:[]})
    expect((await call('crearReservaPublica',pub({date:day(13),phone:phone(900)}))).status).toBe(412)
    await configure()
    await admin.query("UPDATE llenamos.restaurants SET active_modules='{}' WHERE id='ra'")
    expect((await call('verRestaurantePublico',{slug:'resta'})).result).toMatchObject({bookingEnabled:false,bookingDisabledReason:'module_off'})
    expect((await call('consultarDisponibilidad',{slug:'resta',locationId:'la',date:DATE,partySize:2})).status).toBe(412)
    expect((await call('crearReserva',{restaurantId:'ra',locationId:'la',date:day(13),time:'13:00',partySize:2,guestName:'Sin módulo',phone:phone(901),source:'phone'},'owner-a')).status).toBe(412)
    await admin.query("UPDATE llenamos.restaurants SET active_modules='{reservations}' WHERE id='ra'")
  })

  const fill=(date:string,time:string,tag:string,over:Record<string,unknown>={})=>Promise.all(['T1','T2','T3'].map((t,i)=>call('crearReserva',{restaurantId:'ra',locationId:'la',date,time,partySize:4,guestName:`${tag} ${i}`,phone:phone(Math.abs(tag.split('').reduce((a,c)=>a*31+c.charCodeAt(0),7))%90000+i),source:'phone',tableIds:[`la-${t}`],durationMinutes:240,...over},'owner-a')))
  const stripeOn=(on:boolean)=>admin.query("INSERT INTO llenamos.platform_restaurants(restaurant_id,name,slug,plan_id,owner_email,integration_status) VALUES('ra','Restaurante ra','resta','sala','o@example.test',$1) ON CONFLICT(restaurant_id) DO UPDATE SET integration_status=EXCLUDED.integration_status",[on?'{"stripe":{"configured":true,"status":"configured"}}':null])

  it('revisión 2: la lista de espera no ofrece huecos de otra fecha que está llena',async()=>{
    await configure({waitlist:{enabled:true,offerMinutes:30},maxAdvanceDays:400})
    const near=day(15),far=day(16)
    expect((await fill(near,'20:00','Cerca')).every(r=>r.status===200)).toBe(true)
    const farFull=await fill(far,'20:00','Lejos')
    expect(farFull.every(r=>r.status===200)).toBe(true)
    const join=await call('apuntarseListaEspera',{slug:'resta',locationId:'la',date:far,from:'20:00',to:'20:30',partySize:4,guestName:'Espera lejana',phone:phone(1500),email:null,language:'es',source:'web',website:''})
    expect(join.status,JSON.stringify(join.body)).toBe(200)
    // Se libera una mesa de la semana anterior: la espera del día lleno no recibe una oferta falsa.
    const first=(await admin.query("SELECT id FROM llenamos.reservations WHERE restaurant_id='ra' AND data->>'guestName'='Cerca 0'")).rows[0].id
    expect((await call('cambiarEstadoReserva',{restaurantId:'ra',locationId:'la',reservationId:first,status:'cancelled'},'owner-a')).status).toBe(200)
    expect((await admin.query('SELECT status FROM llenamos.waitlist WHERE id=$1',[join.result.waitlistId])).rows[0].status).toBe('waiting')
    // Cuando sí se libera su día, la oferta sale y se puede aceptar.
    expect((await call('cambiarEstadoReserva',{restaurantId:'ra',locationId:'la',reservationId:farFull[0]!.result.reservationId,status:'cancelled'},'owner-a')).status).toBe(200)
    expect((await admin.query('SELECT status FROM llenamos.waitlist WHERE id=$1',[join.result.waitlistId])).rows[0].status).toBe('offered')
    await configure()
  })

  it('revisión 3: tras pagar la señal no se pide otra vez, aunque el aforo se haya reducido',async()=>{
    const date=day(17)
    await configure({deposit:{mode:'perPerson',amountCents:500,fromPartySize:2}})
    await stripeOn(true)
    const created=await call('crearReservaPublica',pub({date,phone:phone(1600),email:'pago@example.test',time:'14:00'}))
    expect(created.result.deposit.status).toBe('required')
    const row=(await admin.query('SELECT id FROM llenamos.reservations WHERE restaurant_id=$1 AND reference=$2',['ra',created.result.reference])).rows[0]
    await recordCheckoutSession(app,'ra','la',row.id,'cs_rev3')
    // Se reduce el aforo a cero mesas antes de que llegue el webhook.
    expect((await call('guardarPlano',{restaurantId:'ra',locationId:'la',updateTables:['T1','T2','T3'].map(t=>({id:`la-${t}`,enabled:false}))},'owner-a')).status).toBe(200)
    expect(await applyDepositPayment(app,{restaurantId:'ra',locationId:'la',reservationId:row.id,checkoutSessionId:'cs_rev3',amountCents:2000,currency:'eur'})).toBe('paid')
    const stored=(await admin.query('SELECT status,data FROM llenamos.reservations WHERE id=$1',[row.id])).rows[0]
    expect(stored.status).toBe('confirmed')
    expect(stored.data.deposit.status).toBe('paid')
    const pending=await admin.query("SELECT payload->>'template' AS t FROM llenamos.outbox WHERE payload->>'reservationId'=$1 AND status='pending'",[row.id])
    expect(pending.rows.map(r=>r.t).sort()).toEqual(['confirmation','confirmation'])
    expect(pending.rows.some(r=>r.t==='deposit_request')).toBe(false)
    expect((await call('guardarPlano',{restaurantId:'ra',locationId:'la',updateTables:['T1','T2','T3'].map(t=>({id:`la-${t}`,enabled:true}))},'owner-a')).status).toBe(200)
    await stripeOn(false)
    await configure()
  })

  it('revisión 4: al cancelar se borran los enlaces con token y cocina o sala no leen la cola de avisos',async()=>{
    await configure({autoConfirm:false})
    const created=await call('crearReservaPublica',pub({date:day(18),phone:phone(1700),email:'tok@example.test',time:'13:00'}))
    const id=(await admin.query('SELECT id FROM llenamos.reservations WHERE reference=$1 AND restaurant_id=$2',[created.result.reference,'ra'])).rows[0].id
    const urls=async()=>Number((await admin.query("SELECT count(*) FROM llenamos.outbox WHERE payload->>'reservationId'=$1 AND payload->'data'->>'manageUrl' IS NOT NULL",[id])).rows[0].count)
    expect(await urls()).toBeGreaterThan(0)
    const link={slug:'resta',reference:created.result.reference,token:created.result.manageToken,website:''}
    expect((await call('gestionarReservaPublica',{...link,action:'cancel'})).status).toBe(200)
    // Solo queda el aviso de cancelación (sin enlace de gestión); los anulados ya no llevan el token.
    const cancelled=await admin.query("SELECT payload FROM llenamos.outbox WHERE payload->>'reservationId'=$1 AND status='cancelled'",[id])
    expect(cancelled.rows.length).toBeGreaterThan(0)
    expect(cancelled.rows.every(r=>!JSON.stringify(r.payload).includes(created.result.manageToken))).toBe(true)
    const read=(actor:string)=>withIdentity(app,identities[actor]!,'ra',async client=>Number((await client.query("SELECT count(*) FROM llenamos.outbox WHERE kind='aviso.mensaje'")).rows[0].count))
    expect(await read('owner-a')).toBeGreaterThan(0)
    for(const actor of ['cook-a','waiter-a'])expect(await read(actor),actor).toBe(0)
    await configure()
  })

  it('revisión 5: tras demasiados fallos ni el token correcto entra desde esa IP',async()=>{
    const mine=await call('crearReservaPublica',pub({date:day(19),phone:phone(1800),time:'13:00'}))
    const ok={slug:'resta',reference:mine.result.reference,token:mine.result.manageToken}
    const attacker='203.0.113.50',fake='C'.repeat(43)
    const alphabet='23456789ABCDEFGHJKMNPQRSTUVWXYZ'
    const refs=Array.from({length:limits.link.failedIp.max},(_,i)=>`${alphabet[i%alphabet.length]}${alphabet[(i*7+3)%alphabet.length]}ZZZ${alphabet[i%5]}`)
    for(const ref of refs)expect((await call('verReservaPublica',{slug:'resta',reference:ref,token:fake},undefined,attacker)).status).toBe(404)
    expect((await call('verReservaPublica',ok,undefined,attacker)).status).toBe(429)
    expect((await call('verReservaPublica',ok,undefined,'198.51.100.200')).status).toBe(200) // otra IP no se ve afectada
    // Por referencia: demasiados fallos contra ella la bloquean también para el token correcto.
    for(let i=0;i<limits.link.failedReference.max;i++)await call('verReservaPublica',{...ok,token:`${String.fromCharCode(68+i)}`.repeat(43)},undefined,`192.0.2.${100+i}`)
    expect((await call('verReservaPublica',ok,undefined,'192.0.2.250')).status).toBe(429)
  })

  it('revisión 6: el ámbito público solo tiene los permisos de cada comando',async()=>{
    const before={settings:await count('SELECT count(*) FROM llenamos.reservation_settings'),tables:await count('SELECT count(*) FROM llenamos.dining_tables'),consents:await count('SELECT count(*) FROM llenamos.consents')}
    await withPublicScope(app,'ra',async client=>{
      expect((await client.query("UPDATE llenamos.reservation_settings SET revision=99 WHERE restaurant_id='ra'")).rowCount).toBe(0)
      expect((await client.query("DELETE FROM llenamos.dining_tables WHERE restaurant_id='ra'")).rowCount).toBe(0)
      expect((await client.query("DELETE FROM llenamos.dining_areas WHERE restaurant_id='ra'")).rowCount).toBe(0)
      expect((await client.query("SELECT 1 FROM llenamos.consents")).rowCount).toBe(0)
      expect((await client.query("SELECT 1 FROM llenamos.reservation_origins")).rowCount).toBe(0)
      expect((await client.query("SELECT 1 FROM llenamos.reservation_settings")).rowCount).toBeGreaterThan(0)
      await expect(client.query("INSERT INTO llenamos.reservation_settings(restaurant_id,location_id,data) VALUES('ra','lb2','{}')")).rejects.toThrow(/row-level security/)
    })
    await withPublicScope(app,'ra',async client=>{
      await expect(client.query("INSERT INTO llenamos.dining_areas(restaurant_id,location_id,id,data) VALUES('ra','la','x','{}')")).rejects.toThrow(/row-level security/)
    })
    expect({settings:await count('SELECT count(*) FROM llenamos.reservation_settings'),tables:await count('SELECT count(*) FROM llenamos.dining_tables'),consents:await count('SELECT count(*) FROM llenamos.consents')}).toEqual(before)
  })

  it('revisión 7: las mesas ocupadas sin reserva (sesiones de sala) bloquean la venta y no se cuentan dos veces',async()=>{
    const date=day(20),start=core.instanteDeHoraLocal(date,20*60,'Europe/Madrid')!
    const seated=await call('crearReserva',{restaurantId:'ra',locationId:'la',date,time:'20:00',partySize:4,guestName:'Sentada',phone:phone(1900),source:'phone',status:'seated',tableIds:['la-T1']},'owner-a')
    expect(seated.status,JSON.stringify(seated.body)).toBe(200)
    expect((await fill(date,'20:00','Resto',{tableIds:undefined})).filter(r=>r.status===200).length).toBe(2)
    expect((await call('crearReservaPublica',pub({date,phone:phone(1901)}))).status).toBe(412)
    // La sesión de mesa de sala representa a la reserva sentada: su mesa deja de contarse por duplicado.
    registerOccupancySource('prueba-sala',async()=>({occupancy:[],represented:new Set([seated.result.reservationId])}))
    try { expect((await call('crearReservaPublica',pub({date,phone:phone(1902)}))).status).toBe(200) } finally { unregisterOccupancySource('prueba-sala') }
    // Una mesa ocupada sin reserva (sesión abierta) bloquea aunque no haya reservas.
    const date2=day(21),start2=core.instanteDeHoraLocal(date2,20*60,'Europe/Madrid')!
    registerOccupancySource('prueba-sala',async()=>({occupancy:['T1','T2','T3'].map(t=>({id:`session-${t}`,inicio:start2,duracionMinutos:240,comensales:4,estado:'sentada' as const,mesaIds:[`la-${t}`]})),represented:new Set<string>()}))
    try { expect((await call('crearReservaPublica',pub({date:date2,phone:phone(1903)}))).status).toBe(412) } finally { unregisterOccupancySource('prueba-sala') }
    expect((await call('crearReservaPublica',pub({date:date2,phone:phone(1904)}))).status).toBe(200)
    void start
  })

  it('revisión 8: los intentos rechazados no consumen el cupo de un teléfono ajeno y espera y creación no comparten clave',async()=>{
    const date=day(22),victim=phone(2000)
    expect((await fill(date,'20:00','Llena')).every(r=>r.status===200)).toBe(true)
    const attempts=[]
    for(let i=0;i<limits.create.recipient.max+2;i++)attempts.push((await call('crearReservaPublica',pub({date,time:'20:00',phone:victim}))).status)
    expect(attempts.every(s=>s===412)).toBe(true) // ninguno llega a 429: lo rechazado no cuenta
    expect((await call('crearReservaPublica',pub({date,time:'13:00',phone:victim}))).status).toBe(200)
    await configure({waitlist:{enabled:true,offerMinutes:30},maxAdvanceDays:400})
    const joins=[]
    for(let i=0;i<limits.waitlist.recipient.max+1;i++)joins.push((await call('apuntarseListaEspera',{slug:'resta',locationId:'la',date,from:'20:00',to:'20:30',partySize:4,guestName:'Víctima',phone:victim,email:null,language:'es',source:'web',website:''})).status)
    expect(joins.slice(0,-1).every(s=>s===200)).toBe(true)
    expect(joins.at(-1)).toBe(429)
    expect((await call('crearReservaPublica',pub({date,time:'13:30',phone:victim}))).status).toBe(200) // la espera no bloquea reservar
    await configure()
  })

  it('menores: clientes pagina por cursor, las lecturas exigen el módulo y cocina o barra ven el plano',async()=>{
    const query=(name:string)=>reservasLiveQueries.find(q=>q.name===name)!
    const names:string[]=[];let after:{name:string;id:string}|undefined
    for(let page=0;page<200;page++) {
      const out=await withIdentity(app,identities['owner-a']!,'ra',client=>query('clientes').snapshot(client,{restaurantId:'ra',limit:5,...(after?{after}:{})},{uid:'owner-a'})) as {customers:Array<{name:string;id:string}>;nextCursor:{name:string;id:string}|null}
      expect(out.customers.length).toBeLessThanOrEqual(5)
      names.push(...out.customers.map(c=>c.id))
      if(!out.nextCursor)break
      after=out.nextCursor
    }
    const total=await count("SELECT count(*) FROM llenamos.customers WHERE restaurant_id='ra'")
    expect(names.length).toBe(total)
    expect(new Set(names).size).toBe(total)
    expect(query('plano').roles).toEqual(expect.arrayContaining(['kitchen','bar','waiter']))
    await admin.query("UPDATE llenamos.restaurants SET active_modules='{}' WHERE id='ra'")
    await expect(withIdentity(app,identities['owner-a']!,'ra',client=>query('reservasDia').snapshot(client,{restaurantId:'ra',locationId:'la',date:DATE},{uid:'owner-a'}))).rejects.toMatchObject({status:412})
    await expect(withIdentity(app,identities['owner-a']!,'ra',client=>query('plano').snapshot(client,{restaurantId:'ra',locationId:'la'},{uid:'owner-a'}))).rejects.toMatchObject({status:412})
    await admin.query("UPDATE llenamos.restaurants SET active_modules='{floor}' WHERE id='ra'")
    await expect(withIdentity(app,identities['owner-a']!,'ra',client=>query('plano').snapshot(client,{restaurantId:'ra',locationId:'la'},{uid:'owner-a'}))).resolves.toMatchObject({tables:expect.any(Array)})
    await admin.query("UPDATE llenamos.restaurants SET active_modules='{reservations}' WHERE id='ra'")
  })

  it('menores: mover una reserva meses adelante y la proyección pública con límite',async()=>{
    const created=await call('crearReserva',{restaurantId:'ra',locationId:'la',date:day(23),time:'13:00',partySize:2,guestName:'Viajera',phone:phone(2100),source:'phone'},'owner-a')
    const moved=await call('moverReserva',{restaurantId:'ra',locationId:'la',reservationId:created.result.reservationId,date:day(40),time:'14:00'},'owner-a')
    expect(moved.status,JSON.stringify(moved.body)).toBe(200)
    expect(core.horaLocal(moved.result.startAt,'Europe/Madrid').fecha).toBe(day(40))
    expect((await call('verRestaurantePublico',{slug:'resta'},undefined,'198.51.100.250')).status).toBe(200)
  })

  it('el ámbito público y el personal ven únicamente su restaurante',async()=>{
    await withPublicScope(app,'ra',async client=>{
      expect(Number((await client.query("SELECT count(*) FROM llenamos.reservations WHERE restaurant_id='rb'")).rows[0].count)).toBe(0)
      await expect(client.query("INSERT INTO llenamos.outbox(id,restaurant_id,kind,payload) VALUES($1,'rb','x','{}')",[randomUUID()])).rejects.toThrow(/row-level security/)
    })
    await withIdentity(app,identities['owner-a']!,'ra',async client=>{
      expect(Number((await client.query("SELECT count(*) FROM llenamos.reservations WHERE restaurant_id='rb'")).rows[0].count)).toBe(0)
      await expect(client.query('SELECT * FROM llenamos.abuse_counters')).rejects.toThrow(/permission denied/)
    })
    await withIdentity(app,identities['owner-b']!,'rb',async client=>{
      expect(Number((await client.query("SELECT count(*) FROM llenamos.reservations")).rows[0].count)).toBe(0)
      expect(Number((await client.query("SELECT count(*) FROM llenamos.dining_tables")).rows[0].count)).toBe(3)
    })
    // Sin contexto no hay nada, aunque la consulta omita el WHERE.
    const client=await app.connect()
    try{expect(Number((await client.query('SELECT count(*) FROM llenamos.reservations')).rows[0].count)).toBe(0)}finally{client.release()}
  })

  it('plano atómico: una baja inválida revierte el guardado y no se puede borrar una zona con mesas',async()=>{
    const bad=await call('guardarPlano',{restaurantId:'ra',locationId:'la',createAreas:[{id:'patio',name:'Patio',sortOrder:1}],deleteAreas:['sala']},'owner-a')
    expect(bad.status).toBe(412)
    expect(await count("SELECT count(*) FROM llenamos.dining_areas WHERE restaurant_id='ra' AND id='patio'")).toBe(0)
    const good=await call('guardarPlano',{restaurantId:'ra',locationId:'la',createAreas:[{id:'patio',name:'Patio',sortOrder:1}],updateTables:[{id:'la-T3',areaId:'patio'}]},'manager-none'.replace('manager-none','owner-a'))
    expect(good.status,JSON.stringify(good.body)).toBe(200)
    const back=await call('guardarPlano',{restaurantId:'ra',locationId:'la',updateTables:[{id:'la-T3',areaId:'sala'}],deleteAreas:['patio']},'owner-a')
    expect(back.status).toBe(200)
  })

  it('fichas de cliente: editar solo notas, alergias y etiquetas; lecturas en vivo acotadas',async()=>{
    const id=core.customerIdFor('ra',phone(10))
    expect((await call('editarCliente',{restaurantId:'ra',customerId:id,notes:'Prefiere terraza',allergies:'Frutos secos',tags:['habitual']},'waiter-a')).status).toBe(200)
    expect((await call('editarCliente',{restaurantId:'ra',customerId:id,notes:'x',allergies:'',tags:[]},'cook-a')).status).toBe(403)
    expect((await call('editarCliente',{restaurantId:'rb',customerId:id,notes:'x',allergies:'',tags:[]},'owner-b')).status).toBe(404)
    expect((await call('editarCliente',{restaurantId:'ra',customerId:id,notes:'x',allergies:'',tags:[],name:'Otro'},'waiter-a')).status).toBe(400)
    const query=(name:string)=>reservasLiveQueries.find(q=>q.name===name)!
    const day=await withIdentity(app,identities['waiter-a']!,'ra',client=>query('reservasDia').snapshot(client,{restaurantId:'ra',locationId:'la',date:DATE},{uid:'waiter-a'})) as {reservations:Array<{guestName:string}>}
    expect(day.reservations.length).toBeGreaterThan(0)
    const clientes=await withIdentity(app,identities['waiter-a']!,'ra',client=>query('clientes').snapshot(client,{restaurantId:'ra',search:'Ana',limit:5},{uid:'waiter-a'})) as {customers:Array<{notes:string}>}
    expect(clientes.customers.some(c=>c.notes==='Prefiere terraza')).toBe(true)
    await expect(withIdentity(app,identities['waiter-la']!,'ra',client=>query('reservasDia').snapshot(client,{restaurantId:'ra',locationId:'lb2',date:DATE},{uid:'waiter-la'}))).rejects.toMatchObject({status:403})
    const planoLive=await withIdentity(app,identities['waiter-a']!,'ra',client=>query('plano').snapshot(client,{restaurantId:'ra',locationId:'la'},{uid:'waiter-a'})) as {tables:unknown[]}
    expect(planoLive.tables.length).toBe(3)
    const inputs:Record<string,unknown>={reservasDia:{restaurantId:'ra',locationId:'la',date:DATE},ajustesReservas:{restaurantId:'ra',locationId:'la'},listaEsperaDia:{restaurantId:'ra',locationId:'la',date:DATE},
      plano:{restaurantId:'ra',locationId:'la'},clientes:{restaurantId:'ra'},cliente:{restaurantId:'ra',customerId:id},reservasCliente:{restaurantId:'ra',locationId:'la',customerId:id}}
    for(const q of reservasLiveQueries)expect(q.topics(q.input.parse(inputs[q.name])).every(topic=>/^reservas\./.test(topic)),q.name).toBe(true)
  })
})
