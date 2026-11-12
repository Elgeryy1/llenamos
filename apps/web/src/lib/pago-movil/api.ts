import { z } from 'zod'
import * as core from '@llenamos/core'
import { callableUrl } from '@/lib/publica/callables'
import { dataBackend } from '@/lib/api/config'
import { ApiCallError, postOperation } from '@/lib/api/transport'
import type { FirebaseSettings } from '@/lib/firebase/config'

export const schemas = {
  verCobroPublico: { input: core.VerCobroPublicoInputSchema, output: core.VerCobroPublicoVpsOutputSchema },
  iniciarPagoCuenta: { input: core.IniciarPagoCuentaVpsInputSchema, output: core.IniciarPagoCuentaOutputSchema },
  verReciboDigital: { input: core.VerReciboDigitalInputSchema, output: core.VerReciboDigitalVpsOutputSchema },
  verPartesPagoMesa: { input: core.PartesPagoMesaInputSchema, output: core.VerPartesPagoMesaOutputSchema },
  elegirPartePagoMesa: { input: core.ElegirPartePagoMesaInputSchema, output: core.ElegirPartePagoMesaOutputSchema },
} as const
export type CheckoutLink = core.CallableInput<'verCobroPublico'>
export type TableLink = z.input<typeof core.PartesPagoMesaInputSchema>
export type ReceiptLink = core.CallableInput<'verReciboDigital'>
export type PublicBill = z.output<typeof schemas.verCobroPublico.output>
export type PublicReceipt = z.output<typeof schemas.verReciboDigital.output>
export type Parts = z.output<typeof schemas.verPartesPagoMesa.output>
export class MobileError extends Error { constructor(readonly code: string) { super(code) } }
/**
 * Llamadas públicas del pago móvil y el recibo. En el VPS van a la API (`/api/v1/operations/:name`, sin identidad ni
 * cookies); en la demo, a las callables de los emuladores. Entrada y salida se validan con los esquemas del contrato.
 */
export async function mobileCall<N extends keyof typeof schemas>(settings: FirebaseSettings | null, name: N,
  input: z.input<(typeof schemas)[N]['input']>, fetcher: typeof fetch = fetch): Promise<z.output<(typeof schemas)[N]['output']>> {
  let backend: 'postgres' | 'firebase-demo'
  try { backend = dataBackend(settings) } catch { throw new MobileError('config') }
  const data = (schemas[name].input as z.ZodType).parse(input)
  if (backend === 'postgres') {
    let result: unknown
    try { result = await postOperation(name, data, { authentication: 'none', fetcher, timeoutMs: 20000 }) }
    catch (error) { throw new MobileError(error instanceof ApiCallError ? error.code : 'network') }
    return schemas[name].output.parse(result) as z.output<(typeof schemas)[N]['output']>
  }
  if (!settings) throw new MobileError('config')
  let response: Response, json: { result?: unknown; error?: { status: string } }
  try {
    response = await fetcher(callableUrl(settings, name), { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data }), cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(20000) })
    json = await response.json()
  } catch { throw new MobileError('network') }
  if (!response.ok || json.error) throw new MobileError(json.error?.status ?? (response.status === 404 ? 'not-deployed' : 'internal'))
  return schemas[name].output.parse(json.result) as z.output<(typeof schemas)[N]['output']>
}
export function money(cents: number, language: core.Language) {
  return new Intl.NumberFormat(language, { style: 'currency', currency: 'EUR' }).format(cents / 100)
}
/** La propina se convierte por texto para no introducir decimales binarios en dinero. */
export function tipFromText(raw: string) {
  if (!/^\d{1,5}([.,]\d{0,2})?$/.test(raw)) return null
  const [whole, decimals = ''] = raw.replace(',', '.').split('.')
  return Number(whole) * 100 + Number(decimals.padEnd(2, '0'))
}
export function privatePath(path: string, prefix: '/p/' | '/recibo/') {
  const u = new URL(path, 'https://local.invalid')
  if (u.origin !== 'https://local.invalid' || !u.pathname.startsWith(prefix)) throw new MobileError('internal')
  return u.pathname + u.search
}
export function stripeRedirect(value: string) {
  const u = new URL(value)
  if (u.protocol !== 'https:' || u.hostname !== 'checkout.stripe.com' || u.username || u.password || u.port) throw new MobileError('internal')
  return u.href
}
