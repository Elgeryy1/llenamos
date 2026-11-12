import { migrationSql } from '../test-migrations.js'
import { randomUUID } from 'node:crypto'
import { afterAll,beforeAll,describe,it,expect,vi } from 'vitest'
import { Pool } from 'pg'
import * as core from '@llenamos/core'
import { withIdentity,checkReadiness } from '../database.js'
import type { IdentityToken } from '../auth.js'
import { apiServer } from '../server.js'
import { createInvitationService } from '../invitations/service.js'
import type { InvitationAuthAdmin,InvitationAccount } from '../invitations/auth-admin.js'
import { integrationVault } from './integrations.js'

const source=process.env.TEST_POSTGRES_URL
const enabled=process.env.TEST_POSTGRES_API==='1'&&!!source
const token=(uid:string,version:string,platformClaim=false):IdentityToken=>({uid,sessionVersion:version.repeat(32),authTime:100,platformClaim})
describe.skipIf(!enabled)('Plataforma SQL: alta y configuración real',()=>{
  let admin:Pool,bootstrap:Pool,app:Pool,owned=false,server:ReturnType<typeof apiServer>,base:string
  const suffix=randomUUID().replaceAll('-','').slice(0,12),database=`llenamos_api_test_platform_${suffix}`,runtime=`llenamos_api_platform_${suffix}`
  const accounts=new Map<string,InvitationAccount>()
  const resolveAccount=vi.fn(async(email:string)=>{
    if(!accounts.has(email))accounts.set(email,{uid:`account_${accounts.size+1}`,email,disabled:false,claims:{}})
    return accounts.get(email)!
  })
  const auth:InvitationAuthAdmin={resolveAccount,account:async uid=>[...accounts.values()].find(account=>account.uid===uid)!,proveMailbox:async()=>Date.now()}
  const request=(name:string,data:unknown,actor='operator')=>fetch(`${base}/v1/operations/${name}`,{method:'POST',headers:{'Content-Type':'application/json',...(actor?{Authorization:`Bearer ${actor}`}:{})},body:JSON.stringify({data})})
  const createInput=(slug:string,requestId=`create_${randomUUID().replaceAll('-','')}`)=>({requestId,ownerEmail:`${slug}@example.test`,ownerName:'Propietario',name:`Restaurante ${slug}`,slug,locationName:'Local principal',planId:'sala',planVersion:1})
  const create=async(slug:string)=>{
    const response=await request('altaRestauranteLogiqd',createInput(slug))
    expect(response.status,await response.clone().text()).toBe(200)
    return core.AltaRestauranteLogiqdOutputSchema.parse((await response.json() as {result:unknown}).result)
  }
  const configInput=(restaurantId:string,expectedRevision:number)=>({restaurantId,expectedRevision,requestId:`configure_${randomUUID().replaceAll('-','')}`,planId:'sala',planVersion:1,moduleOverrides:{},reason:'Cambio solicitado'})
  beforeAll(async()=>{
    const url=new URL(source!)
    if(!['localhost','127.0.0.1'].includes(url.hostname)||!url.pathname.startsWith('/llenamos_api_test_'))throw new Error('Solo PostgreSQL temporal loopback de pruebas.')
    bootstrap=new Pool({connectionString:source,max:1})
    await bootstrap.query(`CREATE DATABASE ${database}`);owned=true
    url.pathname=`/${database}`
    admin=new Pool({connectionString:url.toString(),max:1})
    for(const sql of migrationSql())await admin.query(sql)
    await admin.query(`CREATE ROLE ${runtime} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD 'fixture-only' IN ROLE llenamos_app`)
    url.username=runtime;url.password='fixture-only';app=new Pool({connectionString:url.toString(),max:6,statement_timeout:5000})
    for(const [uid,version,platform] of [['operator','a',true],['owner-a','b',false],['owner-b','c',false],['worker','d',false]] as const)
      await admin.query('INSERT INTO llenamos.identities(uid,session_version,tokens_valid_after,locked,platform_operator) VALUES($1,$2,to_timestamp(100),false,$3)',[uid,version.repeat(32),platform])
    for(const rid of ['tenant-a','tenant-b'])await admin.query('INSERT INTO llenamos.restaurants(id,name,slug) VALUES($1,$2,$1)',[rid,`Restaurante ${rid}`])
    for(const [rid,uid,role] of [['tenant-a','owner-a','owner'],['tenant-b','owner-b','owner'],['tenant-a','worker','waiter']])
      await admin.query('INSERT INTO llenamos.memberships(restaurant_id,uid,role,active,display_name,email) VALUES($1,$2::text,$3,true,$2::text,$4)',[rid,uid,role,`${uid}@example.test`])
    const identities:Record<string,IdentityToken>={operator:token('operator','a',true),'owner-a':token('owner-a','b'),'owner-b':token('owner-b','c'),worker:token('worker','d')}
    const invitations=createInvitationService(app,auth,{encryptionKey:Buffer.alloc(32,9)})
    server=apiServer(app,async value=>identities[value]??token(value,'e'),undefined,{invitations,integrationVault:integrationVault(Buffer.alloc(32,1))})
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
    const address=server.address();if(!address||typeof address==='string')throw new Error('address')
    base=`http://127.0.0.1:${address.port}`
  },30_000)
  afterAll(async()=>{
    server?.closeAllConnections();if(server)await new Promise<void>(resolve=>server.close(()=>resolve()))
    await app?.end();await admin?.end()
    // DROP ... WITH(FORCE) cierra conexiones que el pool aún no ha soltado; solo ese aviso es esperable.
    for(const pool of [app,admin])pool?.on('error',error=>{if((error as {code?:string}).code!=='57P01')throw error})
    if(owned){await bootstrap.query(`DROP DATABASE ${database} WITH(FORCE)`);await bootstrap.query(`DROP ROLE IF EXISTS ${runtime}`)}
    await bootstrap?.end()
  })
  it('catálogo público real igual al contrato provisional, sin precio Stripe ni cobros',async()=>{
    const response=await request('listarPlanesDisponibles',{},'')
    expect(response.status).toBe(200)
    const result=core.ListarPlanesDisponiblesOutputSchema.parse((await response.json() as {result:unknown}).result)
    expect(result.plans).toEqual(core.provisionalPlanCatalog().sort((a,b)=>a.id.localeCompare(b.id)).map(plan=>core.PublicPlanDefinitionSchema.parse(plan)))
    expect(JSON.stringify(result)).not.toContain('stripeMonthlyPriceId')
  })
  it('readiness exige esquema además de rol; no expone secretos',async()=>{
    await expect(checkReadiness(app,true)).resolves.toBeUndefined()
    expect((await fetch(`${base}/readyz`)).status).toBe(200)
    await admin.query('ALTER TABLE llenamos.platform_audit RENAME TO platform_audit_fixture')
    try{expect((await fetch(`${base}/readyz`)).status).toBe(503)}finally{await admin.query('ALTER TABLE llenamos.platform_audit_fixture RENAME TO platform_audit')}
  })
  it('alta deja propietario y membresía pendientes, APIs vacías permitidas, sin token al operador',async()=>{
    const result=await create('alta-pendiente')
    await withIdentity(app,token('operator','a',true),null,client=>client.query('SELECT llenamos.platform_configuration($1)',[result.restaurantId]))
    expect(result.invitationStatus).toBe('pending')
    const row=(await admin.query('SELECT i.locked,m.active,m.invitation_pending FROM llenamos.memberships m JOIN llenamos.identities i ON i.uid=m.uid WHERE m.restaurant_id=$1',[result.restaurantId])).rows[0]
    expect(row).toEqual({locked:true,active:false,invitation_pending:true})
    expect((await admin.query('SELECT * FROM llenamos.integration_secrets WHERE restaurant_id=$1',[result.restaurantId])).rows).toEqual([])
    expect(Object.keys(result).sort()).toEqual(['invitationStatus','locationId','restaurantId'])
    const table=(await admin.query('SELECT active_modules,entitlement_version FROM llenamos.restaurants WHERE id=$1',[result.restaurantId])).rows[0]
    expect(table.active_modules).toEqual(['reservations','floor','kitchen']);expect(table.entitlement_version).toBe(1)
  })
  it('alta con APIs vacías funciona sin claves de custodia; una API real sin clave revierte toda el alta',async()=>{
    const isolated=apiServer(app,async()=>token('operator','a',true),undefined,{invitations:createInvitationService(app,auth)})
    await new Promise<void>(resolve=>isolated.listen(0,'127.0.0.1',resolve))
    const address=isolated.address();if(!address||typeof address==='string')throw new Error('address')
    const url=`http://127.0.0.1:${address.port}/v1/operations/altaRestauranteLogiqd`
    const send=(input:unknown)=>fetch(url,{method:'POST',headers:{Authorization:'Bearer operator','Content-Type':'application/json'},body:JSON.stringify({data:input})})
    try {
      const response=await send({...createInput('sin-custodia'),integrations:{stripe:{secretKey:'',webhookSecret:''},email:{apiKey:' '}}})
      expect(response.status).toBe(200)
      expect((await response.json() as {result:{invitationStatus:string}}).result.invitationStatus).toBe('pending')
      const rejected=await send({...createInput('sin-clave-api'),integrations:{email:{apiKey:'do-not-leak'}}})
      expect(rejected.status).toBe(503)
      expect(await rejected.text()).not.toContain('do-not-leak')
      expect((await admin.query("SELECT id FROM llenamos.restaurants WHERE slug='sin-clave-api'")).rows).toEqual([])
    }finally{isolated.closeAllConnections();await new Promise<void>(resolve=>isolated.close(()=>resolve()))}
  })
  it('dos reintentos concurrentes crean una sola alta y no vuelven a resolver identidad',async()=>{
    const input=createInput('alta-idempotente'),before=resolveAccount.mock.calls.length
    const responses=await Promise.all([request('altaRestauranteLogiqd',input),request('altaRestauranteLogiqd',input)])
    expect(responses.map(response=>response.status)).toEqual([200,200])
    expect(await responses[0]!.json()).toEqual(await responses[1]!.json())
    expect(resolveAccount.mock.calls.length-before).toBe(1)
    expect(Number((await admin.query("SELECT count(*) AS n FROM llenamos.restaurants WHERE slug='alta-idempotente'")).rows[0].n)).toBe(1)
    expect((await request('altaRestauranteLogiqd',{...input,name:'Otros datos'})).status).toBe(409)
    expect((await request('altaRestauranteLogiqd',createInput('alta-idempotente'))).status).toBe(409)
  })
  it('el mismo propietario admite dos restaurantes sin activar su acceso',async()=>{
    const one=createInput('multi-uno'),two={...createInput('multi-dos'),ownerEmail:one.ownerEmail}
    for(const input of [one,two])expect((await request('altaRestauranteLogiqd',input)).status).toBe(200)
    const uid=accounts.get(one.ownerEmail)!.uid
    expect((await admin.query('SELECT active FROM llenamos.memberships WHERE uid=$1',[uid])).rows).toEqual([{active:false},{active:false}])
  })
  it('roles de restaurantes no dan altas ni configuran otros; LogiQD sigue fuera del interior',async()=>{
    const result=await create('separacion')
    for(const actor of ['owner-a','owner-b','worker']) {
      expect((await request('altaRestauranteLogiqd',createInput(`prohibido-${actor}`),actor)).status).toBe(403)
      expect((await request('configurarRestauranteLogiqd',configInput(result.restaurantId,1),actor)).status).toBe(403)
    }
    expect((await fetch(`${base}/v1/restaurants/${result.restaurantId}/context`,{headers:{Authorization:'Bearer operator'}})).status).toBe(403)
    await expect(withIdentity(app,token('operator','a',true),result.restaurantId,client=>client.query('UPDATE llenamos.memberships SET active=true WHERE restaurant_id=$1',[result.restaurantId]))).rejects.toMatchObject({code:'42501'})
  })
  it('revisión optimista serializa cambios y reintento conserva resultado exacto',async()=>{
    const {restaurantId}=await create('revision')
    const input=configInput(restaurantId,1)
    const responses=await Promise.all([request('configurarRestauranteLogiqd',input),request('configurarRestauranteLogiqd',{...configInput(restaurantId,1),planId:'grupo'})])
    expect(responses.map(response=>response.status).sort()).toEqual([200,409])
    const current=(await admin.query('SELECT revision FROM llenamos.platform_restaurants WHERE restaurant_id=$1',[restaurantId])).rows[0].revision
    expect(current).toBe(2)
    const stable=configInput(restaurantId,2),first=await request('configurarRestauranteLogiqd',stable),second=await request('configurarRestauranteLogiqd',stable)
    expect(first.status).toBe(200);expect(await first.json()).toEqual(await second.json())
    expect((await request('configurarRestauranteLogiqd',{...stable,reason:'Otro motivo'})).status).toBe(409)
  })
  it('credenciales cifradas aisladas; blanco conserva y retirada explícita elimina parcial',async()=>{
    const a=await create('integraciones-a'),b=await create('integraciones-b')
    const input={...configInput(a.restaurantId,1),integrations:{stripe:{secretKey:'sk_tenant_a',webhookSecret:'whsec_tenant_a'},email:{apiKey:'partial_a'}}}
    const first=await request('configurarRestauranteLogiqd',input),text=await first.text()
    expect(first.status).toBe(200);expect(text).not.toContain('sk_tenant_a');expect(text).not.toContain('partial_a')
    expect(JSON.parse(text).result.restaurant.integrationStatus.stripe).toEqual({configured:true,status:'configured'})
    const ciphertext=(await admin.query('SELECT ciphertext FROM llenamos.integration_secrets WHERE restaurant_id=$1',[a.restaurantId])).rows[0].ciphertext
    expect(ciphertext).not.toContain('sk_tenant_a')
    // El secreto de firma se guarda aparte (sin la clave API ni el correo) y solo por proveedor completo.
    const signing=(await admin.query('SELECT provider,ciphertext FROM llenamos.integration_webhook_secrets WHERE restaurant_id=$1',[a.restaurantId])).rows
    expect(signing.map(r=>r.provider)).toEqual(['stripe'])
    expect(integrationVault(Buffer.alloc(32,1)).openWebhook(a.restaurantId,'stripe',signing[0].ciphertext)).toEqual({webhookSecret:'whsec_tenant_a'})
    expect(signing[0].ciphertext).not.toContain('sk_tenant_a')
    await expect(withIdentity(app,token('operator','a',true),null,client=>client.query('SELECT * FROM llenamos.integration_secrets'))).rejects.toMatchObject({code:'42501'})
    expect((await request('configurarRestauranteLogiqd',{...configInput(a.restaurantId,2),integrations:{stripe:{secretKey:''}}})).status).toBe(200)
    const newCiphertext=(await admin.query('SELECT ciphertext FROM llenamos.integration_secrets WHERE restaurant_id=$1',[a.restaurantId])).rows[0].ciphertext
    expect(integrationVault(Buffer.alloc(32,1)).open(a.restaurantId,newCiphertext).stripe?.secretKey).toBe('sk_tenant_a')
    expect(()=>integrationVault(Buffer.alloc(32,1)).open(b.restaurantId,newCiphertext)).toThrow()
    expect((await request('configurarRestauranteLogiqd',{...configInput(a.restaurantId,3),removeIntegrations:['stripe','email']})).status).toBe(200)
    expect((await admin.query('SELECT restaurant_id FROM llenamos.integration_secrets')).rows).toEqual([])
  })
  it('serviceUntil respeta fechas/transiciones; cancelado no se reactiva ni módulos saltan suspensión',async()=>{
    const {restaurantId}=await create('service-until')
    expect((await request('configurarRestauranteLogiqd',{...configInput(restaurantId,1),serviceUntil:Date.now()-1})).status).toBe(400)
    expect((await request('configurarRestauranteLogiqd',{...configInput(restaurantId,1),serviceUntil:Date.now()+367*86_400_000})).status).toBe(400)
    expect((await request('configurarRestauranteLogiqd',{...configInput(restaurantId,1),serviceUntil:Date.now()+30*86_400_000,moduleOverrides:{repite:true}})).status).toBe(200)
    expect((await admin.query('SELECT status FROM llenamos.platform_subscriptions WHERE restaurant_id=$1',[restaurantId])).rows[0].status).toBe('active')
    await admin.query("UPDATE llenamos.platform_subscriptions SET status='cancelled' WHERE restaurant_id=$1",[restaurantId])
    expect((await request('configurarRestauranteLogiqd',{...configInput(restaurantId,2),serviceUntil:Date.now()+30*86_400_000})).status).toBe(412)
    const response=await request('configurarRestauranteLogiqd',{...configInput(restaurantId,2),moduleOverrides:{repite:true}})
    expect(response.status).toBe(200)
    expect((await response.json() as {result:{restaurant:{activeModules:string[]}}}).result.restaurant.activeModules).toEqual([])
  })
  it('no permite bajar a plan sin capacidad ni modificar contrato Stripe vinculado',async()=>{
    const {restaurantId}=await create('limites')
    await admin.query('UPDATE llenamos.platform_usage SET members=6 WHERE restaurant_id=$1',[restaurantId])
    expect((await request('configurarRestauranteLogiqd',{...configInput(restaurantId,1),planId:'barra'})).status).toBe(412)
    await admin.query("UPDATE llenamos.platform_subscriptions SET stripe_subscription_id='sub_fixture' WHERE restaurant_id=$1",[restaurantId])
    expect((await request('configurarRestauranteLogiqd',configInput(restaurantId,1))).status).toBe(412)
  })
  it('sin worker, SQL deniega escrituras y el servidor deniega mutaciones tras vencer el servicio',async()=>{
    const input=createInput('expiracion'),response=await request('altaRestauranteLogiqd',input)
    expect(response.status).toBe(200)
    const result=core.AltaRestauranteLogiqdOutputSchema.parse((await response.json() as {result:unknown}).result),uid=accounts.get(input.ownerEmail)!.uid
    await admin.query('UPDATE llenamos.identities SET session_version=$2,tokens_valid_after=to_timestamp(100),locked=false WHERE uid=$1',[uid,'e'.repeat(32)])
    await admin.query('UPDATE llenamos.memberships SET active=true,invitation_pending=false WHERE restaurant_id=$1',[result.restaurantId])
    await withIdentity(app,token(uid,'e'),result.restaurantId,client=>client.query('INSERT INTO llenamos.outbox(id,restaurant_id,kind,payload) VALUES($1,$2,$3,$4)',[randomUUID(),result.restaurantId,'fixture','{}']))
    await admin.query("UPDATE llenamos.restaurants SET access_valid_until=now()-interval '1 second' WHERE id=$1",[result.restaurantId])
    await withIdentity(app,token(uid,'e'),result.restaurantId,async client=>expect((await client.query('SELECT * FROM llenamos.outbox')).rows).toEqual([]))
    await expect(withIdentity(app,token(uid,'e'),result.restaurantId,client=>client.query('INSERT INTO llenamos.outbox(id,restaurant_id,kind,payload) VALUES($1,$2,$3,$4)',[randomUUID(),result.restaurantId,'fixture','{}']))).rejects.toMatchObject({code:'42501'})
    const before=resolveAccount.mock.calls.length
    expect((await request('invitarMiembro',{restaurantId:result.restaurantId,email:'no-invitar@example.test',displayName:'Trabajador',role:'waiter'},uid)).status).toBe(412)
    expect(resolveAccount.mock.calls.length).toBe(before)
  })
})
