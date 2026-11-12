import { z } from 'zod'
import * as core from '@llenamos/core'

/** La conexión permanece apagada fuera del doble local de la fila 1. */
export function repiteConfigured(base = process.env.REPITE_API_URL): boolean {
  if (!base) return false
  try {
    const url = new URL(base)
    return url.protocol === 'http:' && ['127.0.0.1','127.0.0.2','localhost','[::1]'].includes(url.hostname) && process.env.GCLOUD_PROJECT === 'demo-llenamos' && !!process.env.FIRESTORE_EMULATOR_HOST
  } catch { return false }
}

/** Adaptador HTTP del contrato propuesto. Solo permite el doble de loopback en demo. */
export function httpRepite(base: string | undefined, token: string | undefined, fetcher: typeof fetch = fetch): core.RepiteAdapter {
  if (!repiteConfigured(base)) return core.notConfiguredRepite()
  async function call<T>(path: string, method: string, body: object | undefined, key: string | undefined, schema: z.ZodType<T>): Promise<core.RepiteResult<T>> {
    try {
      const response = await fetcher(`${base!.replace(/\/$/,'')}${path}`,{ method,headers:{ Authorization:`Bearer ${token ?? ''}`,'Content-Type':'application/json',...(key ? { 'Idempotency-Key':key } : {}) },...(body ? { body:JSON.stringify(body) } : {}),signal:AbortSignal.timeout(10000),redirect:'error' })
      if (!response.ok) {
        const code: core.RepiteErrorCode = response.status === 429 ? 'rate_limited' : response.status >= 500 ? 'unavailable' : response.status === 404 ? 'not_found' : response.status === 409 ? 'conflict' : response.status === 401 || response.status === 403 ? 'unauthorized' : 'invalid'
        const retry = response.headers.get('Retry-After')
        const retryAfterMs = retry === null ? 0 : /^\d+$/.test(retry) ? Number(retry)*1000 : Math.max(0,Date.parse(retry)-Date.now())
        return { ok:false,error:{ code,message:'Repite no ha podido completar la operación.',retryable:code === 'rate_limited' || code === 'unavailable',...(Number.isFinite(retryAfterMs) && retryAfterMs>0 ? { retryAfterMs } : {}) } }
      }
      return { ok:true,value:schema.parse(await response.json()) }
    } catch { return { ok:false,error:{ code:'unavailable',message:'Repite no responde o su respuesta no es válida.',retryable:true } } }
  }
  const merchant = (id:string) => `/merchants/${encodeURIComponent(id)}`
  const card = (p:{merchantId:string;cardId:string}) => `${merchant(p.merchantId)}/cards/${encodeURIComponent(p.cardId)}`
  const count = z.number().int().min(0), previous = z.object({ visits:count,newCustomers:count,returningCustomers:count,rewardsRedeemed:count,noticesSent:count,returnedAfterNotice:count })
  return {
    createCard:p => call(`${merchant(p.merchantId)}/cards`,'POST',{ externalRef:p.externalRef,displayName:p.displayName,language:p.language },p.idempotencyKey,z.object({ cardId:z.string().min(1),saveUrl:z.string().nullable() })),
    addStamp:p => call(`${card(p)}/stamps`,'POST',{ visitKey:p.visitKey,trigger:p.trigger,occurredAt:p.occurredAt },p.idempotencyKey,z.object({ stampId:z.string(),stamps:count,stampsForReward:count.min(1),rewardReady:z.boolean(),duplicate:z.boolean() })),
    getCard:p => call(card(p),'GET',undefined,undefined,core.RepiteCardStateSchema),
    sendWeMissYou:p => call(`${card(p)}/notices/we-miss-you`,'POST',{},p.idempotencyKey,z.object({ status:z.enum(['scheduled','rate_limited','not_in_wallet']),noticeId:z.string().nullable(),duplicate:z.boolean() })),
    monthReport:p => call(`${merchant(p.merchantId)}/reports/${encodeURIComponent(p.month)}`,'GET',undefined,undefined,previous.extend({ month:core.RepiteMonthSchema,previous:previous.nullable() })),
    removeCard:p => call(card(p),'DELETE',undefined,p.idempotencyKey,z.object({ removed:z.literal(true),duplicate:z.boolean() })),
  }
}
export const adapter = () => httpRepite(process.env.REPITE_API_URL,process.env.REPITE_API_TOKEN)
