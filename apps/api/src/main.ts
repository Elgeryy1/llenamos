import { configuration } from './config.js'
import { firebaseVerifier } from './auth.js'
import { checkReadiness,checkWebhookRole,createPool } from './database.js'
import { POOL_MAX } from './pools.js'
import { apiServer } from './server.js'
import { createFirebaseInvitationAuth } from './invitations/auth-admin.js'
import { rehearsalIdentity } from './rehearsal-identity.js'
import { createInvitationService } from './invitations/service.js'
import { integrationVault } from './platform/integrations.js'
import { fileStore } from './files/storage.js'
import { fileRoutes } from './files/routes.js'
import { privacyRoutes } from './privacy/routes.js'
import { webhookReceiver } from './webhooks/receiver.js'
import { MODULES } from './modules/index.js'
import { configureStripeVault } from './payments/credentials.js'
import { billingWebhookRoute,publicApiRoute } from './modules/plataforma/index.js'
import type { HttpRoute } from './http.js'

const config=configuration()
const pool=createPool(config.databaseUrl,{max:POOL_MAX.api})
// Solo con NODE_ENV=rehearsal (config lo exige): verificador y administración de identidad de ensayo, nunca la nube.
const rehearsal=config.rehearsal?rehearsalIdentity(config.projectId,config.rehearsal):undefined
const identityAdmin=rehearsal?.admin??(config.identityCredentialFile?createFirebaseInvitationAuth({projectId:config.projectId,credentialFile:config.identityCredentialFile}):undefined)
const invitations=identityAdmin?createInvitationService(pool,identityAdmin,{encryptionKey:config.invitationKey,mail:config.mail}):undefined
await checkReadiness(pool,!!invitations,Boolean(config.rehearsal))
const vault=integrationVault(config.integrationKey)
// Cobros con la Stripe del restaurante: la API abre su clave sellada solo para la operación pública en curso.
configureStripeVault(vault)
// API pública con claves (freno por IP verificada antes de autenticar).
const routes:HttpRoute[]=[publicApiRoute()]
let webhookPool:ReturnType<typeof createPool>|undefined
// Sin login propio del receptor no hay webhooks: nunca se reutiliza el pool de la API.
if(config.webhookDatabaseUrl) {
  webhookPool=createPool(config.webhookDatabaseUrl,{applicationName:'llenamos-webhook',max:POOL_MAX.webhook})
  await checkWebhookRole(webhookPool)
  // Billing de la plataforma: mismo login restringido, secreto de la plataforma (sin él responde 503, sin tumbar el arranque).
  routes.push(billingWebhookRoute({pool:webhookPool}))
}
if(config.integrationKey&&webhookPool) {
  const handled=new Set(MODULES.flatMap(module=>(module.workerHandlers??[]).map(([kind])=>kind)))
  handled.add('webhook.whatsapp')
  const receive=webhookReceiver(webhookPool,vault,{handled})
  routes.push(({req,res,path})=>receive(req,res,path))
}
if(config.filesRoot) {
  const store=fileStore(config.filesRoot)
  routes.push(fileRoutes(store))
  if(config.integrationKey)routes.push(privacyRoutes(store,config.integrationKey))
}
const server=apiServer(pool,rehearsal?.verify??firebaseVerifier(config.projectId),undefined,{invitations,integrationVault:vault,routes},{live:{listenUrl:config.databaseUrl},rehearsal:Boolean(config.rehearsal)})
server.listen(config.port,config.host)
let closing=false
const stop=()=>{
  if (closing) return
  closing=true
  server.close(()=>{ void Promise.all([pool.end(),webhookPool?.end()]).then(()=>process.exit(0)) })
  setTimeout(()=>process.exit(1),10_000).unref()
}
process.on('SIGTERM',stop)
process.on('SIGINT',stop)
