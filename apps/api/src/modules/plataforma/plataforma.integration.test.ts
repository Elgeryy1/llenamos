import { createHmac,randomUUID } from 'node:crypto'
import { createServer,type Server } from 'node:http'
import { afterAll,afterEach,beforeAll,describe,expect,it } from 'vitest'
import { Pool,type PoolClient } from 'pg'
import * as core from '@llenamos/core'
import { migrationSql } from '../../test-migrations.js'
import { withIdentity } from '../../database.js'
import { withTenant } from '../../worker/tenant.js'
import { RetryLater } from '../../worker/types.js'
import { withPublicScope } from '../reservas/scope.js'
import type { IdentityToken } from '../../auth.js'
import { apiServer } from '../../server.js'
import { useBillingProvider,type BillingProvider } from './provider.js'
import { useCustodyKey } from './custody.js'
import { useDestinationResolver } from './destination.js'
import { BILLING_WEBHOOK_PATH,billingWebhookRoute,handleBillingEvent,poolRunner } from './webhook.js'
import { deliveryHandler,enqueuePlatformEvent,platformEventHandler,platformMaintenance,type DeliveryContext } from './eventos.js'
import { expireDueSubscriptions } from './suscripcion.js'
import { publicApiRoute,registerApiReaders,resetApiReaders } from './api-publica.js'

const source=process.env.TEST_POSTGRES_URL
const enabled=process.env.TEST_POSTGRES_API==='1'&&!!source
const token=(uid:string,version:string,platformClaim=false):IdentityToken=>({uid,sessionVersion:version.repeat(32),authTime:100,platformClaim})
const DAY=86_400_000
const sala=()=>core.provisionalPlanCatalog().find(p=>p.id==='sala')!
const planV2=()=>core.PlanDefinitionSchema.parse({...sala(),version:2,stripeMonthlyPriceId:'price_sala_mes',stripeAnnualPriceId:'price_sala_anio'})
const grupoV2=()=>core.PlanDefinitionSchema.parse({...core.provisionalPlanCatalog().find(p=>p.id==='grupo')!,version:2,stripeMonthlyPriceId:'price_grupo_mes',stripeAnnualPriceId:'price_grupo_anio'})

describe.skipIf(!enabled)('Plataforma restante: alta, Billing, API pública y webhooks en PostgreSQL',()=>{
  let admin:Pool,bootstrap:Pool,app:Pool,webhookPool:Pool,workerPool:Pool,owned=false,server:Server,base:string
  const suffix=randomUUID().replaceAll('-','').slice(0,12),database=`llenamos_api_test_billing_${suffix}`,runtime=`llenamos_api_billing_${suffix}`
  const actors:Record<string,IdentityToken>={}
  const request=async(name:string,data:unknown,actor='owner-a')=>{
    const response=await fetch(`${base}/v1/operations/${name}`,{method:'POST',headers:{'Content-Type':'application/json',...(actor?{Authorization:`Bearer ${actor}`}:{})},body:JSON.stringify({data})})
    return {status:response.status,body:await response.json() as {result?:unknown;error?:{code:string;message:string}}}
  }
  const ok=async(name:string,data:unknown,actor?:string)=>{const r=await request(name,data,actor);expect(r.status,JSON.stringify(r.body)).toBe(200);return r.body.result as never}
  const id=()=>`req_${randomUUID().replaceAll('-','')}`
  const asOwner=<T>(rid:string,fn:(client:PoolClient)=>Promise<T>,actor='owner-a')=>withIdentity(app,actors[actor]!,rid,fn)

  async function seed(rid:string,options:{status?:string;trialDays?:number;planVersion?:number;modules?:string[];members?:[string,string,string[]?][]}={}) {
    const modules=options.modules??['reservations','floor','kitchen'],days=options.trialDays??14
    await admin.query("INSERT INTO llenamos.restaurants(id,name,slug,plan,active_modules,entitlement_version,access_valid_until,commercial_plan_id,commercial_plan_version) VALUES($1,$1,$1,'sala',$2,1,now()+$3*interval '1 day','sala',$4)",[rid,modules,days,options.planVersion??1])
    await admin.query("INSERT INTO llenamos.platform_restaurants(restaurant_id,name,slug,plan_id,plan_version,owner_email,status,active_modules) VALUES($1,$1,$1,'sala',$4,$2,$3,$5)",[rid,`${rid}@example.test`,options.status??'trialing',options.planVersion??1,modules])
    await admin.query("INSERT INTO llenamos.platform_subscriptions(restaurant_id,plan_id,plan_version,status,trial_ends_at) VALUES($1,'sala',$3,$2,now()+$4*interval '1 day')",[rid,options.status??'trialing',options.planVersion??1,days])
    await admin.query('INSERT INTO llenamos.platform_usage(restaurant_id,locations,members,api_keys,webhooks) VALUES($1,1,1,0,0)',[rid])
    await admin.query("INSERT INTO llenamos.locations(restaurant_id,id,name,slug) VALUES($1,'principal','Principal','principal'),($1,'terraza','Terraza','terraza')",[rid])
  }
  const member=(rid:string,uid:string,role:string,locations:string[]=[])=>admin.query('INSERT INTO llenamos.memberships(restaurant_id,uid,role,active,display_name,email,location_ids) VALUES($1,$2::text,$3,true,$2::text,$4,$5)',[rid,uid,role,`${uid}@example.test`,locations])
  async function cleanKeysFor(rid:string){await admin.query('UPDATE llenamos.api_keys SET revoked_at=now() WHERE restaurant_id=$1 AND revoked_at IS NULL',[rid]);await admin.query("UPDATE llenamos.platform_usage SET api_keys=0 WHERE restaurant_id=$1",[rid])}
  const subscription=async(rid:string)=>(await admin.query('SELECT * FROM llenamos.platform_subscriptions WHERE restaurant_id=$1',[rid])).rows[0]

  beforeAll(async()=>{
    const url=new URL(source!)
    if(!['localhost','127.0.0.1'].includes(url.hostname)||!url.pathname.startsWith('/llenamos_api_test_'))throw new Error('Solo PostgreSQL temporal loopback de pruebas.')
    bootstrap=new Pool({connectionString:source,max:1})
    await bootstrap.query(`CREATE DATABASE ${database}`);owned=true
    url.pathname=`/${database}`
    admin=new Pool({connectionString:url.toString(),max:2})
    for(const sql of migrationSql())await admin.query(sql)
    await admin.query(`CREATE ROLE ${runtime} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD 'fixture-only' IN ROLE llenamos_app`)
    url.username=runtime;url.password='fixture-only';app=new Pool({connectionString:url.toString(),max:8,statement_timeout:8000})
    const people:[string,string,boolean][]=[['operator','a',true],['owner-a','b',false],['manager-a','c',false],['waiter-a','d',false],['owner-b','e',false],['guest','f',false],['limited','9',false]]
    // Logins aparte como en producción: el receptor de Billing (no es miembro de llenamos_app) y el worker.
    await admin.query(`CREATE ROLE ${runtime}_wh LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD 'fixture-only' IN ROLE llenamos_webhook`)
    await admin.query(`CREATE ROLE ${runtime}_wk LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD 'fixture-only' IN ROLE llenamos_app,llenamos_worker`)
    const login=(suffix:string)=>{const u=new URL(url);u.username=`${runtime}_${suffix}`;u.password='fixture-only';return new Pool({connectionString:u.toString(),max:4,statement_timeout:8000})}
    webhookPool=login('wh');workerPool=login('wk')
    for(const [uid,version,platform] of people) {
      await admin.query('INSERT INTO llenamos.identities(uid,session_version,tokens_valid_after,locked,platform_operator) VALUES($1,$2,to_timestamp(100),false,$3)',[uid,version.repeat(32),platform])
      actors[uid]=token(uid,version,platform)
    }
    await seed('tenant-a');await seed('tenant-b')
    await member('tenant-a','owner-a','owner');await member('tenant-a','manager-a','manager');await member('tenant-a','waiter-a','waiter')
    await member('tenant-a','limited','manager',['principal'])
    await member('tenant-b','owner-b','owner')
    // guest tiene un correo acreditado por una invitación aceptada en otro restaurante, pero ningún restaurante propio.
    await seed('seed-guest');await member('seed-guest','guest','waiter')
    useCustodyKey(Buffer.alloc(32,9))
    useDestinationResolver(async()=>[{address:'93.184.216.34',family:4}])
    server=apiServer(app,async value=>actors[value]??token(value,'z'))
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
    const address=server.address();if(!address||typeof address==='string')throw new Error('address')
    base=`http://127.0.0.1:${address.port}`
  },60_000)
  afterAll(async()=>{
    server?.closeAllConnections();if(server)await new Promise<void>(resolve=>server.close(()=>resolve()))
    useCustodyKey(undefined);useDestinationResolver(undefined);useBillingProvider(undefined)
    await webhookPool?.end();await workerPool?.end();await app?.end();await admin?.end()
    for(const pool of [app,admin])pool?.on('error',error=>{if((error as {code?:string}).code!=='57P01')throw error})
    if(owned){await bootstrap.query(`DROP DATABASE ${database} WITH(FORCE)`);await bootstrap.query(`DROP ROLE IF EXISTS ${runtime}`);await bootstrap.query(`DROP ROLE IF EXISTS ${runtime}_wh`);await bootstrap.query(`DROP ROLE IF EXISTS ${runtime}_wk`)}
    await bootstrap?.end()
  })
  const flag=(on:boolean)=>admin.query("INSERT INTO llenamos.platform_flags(name,enabled) VALUES('self_signup',$1) ON CONFLICT(name) DO UPDATE SET enabled=excluded.enabled",[on])
  afterEach(async()=>{delete process.env.PLATFORM_SELF_SIGNUP;await flag(false);useBillingProvider(undefined);resetApiReaders()})

  describe('alta por su cuenta',()=>{
    const draft=(slug:string)=>({name:`Casa ${slug}`,slug,location:{name:'Sala principal',address:'Calle 1',city:'Madrid',phone:'600000000'},settings:core.defaultReservationSettings(),planId:'sala',planVersion:1,acceptedTermsVersion:'alta-provisional-v1'})
    const save=(slug:string,actor='guest',requestId=id())=>request('guardarAlta',{requestId,onboardingId:null,expectedRevision:null,step:'review',draft:draft(slug)},actor)
    it('está apagada por defecto: solo LogiQD da de alta restaurantes',async()=>{
      const r=await save('apagada')
      expect(r.status).toBe(403)
      expect(r.body.error?.message).toContain('LogiQD')
    })
    it('un operador de plataforma no usa el asistente',async()=>{
      process.env.PLATFORM_SELF_SIGNUP='1';await flag(true)
      expect((await save('operador','operator')).status).toBe(403)
    })
    it('crea restaurante, local, propietario, prueba y uso; reintentar recupera la respuesta; la prueba es única',async()=>{
      process.env.PLATFORM_SELF_SIGNUP='1';await flag(true)
      const requestId=id()
      const saved=core.GuardarAltaOutputSchema.parse(await ok('guardarAlta',{requestId,onboardingId:null,expectedRevision:null,step:'review',draft:draft('casa-uno')},'guest'))
      expect(core.GuardarAltaOutputSchema.parse(await ok('guardarAlta',{requestId,onboardingId:null,expectedRevision:null,step:'review',draft:draft('casa-uno')},'guest'))).toEqual(saved)
      expect((await request('guardarAlta',{requestId,onboardingId:null,expectedRevision:null,step:'review',draft:draft('otra-cosa')},'guest')).status).toBe(409)
      // Un borrador es privado de su cuenta.
      expect((await request('completarAlta',{requestId:id(),onboardingId:saved.onboardingId,expectedRevision:saved.onboarding.revision},'owner-b')).status).toBe(404)
      expect((await request('completarAlta',{requestId:id(),onboardingId:saved.onboardingId,expectedRevision:99},'guest')).status).toBe(409)
      const finish={requestId:id(),onboardingId:saved.onboardingId,expectedRevision:saved.onboarding.revision}
      const done=core.CompletarAltaOutputSchema.parse(await ok('completarAlta',finish,'guest'))
      expect(done.subscription.status).toBe('trialing')
      expect(done.entitlements.serviceEnabled).toBe(true)
      expect(done.entitlements.activeModules).toEqual(['reservations','floor','kitchen'])
      expect(core.CompletarAltaOutputSchema.parse(await ok('completarAlta',finish,'guest'))).toEqual(done)
      const rows=await admin.query("SELECT m.role,m.active,r.slug,u.members,u.locations FROM llenamos.memberships m JOIN llenamos.restaurants r ON r.id=m.restaurant_id JOIN llenamos.platform_usage u ON u.restaurant_id=r.id WHERE m.restaurant_id=$1",[done.restaurantId])
      expect(rows.rows).toEqual([{role:'owner',active:true,slug:'casa-uno',members:1,locations:1}])
      expect((await admin.query("SELECT 1 FROM llenamos.locations WHERE restaurant_id=$1 AND id='principal'",[done.restaurantId])).rowCount).toBe(1)
      // El nuevo propietario ya opera su restaurante; ningún otro lo ve.
      await ok('verSuscripcion',{restaurantId:done.restaurantId},'guest')
      expect((await request('verSuscripcion',{restaurantId:done.restaurantId},'owner-b')).status).toBe(403)
      // Segunda prueba con la misma cuenta, otro borrador y otra dirección: rechazada.
      const second=core.GuardarAltaOutputSchema.parse(await ok('guardarAlta',{requestId:id(),onboardingId:null,expectedRevision:null,step:'review',draft:draft('casa-dos')},'guest'))
      const again=await request('completarAlta',{requestId:id(),onboardingId:second.onboardingId,expectedRevision:second.onboarding.revision},'guest')
      expect(again.status).toBe(412)
      expect(again.body.error?.message).toContain('prueba')
      expect((await admin.query("SELECT 1 FROM llenamos.restaurants WHERE slug='casa-dos'")).rowCount).toBe(0)
    })
    it('exige condiciones aceptadas, plan disponible y dirección libre',async()=>{
      process.env.PLATFORM_SELF_SIGNUP='1';await flag(true)
      for(const [uid,version] of [['alta-terms','1'],['alta-slug','2']] as [string,string][]) {
        await admin.query('INSERT INTO llenamos.identities(uid,session_version,tokens_valid_after,locked) VALUES($1,$2,to_timestamp(100),false)',[uid,version.repeat(32)])
        actors[uid]=token(uid,version)
        await admin.query("INSERT INTO llenamos.memberships(restaurant_id,uid,role,active,display_name,email) VALUES('seed-guest',$1::text,'waiter',true,$1::text,$2)",[uid,`${uid}@example.test`])
      }
      const terms=core.GuardarAltaOutputSchema.parse(await ok('guardarAlta',{requestId:id(),onboardingId:null,expectedRevision:null,step:'review',draft:{...draft('sin-terminos'),acceptedTermsVersion:'otra'}},'alta-terms'))
      expect((await request('completarAlta',{requestId:id(),onboardingId:terms.onboardingId,expectedRevision:terms.onboarding.revision},'alta-terms')).status).toBe(412)
      const slug=core.GuardarAltaOutputSchema.parse(await ok('guardarAlta',{requestId:id(),onboardingId:null,expectedRevision:null,step:'review',draft:draft('tenant-a')},'alta-slug'))
      const taken=await request('completarAlta',{requestId:id(),onboardingId:slug.onboardingId,expectedRevision:slug.onboarding.revision},'alta-slug')
      expect(taken.status).toBe(409)
      // El fallo no consume la prueba: tras cambiar la dirección se completa.
      const fixed=core.GuardarAltaOutputSchema.parse(await ok('guardarAlta',{requestId:id(),onboardingId:slug.onboardingId,expectedRevision:slug.onboarding.revision,step:'review',draft:{slug:'alta-slug-libre'}},'alta-slug'))
      await ok('completarAlta',{requestId:id(),onboardingId:fixed.onboardingId,expectedRevision:fixed.onboarding.revision},'alta-slug')
    })
    async function account(uid:string,email:string,version:string) {
      await admin.query('INSERT INTO llenamos.identities(uid,session_version,tokens_valid_after,locked) VALUES($1,$2,to_timestamp(100),false)',[uid,version.repeat(32)])
      await admin.query("INSERT INTO llenamos.memberships(restaurant_id,uid,role,active,display_name,email) VALUES('seed-guest',$1::text,'waiter',true,$1::text,$2)",[uid,email])
      actors[uid]=token(uid,version)
    }
    const complete=async(actor:string,over:Record<string,unknown>)=>{
      const saved=core.GuardarAltaOutputSchema.parse(await ok('guardarAlta',{requestId:id(),onboardingId:null,expectedRevision:null,step:'review',draft:{...draft(String(over.slug)),...over}},actor))
      return request('completarAlta',{requestId:id(),onboardingId:saved.onboardingId,expectedRevision:saved.onboarding.revision},actor)
    }
    it('crea los ajustes mínimos de reservas y sala, el plano y la carta interna sin publicar',async()=>{
      process.env.PLATFORM_SELF_SIGNUP='1';await flag(true)
      await account('ajustes','ajustes@example.test','3')
      const done=await complete('ajustes',{slug:'casa-ajustes',floor:{areaName:'Terraza',tableCount:3,seats:2},menu:[{name:'Tortilla',priceCents:900},{name:'Agua',priceCents:200}]})
      expect(done.status,JSON.stringify(done.body)).toBe(200)
      const { restaurantId:rid } = core.CompletarAltaOutputSchema.parse(done.body.result)
      const count=async(table:string)=>(await admin.query(`SELECT count(*)::int AS n FROM llenamos.${table} WHERE restaurant_id=$1 AND location_id='principal'`,[rid])).rows[0].n
      expect({reservas:await count('reservation_settings'),zonas:await count('dining_areas'),mesas:await count('dining_tables'),estaciones:await count('sala_stations'),ajustes:await count('sala_settings'),categorias:await count('sala_menu_categories'),platos:await count('sala_menu_items')})
        .toEqual({reservas:1,zonas:1,mesas:3,estaciones:1,ajustes:1,categorias:1,platos:2})
      const dishes=(await admin.query("SELECT doc FROM llenamos.sala_menu_items WHERE restaurant_id=$1 ORDER BY id",[rid])).rows.map(r=>r.doc)
      expect(dishes[0]).toMatchObject({priceCents:900,allergensReviewed:false,selfOrder:false,takeaway:false})
      expect((await admin.query("SELECT doc->>'name' AS n FROM llenamos.sala_stations WHERE restaurant_id=$1",[rid])).rows).toEqual([{n:'Cocina'}])
      // Sin plano ni carta: seis mesas de cuatro plazas y ninguna carta.
      await account('ajustes2','ajustes2@example.test','4')
      const plain=core.CompletarAltaOutputSchema.parse((await complete('ajustes2',{slug:'casa-plana'})).body.result)
      expect((await admin.query("SELECT count(*)::int AS n FROM llenamos.dining_tables WHERE restaurant_id=$1",[plain.restaurantId])).rows[0].n).toBe(6)
      expect((await admin.query("SELECT count(*)::int AS n FROM llenamos.sala_menu_items WHERE restaurant_id=$1",[plain.restaurantId])).rows[0].n).toBe(0)
      // El nuevo propietario ya puede abrir su plano y sus ajustes por las operaciones del servicio: ve su local.
      expect((await withIdentity(app,actors.ajustes!,rid,c=>c.query("SELECT 1 FROM llenamos.dining_tables"))).rowCount).toBe(3)
    })
    it('una prueba por buzón: ni un +alias ni los puntos de Gmail abren otra, aunque cambie el uid',async()=>{
      process.env.PLATFORM_SELF_SIGNUP='1';await flag(true)
      await account('buzon-a','Ana.Perez@gmail.com','5');await account('buzon-b','anaperez+nueva@googlemail.com','6');await account('buzon-c','dueno@example.test','7');await account('buzon-d','Dueno+otra@EXAMPLE.test','8')
      expect((await complete('buzon-a',{slug:'buzon-uno'})).status).toBe(200)
      const alias=await complete('buzon-b',{slug:'buzon-dos'})
      expect(alias.status).toBe(412);expect(alias.body.error?.message).toContain('prueba')
      expect((await complete('buzon-c',{slug:'buzon-tres'})).status).toBe(200)
      expect((await complete('buzon-d',{slug:'buzon-cuatro'})).status).toBe(412)
      expect((await admin.query("SELECT 1 FROM llenamos.restaurants WHERE slug IN ('buzon-dos','buzon-cuatro')")).rowCount).toBe(0)
    })
    it('valida nombre y dirección también en SQL, como el alta administrativa',async()=>{
      process.env.PLATFORM_SELF_SIGNUP='1';await flag(true)
      await account('valida','valida@example.test','9')
      const saved=core.GuardarAltaOutputSchema.parse(await ok('guardarAlta',{requestId:id(),onboardingId:null,expectedRevision:null,step:'review',draft:draft('valida-ok')},'valida'))
      // Se corrompe el borrador por debajo de la API (lo que no deja pasar el esquema) y la función lo rechaza.
      await admin.query("UPDATE llenamos.platform_onboardings SET draft=jsonb_set(draft,'{slug}','\"Con Espacios\"') WHERE id=$1",[saved.onboardingId])
      await expect(withIdentity(app,actors.valida!,null,c=>c.query("SELECT llenamos.billing_onboarding_complete($1,$2,$3,'sala','abcdefghijklmnop')",[saved.onboardingId,saved.onboarding.revision,`alta_${'b'.repeat(32)}`]))).rejects.toMatchObject({code:'22023'})
      expect((await admin.query("SELECT 1 FROM llenamos.restaurants WHERE id LIKE 'alta_bbbb%'")).rowCount).toBe(0)
    })
    it('limita los borradores abiertos por cuenta',async()=>{
      process.env.PLATFORM_SELF_SIGNUP='1';await flag(true)
      await admin.query('INSERT INTO llenamos.identities(uid,session_version,tokens_valid_after,locked) VALUES($1,$2,to_timestamp(100),false)',['borradores','8'.repeat(32)])
      actors.borradores=token('borradores','8')
      const statuses:number[]=[]
      for(let i=0;i<7;i++)statuses.push((await request('guardarAlta',{requestId:id(),onboardingId:null,expectedRevision:null,step:'identity',draft:{}},'borradores')).status)
      expect(statuses).toEqual([200,200,200,200,200,429,429])
    })
  })

  describe('suscripción, planes y excepciones',()=>{
    it('el propietario y el encargado ven el plan; camarero y ajenos no',async()=>{
      for(const actor of ['owner-a','manager-a']) {
        const view=core.VerSuscripcionOutputSchema.parse(await ok('verSuscripcion',{restaurantId:'tenant-a'},actor))
        expect(view.subscription.status).toBe('trialing')
        expect(JSON.stringify(view)).not.toContain('stripeMonthlyPriceId')
      }
      for(const actor of ['waiter-a','owner-b','guest','operator'])expect((await request('verSuscripcion',{restaurantId:'tenant-a'},actor)).status,actor).toBe(403)
      expect((await request('verSuscripcion',{restaurantId:'tenant-a'},'')).status).toBe(401)
    })
    it('una prueba vencida se suspende al mirarla, conserva el panel de planes y cierra el resto',async()=>{
      await seed('expirada',{trialDays:-1});await member('expirada','owner-a','owner')
      await admin.query("UPDATE llenamos.restaurants SET access_valid_until=now()+interval '1 day' WHERE id='expirada'")
      const view=core.VerSuscripcionOutputSchema.parse(await ok('verSuscripcion',{restaurantId:'expirada'}))
      expect(view.subscription.status).toBe('suspended')
      expect(view.entitlements).toMatchObject({serviceEnabled:false,activeModules:[],reason:'suspended'})
      const row=(await admin.query("SELECT r.active_modules,r.access_valid_until<=now() AS closed,p.status FROM llenamos.restaurants r JOIN llenamos.platform_restaurants p ON p.restaurant_id=r.id WHERE r.id='expirada'")).rows[0]
      expect(row).toEqual({active_modules:[],closed:true,status:'suspended'})
      // Sigue pudiendo ver el plan y abrir la facturación; los datos operativos ya no.
      expect((await request('verSuscripcion',{restaurantId:'expirada'})).status).toBe(200)
      expect((await request('iniciarSuscripcion',{restaurantId:'expirada',requestId:id(),expectedRevision:view.subscription.revision,planId:'sala',planVersion:1,interval:'month'})).status).toBe(200)
      expect((await request('listarIntegraciones',{restaurantId:'expirada'})).status).toBe(412)
    })
    it('el barrido de vencimientos suspende lo vencido sin que nadie abra el plan, y avisa por evento',async()=>{
      await seed('vence',{trialDays:-1});await member('vence','owner-a','owner')
      await seed('vence-ok');await seed('vence-baja',{status:'active'})
      await admin.query("UPDATE llenamos.platform_subscriptions SET status='active',period_ends_at=now()-interval '1 hour',cancel_at_period_end=true WHERE restaurant_id='vence-baja'")
      const swept=await expireDueSubscriptions(workerPool,500)
      expect(swept).toBeGreaterThanOrEqual(2)
      expect(await subscription('vence')).toMatchObject({status:'suspended',revision:2})
      expect(await subscription('vence-baja')).toMatchObject({status:'cancelled'})
      expect(await subscription('vence-ok')).toMatchObject({status:'trialing',revision:1})
      expect((await admin.query("SELECT active_modules FROM llenamos.restaurants WHERE id='vence'")).rows[0].active_modules).toEqual([])
      expect((await admin.query("SELECT payload FROM llenamos.events WHERE restaurant_id='vence' AND topic='plataforma.suscripcion'")).rows).toEqual([{payload:{status:'suspended',revision:2}}])
      // Repetir el barrido no vuelve a cambiar nada.
      await expireDueSubscriptions(workerPool,500)
      expect((await subscription('vence')).revision).toBe(2)
    })
    it('catálogo: solo plataforma publica, las versiones son inmutables y repetir es idempotente',async()=>{
      const plan=planV2()
      const body={requestId:id(),plan}
      expect((await request('guardarPlanPlataforma',body,'owner-a')).status).toBe(403)
      await ok('guardarPlanPlataforma',body,'operator')
      await ok('guardarPlanPlataforma',body,'operator')
      await ok('guardarPlanPlataforma',{requestId:id(),plan},'operator')
      const changed=await request('guardarPlanPlataforma',{requestId:id(),plan:{...plan,monthlyCents:1}},'operator')
      expect(changed.status).toBe(412)
      expect(changed.body.error?.message).toContain('inmutable')
      expect((await request('guardarPlanPlataforma',{...body,plan:{...plan,monthlyCents:2}},'operator')).status).toBe(409)
      // Un precio de Stripe identifica una sola versión: reutilizarlo dejaría ambiguas las renovaciones.
      const reused=await request('guardarPlanPlataforma',{requestId:id(),plan:{...plan,version:3,stripeMonthlyPriceId:'price_sala_mes',stripeAnnualPriceId:'price_otra_anio'}},'operator')
      expect(reused.status).toBe(412);expect(reused.body.error?.message).toContain('precio')
      expect((await request('guardarPlanPlataforma',{requestId:id(),plan:{...plan,version:3,stripeMonthlyPriceId:'price_sala_anio',stripeAnnualPriceId:'price_nueva'}},'operator')).status).toBe(412)
      expect((await request('guardarPlanPlataforma',{requestId:id(),plan:{...plan,version:3,stripeMonthlyPriceId:'price_igual',stripeAnnualPriceId:'price_igual'}},'operator')).status).toBe(412)
      await ok('guardarPlanPlataforma',{requestId:id(),plan:{...plan,version:3,stripeMonthlyPriceId:'price_sala_v3_mes',stripeAnnualPriceId:'price_sala_v3_anio'}},'operator')
      await ok('guardarPlanPlataforma',{requestId:id(),plan:grupoV2()},'operator')
      // La versión original del catálogo tampoco se reescribe.
      const original=core.provisionalPlanCatalog().find(p=>p.id==='sala')!
      expect((await request('guardarPlanPlataforma',{requestId:id(),plan:{...original,monthlyCents:1}},'operator')).status).toBe(412)
      // El catálogo público nunca expone los precios de Stripe.
      const catalog=core.ListarPlanesDisponiblesOutputSchema.parse(await ok('listarPlanesDisponibles',{},''))
      expect(JSON.stringify(catalog)).not.toContain('price_sala_mes')
    })
    it('excepciones de módulo: solo plataforma, con revisión y sin saltarse una suspensión',async()=>{
      const rev=core.VerSuscripcionOutputSchema.parse(await ok('verSuscripcion',{restaurantId:'tenant-b'},'owner-b')).subscription.revision
      const input={restaurantId:'tenant-b',requestId:id(),expectedRevision:rev,moduleOverrides:{pos:true,kitchen:false},reason:'Piloto de caja'}
      expect((await request('cambiarExcepcionesPlataforma',input,'owner-b')).status).toBe(403)
      const out=core.CambiarExcepcionesPlataformaOutputSchema.parse(await ok('cambiarExcepcionesPlataforma',input,'operator'))
      expect(out.entitlements.activeModules).toEqual(['reservations','floor','pos'])
      expect(core.CambiarExcepcionesPlataformaOutputSchema.parse(await ok('cambiarExcepcionesPlataforma',input,'operator'))).toEqual(out)
      expect((await request('cambiarExcepcionesPlataforma',{...input,requestId:id()},'operator')).status).toBe(409)
      const row=(await admin.query("SELECT r.active_modules,r.module_overrides,r.entitlement_version,s.revision FROM llenamos.restaurants r JOIN llenamos.platform_subscriptions s ON s.restaurant_id=r.id WHERE r.id='tenant-b'")).rows[0]
      expect(row).toMatchObject({active_modules:['reservations','floor','pos'],module_overrides:{pos:true,kitchen:false},entitlement_version:rev+1,revision:rev+1})
      expect((await admin.query("SELECT reason FROM llenamos.platform_audit WHERE restaurant_id='tenant-b' AND action='subscription.overrides'")).rows).toEqual([{reason:'Piloto de caja'}])
    })
    it('uso: medición real para el propietario y listado mínimo para plataforma, sin interior del restaurante',async()=>{
      const usage=core.VerUsoPlataformaOutputSchema.parse(await ok('verUsoPlataforma',{restaurantId:'tenant-a'}))
      expect(usage).toMatchObject({restaurantId:'tenant-a',locations:2,members:4,apiKeys:0,webhooks:0})
      expect((await request('verUsoPlataforma',{restaurantId:'tenant-a'},'waiter-a')).status).toBe(403)
      expect((await request('verUsoPlataforma',{restaurantId:'tenant-a'},'owner-b')).status).toBe(403)
      const page=core.ListarRestaurantesLogiqdOutputSchema.parse(await ok('listarRestaurantesLogiqd',{limit:2},'operator'))
      expect(page.restaurants).toHaveLength(2);expect(page.nextCursor).not.toBeNull()
      const next=core.ListarRestaurantesLogiqdOutputSchema.parse(await ok('listarRestaurantesLogiqd',{limit:2,cursor:page.nextCursor},'operator'))
      expect(next.restaurants[0]!.restaurantId>page.restaurants[1]!.restaurantId).toBe(true)
      expect((await request('listarRestaurantesLogiqd',{},'owner-a')).status).toBe(403)
      expect((await request('listarRestaurantesLogiqd',{cursor:'%%%'},'operator')).status).toBe(400)
      const suspended=core.ListarRestaurantesLogiqdOutputSchema.parse(await ok('listarRestaurantesLogiqd',{status:'suspended'},'operator'))
      expect(suspended.restaurants.map(r=>r.status)).toEqual(suspended.restaurants.map(()=>'suspended'))
      // Plataforma no entra en el interior: ni claves, ni webhooks, ni miembros por SQL de la API.
      const inside=await withIdentity(app,actors.operator!,null,async client=>({
        keys:(await client.query('SELECT 1 FROM llenamos.api_keys')).rowCount,hooks:(await client.query('SELECT 1 FROM llenamos.webhook_endpoints')).rowCount,members:(await client.query('SELECT 1 FROM llenamos.memberships')).rowCount}))
      expect(inside).toEqual({keys:0,hooks:0,members:0})
    })
    it('apertura de soporte: solo plataforma, con caducidad, idempotente y sin conceder lectura',async()=>{
      const input={restaurantId:'tenant-b',requestId:id(),reason:'Revisar un cobro',durationMinutes:30}
      expect((await request('abrirAccesoSoporte',input,'owner-b')).status).toBe(403)
      const a=core.AbrirAccesoSoporteOutputSchema.parse(await ok('abrirAccesoSoporte',input,'operator'))
      expect(core.AbrirAccesoSoporteOutputSchema.parse(await ok('abrirAccesoSoporte',input,'operator'))).toEqual(a)
      expect(a.expiresAt).toBeGreaterThan(Date.now()+29*60_000)
      expect((await request('abrirAccesoSoporte',{...input,requestId:id(),restaurantId:'no-existe'},'operator')).status).toBe(404)
      expect((await request('abrirAccesoSoporte',{...input,requestId:id(),durationMinutes:61},'operator')).status).toBe(400)
      expect((await admin.query("SELECT count(*)::int AS n FROM llenamos.platform_support_access WHERE restaurant_id='tenant-b'")).rows[0].n).toBe(1)
      expect((await admin.query("SELECT 1 FROM llenamos.platform_audit WHERE restaurant_id='tenant-b' AND action='support.opened'")).rowCount).toBe(1)
    })
  })

  describe('Stripe Billing',()=>{
    const fakeProvider=(overrides:Partial<BillingProvider>={}):BillingProvider&{calls:string[]}=>{
      const calls:string[]=[]
      return {configured:true,calls,
        async start(input){calls.push(`start:${input.key}`);return {id:`cs_${input.key.slice(0,12)}`,url:`https://checkout.stripe.test/${input.key.slice(0,12)}`}},
        async portal(customer,key){calls.push(`portal:${customer}:${key}`);return {url:'https://billing.stripe.test/portal'}},
        async cancel(subscription,key){calls.push(`cancel:${subscription}:${key}`);return {endsAt:periodEnd*1000}},
        async current(){throw new Error('sin reconciliar')},...overrides}
    }
    const periodEnd=Math.floor(Date.now()/1000)+30*86_400
    let seq=0
    const stripe=(type:string,object:unknown,created:number)=>({id:`evt_${randomUUID().replaceAll('-','')}${seq++}`,type,created,livemode:false,data:{object}})
    const invoice=(over:Record<string,unknown>={},invoiceId='in_1',cents=9900,price='price_sala_mes')=>({id:invoiceId,customer:'cus_1',subscription:'sub_1',currency:'eur',status:'paid',paid:true,amount_paid:cents,amount_due:cents,total:cents,
      lines:{has_more:false,data:[{quantity:1,amount:cents,currency:'eur',period:{start:periodEnd-30*86_400,end:periodEnd},price:{id:price}}]},...over})
    const stripeSubscription=(over:Record<string,unknown>={})=>({id:'sub_1',customer:'cus_1',status:'active',cancel_at_period_end:false,items:{data:[{price:{id:'price_sala_mes'},quantity:1}]},...over})
    const runner=()=>poolRunner(webhookPool)
    const start=(rid:string,over:Record<string,unknown>={})=>({restaurantId:rid,requestId:id(),expectedRevision:1,planId:'sala',planVersion:2,interval:'month',...over})

    it('sin Stripe configurado no se cobra ni se simula: devuelve not_configured y no deja intención pendiente',async()=>{
      useBillingProvider({...fakeProvider(),configured:false})
      const input=start('tenant-a')
      const first=core.IniciarSuscripcionOutputSchema.parse(await ok('iniciarSuscripcion',input))
      expect(first).toEqual({status:'not_configured',message:expect.stringContaining('No se ha realizado ningún cargo')})
      expect(core.IniciarSuscripcionOutputSchema.parse(await ok('iniciarSuscripcion',input))).toEqual(first)
      expect((await subscription('tenant-a')).pending_intent).toBeNull()
      expect(core.AbrirPortalFacturacionOutputSchema.parse(await ok('abrirPortalFacturacion',{restaurantId:'tenant-a',requestId:id()})).status).toBe('not_configured')
      expect(core.CancelarSuscripcionOutputSchema.parse(await ok('cancelarSuscripcion',{restaurantId:'tenant-a',requestId:id(),expectedRevision:1,reason:'Prueba'})).status).toBe('not_configured')
      // Mismo identificador con otros datos: conflicto.
      expect((await request('iniciarSuscripcion',{...input,interval:'year'})).status).toBe(409)
    })
    it('solo el propietario gestiona; el encargado, el camarero y los ajenos no',async()=>{
      useBillingProvider(fakeProvider())
      for(const actor of ['manager-a','waiter-a','owner-b','operator'])expect((await request('iniciarSuscripcion',start('tenant-a'),actor)).status,actor).toBe(403)
      expect((await request('abrirPortalFacturacion',{restaurantId:'tenant-a',requestId:id()},'manager-a')).status).toBe(403)
      expect((await request('cancelarSuscripcion',{restaurantId:'tenant-a',requestId:id(),expectedRevision:1,reason:'x'},'manager-a')).status).toBe(403)
    })
    it('Checkout, vinculación, primera factura pagada, duplicados, impago y baja de punta a punta',async()=>{
      await seed('cobro');await member('cobro','owner-a','owner')
      const provider=fakeProvider();useBillingProvider(provider)
      const input=start('cobro')
      const started=core.IniciarSuscripcionOutputSchema.parse(await ok('iniciarSuscripcion',input))
      expect(started).toMatchObject({status:'ready',url:expect.stringMatching(/^https:\/\/checkout\.stripe\.test\//)})
      expect(core.IniciarSuscripcionOutputSchema.parse(await ok('iniciarSuscripcion',input))).toEqual(started)
      expect(new Set(provider.calls).size).toBe(1) // el reintento no vuelve a llamar a Stripe
      const row=await subscription('cobro'),intentId=row.pending_intent as string
      expect(intentId).toMatch(/^[a-f0-9]{64}$/)
      expect((await request('iniciarSuscripcion',start('cobro'))).status).toBe(412) // hay otro cambio pendiente
      const intent=(await admin.query('SELECT external_id,kind FROM llenamos.billing_intents WHERE restaurant_id=$1 AND id=$2',['cobro',intentId])).rows[0]
      // Un Checkout ajeno no se vincula.
      const forged=stripe('checkout.session.completed',{id:'cs_otro',mode:'subscription',customer:'cus_1',subscription:'sub_1',metadata:{restaurantId:'cobro',intentId}},1000)
      await expect(handleBillingEvent(runner(),forged)).rejects.toMatchObject({status:422})
      const checkout=stripe('checkout.session.completed',{id:intent.external_id,mode:'subscription',customer:'cus_1',subscription:'sub_1',metadata:{restaurantId:'cobro',intentId}},1000)
      expect(await handleBillingEvent(runner(),checkout)).toEqual({status:'bound'})
      expect(await handleBillingEvent(runner(),checkout)).toEqual({status:'duplicate'})
      let bound=await subscription('cobro')
      expect(bound).toMatchObject({stripe_customer_id:'cus_1',stripe_subscription_id:'sub_1',status:'trialing',plan_version:1})
      // Vincular no concede servicio de pago: sigue en prueba.
      const paid=stripe('invoice.paid',invoice(),2000)
      expect(await handleBillingEvent(runner(),paid)).toEqual({status:'applied'})
      expect(await handleBillingEvent(runner(),paid)).toEqual({status:'duplicate'})
      bound=await subscription('cobro')
      expect(bound).toMatchObject({status:'active',plan_version:2,pending_intent:null,last_paid_invoice_id:'in_1',interval:'month'})
      expect(bound.period_ends_at.getTime()).toBe(periodEnd*1000)
      const restaurant=(await admin.query("SELECT r.active_modules,r.commercial_plan_version,r.entitlement_version,p.status FROM llenamos.restaurants r JOIN llenamos.platform_restaurants p ON p.restaurant_id=r.id WHERE r.id='cobro'")).rows[0]
      expect(restaurant).toMatchObject({active_modules:['reservations','floor','kitchen'],commercial_plan_version:2,status:'active',entitlement_version:bound.revision})
      // Una factura con otro importe o precio desconocido no concede nada.
      await expect(handleBillingEvent(runner(),stripe('invoice.paid',invoice({},'in_2',100),3000))).rejects.toMatchObject({status:422})
      await expect(handleBillingEvent(runner(),stripe('invoice.paid',invoice({},'in_3',9900,'price_desconocido'),3001))).rejects.toMatchObject({status:422})
      // Impago: periodo de gracia de siete días y servicio activo.
      await handleBillingEvent(runner(),stripe('invoice.payment_failed',invoice({status:'open',paid:false,amount_paid:0},'in_4'),4000))
      bound=await subscription('cobro')
      expect(bound.status).toBe('past_due')
      expect(bound.grace_ends_at.getTime()-Date.now()).toBeGreaterThan(6*DAY)
      // Pagada de nuevo vuelve a active.
      await handleBillingEvent(runner(),stripe('invoice.paid',invoice({},'in_5'),5000))
      expect((await subscription('cobro')).status).toBe('active')
      // Baja programada por el propietario: Stripe confirma el fin del periodo.
      const cancel={restaurantId:'cobro',requestId:id(),expectedRevision:(await subscription('cobro')).revision,reason:'Cierra el local'}
      const cancelled=core.CancelarSuscripcionOutputSchema.parse(await ok('cancelarSuscripcion',cancel))
      expect(cancelled).toEqual({status:'scheduled',endsAt:periodEnd*1000})
      expect(core.CancelarSuscripcionOutputSchema.parse(await ok('cancelarSuscripcion',cancel))).toEqual(cancelled)
      expect((await subscription('cobro')).cancel_at_period_end).toBe(true)
      // Eliminación definitiva: no se reactiva con facturas tardías.
      await handleBillingEvent(runner(),stripe('customer.subscription.deleted',stripeSubscription({status:'canceled'}),6000))
      expect((await subscription('cobro')).status).toBe('cancelled')
      await expect(handleBillingEvent(runner(),stripe('invoice.paid',invoice({},'in_6'),7000))).rejects.toMatchObject({status:422})
      expect((await subscription('cobro')).status).toBe('cancelled')
      const closed=(await admin.query("SELECT active_modules,access_valid_until<=now() AS closed FROM llenamos.restaurants WHERE id='cobro'")).rows[0]
      expect(closed).toEqual({active_modules:[],closed:true})
    })
    it('un evento desordenado se reconcilia con Stripe y, sin Stripe, no cambia el acceso',async()=>{
      await seed('orden');await member('orden','owner-a','owner')
      useBillingProvider(fakeProvider())
      const mine={customer:'cus_2',subscription:'sub_2'}
      const {intentId,externalId}=await (async()=>{
        await ok('iniciarSuscripcion',start('orden'))
        const sub=await subscription('orden'),i=(await admin.query('SELECT external_id FROM llenamos.billing_intents WHERE restaurant_id=$1 AND id=$2',['orden',sub.pending_intent])).rows[0]
        return {intentId:sub.pending_intent as string,externalId:i.external_id as string}
      })()
      await handleBillingEvent(runner(),stripe('checkout.session.completed',{id:externalId,mode:'subscription',customer:'cus_2',subscription:'sub_2',metadata:{restaurantId:'orden',intentId}},1000))
      await handleBillingEvent(runner(),stripe('invoice.paid',invoice(mine),2000))
      const late=stripe('invoice.payment_failed',invoice({...mine,status:'open',paid:false,amount_paid:0},'in_viejo'),1500)
      await expect(handleBillingEvent(runner(),late,{provider:{...fakeProvider(),configured:false}})).rejects.toMatchObject({status:503})
      expect((await subscription('orden')).status).toBe('active')
      const reconcile=fakeProvider({async current(){return stripeSubscription({id:'sub_2',customer:'cus_2',latest_invoice:invoice(mine)})}})
      expect(await handleBillingEvent(runner(),late,{provider:reconcile})).toEqual({status:'applied'})
      expect((await subscription('orden')).status).toBe('active')
      // Eventos que no son de facturación o contratos sin vincular.
      expect(await handleBillingEvent(runner(),stripe('charge.refunded',{},9000))).toEqual({status:'ignored'})
      await expect(handleBillingEvent(runner(),stripe('invoice.paid',invoice({customer:'cus_x',subscription:'sub_x'}),9001))).rejects.toMatchObject({status:503})
    })
    it('el receptor firma con el secreto de la plataforma, rechaza lo demás y no acepta sin secreto',async()=>{
      await seed('hook');await member('hook','owner-a','owner')
      useBillingProvider(fakeProvider())
      const mount=(secret:string|undefined)=>createServer((req,res)=>{void billingWebhookRoute({secret,pool:webhookPool}) ({req,res,path:new URL(req.url!,'http://x').pathname,pool:app,respond:()=>undefined}).then(handled=>{if(!handled){res.writeHead(404);res.end()}})})
      const listen=async(s:Server)=>{await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${(s.address() as {port:number}).port}${BILLING_WEBHOOK_PATH}`}
      const withSecret=mount('whsec_plataforma'),without=mount(undefined)
      try {
        const url=await listen(withSecret),off=await listen(without)
        const body=JSON.stringify(stripe('charge.refunded',{},1)),t=Math.floor(Date.now()/1000)
        const sign=(secret:string)=>`t=${t},v1=${createHmac('sha256',secret).update(`${t}.${body}`).digest('hex')}`
        expect((await fetch(url,{method:'POST',body,headers:{'Stripe-Signature':sign('whsec_plataforma')}})).status).toBe(200)
        expect((await fetch(url,{method:'POST',body,headers:{'Stripe-Signature':sign('whsec_de_un_restaurante')}})).status).toBe(401)
        expect((await fetch(url,{method:'POST',body})).status).toBe(401)
        expect((await fetch(url,{method:'GET'})).status).toBe(405)
        const unbound=JSON.stringify(stripe('invoice.paid',invoice({customer:'cus_q',subscription:'sub_q'}),5))
        const t2=`t=${t},v1=${createHmac('sha256','whsec_plataforma').update(`${t}.${unbound}`).digest('hex')}`
        expect((await fetch(url,{method:'POST',body:unbound,headers:{'Stripe-Signature':t2}})).status).toBe(503) // Stripe reintenta
        expect((await fetch(off,{method:'POST',body,headers:{'Stripe-Signature':sign('whsec_plataforma')}})).status).toBe(503)
      }finally{withSecret.closeAllConnections();without.closeAllConnections();withSecret.close();without.close()}
    })
    it('un fallo del proveedor deja el estado intacto y permite repetir la misma petición',async()=>{
      await seed('fallo');await member('fallo','owner-a','owner')
      let fail=true
      useBillingProvider(fakeProvider({async start(input){if(fail)throw new Error('timeout');return {id:'cs_ok',url:`https://checkout.stripe.test/${input.key.slice(0,8)}`}}}))
      const input=start('fallo')
      expect((await request('iniciarSuscripcion',input)).status).toBe(502)
      expect(await subscription('fallo')).toMatchObject({pending_intent:null})
      expect((await admin.query("SELECT 1 FROM llenamos.billing_intents WHERE restaurant_id='fallo'")).rowCount).toBe(0)
      fail=false
      expect((await ok('iniciarSuscripcion',input) as {status:string}).status).toBe('ready')
    })
    it('una factura que deja recursos por encima del límite del plan suspende en lugar de activar',async()=>{
      await seed('exceso');await member('exceso','owner-a','owner')
      await admin.query("UPDATE llenamos.platform_usage SET webhooks=9 WHERE restaurant_id='exceso'")
      await admin.query("UPDATE llenamos.platform_subscriptions SET plan_version=2,stripe_customer_id='cus_1',stripe_subscription_id='sub_exceso' WHERE restaurant_id='exceso'")
      await admin.query("UPDATE llenamos.restaurants SET commercial_plan_version=2 WHERE id='exceso'")
      const result=await handleBillingEvent(runner(),stripe('invoice.paid',invoice({subscription:'sub_exceso'}),100))
      expect(result).toEqual({status:'blocked_overage'})
      expect((await subscription('exceso')).status).toBe('suspended')
    })
    it('una factura bloqueada por exceso de uso se reaplica al reenviar el evento cuando ya cabe',async()=>{
      await seed('exceso2');await member('exceso2','owner-a','owner')
      await admin.query("UPDATE llenamos.platform_usage SET webhooks=9 WHERE restaurant_id='exceso2'")
      await admin.query("UPDATE llenamos.platform_subscriptions SET plan_version=2,stripe_customer_id='cus_x2',stripe_subscription_id='sub_x2' WHERE restaurant_id='exceso2'")
      await admin.query("UPDATE llenamos.restaurants SET commercial_plan_version=2 WHERE id='exceso2'")
      const paid=stripe('invoice.paid',invoice({customer:'cus_x2',subscription:'sub_x2'},'in_x2'),500)
      expect(await handleBillingEvent(runner(),paid)).toEqual({status:'blocked_overage'})
      expect(await handleBillingEvent(runner(),paid)).toEqual({status:'blocked_overage'}) // sigue sin caber: no cambia nada nuevo
      await admin.query("UPDATE llenamos.platform_usage SET webhooks=0 WHERE restaurant_id='exceso2'")
      expect(await handleBillingEvent(runner(),paid)).toEqual({status:'applied'})
      expect(await subscription('exceso2')).toMatchObject({status:'active',last_paid_invoice_id:'in_x2'})
      expect(await handleBillingEvent(runner(),paid)).toEqual({status:'duplicate'})
    })

    describe('renovación de un contrato de pago',()=>{
      const cus=(n:string)=>({customer:`cus_${n}`,subscription:`sub_${n}`})
      async function paidContract(rid:string,n:string,periodEnds:string) {
        await ok('guardarPlanPlataforma',{requestId:id(),plan:planV2()},'operator')
        await seed(rid,{planVersion:2});await member(rid,'owner-a','owner')
        await admin.query("UPDATE llenamos.platform_subscriptions SET status='active',trial_ends_at=NULL,interval='month',period_ends_at=now()+$2::interval,stripe_customer_id=$3,stripe_subscription_id=$4,last_billing_created=100 WHERE restaurant_id=$1",[rid,periodEnds,`cus_${n}`,`sub_${n}`])
        await admin.query("UPDATE llenamos.restaurants SET commercial_plan_version=2,access_valid_until=now()+$2::interval WHERE id=$1",[rid,periodEnds])
        await admin.query("UPDATE llenamos.platform_restaurants SET status='active' WHERE restaurant_id=$1",[rid])
      }
      const restaurantRow=async(rid:string)=>(await admin.query("SELECT active_modules,access_valid_until FROM llenamos.restaurants WHERE id=$1",[rid])).rows[0]
      const sweep=()=>expireDueSubscriptions(workerPool,500)

      it('quien paga no pierde el servicio si Stripe cobra la renovación una hora tarde',async()=>{
        await paidContract('renueva','r1','-1 minute')
        expect(await sweep()).toBeGreaterThan(0)
        const bridged=await subscription('renueva')
        expect(bridged).toMatchObject({status:'past_due',renewal_grace:true})
        expect(bridged.grace_ends_at.getTime()-Date.now()).toBeGreaterThan(47*3600_000)
        const row=await restaurantRow('renueva')
        expect(row.active_modules).toEqual(['reservations','floor','kitchen']) // no se cierran los módulos en mitad del servicio
        expect(row.access_valid_until.getTime()-Date.now()).toBeGreaterThan(47*3600_000)
        const view=core.VerSuscripcionOutputSchema.parse(await ok('verSuscripcion',{restaurantId:'renueva'}))
        expect(view.entitlements).toMatchObject({serviceEnabled:true})
        // La factura llega una hora después y deja el contrato como uno normal.
        const nextEnd=Math.floor(Date.now()/1000)+30*86_400
        expect(await handleBillingEvent(runner(),stripe('invoice.paid',invoice({...cus('r1'),lines:{has_more:false,data:[{amount:9900,currency:'eur',period:{start:nextEnd-30*86_400,end:nextEnd},price:{id:'price_sala_mes'}}]}},'in_renov'),5000))).toEqual({status:'applied'})
        const paid=await subscription('renueva')
        expect(paid).toMatchObject({status:'active',renewal_grace:false,grace_ends_at:null})
        expect(paid.period_ends_at.getTime()).toBe(nextEnd*1000)
        expect(await sweep()).toBe(0)
      })
      it('si el primer cobro de la renovación falla, el impago conserva sus siete días de gracia',async()=>{
        await paidContract('renueva-falla','r2','-1 minute')
        await sweep()
        expect(await subscription('renueva-falla')).toMatchObject({status:'past_due',renewal_grace:true})
        await handleBillingEvent(runner(),stripe('invoice.payment_failed',invoice({...cus('r2'),status:'open',paid:false,amount_paid:0,attempt_count:1},'in_falla'),6000))
        const failed=await subscription('renueva-falla')
        expect(failed).toMatchObject({status:'past_due',renewal_grace:false})
        expect(failed.grace_ends_at.getTime()-Date.now()).toBeGreaterThan(6*DAY)
        expect((await restaurantRow('renueva-falla')).active_modules).toEqual(['reservations','floor','kitchen'])
        // Un segundo intento fallido no alarga la gracia.
        await handleBillingEvent(runner(),stripe('invoice.payment_failed',invoice({...cus('r2'),status:'open',paid:false,amount_paid:0,attempt_count:2},'in_falla'),7000))
        expect((await subscription('renueva-falla')).grace_ends_at.getTime()).toBe(failed.grace_ends_at.getTime())
        // Pasada la gracia sí se suspende.
        await admin.query("UPDATE llenamos.platform_subscriptions SET grace_ends_at=now()-interval '1 minute' WHERE restaurant_id='renueva-falla'")
        await sweep()
        expect(await subscription('renueva-falla')).toMatchObject({status:'suspended'})
        expect((await restaurantRow('renueva-falla')).active_modules).toEqual([])
      })
      it('customer.subscription.updated adelanta el periodo de un contrato activo, con un tope razonable',async()=>{
        await paidContract('adelanta','r3','2 hours')
        const before=(await subscription('adelanta')).period_ends_at.getTime()
        const nextEnd=Math.floor(Date.now()/1000)+32*86_400
        const update=(end:number,created:number)=>stripe('customer.subscription.updated',stripeSubscription({id:'sub_r3',customer:'cus_r3',items:{data:[{price:{id:'price_sala_mes'},quantity:1,current_period_end:end}]}}),created)
        await handleBillingEvent(runner(),update(Math.floor(Date.now()/1000)+3*365*86_400,6000))
        expect((await subscription('adelanta')).period_ends_at.getTime()).toBe(before) // un periodo absurdo no se acepta
        await handleBillingEvent(runner(),update(nextEnd,7000))
        const after=await subscription('adelanta')
        expect(after.period_ends_at.getTime()).toBe(nextEnd*1000)
        expect(after.status).toBe('active')
        expect(await sweep()).toBe(0)
        // La factura de ese mismo periodo se aplica sin objeciones.
        const fine=await handleBillingEvent(runner(),stripe('invoice.paid',invoice({...cus('r3'),lines:{has_more:false,data:[{amount:9900,currency:'eur',period:{start:nextEnd-30*86_400,end:nextEnd},price:{id:'price_sala_mes'}}]}},'in_r3'),8000))
        expect(fine).toEqual({status:'applied'})
      })
      it('un contrato con la baja programada o sin Stripe no recibe margen: se da de baja o se suspende',async()=>{
        await paidContract('baja-programada','r4','-1 minute')
        await admin.query("UPDATE llenamos.platform_subscriptions SET cancel_at_period_end=true WHERE restaurant_id='baja-programada'")
        await paidContract('sin-stripe','r5','-1 minute')
        await admin.query("UPDATE llenamos.platform_subscriptions SET stripe_subscription_id=NULL,stripe_customer_id=NULL WHERE restaurant_id='sin-stripe'")
        await sweep()
        expect((await subscription('baja-programada')).status).toBe('cancelled')
        expect((await subscription('sin-stripe')).status).toBe('suspended')
      })
    })

    it('un Checkout abandonado no bloquea pagar: lo libera checkout.session.expired o la caducidad de 24 horas',async()=>{
      await seed('aband');await member('aband','owner-a','owner')
      useBillingProvider(fakeProvider())
      await ok('iniciarSuscripcion',start('aband'))
      const pending=(await subscription('aband')).pending_intent as string
      const external=(await admin.query('SELECT external_id FROM llenamos.billing_intents WHERE id=$1',[pending])).rows[0].external_id as string
      expect((await request('iniciarSuscripcion',start('aband'))).status).toBe(412)
      const session=(id:string)=>({id,metadata:{restaurantId:'aband',intentId:pending}})
      await expect(handleBillingEvent(runner(),stripe('checkout.session.expired',session('cs_otra'),10))).rejects.toMatchObject({status:422})
      const expired=stripe('checkout.session.expired',session(external),10)
      expect(await handleBillingEvent(runner(),expired)).toEqual({status:'checkout_expired'})
      expect(await handleBillingEvent(runner(),expired)).toEqual({status:'duplicate'})
      expect((await subscription('aband')).pending_intent).toBeNull()
      expect((await ok('iniciarSuscripcion',start('aband')) as {status:string}).status).toBe('ready')
      // Sin ningún aviso de Stripe, una intención de más de 24 horas deja de bloquear.
      await seed('aband2');await member('aband2','owner-a','owner')
      await ok('iniciarSuscripcion',start('aband2'))
      expect((await request('iniciarSuscripcion',start('aband2'))).status).toBe(412)
      await admin.query("UPDATE llenamos.billing_intents SET created_at=now()-interval '25 hours' WHERE restaurant_id='aband2'")
      expect((await ok('iniciarSuscripcion',start('aband2')) as {status:string}).status).toBe('ready')
    })
    it('acepta la factura de un cambio de plan con prorrateo y rechaza las que no cuadran',async()=>{
      await ok('guardarPlanPlataforma',{requestId:id(),plan:planV2()},'operator');await ok('guardarPlanPlataforma',{requestId:id(),plan:grupoV2()},'operator')
      await seed('prorr',{planVersion:2});await member('prorr','owner-a','owner')
      const end=Math.floor(Date.now()/1000)+20*86_400
      await admin.query("UPDATE llenamos.platform_subscriptions SET status='active',trial_ends_at=NULL,period_ends_at=to_timestamp($2),stripe_customer_id='cus_pr',stripe_subscription_id='sub_pr',last_billing_created=50 WHERE restaurant_id=$1",['prorr',end])
      const line=(amount:number,price:string,proration=true)=>({amount,currency:'eur',proration,period:{start:end-10*86_400,end},price:{id:price}})
      const base={customer:'cus_pr',subscription:'sub_pr'}
      const invoiceOf=(lines:unknown[],total:number,id_='in_pr')=>invoice({...base,total,amount_due:total,amount_paid:total,lines:{has_more:false,data:lines}},id_)
      await expect(handleBillingEvent(runner(),stripe('invoice.paid',invoiceOf([line(-4950,'price_sala_mes'),line(9950,'price_grupo_mes')],1),100))).rejects.toMatchObject({status:422}) // total que no cuadra
      await expect(handleBillingEvent(runner(),stripe('invoice.paid',invoiceOf([line(9900,'price_sala_mes',false),line(9950,'price_grupo_mes',false)],19850),101))).rejects.toMatchObject({status:422}) // dos tarifas
      expect(await handleBillingEvent(runner(),stripe('invoice.paid',invoiceOf([line(-4950,'price_sala_mes'),line(9950,'price_grupo_mes')],5000),102))).toEqual({status:'applied'})
      expect(await subscription('prorr')).toMatchObject({status:'active',plan_id:'grupo',plan_version:2})
    })
    it('rechaza eventos de otro modo de Stripe, ignora una factura en borrador al reconciliar y lee un secreto ausente como no configurado',async()=>{
      await seed('modo');await member('modo','owner-a','owner')
      await admin.query("UPDATE llenamos.platform_subscriptions SET plan_version=2,stripe_customer_id='cus_md',stripe_subscription_id='sub_md',last_billing_created=900 WHERE restaurant_id='modo'")
      const live={...fakeProvider(),livemode:true}
      await expect(handleBillingEvent(runner(),stripe('invoice.paid',invoice({customer:'cus_md',subscription:'sub_md'}),1000),{provider:live})).rejects.toMatchObject({status:422})
      const test={...fakeProvider(),livemode:false}
      // Evento desordenado (created 5 <= 900) cuya factura vigente está en borrador: no es un impago.
      const draft=fakeProvider({async current(){return stripeSubscription({id:'sub_md',customer:'cus_md',latest_invoice:invoice({customer:'cus_md',subscription:'sub_md',status:'draft',paid:false,amount_paid:0},'in_draft')})}})
      expect(await handleBillingEvent(runner(),stripe('invoice.payment_failed',invoice({customer:'cus_md',subscription:'sub_md',status:'open',paid:false,amount_paid:0},'in_md'),5),{provider:{...draft,livemode:false}})).toEqual({status:'ignored'})
      expect((await subscription('modo')).status).toBe('trialing')
      void test
      process.env.STRIPE_BILLING_WEBHOOK_SECRET_FILE='/no/existe/secreto'
      try {
        const route=billingWebhookRoute({pool:webhookPool}) // no lanza al construirse
        const http2=createServer((req,res)=>{void route({req,res,path:BILLING_WEBHOOK_PATH,pool:app,respond:()=>undefined})})
        await new Promise<void>(r=>http2.listen(0,'127.0.0.1',r))
        try {expect((await fetch(`http://127.0.0.1:${(http2.address() as {port:number}).port}/`,{method:'POST',body:'{}'})).status).toBe(503)}
        finally{http2.closeAllConnections();http2.close()}
      }finally{delete process.env.STRIPE_BILLING_WEBHOOK_SECRET_FILE}
    })
  })

  describe('API pública con claves',()=>{
    const keyInput=(over:Record<string,unknown>={})=>({restaurantId:'tenant-a',requestId:id(),name:'Integración',scopes:['menu.read','orders.read'],locationIds:['principal'],expiresAt:Date.now()+30*DAY,...over})
    const list=async(rid='tenant-a',actor='owner-a',extra:Record<string,unknown>={})=>core.ListarIntegracionesOutputSchema.parse(await ok('listarIntegraciones',{restaurantId:rid,limit:50,cursor:null,...extra},actor))
    async function cleanKeys(rid='tenant-a'){await admin.query("UPDATE llenamos.api_keys SET revoked_at=now() WHERE restaurant_id=$1 AND revoked_at IS NULL",[rid])}

    it('la clave se muestra una vez, solo se guarda su hash y el reintento devuelve la misma respuesta',async()=>{
      const input=keyInput()
      const created=core.CrearClaveApiOutputSchema.parse(await ok('crearClaveApi',input))
      expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(core.CrearClaveApiOutputSchema.parse(await ok('crearClaveApi',input))).toEqual(created)
      const dump=JSON.stringify((await admin.query('SELECT * FROM llenamos.api_keys')).rows)+JSON.stringify((await admin.query('SELECT * FROM llenamos.idempotency')).rows)
      expect(dump).not.toContain(created.token)
      expect(dump).toContain(core.sha256Hex(created.token))
      const view=await list()
      expect(JSON.stringify(view)).not.toContain(created.token)
      expect(view.keys.find(k=>k.id===created.keyId)).toMatchObject({prefix:created.prefix,scopes:['menu.read','orders.read'],locationIds:['principal'],revokedAt:null,lastUsedAt:null})
      expect((await request('crearClaveApi',{...input,name:'Otro'})).status).toBe(409)
      await cleanKeys()
    })
    it('roles, aislamiento entre restaurantes, caducidad futura, locales existentes y cuota del plan',async()=>{
      await cleanKeys()
      expect((await request('crearClaveApi',keyInput(),'waiter-a')).status).toBe(403)
      expect((await request('crearClaveApi',keyInput(),'owner-b')).status).toBe(403)
      expect((await request('crearClaveApi',keyInput({expiresAt:Date.now()-1000}))).status).toBe(400)
      expect((await request('crearClaveApi',keyInput({locationIds:['no-existe']}))).status).toBe(404)
      expect((await request('crearClaveApi',keyInput({scopes:['todo']}))).status).toBe(400)
      // Un encargado acotado a un local no crea claves de otro local.
      expect((await request('crearClaveApi',keyInput({locationIds:['terraza']}),'limited')).status).toBe(403)
      const first=core.CrearClaveApiOutputSchema.parse(await ok('crearClaveApi',keyInput(),'manager-a'))
      const full=await request('crearClaveApi',keyInput())
      expect(full.status).toBe(429) // el plan sala admite una clave
      expect((await admin.query("SELECT api_keys FROM llenamos.platform_usage WHERE restaurant_id='tenant-a'")).rows[0].api_keys).toBe(1)
      // Otro restaurante no puede revocar ni ver la clave.
      expect((await request('revocarClaveApi',{restaurantId:'tenant-b',requestId:id(),keyId:first.keyId},'owner-b')).status).toBe(404)
      expect((await list('tenant-b','owner-b')).keys).toEqual([])
      expect((await request('revocarClaveApi',{restaurantId:'tenant-a',requestId:id(),keyId:first.keyId},'limited')).status).toBe(200)
      expect((await admin.query("SELECT api_keys FROM llenamos.platform_usage WHERE restaurant_id='tenant-a'")).rows[0].api_keys).toBe(0)
      await ok('crearClaveApi',keyInput()) // la cuota se libera al revocar
      await cleanKeys()
    })
    it('lista paginada por cursor y acotada a los locales del miembro',async()=>{
      await cleanKeys()
      await admin.query("UPDATE llenamos.platform_plans SET definition=jsonb_set(definition,'{limits,apiKeys}','null') WHERE id='grupo'")
      await seed('paginas');await member('paginas','owner-a','owner')
      await admin.query("UPDATE llenamos.platform_subscriptions SET plan_id='grupo' WHERE restaurant_id='paginas'")
      for(let i=0;i<5;i++)await ok('crearClaveApi',keyInput({restaurantId:'paginas',locationIds:[i%2?'terraza':'principal'],name:`Clave ${i}`}))
      const seen:string[]=[];let cursor:string|null=null,pages=0
      do {
        const page:Awaited<ReturnType<typeof list>>=await list('paginas','owner-a',{limit:2,cursor});pages++
        seen.push(...page.keys.map(k=>k.name));cursor=page.nextCursor
      } while(cursor&&pages<10)
      expect(seen.sort()).toEqual(['Clave 0','Clave 1','Clave 2','Clave 3','Clave 4'])
      expect(pages).toBe(3)
      expect((await request('listarIntegraciones',{restaurantId:'paginas',limit:2,cursor:'basura'})).status).toBe(400)
    })

    // --- webhooks salientes ---
    const hookInput=(over:Record<string,unknown>={})=>({restaurantId:'tenant-a',requestId:id(),endpointId:null,url:'https://receptor.example.test/hook',events:['reservation.created','subscription.changed'],locationIds:['principal'],status:'active',...over})
    it('webhooks: destino público obligatorio, secreto cifrado y mostrado una vez, rotación, revocación y cuota',async()=>{
      for(const url of ['http://receptor.example.test/hook','https://localhost:8443/x','https://10.0.0.1/hook'])
        expect((await request('guardarWebhook',hookInput({url}))).status,url).toBe(400)
      useDestinationResolver(async host=>[{address:host==='privado.example.test'?'192.168.0.10':'93.184.216.34',family:4}])
      try {expect((await request('guardarWebhook',hookInput({url:'https://privado.example.test/hook'}))).status).toBe(400)}finally{useDestinationResolver(async()=>[{address:'93.184.216.34',family:4}])}
      const input=hookInput()
      const created=core.GuardarWebhookOutputSchema.parse(await ok('guardarWebhook',input))
      expect(created.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(created.secretVersion).toBe(1)
      expect(core.GuardarWebhookOutputSchema.parse(await ok('guardarWebhook',input))).toEqual(created)
      const stored=JSON.stringify((await admin.query('SELECT * FROM llenamos.webhook_secrets')).rows)+JSON.stringify((await admin.query('SELECT * FROM llenamos.idempotency')).rows)
      expect(stored).not.toContain(created.secret!)
      expect((await request('guardarWebhook',hookInput({restaurantId:'tenant-a',endpointId:created.endpointId,locationIds:['no-existe']}))).status).toBe(404)
      expect((await request('crearClaveApi',keyInput({locationIds:['principal']}),'waiter-a')).status).toBe(403)
      expect((await request('guardarWebhook',hookInput())).status).toBe(429) // sala admite un webhook
      const edited=core.GuardarWebhookOutputSchema.parse(await ok('guardarWebhook',hookInput({endpointId:created.endpointId,url:'https://receptor.example.test/nuevo',events:['order.placed']})))
      expect(edited).toEqual({endpointId:created.endpointId,secret:null,secretVersion:1})
      const rotated=core.RotarSecretoWebhookOutputSchema.parse(await ok('rotarSecretoWebhook',{restaurantId:'tenant-a',requestId:id(),endpointId:created.endpointId}))
      expect(rotated.secretVersion).toBe(2);expect(rotated.secret).not.toBe(created.secret)
      expect((await list()).endpoints).toEqual([expect.objectContaining({id:created.endpointId,url:'https://receptor.example.test/nuevo',events:['order.placed'],secretVersion:2,status:'active'})])
      expect((await request('rotarSecretoWebhook',{restaurantId:'tenant-b',requestId:id(),endpointId:created.endpointId},'owner-b')).status).toBe(404)
      await ok('guardarWebhook',hookInput({endpointId:created.endpointId,status:'revoked'}))
      expect((await request('rotarSecretoWebhook',{restaurantId:'tenant-a',requestId:id(),endpointId:created.endpointId})).status).toBe(412)
      expect((await request('guardarWebhook',hookInput({endpointId:created.endpointId,status:'active'}))).status).toBe(412)
      await ok('guardarWebhook',hookInput()) // la cuota se libera al revocar
      await admin.query("DELETE FROM llenamos.webhook_deliveries");await admin.query("UPDATE llenamos.webhook_endpoints SET status='revoked' WHERE restaurant_id='tenant-a'")
    })

    describe('entrega de eventos',()=>{
      const sent:{url:string;body:string;signature:string}[]=[]
      let replies:number[]=[]
      const transport=async(url:string,body:string,signature:string)=>{sent.push({url,body,signature});const status=replies.shift()??200;if(status===0)throw new Error('red');return status}
      const handler=deliveryHandler({transport,key:Buffer.alloc(32,9)})
      const context=(rid:string,payload:Record<string,unknown>):DeliveryContext=>({item:{id:randomUUID(),restaurantId:rid,kind:'plataforma.entrega',payload,attempts:1},tenant:fn=>withTenant(workerPool,rid,fn),now:()=>new Date(),extendLease:async()=>true})
      async function endpoint(rid='tenant-a',actor='owner-a',over:Record<string,unknown>={}) {
        await admin.query("UPDATE llenamos.webhook_endpoints SET status='revoked' WHERE restaurant_id=$1",[rid])
        await admin.query("UPDATE llenamos.platform_usage SET webhooks=0 WHERE restaurant_id=$1",[rid])
        return core.GuardarWebhookOutputSchema.parse(await ok('guardarWebhook',hookInput({restaurantId:rid,events:['reservation.created','subscription.changed'],...over}),actor))
      }
      async function emit(rid:string,eventId:string,type:core.PlatformEvent['type']='reservation.created',locationId:string|null='principal') {
        return asOwner(rid,client=>enqueuePlatformEvent(client,{id:eventId,type,restaurantId:rid,locationId,data:{entityId:'res-1',status:'confirmed'}}),rid==='tenant-b'?'owner-b':'owner-a')
      }
      const delivery=async(rid:string,eventId:string)=>(await admin.query('SELECT * FROM llenamos.webhook_deliveries WHERE restaurant_id=$1 AND event_id=$2',[rid,eventId])).rows[0]
      const queue=async(rid:string)=>(await admin.query("SELECT payload,available_at,id FROM llenamos.outbox WHERE restaurant_id=$1 AND kind='plataforma.entrega' ORDER BY occurred_at,id",[rid])).rows

      it('crea una entrega por webhook suscrito, sin duplicar y sin cruzar restaurantes',async()=>{
        await admin.query("DELETE FROM llenamos.outbox WHERE kind='plataforma.entrega'");await admin.query('DELETE FROM llenamos.webhook_attempts');await admin.query('DELETE FROM llenamos.webhook_deliveries')
        const a=await endpoint('tenant-a','owner-a');const b=await endpoint('tenant-b','owner-b')
        const eventId=core.sha256Hex('evento-aislado')
        expect(await emit('tenant-a',eventId)).toBe(1)
        expect(await emit('tenant-a',eventId)).toBe(0) // el mismo hecho no duplica
        expect((await delivery('tenant-a',eventId)).endpoint_id).toBe(a.endpointId)
        expect(await delivery('tenant-b',eventId)).toBeUndefined()
        expect(await emit('tenant-a',core.sha256Hex('fuera-de-local'),'reservation.created','terraza')).toBe(0)
        expect(await emit('tenant-a',core.sha256Hex('otro-tipo'),'order.placed')).toBe(0)
        expect(await emit('tenant-a',core.sha256Hex('sub'),'subscription.changed',null)).toBe(1)
        expect(await queue('tenant-a')).toHaveLength(2)
        expect(await queue('tenant-b')).toHaveLength(0)
        void b
        // Un productor no puede fabricar eventos de otro restaurante.
        await expect(asOwner('tenant-a',client=>enqueuePlatformEvent(client,{id:core.sha256Hex('x'),type:'reservation.created',restaurantId:'tenant-b',locationId:'principal',data:{entityId:'r',status:null}}))).rejects.toMatchObject({code:'42501'})
        expect(await delivery('tenant-b',core.sha256Hex('x'))).toBeUndefined()
        await expect(asOwner('tenant-a',client=>client.query("SELECT llenamos.platform_emit_event('tenant-a','x','otro.tipo',NULL,'e',NULL)"))).rejects.toMatchObject({code:'22023'})
      })
      it('los eventos de un flujo público (sin miembro) no se pierden, pero solo valen para el restaurante del ámbito',async()=>{
        await endpoint()
        const eventId=core.sha256Hex('evento-publico')
        const made=await withPublicScope(app,'tenant-a',client=>enqueuePlatformEvent(client,{id:eventId,type:'reservation.created',restaurantId:'tenant-a',locationId:'principal',data:{entityId:'res-publica',status:'confirmed'}}))
        expect(made).toBe(1)
        expect((await delivery('tenant-a',eventId)).status).toBe('queued')
        await expect(withPublicScope(app,'tenant-a',client=>enqueuePlatformEvent(client,{id:core.sha256Hex('otro'),type:'reservation.created',restaurantId:'tenant-b',locationId:'principal',data:{entityId:'r',status:null}}))).rejects.toMatchObject({code:'42501'})
        await expect(app.query("SELECT llenamos.platform_emit_event('tenant-a','z','reservation.created','principal','r',NULL)")).rejects.toMatchObject({code:'42501'}) // sin contexto de restaurante
      })
      it('los hechos que otros módulos dejan en la cola (plataforma.evento, p. ej. sala) se convierten en entregas, sin duplicar',async()=>{
        const hook=await endpoint('tenant-a','owner-a',{events:['order.placed']})
        const item=(payload:Record<string,unknown>,idv=randomUUID()):DeliveryContext=>({item:{id:idv,restaurantId:'tenant-a',kind:'plataforma.evento',payload,attempts:1},tenant:fn=>withTenant(workerPool,'tenant-a',fn),now:()=>new Date()})
        const fact={type:'order.placed',version:1,locationId:'principal',occurredAt:Date.now(),data:{entityId:'pedido-1',status:'pending'}}
        const same=randomUUID()
        await platformEventHandler(item(fact,same));await platformEventHandler(item(fact,same))
        const rows=(await admin.query("SELECT event,endpoint_id FROM llenamos.webhook_deliveries WHERE restaurant_id='tenant-a' AND event->>'type'='order.placed' AND event->'data'->>'entityId'='pedido-1'")).rows
        expect(rows).toHaveLength(1);expect(rows[0].endpoint_id).toBe(hook.endpointId)
        expect(rows[0].event.occurredAt).toBe(fact.occurredAt)
        await expect(platformEventHandler(item({...fact,type:'otra.cosa'}))).rejects.toMatchObject({code:'evento-no-valido'})
      })
      it('el barrido de mantenimiento recoge entregas atascadas (lease vencido o trabajo perdido) sin duplicar trabajos',async()=>{
        sent.length=0
        await endpoint()
        const stuck=core.sha256Hex('evento-atascado'),lost=core.sha256Hex('evento-perdido')
        await emit('tenant-a',stuck);await emit('tenant-a',lost)
        const a=await delivery('tenant-a',stuck),b=await delivery('tenant-a',lost)
        // Un worker reclamó la primera y cayó; el trabajo de la segunda quedó en cuarentena en la cola.
        await admin.query("UPDATE llenamos.webhook_deliveries SET status='leased',attempts=1,lease_id=gen_random_uuid(),lease_until=now()-interval '10 minutes' WHERE id=$1",[a.id])
        await admin.query("UPDATE llenamos.webhook_deliveries SET next_attempt_at=now()-interval '2 hours' WHERE id=$1",[b.id])
        await admin.query("UPDATE llenamos.outbox SET status='quarantined' WHERE kind='plataforma.entrega' AND payload->>'deliveryId' IN ($1,$2)",[a.id,b.id])
        const sweepTask=platformMaintenance(workerPool).find(task=>task.name==='entregas-webhook')!
        expect(await sweepTask.run()).toBe(2)
        expect(await sweepTask.run()).toBe(0) // ya hay trabajo pendiente para ambas
        const jobs=(await admin.query("SELECT payload FROM llenamos.outbox WHERE kind='plataforma.entrega' AND status='pending' AND payload->>'deliveryId' IN ($1,$2) ORDER BY payload->>'deliveryId'",[a.id,b.id])).rows.map(r=>r.payload)
        expect(jobs).toEqual(expect.arrayContaining([{deliveryId:a.id,round:0,attempt:0},{deliveryId:b.id,round:0,attempt:0}]))
        for(const payload of jobs)await handler(context('tenant-a',payload))
        expect(await delivery('tenant-a',stuck)).toMatchObject({status:'delivered',attempts:1})
        expect(await delivery('tenant-a',lost)).toMatchObject({status:'delivered',attempts:1})
        expect(sent).toHaveLength(2)
      })
      it('los cambios de suscripción llegan a los webhooks suscritos al restaurante',async()=>{
        await endpoint('tenant-b','owner-b')
        const rev=(await subscription('tenant-b')).revision as number
        await ok('cambiarExcepcionesPlataforma',{restaurantId:'tenant-b',requestId:id(),expectedRevision:rev,moduleOverrides:{pos:false},reason:'Prueba de aviso'},'operator')
        const rows=(await admin.query("SELECT event FROM llenamos.webhook_deliveries WHERE restaurant_id='tenant-b' AND event->>'type'='subscription.changed' AND (event->>'occurredAt')::bigint>$1",[Date.now()-60_000])).rows
        expect(rows).toHaveLength(1)
        expect(core.PlatformEventSchema.parse(rows[0].event)).toMatchObject({type:'subscription.changed',locationId:null,data:{entityId:'subscription',status:'trialing'}})
        expect((await admin.query("SELECT 1 FROM llenamos.outbox WHERE restaurant_id='tenant-b' AND kind='plataforma.entrega'")).rowCount).toBeGreaterThan(0)
      })
      it('entrega firmada y verificable, una sola vez; un trabajo repetido no reenvía',async()=>{
        sent.length=0
        const eventId=core.sha256Hex('evento-firmado'),created=await endpoint()
        await emit('tenant-a',eventId)
        const d=await delivery('tenant-a',eventId)
        await handler(context('tenant-a',{deliveryId:d.id,round:0,attempt:0}))
        await handler(context('tenant-a',{deliveryId:d.id,round:0,attempt:0}))
        expect(sent).toHaveLength(1)
        const event=core.PlatformEventSchema.parse(JSON.parse(sent[0]!.body))
        expect(event).toMatchObject({id:eventId,type:'reservation.created',restaurantId:'tenant-a',data:{entityId:'res-1',status:'confirmed'}})
        expect(sent[0]!.body).not.toMatch(/phone|email|nombre/i)
        expect(core.verifyPlatformWebhook(created.secret!,sent[0]!.signature,sent[0]!.body,Date.now())).toBe(true)
        expect(core.verifyPlatformWebhook('x'.repeat(43),sent[0]!.signature,sent[0]!.body,Date.now())).toBe(false)
        expect(await delivery('tenant-a',eventId)).toMatchObject({status:'delivered',attempts:1,last_status:200,last_error:null})
        expect((await admin.query('SELECT status,round FROM llenamos.webhook_attempts WHERE delivery_id=$1',[d.id])).rows).toEqual([{status:200,round:0}])
      })
      it('reintenta con espera creciente y un trabajo nuevo; agota a los doce intentos y suspende el destino',async()=>{
        sent.length=0
        const eventId=core.sha256Hex('evento-reintentos'),created=await endpoint()
        await emit('tenant-a',eventId)
        const d=await delivery('tenant-a',eventId)
        replies=[500]
        await handler(context('tenant-a',{deliveryId:d.id,round:0,attempt:0}))
        expect(await delivery('tenant-a',eventId)).toMatchObject({status:'retry',attempts:1,last_status:500})
        const jobs=await queue('tenant-a')
        const retry=jobs.at(-1)!
        expect(retry.payload).toEqual({deliveryId:d.id,round:0,attempt:1})
        expect(retry.available_at.getTime()).toBeGreaterThan(Date.now()+20_000)
        // El trabajo viejo (intento 0) ya no envía; el nuevo sí.
        await handler(context('tenant-a',{deliveryId:d.id,round:0,attempt:0}))
        expect(sent).toHaveLength(1)
        replies=[0]
        await handler(context('tenant-a',{deliveryId:d.id,round:0,attempt:1}))
        expect(await delivery('tenant-a',eventId)).toMatchObject({status:'retry',attempts:2,last_status:null,last_error:expect.stringContaining('conectar')})
        for(let attempt=2;attempt<12;attempt++){replies=[503];await handler(context('tenant-a',{deliveryId:d.id,round:0,attempt}))}
        expect(await delivery('tenant-a',eventId)).toMatchObject({status:'exhausted',attempts:12})
        expect((await list()).endpoints.find(e=>e.id===created.endpointId)).toMatchObject({status:'suspended',consecutiveFailures:12})
        expect((await list()).deliveries.find(x=>x.id===d.id)).toMatchObject({status:'exhausted',attempts:12})
        // Repetir reactiva el destino, abre una ronda nueva y el trabajo nuevo entrega.
        const again=core.RepetirEntregaWebhookOutputSchema.parse(await ok('repetirEntregaWebhook',{restaurantId:'tenant-a',requestId:id(),deliveryId:d.id,reason:'El receptor ya funciona'}))
        expect(again).toEqual({deliveryId:d.id,status:'queued'})
        expect((await queue('tenant-a')).at(-1)!.payload).toEqual({deliveryId:d.id,round:1,attempt:0})
        replies=[204]
        await handler(context('tenant-a',{deliveryId:d.id,round:1,attempt:0}))
        expect(await delivery('tenant-a',eventId)).toMatchObject({status:'delivered',attempts:1,round:1})
        expect((await request('repetirEntregaWebhook',{restaurantId:'tenant-b',requestId:id(),deliveryId:d.id,reason:'ajena'},'owner-b')).status).toBe(404)
        expect((await request('repetirEntregaWebhook',{restaurantId:'tenant-a',requestId:id(),deliveryId:'inexistente',reason:'x'})).status).toBe(404)
      })
      it('410 revoca el destino, un destino revocado cancela y la suscripción cambiada cancela',async()=>{
        sent.length=0
        const eventId=core.sha256Hex('evento-410'),created=await endpoint()
        await emit('tenant-a',eventId)
        const d=await delivery('tenant-a',eventId)
        replies=[410]
        await handler(context('tenant-a',{deliveryId:d.id,round:0,attempt:0}))
        expect(await delivery('tenant-a',eventId)).toMatchObject({status:'cancelled'})
        expect((await list()).endpoints.find(e=>e.id===created.endpointId)?.status).toBe('revoked')
        const other=core.sha256Hex('evento-revocado')
        const second=await endpoint()
        await emit('tenant-a',other)
        const d2=await delivery('tenant-a',other)
        await admin.query("UPDATE llenamos.webhook_endpoints SET events=ARRAY['order.placed'] WHERE id=$1",[second.endpointId])
        await handler(context('tenant-a',{deliveryId:d2.id,round:0,attempt:0}))
        expect(await delivery('tenant-a',other)).toMatchObject({status:'cancelled',last_error:'suscripcion-cambiada'})
        expect(sent).toHaveLength(1)
      })
      it('un lease vencido de un trabajador caído se retoma y una respuesta con lease ajeno se descarta',async()=>{
        sent.length=0
        const eventId=core.sha256Hex('evento-lease');await endpoint()
        await emit('tenant-a',eventId)
        const d=await delivery('tenant-a',eventId)
        await admin.query("UPDATE llenamos.webhook_deliveries SET status='leased',attempts=1,lease_id=gen_random_uuid(),lease_until=now()+interval '10 minutes' WHERE id=$1",[d.id])
        // Con el lease vigente no se envía, pero tampoco se da por terminado: V2 reintenta después de que venza.
        await expect(handler(context('tenant-a',{deliveryId:d.id,round:0,attempt:0}))).rejects.toBeInstanceOf(RetryLater)
        expect(sent).toHaveLength(0)
        await admin.query("UPDATE llenamos.webhook_deliveries SET lease_until=now()-interval '1 second' WHERE id=$1",[d.id])
        await handler(context('tenant-a',{deliveryId:d.id,round:0,attempt:0}))
        expect(sent).toHaveLength(1)
        expect(await delivery('tenant-a',eventId)).toMatchObject({status:'delivered',attempts:1})
        const slow=core.sha256Hex('evento-lento');await emit('tenant-a',slow)
        const s=await delivery('tenant-a',slow)
        const stolen=deliveryHandler({key:Buffer.alloc(32,9),transport:async()=>{
          await admin.query("UPDATE llenamos.webhook_deliveries SET lease_id=gen_random_uuid() WHERE id=$1",[s.id])
          return 200
        }})
        await stolen(context('tenant-a',{deliveryId:s.id,round:0,attempt:0}))
        expect((await delivery('tenant-a',slow)).status).toBe('leased') // el resultado tardío no cambia nada
      })
    })

    // --- ruta pública ---
    describe('lectura pública',()=>{
      let http:Server,url:string,keys:{good:string;goodId:string;terrace:string;expired:string;revoked:string;menuOnly:string}
      const clock={now:Date.now()}
      beforeAll(async()=>{
        await seed('pub');await member('pub','owner-a','owner')
        await admin.query("UPDATE llenamos.platform_subscriptions SET plan_id='grupo' WHERE restaurant_id='pub'")
        await seed('pub-b');await member('pub-b','owner-b','owner')
        const make=async(over:Record<string,unknown>)=>core.CrearClaveApiOutputSchema.parse(await ok('crearClaveApi',keyInput({restaurantId:'pub',...over})))
        const good=await make({locationIds:['principal']}),terrace=await make({locationIds:['terraza']}),menuOnly=await make({scopes:['menu.read']})
        const expired=await make({}),revoked=await make({})
        await admin.query("UPDATE llenamos.api_keys SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.keyId])
        await ok('revocarClaveApi',{restaurantId:'pub',requestId:id(),keyId:revoked.keyId})
        keys={good:good.token,goodId:good.keyId,terrace:terrace.token,expired:expired.token,revoked:revoked.token,menuOnly:menuOnly.token}
        const route=publicApiRoute({now:()=>clock.now})
        http=createServer((req,res)=>{void route({req,res,path:new URL(req.url!,'http://x').pathname,pool:app,respond:()=>undefined}).then(handled=>{if(!handled){res.writeHead(404);res.end()}})})
        await new Promise<void>(r=>http.listen(0,'127.0.0.1',r))
        url=`http://127.0.0.1:${(http.address() as {port:number}).port}`
      },30_000)
      afterAll(async()=>{http?.closeAllConnections();if(http)await new Promise<void>(r=>http.close(()=>r()))})
      const get=(path:string,bearer?:string)=>fetch(`${url}${path}`,{headers:bearer?{Authorization:`Bearer ${bearer}`}:{}})
      const menu='/v1/restaurants/pub/locations/principal/menu',orders='/v1/restaurants/pub/locations/principal/orders'
      const menuBody={restaurantId:'pub',locationId:'principal',restaurantName:'Pub',locationName:'Principal',brandColor:'#f0a35e',timezone:'Europe/Madrid',currency:'EUR',categories:[],items:[],dailyMenus:[],selfOrder:{enabled:false,requireApproval:true,callWaiter:false,requestBill:false},takeaway:{enabled:false}}

      it('sin lector registrado la ruta autentica pero no inventa datos (501)',async()=>{
        expect((await get(menu,keys.good)).status).toBe(501)
      })
      it('autentica por hash, valida alcance y local, y entrega solo lo registrado',async()=>{
        const seen:unknown[]=[]
        registerApiReaders({
          menu:async(client,scope)=>{seen.push(scope);expect((await client.query("SELECT current_setting('app.actor_uid',true) AS actor")).rows[0].actor).toBeFalsy();return menuBody},
          orders:async(_client,scope)=>{seen.push(scope);return {orders:[{id:'o1',placedAt:5,status:'accepted',totalCents:1200,lineIds:['l1']}],nextCursor:scope.cursor?null:'siguiente'}},
        })
        const res=await get(orders+'?limit=1',keys.good)
        expect(res.status).toBe(200)
        expect(res.headers.get('cache-control')).toBe('no-store')
        expect(core.ApiOrdersOutputSchema.parse(await res.json())).toMatchObject({orders:[{id:'o1'}],nextCursor:'siguiente'})
        expect(seen[0]).toMatchObject({restaurantId:'pub',locationId:'principal',limit:1,cursor:null,keyId:keys.goodId})
        expect((await get(orders+'?limit=1&cursor=siguiente',keys.good)).status).toBe(200)
        expect((await admin.query('SELECT last_used_at FROM llenamos.api_keys WHERE id=$1',[keys.goodId])).rows[0].last_used_at).not.toBeNull()
        expect((await get(menu,keys.good)).status).toBe(200)
        // Alcance y local.
        expect((await get(orders,keys.menuOnly)).status).toBe(403)
        expect((await get(menu,keys.menuOnly)).status).toBe(200)
      })
      it('claves inválidas, caducadas, revocadas o de otro restaurante nunca autentican',async()=>{
        expect((await get(menu)).status).toBe(401)
        expect((await get(menu,'x'.repeat(43))).status).toBe(401)
        expect((await get(menu,'corto')).status).toBe(401)
        for(const bad of [keys.expired,keys.revoked])expect((await get(menu,bad)).status).toBe(401)
        const response=await get(menu,keys.expired)
        expect(response.headers.get('www-authenticate')).toBe('Bearer')
        expect((await get('/v1/restaurants/pub-b/locations/principal/menu',keys.good)).status).toBe(401)
        expect((await get('/v1/restaurants/pub/locations/terraza/menu',keys.good)).status).toBe(403)
        expect((await get('/v1/restaurants/pub/locations/principal/orders',keys.terrace)).status).toBe(403)
        expect((await fetch(`${url}${menu}`,{method:'POST',headers:{Authorization:`Bearer ${keys.good}`}})).status).toBe(405)
        expect((await get(menu+'?filtro=1',keys.good)).status).toBe(400)
        expect((await get(orders+'?limit=1000',keys.good)).status).toBe(400)
        expect((await get('/v1/restaurants/pub/locations/principal/otra',keys.good)).status).toBe(404)
      })
      it('exige el módulo de sala y una suscripción vigente',async()=>{
        registerApiReaders({menu:async()=>menuBody})
        await admin.query("UPDATE llenamos.restaurants SET active_modules='{reservations}' WHERE id='pub'")
        expect((await get(menu,keys.good)).status).toBe(403)
        await admin.query("UPDATE llenamos.restaurants SET active_modules='{reservations,floor}',access_valid_until=now()-interval '1 second' WHERE id='pub'")
        expect((await get(menu,keys.good)).status).toBe(403)
        await admin.query("UPDATE llenamos.restaurants SET access_valid_until=now()+interval '5 days' WHERE id='pub'")
        expect((await get(menu,keys.good)).status).toBe(200)
      })
      it('limita a 60 por minuto y clave; los intentos con clave inválida no gastan ese límite',async()=>{
        registerApiReaders({menu:async()=>menuBody})
        await admin.query("DELETE FROM llenamos.api_rate WHERE restaurant_id='pub'")
        for(let i=0;i<30;i++)expect((await get(menu,'z'.repeat(43))).status).toBe(401)
        expect((await admin.query("SELECT count(*)::int AS n FROM llenamos.api_rate WHERE restaurant_id='pub'")).rows[0].n).toBe(0)
        const codes:number[]=[]
        for(let i=0;i<62;i++)codes.push((await get(menu,keys.good)).status)
        expect(codes.filter(code=>code===200)).toHaveLength(60)
        expect(codes.slice(60)).toEqual([429,429])
        expect((await get(menu,keys.expired)).status).toBe(401)
        const limited=await get(menu,keys.good)
        expect(limited.headers.get('retry-after')).toBe('60')
        await admin.query("UPDATE llenamos.api_rate SET bucket=bucket-2 WHERE restaurant_id='pub'")
        expect((await get(menu,keys.good)).status).toBe(200)
      })
      it('un tercero sin clave no bloquea a los demás: el freno previo es por IP verificada',async()=>{
        registerApiReaders({menu:async()=>menuBody})
        await admin.query("DELETE FROM llenamos.api_rate WHERE restaurant_id='pub'")
        process.env.TRUSTED_IP_HEADER='x-test-ip'
        const strictRoute=publicApiRoute({ipPerMinute:6})
        const strict=createServer((req,res)=>{void strictRoute({req,res,path:new URL(req.url!,'http://x').pathname,pool:app,respond:()=>undefined}).then(h=>{if(!h){res.writeHead(404);res.end()}})})
        try {
          await new Promise<void>(r=>strict.listen(0,'127.0.0.1',r))
          const base2=`http://127.0.0.1:${(strict.address() as {port:number}).port}`
          const as=(ip:string,path:string,bearer:string)=>fetch(`${base2}${path}`,{headers:{Authorization:`Bearer ${bearer}`,'x-test-ip':ip}})
          // El atacante cambia de restaurante y de clave en cada petición: su IP se agota igual.
          const attacker:number[]=[]
          for(let i=0;i<10;i++)attacker.push((await as('203.0.113.9',`/v1/restaurants/otro${i}/locations/principal/menu`,'a'.repeat(43))).status)
          expect(attacker.slice(0,6).every(code=>code===401)).toBe(true)
          expect(attacker.slice(6).every(code=>code===429)).toBe(true)
          // La clave legítima, desde otra IP, sigue funcionando y su límite por clave está intacto.
          expect((await as('198.51.100.7',menu,keys.good)).status).toBe(200)
          expect((await admin.query("SELECT count FROM llenamos.api_rate WHERE restaurant_id='pub' AND scope=$1",[`k:${keys.goodId}`])).rows[0].count).toBe(1)
          // La cabecera de IP solo vale si llega de un proxy listado: sin cabecera manda el socket.
          process.env.TRUSTED_PROXY_ADDRESSES='192.0.2.1'
          const spoof:number[]=[]
          for(let i=0;i<8;i++)spoof.push((await as(`198.51.100.${20+i}`,menu,'b'.repeat(43))).status)
          expect(spoof.slice(6)).toEqual([429,429])
        }finally{delete process.env.TRUSTED_IP_HEADER;delete process.env.TRUSTED_PROXY_ADDRESSES;strict.closeAllConnections();strict.close()}
      })
    })
  })

  describe('privilegios de los roles',()=>{
    const attempt=async(pool:Pool,sql:string,params:unknown[]=[])=>pool.query(sql,params).then(()=>'permitido',(error:{code?:string})=>error.code??'error')
    it('el rol HTTP no escribe suscripciones, planes ni tablas de custodia, y no ejecuta las funciones del receptor ni del worker',async()=>{
      const denied=async(sql:string,actor='owner-a',rid='tenant-a')=>asOwner(rid,client=>client.query(sql),actor).then(()=>'permitido',(error:{code?:string})=>error.code??'error')
      expect(await denied("UPDATE llenamos.platform_subscriptions SET status='active'")).toBe('42501')
      expect(await denied("UPDATE llenamos.platform_plans SET definition='{}'")).toBe('42501')
      expect(await denied("INSERT INTO llenamos.billing_events(event_hash,event_id,restaurant_id,status,created) VALUES(repeat('a',64),'e','tenant-a','x',1)")).toBe('42501')
      expect(await denied("UPDATE llenamos.api_keys SET token_hash=repeat('b',64)")).toBe('42501')
      expect(await denied('SELECT * FROM llenamos.api_rate')).toBe('42501')
      expect(await denied("SELECT llenamos.billing_member('tenant-a',false)")).toBe('42501')
      expect(await denied("SELECT llenamos.billing_publish('tenant-a','x','a','b','c',1,NULL)")).toBe('42501')
      expect(await denied("SELECT llenamos.billing_view('tenant-a')",'owner-b','tenant-b')).toBe('42501')
      expect(await denied("SELECT llenamos.billing_view('tenant-a')",'waiter-a')).toBe('42501')
      expect(await denied("SELECT llenamos.billing_plan_publish('{}')")).toBe('42501')
      expect(await denied("SELECT llenamos.billing_capacity('tenant-b','apiKeys',true)")).toBe('42501')
      // Las funciones que aplican eventos de Stripe y el mantenimiento no están al alcance de una inyección SQL en la API.
      const forged="'{\"planId\":\"grupo\",\"planVersion\":1,\"status\":\"active\",\"interval\":\"year\",\"periodEndsAt\":9999999999999,\"graceEndsAt\":null,\"cancelAtPeriodEnd\":false}'::jsonb"
      for(const call of [
        `SELECT llenamos.billing_event_commit(repeat('c',64),'evt_x',1,'tenant-a','applied',-1,${forged},'{reservations}','{}',now()+interval '3650 days',NULL)`,
        "SELECT llenamos.billing_event_bind(repeat('c',64),'evt_x',1,'tenant-a',repeat('d',64),'cs_x','cus_x','sub_x')",
        "SELECT llenamos.billing_event_lock('sub_1','cus_1',repeat('c',64))","SELECT llenamos.billing_event_peek('sub_1','cus_1',repeat('c',64))","SELECT llenamos.billing_event_seen(repeat('c',64))",
        "SELECT llenamos.billing_event_checkout_expired(repeat('c',64),'evt_x',1,'tenant-a',repeat('d',64),'cs_x')",
        'SELECT llenamos.billing_expire_due(10)','SELECT llenamos.billing_deliveries_sweep(10)',
      ])expect(await denied(call),call).toBe('42501')
      expect((await subscription('tenant-a')).plan_id).toBe('sala')
    })
    it('el receptor de Billing ejecuta sus funciones y nada más; el worker ejecuta el mantenimiento y no el receptor',async()=>{
      expect(await attempt(webhookPool,"SELECT llenamos.billing_event_seen(repeat('c',64))")).toBe('permitido')
      expect(await attempt(webhookPool,"SELECT llenamos.billing_event_peek('sub_9','cus_9',repeat('c',64))")).toBe('permitido')
      for(const sql of ['SELECT llenamos.billing_expire_due(1)','SELECT llenamos.billing_view(\'tenant-a\')','SELECT * FROM llenamos.platform_subscriptions','SELECT * FROM llenamos.platform_plans','SELECT * FROM llenamos.api_keys'])
        expect(await attempt(webhookPool,sql),sql).toBe('42501')
      expect(await attempt(workerPool,'SELECT llenamos.billing_expire_due(1)')).toBe('permitido')
      expect(await attempt(workerPool,'SELECT llenamos.billing_deliveries_sweep(1)')).toBe('permitido')
      expect(await attempt(workerPool,"SELECT llenamos.billing_event_seen(repeat('c',64))")).toBe('42501')
    })
    it('el alta propia se comprueba también en SQL: con el interruptor de la base apagado nada se crea aunque la API lo permita',async()=>{
      process.env.PLATFORM_SELF_SIGNUP='1' // el de la API sí está encendido; el de la base no
      await admin.query('INSERT INTO llenamos.identities(uid,session_version,tokens_valid_after,locked) VALUES($1,$2,to_timestamp(100),false)',['sinflag','7'.repeat(32)])
      actors.sinflag=token('sinflag','7')
      await admin.query("INSERT INTO llenamos.memberships(restaurant_id,uid,role,active,display_name,email) VALUES('seed-guest','sinflag','waiter',true,'sinflag','sinflag@example.test')")
      const draft={name:'Sin interruptor',slug:'sin-interruptor',location:{name:'Sala',address:'',city:'',phone:''},settings:core.defaultReservationSettings(),planId:'sala',planVersion:1,acceptedTermsVersion:'alta-provisional-v1'}
      const saved=core.GuardarAltaOutputSchema.parse(await ok('guardarAlta',{requestId:id(),onboardingId:null,expectedRevision:null,step:'review',draft},'sinflag'))
      const blocked=await request('completarAlta',{requestId:id(),onboardingId:saved.onboardingId,expectedRevision:saved.onboarding.revision},'sinflag')
      expect(blocked.status).toBe(403)
      expect(blocked.body.error?.message).toContain('LogiQD')
      // Una llamada directa a la función (lo que haría una inyección SQL) tampoco crea nada.
      await expect(withIdentity(app,actors.sinflag!,null,client=>client.query("SELECT llenamos.billing_onboarding_complete($1,$2,$3,'sala','abcdefghijklmnop')",[saved.onboardingId,saved.onboarding.revision,`alta_${'a'.repeat(32)}`]))).rejects.toMatchObject({code:'42501'})
      expect((await admin.query("SELECT 1 FROM llenamos.restaurants WHERE slug='sin-interruptor' OR id LIKE 'alta_aaaa%'")).rowCount).toBe(0)
    })
    it('las claves y los webhooks solo los ven propietario y encargado; el hash de la clave no se lee con SQL de la API',async()=>{
      await cleanKeysFor('tenant-a');await admin.query("UPDATE llenamos.webhook_endpoints SET status='revoked' WHERE restaurant_id='tenant-a'")
      const made=core.CrearClaveApiOutputSchema.parse(await ok('crearClaveApi',{restaurantId:'tenant-a',requestId:id(),name:'Para ver',scopes:['menu.read'],locationIds:['principal'],expiresAt:Date.now()+DAY},'owner-a'))
      const hook=core.GuardarWebhookOutputSchema.parse(await ok('guardarWebhook',{restaurantId:'tenant-a',requestId:id(),endpointId:null,url:'https://receptor.example.test/vista',events:['order.placed'],locationIds:['principal'],status:'active'},'owner-a'))
      await admin.query("INSERT INTO llenamos.webhook_deliveries(restaurant_id,id,endpoint_id,event_id,event) VALUES('tenant-a','d_vista',$1,'evt_vista','{}')",[hook.endpointId])
      const count=(table:string,actor:string)=>asOwner('tenant-a',client=>client.query(`SELECT 1 FROM llenamos.${table} WHERE restaurant_id='tenant-a'`),actor).then(r=>r.rowCount)
      for(const table of ['api_keys','webhook_endpoints','webhook_deliveries']) {
        expect(await count(table,'owner-a'),`owner ${table}`).toBeGreaterThan(0)
        expect(await count(table,'manager-a'),`manager ${table}`).toBeGreaterThan(0)
        expect(await count(table,'waiter-a'),`waiter ${table}`).toBe(0)
      }
      // Ni siquiera el propietario lee el hash ni los secretos de firma; los lee el worker para firmar.
      const owner=(sql:string)=>asOwner('tenant-a',client=>client.query(sql)).then(()=>'permitido',(error:{code?:string})=>error.code??'error')
      expect(await owner('SELECT token_hash FROM llenamos.api_keys')).toBe('42501')
      expect(await owner('SELECT * FROM llenamos.api_keys')).toBe('42501')
      expect(await asOwner('tenant-a',client=>client.query('SELECT 1 FROM llenamos.webhook_secrets')).then(r=>r.rowCount)).toBe(0)
      expect(await withTenant(workerPool,'tenant-a',client=>client.query('SELECT 1 FROM llenamos.webhook_secrets').then(r=>r.rowCount))).toBeGreaterThan(0)
      void made
      await admin.query("DELETE FROM llenamos.webhook_deliveries WHERE id='d_vista'");await admin.query("UPDATE llenamos.webhook_endpoints SET status='revoked' WHERE id=$1",[hook.endpointId])
    })
    it('las tablas con restaurante solo se ven con la sesión de ese restaurante',async()=>{
      await admin.query("INSERT INTO llenamos.webhook_endpoints(restaurant_id,id,url,events,location_ids,status,secret_version) VALUES('tenant-b','wh_b','https://b.example.test/h','{order.placed}','{principal}','active',1) ON CONFLICT DO NOTHING")
      expect(await asOwner('tenant-b',client=>client.query('SELECT 1 FROM llenamos.webhook_endpoints'),'owner-b').then(r=>r.rowCount)).toBeGreaterThan(0)
      for(const table of ['webhook_endpoints','webhook_deliveries','webhook_attempts']) {
        const own=await asOwner('tenant-a',client=>client.query(`SELECT DISTINCT restaurant_id FROM llenamos.${table}`)).then(r=>r.rows.map(row=>row.restaurant_id))
        expect(own.filter(r=>r!=='tenant-a'),table).toEqual([])
      }
    })
    it('arranca con el esquema completo: funciones con dueño migrador, sin PUBLIC y con RLS forzada',async()=>{
      const owners=(await admin.query("SELECT DISTINCT pg_get_userbyid(proowner) AS owner FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='llenamos' AND (proname LIKE 'billing\\_%' OR proname LIKE 'api\\_key\\_%' OR proname='platform_emit_event')")).rows
      expect(owners).toEqual([{owner:'llenamos_migrator'}])
      const open=(await admin.query("SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='llenamos' AND (proname LIKE 'billing\\_%' OR proname='platform_emit_event') AND has_function_privilege('public',p.oid,'EXECUTE')")).rows
      expect(open).toEqual([])
      const rls=(await admin.query("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='llenamos' AND relname IN ('api_keys','api_rate','webhook_endpoints','webhook_secrets','webhook_deliveries','webhook_attempts','billing_intents','billing_events','platform_onboardings','platform_self_requests','platform_trials','platform_flags','platform_support_access') AND NOT (relrowsecurity AND relforcerowsecurity)")).rows
      expect(rls).toEqual([])
    })
  })
})
