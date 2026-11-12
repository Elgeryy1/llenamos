import type { PoolClient } from 'pg'
import * as core from '@llenamos/core'
import { ApiError } from '../../errors.js'
import { emitEvent } from '../../events.js'
import { credentialsStatus,mergeCredentials,webhookSubset,WEBHOOK_PROVIDERS,type Credentials,type IntegrationVault } from '../../platform/integrations.js'
import type { Operation } from '../../operations.js'
import type { ModuleDefinition } from '../types.js'
import { proveedoresLiveQueries } from './lecturas.js'

const schemas=core.CALLABLE_SCHEMAS
const owner=core.ROLES.filter(role=>core.can(role,'propietarios.gestionar'))
const rid=(input:unknown)=>(input as {restaurantId:string}).restaurantId

function needVault(vault:IntegrationVault|undefined) {
  if(!vault)throw new ApiError(503,'failed-precondition','La custodia de claves no está configurada en este servidor. Pide ayuda a LogiQD.')
  return vault
}
/** Estado y nombres de campo guardados; nunca un valor. */
function summary(credentials:Credentials) {
  const savedFields=Object.fromEntries(core.RESTAURANT_PROVIDERS.map(provider=>[provider,Object.entries(credentials[provider]??{}).filter(([,value])=>!!value).map(([key])=>key).sort()]))
  return core.ProveedoresRestauranteOutputSchema.parse({providers:credentialsStatus(credentials),savedFields})
}

async function view(client:PoolClient,input:unknown,context:{integrationVault?:IntegrationVault}) {
  const data=core.VerProveedoresRestauranteInputSchema.parse(input),vault=needVault(context.integrationVault)
  const ciphertext=(await client.query<{c:string|null}>('SELECT llenamos.restaurant_vault_open($1,false) AS c',[data.restaurantId])).rows[0]!.c
  return summary(vault.open(data.restaurantId,ciphertext))
}

async function save(client:PoolClient,input:unknown,context:{uid:string;integrationVault?:IntegrationVault}) {
  const data=core.GuardarProveedoresRestauranteInputSchema.parse(input),vault=needVault(context.integrationVault),id=data.restaurantId
  const ciphertext=(await client.query<{c:string|null}>('SELECT llenamos.restaurant_vault_open($1,true) AS c',[id])).rows[0]!.c
  const next=mergeCredentials(vault.open(id,ciphertext),data.integrations,data.remove)
  for(const {provider,field} of data.clear) {
    const fields=next[provider]
    if(!fields)continue
    delete fields[field]
    if(!Object.keys(fields).length)delete next[provider]
  }
  const webhooks=Object.fromEntries(WEBHOOK_PROVIDERS.map(provider=>[provider,vault.sealWebhook(id,provider,webhookSubset(next,provider))]))
  await client.query('SELECT llenamos.restaurant_vault_save($1,$2,$3,$4)',[id,vault.seal(id,next),JSON.stringify(credentialsStatus(next)),JSON.stringify(webhooks)])
  // El evento no lleva proveedores ni valores: solo avisa de que la configuración cambió.
  await emitEvent(client,{restaurantId:id,topic:'plataforma.integracion',entityId:'proveedores',payload:{kind:'providers',action:'saved'}})
  return summary(next)
}

const op=(name:'verProveedoresRestaurante'|'guardarProveedoresRestaurante',run:Operation extends infer O?O extends {run:infer R}?R:never:never):[string,Operation]=>
  [name,{access:'member',roles:owner,restaurantId:rid,input:schemas[name].input,output:schemas[name].output,run}]

/** Claves de proveedores que guarda el propio restaurante en su bóveda cifrada (solo propietario). */
export const proveedoresModule:ModuleDefinition={
  name:'proveedores',
  liveQueries:proveedoresLiveQueries,
  operations:[op('verProveedoresRestaurante',(client,input,context)=>view(client,input,context)),op('guardarProveedoresRestaurante',(client,input,context)=>save(client,input,context))],
}
