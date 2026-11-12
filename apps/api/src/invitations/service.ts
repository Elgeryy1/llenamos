import { randomBytes,randomUUID } from 'node:crypto'
import type { Pool,PoolClient } from 'pg'
import { z } from 'zod'
import { emitEvent } from '../events.js'
import { ApiError } from '../errors.js'
import type { InvitationAuthAdmin } from './auth-admin.js'
import { decryptToken,digest,encryptToken,type TokenEnvelope } from './crypto.js'

const role=z.enum(['owner','manager','waiter','kitchen','bar'])
const id=z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)
export const AcceptInvitationInput=z.strictObject({invitationId:z.string().regex(/^[a-f0-9]{64}$/),token:z.string().regex(/^[A-Za-z0-9_-]{43}$/),password:z.string().min(12).max(128)})
export const InviteMemberInput=z.strictObject({restaurantId:id,email:z.string().trim().email().max(254).transform(v=>v.toLowerCase()),displayName:z.string().trim().min(1).max(80),role})
export const ChangeRoleInput=z.strictObject({restaurantId:id,uid:id,role})
export const DeactivateInput=z.strictObject({restaurantId:id,uid:id})
export type PrepareInvitation={restaurantId:string;uid:string;email:string;displayName:string;role:z.infer<typeof role>;locationIds:string[];invitedBy:string;kind:'owner'|'member'}
export interface InvitationOptions {encryptionKey?:Buffer;mail?:{origin:string;apiKey:string;from:string};fetch?:typeof fetch;leaseMs?:number}
function failure(error:unknown):never {
  if(error instanceof ApiError)throw error
  const message=String((error as {message?:unknown})?.message??'')
  if(message.includes('invitation_already_exists'))throw new ApiError(409,'already-exists','Esta persona ya pertenece al restaurante.')
  if(message.includes('invitation_busy'))throw new ApiError(409,'aborted','La cuenta está aceptando otra invitación. Reintenta más tarde.')
  if(message.includes('invitation_denied'))throw new ApiError(403,'permission-denied','No puedes gestionar esta invitación.')
  if(['invitation_capacity','member_capacity_exceeded','service_disabled','usage_missing','subscription_missing'].some(code=>message.includes(code)))throw new ApiError(412,'failed-precondition','Revisa la capacidad y el estado del plan.')
  if(message.includes('invitation_'))throw new ApiError(412,'failed-precondition','La invitación ha caducado, se ha usado o no es válida.')
  throw new ApiError(503,'unavailable','No se pudo completar la invitación. Vuelve a intentarlo.')
}
export function createInvitationService(pool:Pool,identity:InvitationAuthAdmin,options:InvitationOptions={}) {
  const leaseMs=options.leaseMs??120000,fetcher=options.fetch??fetch
  if(!Number.isInteger(leaseMs)||leaseMs<100||leaseMs>120000)throw new Error('Lease de invitación no válido.')
  if(options.encryptionKey&&options.encryptionKey.length!==32)throw new Error('Clave de invitaciones no válida.')
  if(options.mail) {
    const url=new URL(options.mail.origin)
    if(!options.encryptionKey||url.protocol!=='https:'||url.pathname!=='/'||url.search||url.hash||url.username||url.password||!options.mail.apiKey||!options.mail.from)throw new Error('Configuración de correo de plataforma no válida.')
  }
  const service={
    async resolveAccount(email:string,displayName:string):Promise<string> {
      if(!z.string().trim().email().max(254).safeParse(email).success||!z.string().trim().min(1).max(80).safeParse(displayName).success)throw new ApiError(400,'invalid-argument','Revisa el correo y el nombre de la persona invitada.')
      try {return (await identity.resolveAccount(email.toLowerCase(),displayName)).uid}catch(error){return failure(error)}
    },
    async prepare(client:PoolClient,input:PrepareInvitation) {
      const invitationId=digest(`${input.restaurantId}:${input.uid}`),token=randomBytes(32).toString('base64url')
      try {
        await client.query('SELECT llenamos.invitation_prepare($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[
          invitationId,input.restaurantId,input.uid,input.email.toLowerCase(),input.displayName,input.role,input.locationIds,input.kind,digest(token),options.encryptionKey?JSON.stringify(encryptToken(options.encryptionKey,invitationId,token)):null,new Date(Date.now()+86400000),randomBytes(16).toString('hex')])
        return {invitationId,invitationStatus:'pending' as const}
      }catch(error){return failure(error)}
    },
    async deliver(invitationId:string):Promise<'sent'|'pending'> {
      if(!options.mail||!options.encryptionKey)return 'pending'
      try {
        const row=(await pool.query<{email:string;token_ciphertext:TokenEnvelope|null;state:string}>('SELECT * FROM llenamos.invitation_delivery($1)',[invitationId])).rows[0]
        if(!row?.token_ciphertext)return 'pending'
        if(row.state==='sent')return 'sent'
        const token=decryptToken(options.encryptionKey,invitationId,row.token_ciphertext)
        const link=new URL('/aceptar-invitacion',options.mail.origin)
        link.hash=new URLSearchParams({i:invitationId,t:token}).toString()
        const response=await fetcher('https://api.resend.com/emails',{
          method:'POST',headers:{Authorization:`Bearer ${options.mail.apiKey}`,'Content-Type':'application/json','Idempotency-Key':`invitation-${invitationId}-${digest(token).slice(0,16)}`},
          body:JSON.stringify({from:options.mail.from,to:[row.email],subject:'Tu invitación a Llenamos',text:`Te han invitado a un restaurante en Llenamos. Acepta y elige una contraseña que sólo conozcas tú:\n${link}\n\nCaduca en 24 horas. Al aceptar cambiará la contraseña de toda tu cuenta y se cerrarán sus sesiones anteriores. Si no esperabas esta invitación, ignórala.`}),signal:AbortSignal.timeout(15000),
        })
        if(!response.ok||!(await response.json() as {id?:string}).id)throw new ApiError(503,'unavailable','La invitación sigue pendiente; el correo no ha confirmado el envío.')
        const confirmed=await pool.query<{invitation_mark_sent:boolean}>('SELECT llenamos.invitation_mark_sent($1,$2)',[invitationId,digest(token)])
        return confirmed.rows[0]?.invitation_mark_sent?'sent':'pending'
      }catch(error){return failure(error)}
    },
    async deliverOwner(restaurantId:string,email:string) {
      const id=(await pool.query<{invitation_owner_id:string}>('SELECT llenamos.invitation_owner_id($1,$2)',[restaurantId,email.toLowerCase()])).rows[0]?.invitation_owner_id
      return id?service.deliver(id):'pending' as const
    },
    async refreshOwnerPending(client:PoolClient,restaurantId:string,email:string,displayName:string) {
      const row=(await client.query<{uid:string;email:string;display_name:string;location_ids:string[]}>('SELECT * FROM llenamos.invitation_owner_pending($1,$2)',[restaurantId,email.toLowerCase()])).rows[0]
      if(!row)return
      await service.prepare(client,{restaurantId,uid:row.uid,email:row.email,displayName,role:'owner',locationIds:row.location_ids,invitedBy:'',kind:'owner'})
    },
    async invite(client:PoolClient,data:unknown,context:{uid:string}) {
      const input=InviteMemberInput.parse(data)
      try {await client.query('SELECT llenamos.invitation_member_preflight($1,$2,$3)',[input.restaurantId,input.email,input.role])}catch(error){return failure(error)}
      const uid=await service.resolveAccount(input.email,input.displayName)
      await service.prepare(client,{...input,uid,invitedBy:context.uid,kind:'member',locationIds:[]})
      return {uid,invitationStatus:'pending' as 'sent'|'pending'}
    },
    async changeRole(client:PoolClient,data:unknown,_context:{uid:string}) {
      const input=ChangeRoleInput.parse(data)
      try {await client.query('SELECT llenamos.invitation_change_member($1,$2,$3)',[input.restaurantId,input.uid,input.role]);await emitEvent(client,{restaurantId:input.restaurantId,topic:'equipo.miembro',entityId:input.uid});return {ok:true as const}}catch(error){return failure(error)}
    },
    async deactivate(client:PoolClient,data:unknown,_context:{uid:string}) {
      const input=DeactivateInput.parse(data)
      try {await client.query('SELECT llenamos.invitation_change_member($1,$2,NULL)',[input.restaurantId,input.uid]);await emitEvent(client,{restaurantId:input.restaurantId,topic:'equipo.miembro',entityId:input.uid});return {ok:true as const}}catch(error){return failure(error)}
    },
    async accept(data:unknown) {
      const parsed=AcceptInvitationInput.safeParse(data)
      if(!parsed.success)throw new ApiError(400,'invalid-argument','Revisa la invitación y la nueva contraseña.')
      const input=parsed.data,hash=digest(input.token),lease=randomUUID(),version=randomBytes(16).toString('hex')
      const client=await pool.connect();let uid:string|undefined,locked=false,broken=false
      try {
        uid=(await client.query<{invitation_lookup:string|null}>('SELECT llenamos.invitation_lookup($1,$2)',[input.invitationId,hash])).rows[0]?.invitation_lookup??undefined
        if(!uid)throw new ApiError(412,'failed-precondition','La invitación ha caducado, se ha usado o no es válida.')
        // El lock de sesión permanece entre transacciones: una segunda aceptación no toca Auth
        // aunque caduque el lease mientras la primera espera al proveedor de identidad.
        await client.query("SELECT pg_advisory_lock(hashtextextended('invitation-auth:'||$1,0))",[uid]);locked=true
        await client.query('BEGIN')
        const account=(await client.query<{uid:string;email:string}>('SELECT * FROM llenamos.invitation_begin($1,$2,$3,$4,$5)',[input.invitationId,hash,lease,version,leaseMs])).rows[0]
        if(!account)throw new ApiError(412,'failed-precondition','La invitación no es válida.')
        await client.query('COMMIT')
        // Nunca sustituir por una tarea en segundo plano ni liberar el lock con una promesa viva.
        const validAfter=await identity.proveMailbox(account.uid,account.email,input.password,version)
        if(!Number.isFinite(validAfter)||validAfter>Date.now()+60000)throw new ApiError(503,'unavailable','No se ha confirmado la identidad.')
        const confirmed=await identity.account(uid)
        if(confirmed.claims.sessionVersion!==version||confirmed.email!==account.email||confirmed.disabled)throw new ApiError(409,'aborted','Vuelve a intentar la aceptación.')
        await client.query('BEGIN')
        await client.query('SELECT llenamos.invitation_finish($1,$2,$3,$4)',[input.invitationId,lease,version,new Date(validAfter)])
        await client.query('COMMIT')
        return {ok:true as const,email:account.email}
      }catch(error){try{await client.query('ROLLBACK')}catch{broken=true}return failure(error)}
      finally {
        if(locked&&!broken)try{await client.query("SELECT pg_advisory_unlock(hashtextextended('invitation-auth:'||$1,0))",[uid])}catch{broken=true}
        client.release(broken)
      }
    },
  }
  return service
}
export type InvitationService=ReturnType<typeof createInvitationService>
