import { createCipheriv,createDecipheriv,createHmac,randomBytes } from 'node:crypto'
import { RESTAURANT_PROVIDERS,RestaurantIntegrationsInputSchema,emptyIntegrationStatus,type RestaurantIntegrationsInput,type RestaurantIntegrationStatus,type RestaurantProviderSchema } from '@llenamos/core'
import type { z } from 'zod'
import { ApiError } from '../errors.js'

export type Provider=z.infer<typeof RestaurantProviderSchema>
export type Credentials=Partial<Record<Provider,Record<string,string>>>
export function mergeCredentials(previous:Credentials,patch:RestaurantIntegrationsInput={},remove:Provider[]=[]):Credentials {
  const next=structuredClone(previous)
  for(const provider of RESTAURANT_PROVIDERS) {
    if(remove.includes(provider)){delete next[provider];continue}
    const values=Object.fromEntries(Object.entries(patch[provider]??{}).filter((entry):entry is [string,string]=>typeof entry[1]==='string'&&!!entry[1].trim()).map(([key,value])=>[key,value.trim()]))
    if(Object.keys(values).length)next[provider]={...next[provider],...values}
  }
  return next
}
export function credentialsStatus(credentials:Credentials):RestaurantIntegrationStatus {
  const result=emptyIntegrationStatus()
  const required:Record<Provider,string[]>={stripe:['secretKey','webhookSecret'],whatsapp:['token','phoneNumberId','appSecret','verifyToken'],email:['apiKey','from'],fiscal:['provider','apiKey'],repite:['apiKey','merchantId']}
  for(const provider of RESTAURANT_PROVIDERS) {
    const configured=required[provider].every(key=>!!credentials[provider]?.[key])
    // Correo, WhatsApp y Stripe (señal y cobro móvil) ya tienen consumidor real. Fiscal y Repite siguen sin adaptador operativo.
    result[provider]={configured,status:configured?(provider==='email'||provider==='whatsapp'||provider==='stripe'?'configured':'adapter_pending'):'not_configured'}
  }
  return result
}
/** Subconjunto que basta para verificar firmas entrantes; el receptor de webhooks no necesita nada más. */
export const WEBHOOK_PROVIDERS=['stripe','whatsapp'] as const
export type WebhookProvider=(typeof WEBHOOK_PROVIDERS)[number]
export type WebhookSecrets={webhookSecret?:string;mobileWebhookSecret?:string;appSecret?:string;verifyToken?:string;phoneNumberId?:string}
const webhookFields:Record<WebhookProvider,readonly (keyof WebhookSecrets)[]>={stripe:['webhookSecret','mobileWebhookSecret'],whatsapp:['appSecret','verifyToken','phoneNumberId']}
export function webhookSubset(credentials:Credentials,provider:WebhookProvider):WebhookSecrets|null {
  const source=credentials[provider]??{},picked:WebhookSecrets={}
  for(const field of webhookFields[provider])if(source[field])picked[field]=source[field]
  return Object.keys(picked).length?picked:null
}
export function integrationVault(key?:Buffer) {
  if(key&&key.length!==32)throw new Error('La clave de integraciones debe tener 32 bytes.')
  function secret() {
    if(!key)throw new ApiError(503,'failed-precondition','Configura la custodia antes de guardar APIs.')
    return createHmac('sha256',key).update('llenamos-integrations:v1').digest()
  }
  function webhookKey() {
    if(!key)throw new ApiError(503,'failed-precondition','Configura la custodia antes de guardar APIs.')
    return createHmac('sha256',key).update('llenamos-webhook-secrets:v1').digest()
  }
  return {
    sealWebhook(rid:string,provider:WebhookProvider,value:WebhookSecrets|null):string|null {
      if(!value)return null
      const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',webhookKey(),iv)
      cipher.setAAD(Buffer.from(`llenamos:webhook_secret:v1:${rid}:${provider}`))
      const body=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()])
      return `w1.${Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64url')}`
    },
    openWebhook(rid:string,provider:WebhookProvider,ciphertext:string|null):WebhookSecrets {
      if(!ciphertext)return {}
      try {
        if(!ciphertext.startsWith('w1.'))throw new Error()
        const bytes=Buffer.from(ciphertext.slice(3),'base64url')
        if(bytes.length<28)throw new Error()
        const decipher=createDecipheriv('aes-256-gcm',webhookKey(),bytes.subarray(0,12))
        decipher.setAAD(Buffer.from(`llenamos:webhook_secret:v1:${rid}:${provider}`));decipher.setAuthTag(bytes.subarray(12,28))
        const value=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8')) as Record<string,unknown>
        const clean:WebhookSecrets={}
        for(const field of webhookFields[provider])if(typeof value[field]==='string')clean[field]=value[field] as string
        return clean
      }catch {throw new ApiError(503,'unavailable','No se pudo abrir la configuración de proveedores.')}
    },
    seal(rid:string,value:Credentials):string|null {
      if(!Object.keys(value).length)return null
      const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',secret(),iv)
      cipher.setAAD(Buffer.from(`llenamos:integration_secrets:v1:${rid}`))
      const body=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()])
      return `v1.${Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64url')}`
    },
    open(rid:string,ciphertext:string|null):Credentials {
      if(!ciphertext)return {}
      const current=secret()
      try {
        if(!ciphertext.startsWith('v1.'))throw new Error()
        const bytes=Buffer.from(ciphertext.slice(3),'base64url')
        if(bytes.length<28)throw new Error()
        const decipher=createDecipheriv('aes-256-gcm',current,bytes.subarray(0,12))
        decipher.setAAD(Buffer.from(`llenamos:integration_secrets:v1:${rid}`));decipher.setAuthTag(bytes.subarray(12,28))
        return RestaurantIntegrationsInputSchema.parse(JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8'))) as Credentials
      }catch {throw new ApiError(503,'unavailable','No se pudo abrir la configuración de proveedores.')}
    },
  }
}
export type IntegrationVault=ReturnType<typeof integrationVault>
