import { migrationSql } from '../test-migrations.js'
import { randomBytes,randomUUID } from 'node:crypto'
import { initializeApp,deleteApp,type App } from 'firebase-admin/app'
import { getAuth,type Auth } from 'firebase-admin/auth'
import { Pool } from 'pg'
import { afterAll,beforeAll,describe,expect,it } from 'vitest'
import { createFirebaseInvitationAuth,type InvitationAuthAdmin } from './auth-admin.js'
import { createInvitationService,type InvitationService } from './service.js'
import { digest } from './crypto.js'
import { withIdentity } from '../database.js'
import type { IdentityToken } from '../auth.js'
import { apiServer } from '../server.js'

const enabled=process.env.TEST_POSTGRES_INVITATIONS==='1'&&!!process.env.TEST_POSTGRES_URL&&!!process.env.FIREBASE_AUTH_EMULATOR_HOST
describe.skipIf(!enabled)('Invitaciones: PostgreSQL real + Firebase Auth emulado',()=>{
 let admin:Pool,runtime:Pool,app:App,auth:Auth,identity:InvitationAuthAdmin,service:InvitationService
 const operator='fixture-platform',operatorVersion='a'.repeat(32),key=randomBytes(32),links=new Map<string,URL>(),users:string[]=[]
 const token=(uid:string,version=operatorVersion):IdentityToken=>({uid,sessionVersion:version,authTime:Math.floor(Date.now()/1000),platformClaim:uid===operator})
 const parseToken=(value:string):IdentityToken=>{const p=JSON.parse(Buffer.from(value.split('.')[1]!,'base64url').toString()) as {sub:string;auth_time:number;sessionVersion?:string};return {uid:p.sub,authTime:p.auth_time,sessionVersion:p.sessionVersion??null,platformClaim:false}}
 const config={encryptionKey:key,mail:{origin:'https://app.example.test',apiKey:'fixture-only',from:'acceso@example.test'},leaseMs:100,
  fetch:async(_url:string|URL|Request,options?:RequestInit)=>{const body=JSON.parse(String(options?.body)) as {to:string[];text:string};links.set(body.to[0]!,new URL(body.text.match(/https:\/\/[^\s]+/)![0]));return new Response('{"id":"fixture-delivery"}',{status:200})}}
 beforeAll(async()=>{
  const url=new URL(process.env.TEST_POSTGRES_URL!)
  if(!['127.0.0.1','localhost'].includes(url.hostname)||!url.pathname.startsWith('/llenamos_api_test_invitation')||!/^127\.0\.0\.1:\d+$/.test(process.env.FIREBASE_AUTH_EMULATOR_HOST!))throw new Error('Sólo recursos temporales loopback.')
  admin=new Pool({connectionString:url.toString(),max:2})
  for(const sql of migrationSql())await admin.query(sql)
  await admin.query("CREATE ROLE invitation_fixture LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD 'fixture-only' IN ROLE llenamos_app")
  url.username='invitation_fixture';url.password='fixture-only';runtime=new Pool({connectionString:url.toString(),max:8})
  await admin.query('INSERT INTO llenamos.identities(uid,session_version,tokens_valid_after,locked,platform_operator) VALUES($1,$2,to_timestamp(0),false,true)',[operator,operatorVersion])
  app=initializeApp({projectId:'demo-llenamos'},`invitation-fixture-${randomUUID()}`);auth=getAuth(app)
  identity=createFirebaseInvitationAuth({projectId:'demo-llenamos',testEmulator:true})
  service=createInvitationService(runtime,identity,config)
 },30000)
 afterAll(async()=>{for(const uid of users)await auth?.deleteUser(uid);await runtime?.end();await admin?.end();if(app)await deleteApp(app)})
 async function restaurant(email:string) {
  const rid=`r_${randomBytes(8).toString('hex')}`
  await admin.query('INSERT INTO llenamos.restaurants(id,name,slug,commercial_plan_id,commercial_plan_version,access_valid_until) VALUES($1,$1,$1,$2,1,now()+interval \'30 days\')',[rid,'sala'])
  await admin.query('INSERT INTO llenamos.platform_restaurants(restaurant_id,name,slug,plan_id,owner_email) VALUES($1,$1,$1,$2,$3)',[rid,'sala',email])
  await admin.query("INSERT INTO llenamos.platform_subscriptions(restaurant_id,plan_id,plan_version,status,period_ends_at) VALUES($1,'sala',1,'active',now()+interval '30 days')",[rid])
  await admin.query('INSERT INTO llenamos.platform_usage(restaurant_id,locations,members,api_keys,webhooks) VALUES($1,1,1,0,0)',[rid])
  return rid
 }
 async function account() {
  const email=`account-${randomBytes(8).toString('hex')}@example.test`,version=randomBytes(16).toString('hex')
  const user=await auth.createUser({email,password:'Conocida-Por-Otro-Local',emailVerified:false});users.push(user.uid)
  await auth.setCustomUserClaims(user.uid,{sessionVersion:version})
  await admin.query('INSERT INTO llenamos.identities(uid,session_version,tokens_valid_after,locked) VALUES($1,$2,to_timestamp(0),false)',[user.uid,version])
  return {uid:user.uid,email,version}
 }
 async function login(email:string,password:string) {
  const response=await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password,returnSecureToken:true})})
  const result=await response.json() as {idToken?:string}
  if(!response.ok||!result.idToken)throw new Error('fixture_login_rejected')
  return parseToken(result.idToken)
 }
 function credential(email:string,password='Privada-Del-Titular-2026!') {
  const link=links.get(email)!,p=new URLSearchParams(link.hash.slice(1));expect(link.search).toBe('')
  return {invitationId:p.get('i')!,token:p.get('t')!,password}
 }
 async function ownerInvitation(user:{uid:string;email:string},s=service) {
  const rid=await restaurant(user.email)
  await withIdentity(runtime,token(operator),null,client=>s.prepare(client,{restaurantId:rid,...user,displayName:'Propietario',role:'owner',locationIds:[],invitedBy:operator,kind:'owner'}))
  await s.deliverOwner(rid,user.email)
  return rid
 }
 it('cuenta precreada: consentimiento, dos restaurantes, vieja contraseña/ID token y replay',async()=>{
  const user=await account(),ridA=await restaurant(user.email)
  await admin.query("INSERT INTO llenamos.memberships(restaurant_id,uid,role,active,display_name,email) VALUES($1,$2,'waiter',true,'Anterior',$3)",[ridA,user.uid,user.email])
  const old=await login(user.email,'Conocida-Por-Otro-Local'),ridB=await ownerInvitation(user)
  expect((await admin.query('SELECT active FROM llenamos.memberships WHERE restaurant_id=$1 AND uid=$2',[ridB,user.uid])).rows[0].active).toBe(false)
  await withIdentity(runtime,old,ridB,async client=>expect((await client.query('SELECT id FROM llenamos.restaurants WHERE id=$1',[ridB])).rowCount).toBe(0))
  await expect(login(user.email,'Conocida-Por-Otro-Local')).resolves.toBeTruthy()
  const consent=credential(user.email)
  const server=apiServer(runtime,async()=>{throw new Error('La aceptación no debe verificar una sesión anterior')},()=>{}, {invitations:service})
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  try {
   const address=server.address();if(!address||typeof address==='string')throw new Error('fixture_server_address')
   const response=await fetch(`http://127.0.0.1:${address.port}/v1/operations/aceptarInvitacion`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer old-session-must-be-ignored'},body:JSON.stringify({data:consent})})
   expect(response.status).toBe(200);expect(await response.json()).toEqual({result:{ok:true,email:user.email}})
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
  await expect(withIdentity(runtime,old,ridB,async()=>null)).rejects.toMatchObject({status:401})
  await expect(login(user.email,'Conocida-Por-Otro-Local')).rejects.toThrow('fixture_login_rejected')
  const fresh=await login(user.email,consent.password)
  for(const rid of [ridA,ridB])await withIdentity(runtime,fresh,rid,async client=>expect((await client.query('SELECT id FROM llenamos.restaurants WHERE id=$1',[rid])).rows).toEqual([{id:rid}]))
  await expect(service.accept({...consent,password:'Replay-No-Permitido-2026'})).rejects.toMatchObject({status:412})
  await expect(login(user.email,consent.password)).resolves.toBeTruthy()
 },30000)
 it('sin correo crea pending sin activar; cancelar, reenviar y roles preservan aislamiento',async()=>{
  const owner=await account(),rid=await restaurant(owner.email),guest=await account()
  await admin.query("INSERT INTO llenamos.memberships(restaurant_id,uid,role,active,display_name,email) VALUES($1,$2,'owner',true,'Owner',$3)",[rid,owner.uid,owner.email])
  const pending=createInvitationService(runtime,identity,{encryptionKey:key,leaseMs:100})
  const input={restaurantId:rid,email:guest.email,displayName:'Equipo',role:'waiter'}
  const result=await withIdentity(runtime,token(owner.uid,owner.version),rid,client=>pending.invite(client,input,{uid:owner.uid}))
  expect(result).toEqual({uid:guest.uid,invitationStatus:'pending'});expect(await pending.deliver(digest(`${rid}:${guest.uid}`))).toBe('pending')
  expect((await admin.query('SELECT active FROM llenamos.memberships WHERE restaurant_id=$1 AND uid=$2',[rid,guest.uid])).rows[0].active).toBe(false)
  await service.deliver(digest(`${rid}:${guest.uid}`));const original=credential(guest.email)
  await withIdentity(runtime,token(owner.uid,owner.version),rid,client=>service.deactivate(client,{restaurantId:rid,uid:guest.uid},{uid:owner.uid}))
  expect((await admin.query('SELECT members FROM llenamos.platform_usage WHERE restaurant_id=$1',[rid])).rows[0].members).toBe(1)
  await expect(service.accept(original)).rejects.toMatchObject({status:412})
  await withIdentity(runtime,token(owner.uid,owner.version),rid,client=>service.invite(client,input,{uid:owner.uid}))
  await service.deliver(digest(`${rid}:${guest.uid}`));const replacement=credential(guest.email)
  expect(replacement.token).not.toBe(original.token)
  await expect(service.accept(original)).rejects.toMatchObject({status:412})
  await service.accept(replacement)
  const guestToken=await login(guest.email,replacement.password)
  await expect(withIdentity(runtime,guestToken,rid,client=>service.changeRole(client,{restaurantId:rid,uid:owner.uid,role:'waiter'},{uid:guest.uid}))).rejects.toMatchObject({status:403})
  await expect(withIdentity(runtime,token(owner.uid,owner.version),rid,client=>service.deactivate(client,{restaurantId:rid,uid:owner.uid},{uid:owner.uid}))).rejects.toMatchObject({status:412})
 },30000)
 it('fallo después de Auth deja bloqueo y permite reintento privado tras el lease',async()=>{
  const user=await account();let fail=true
  const partial=createInvitationService(runtime,{...identity,async proveMailbox(...args){const result=await identity.proveMailbox(...args);if(fail){fail=false;throw new Error('fixture_intermediate_failure')}return result}},config)
  const rid=await ownerInvitation(user,partial),input=credential(user.email),old=token(user.uid,user.version)
  await expect(partial.accept(input)).rejects.toMatchObject({status:503})
  expect((await admin.query('SELECT locked FROM llenamos.identities WHERE uid=$1',[user.uid])).rows[0].locked).toBe(true)
  expect((await admin.query('SELECT active FROM llenamos.memberships WHERE restaurant_id=$1 AND uid=$2',[rid,user.uid])).rows[0].active).toBe(false)
  await expect(withIdentity(runtime,old,rid,async()=>null)).rejects.toMatchObject({status:401})
  await new Promise(resolve=>setTimeout(resolve,150));await partial.accept(input)
  await withIdentity(runtime,await login(user.email,input.password),rid,async()=>null)
 },30000)
 it('dos aceptaciones del mismo UID se serializan durante Auth aunque caduque el lease',async()=>{
  const user=await account();let active=0,maximum=0,lastPassword=''
  const slow=createInvitationService(runtime,{...identity,async proveMailbox(...args){active++;maximum=Math.max(maximum,active);try{await new Promise(resolve=>setTimeout(resolve,250));const result=await identity.proveMailbox(...args);lastPassword=args[2];return result}finally{active--}}},config)
  const a=await ownerInvitation(user,slow),first=credential(user.email,'Primera-Privada-2026!'),b=await ownerInvitation(user,slow),second=credential(user.email,'Segunda-Privada-2026!')
  await Promise.all([slow.accept(first),slow.accept(second)])
  expect(maximum).toBe(1)
  expect((await admin.query('SELECT count(*)::int n FROM llenamos.memberships WHERE uid=$1 AND active',[user.uid])).rows[0].n).toBe(2)
  const current=await auth.getUser(user.uid),state=(await admin.query('SELECT session_version,locked FROM llenamos.identities WHERE uid=$1',[user.uid])).rows[0]
  expect(state.locked).toBe(false);expect(state.session_version).toBe(current.customClaims?.sessionVersion)
  const finalToken=await login(user.email,lastPassword)
  for(const rid of [a,b])await withIdentity(runtime,finalToken,rid,async()=>null)
 },30000)
 it('runtime no tiene escritura general a identidades ni lee tokens privados',async()=>{
  await expect(runtime.query("UPDATE llenamos.identities SET locked=false")).rejects.toThrow(/permission denied/)
  await expect(runtime.query('SELECT * FROM llenamos.account_invitations')).rejects.toThrow(/permission denied/)
  await expect(runtime.query("INSERT INTO llenamos.memberships(restaurant_id,uid,role,display_name,email) VALUES('forbidden','forbidden','owner','x','x@example.test')")).rejects.toThrow(/permission denied/)
 })
 it('preflight deniega rol y cupo antes de crear o modificar cuentas Auth',async()=>{
  const manager=await account(),rid=await restaurant(manager.email)
  await admin.query("INSERT INTO llenamos.memberships(restaurant_id,uid,role,active,display_name,email) VALUES($1,$2,'manager',true,'Manager',$3)",[rid,manager.uid,manager.email])
  let authCalls=0
  const observed=createInvitationService(runtime,{...identity,async resolveAccount(...args){authCalls++;return identity.resolveAccount(...args)}},config)
  const input={restaurantId:rid,email:`not-created-${randomUUID()}@example.test`,displayName:'No creada',role:'owner'}
  await expect(withIdentity(runtime,token(manager.uid,manager.version),rid,client=>observed.invite(client,input,{uid:manager.uid}))).rejects.toMatchObject({status:403})
  await admin.query('UPDATE llenamos.platform_usage SET members=15 WHERE restaurant_id=$1',[rid])
  await expect(withIdentity(runtime,token(manager.uid,manager.version),rid,client=>observed.invite(client,{...input,role:'waiter'},{uid:manager.uid}))).rejects.toMatchObject({status:412})
  expect(authCalls).toBe(0)
 },30000)
 it('revocar al invitador durante Auth impide activar y deja bloqueo hasta recuperación privada',async()=>{
  const owner=await account(),guest=await account(),rid=await restaurant(owner.email)
  await admin.query("INSERT INTO llenamos.memberships(restaurant_id,uid,role,active,display_name,email) VALUES($1,$2,'owner',true,'Owner',$3)",[rid,owner.uid,owner.email])
  await withIdentity(runtime,token(owner.uid,owner.version),rid,client=>service.invite(client,{restaurantId:rid,email:guest.email,displayName:'Equipo',role:'waiter'},{uid:owner.uid}))
  await service.deliver(digest(`${rid}:${guest.uid}`));const consent=credential(guest.email)
  const interrupted=createInvitationService(runtime,{...identity,async proveMailbox(...args){const result=await identity.proveMailbox(...args);await admin.query('UPDATE llenamos.memberships SET active=false WHERE restaurant_id=$1 AND uid=$2',[rid,owner.uid]);return result}},config)
  await expect(interrupted.accept(consent)).rejects.toMatchObject({status:403})
  expect((await admin.query('SELECT locked FROM llenamos.identities WHERE uid=$1',[guest.uid])).rows[0].locked).toBe(true)
  expect((await admin.query('SELECT active FROM llenamos.memberships WHERE restaurant_id=$1 AND uid=$2',[rid,guest.uid])).rows[0].active).toBe(false)
  await admin.query('UPDATE llenamos.memberships SET active=true WHERE restaurant_id=$1 AND uid=$2',[rid,owner.uid])
  await new Promise(resolve=>setTimeout(resolve,150));await service.accept(consent)
 },30000)
})
