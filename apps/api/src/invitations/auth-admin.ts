import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { cert, initializeApp, type AppOptions, type ServiceAccount } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { ApiError } from '../errors.js'

export interface InvitationAccount { uid:string; email:string; disabled:boolean; claims:Record<string,unknown> }
export interface InvitationAuthAdmin {
  resolveAccount(email:string,displayName:string):Promise<InvitationAccount>
  account(uid:string):Promise<InvitationAccount>
  proveMailbox(uid:string,email:string,password:string,version:string):Promise<number>
}
/** Sólo Firebase Auth. La credencial de este adaptador no necesita permisos de datos/archivos. */
export function createFirebaseInvitationAuth(options:{projectId:string;credentialFile?:string;testEmulator?:boolean}):InvitationAuthAdmin {
  const emulator=process.env.FIREBASE_AUTH_EMULATOR_HOST
  if(emulator&&!options.testEmulator)throw new Error('Auth emulado sólo se permite en pruebas explícitas.')
  const config:AppOptions={projectId:options.projectId}
  if(!emulator) {
    if(!options.credentialFile)throw new Error('Falta la credencial mínima de administración de identidad.')
    try {
      const credential=JSON.parse(readFileSync(options.credentialFile,'utf8')) as {project_id?:string}
      if(credential.project_id!==options.projectId)throw new Error()
      config.credential=cert(credential as ServiceAccount)
    }catch {throw new Error('No se pudo cargar la credencial de administración de identidad.')}
  } else if(!options.testEmulator||!options.projectId.startsWith('demo-')||!/^127\.0\.0\.1:\d+$/.test(emulator))throw new Error('Emulador Auth de pruebas no válido.')
  const auth=getAuth(initializeApp(config,`invitations-${randomUUID()}`))
  const map=(user:{uid:string;email?:string;disabled:boolean;customClaims?:Record<string,unknown>}):InvitationAccount=>{
    if(!user.email||user.disabled||user.customClaims?.logiqd===true)throw new ApiError(412,'failed-precondition','No se puede invitar esta cuenta.')
    return {uid:user.uid,email:user.email.toLowerCase(),disabled:user.disabled,claims:user.customClaims??{}}
  }
  return {
    async resolveAccount(email,displayName) {
      try {return map(await auth.getUserByEmail(email))}
      catch(error) {
        if((error as {code?:string}).code!=='auth/user-not-found')throw error
        try {return map(await auth.createUser({email,displayName}))}
        catch(created) {
          if((created as {code?:string}).code!=='auth/email-already-exists')throw created
          return map(await auth.getUserByEmail(email))
        }
      }
    },
    async account(uid){return map(await auth.getUser(uid))},
    async proveMailbox(uid,email,password,version) {
      const user=map(await auth.getUser(uid))
      if(user.email!==email)throw new ApiError(412,'failed-precondition','La invitación no es válida.')
      await auth.updateUser(uid,{password,emailVerified:true})
      await auth.setCustomUserClaims(uid,{...user.claims,sessionVersion:version})
      await auth.revokeRefreshTokens(uid)
      const confirmed=await auth.getUser(uid)
      if(confirmed.customClaims?.sessionVersion!==version||confirmed.disabled||confirmed.email?.toLowerCase()!==email)
        throw new ApiError(409,'aborted','Vuelve a intentar la aceptación.')
      return Date.parse(confirmed.tokensValidAfterTime??'')
    },
  }
}
