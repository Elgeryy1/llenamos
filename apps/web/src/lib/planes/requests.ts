import { CALLABLE_SCHEMAS_FASE6, type CallableInput } from '@llenamos/core'
import { llamarCore } from '@/lib/data/callables'

export type PendingBilling = { name:'iniciarSuscripcion';input:CallableInput<'iniciarSuscripcion'> } | { name:'abrirPortalFacturacion';input:CallableInput<'abrirPortalFacturacion'> } | { name:'cancelarSuscripcion';input:CallableInput<'cancelarSuscripcion'> }
export const billingStorageKey = (uid: string, rid: string) => `llenamos:billing:v1:${uid}:${rid}`
export function readBillingRequest(key: string): PendingBilling | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const value = JSON.parse(raw) as PendingBilling
    if (!['iniciarSuscripcion','abrirPortalFacturacion','cancelarSuscripcion'].includes(value.name)) return null
    if (!CALLABLE_SCHEMAS_FASE6[value.name].input.safeParse(value.input).success) return null
    return value
  } catch { return null }
}
export function sendBillingRequest(pending: PendingBilling) {
  if (pending.name==='iniciarSuscripcion') return llamarCore(pending.name,pending.input)
  if (pending.name==='cancelarSuscripcion') return llamarCore(pending.name,pending.input)
  return llamarCore(pending.name,pending.input)
}
