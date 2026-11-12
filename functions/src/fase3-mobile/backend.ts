import type { CallableOutput, CallableParsedInput, ConfirmedExternalPayment } from '@llenamos/core'
import { HttpsError } from 'firebase-functions/v2/https'

/** Puerto del backend de caja. El coordinador conecta service.ts al integrar ambas ramas. */
export interface CajaServices {
  confirmExternalPayment(data: ConfirmedExternalPayment): Promise<{ paymentId: string; dueCents: number }>
  issuePartInvoice(data: CallableParsedInput<'emitirFactura'>, actorUid: string | null): Promise<CallableOutput<'emitirFactura'>>
}
let services: CajaServices | null = null
export function connectCajaServices(value: CajaServices) { services = value }
export function cajaServices() {
  if (!services) throw new HttpsError('unavailable', 'El backend de caja todavía no está conectado. El cobro queda pendiente de reconciliación.')
  return services
}
export function cajaConnected() { return services !== null }
