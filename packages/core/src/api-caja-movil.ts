/** Cobro móvil y recibo digital en el VPS: respuestas completas de las operaciones públicas y las dos de la mesa por QR. */
import { z } from "zod"
import { DocIdSchema, SlugSchema, LanguageSchema } from "./model"
import { LinkTokenSchema } from "./ids"
import { MessageStatusSchema } from "./message-model"
import { AmountCentsSchema, PosRevisionSchema } from "./caja"
import {
  PublicBillSchema, VerReciboDigitalOutputSchema, CrearEnlaceCobroOutputSchema, IniciarPagoCuentaInputSchema,
} from "./api-caja"

export const VerCobroPublicoVpsOutputSchema = PublicBillSchema.extend({
  brandColor: z.string(), paymentsEnabled: z.boolean(), tipCents: AmountCentsSchema, paidCents: AmountCentsSchema,
  receiptPath: z.string().nullable(), invoicePending: z.boolean(), delivery: MessageStatusSchema.or(z.literal("none")),
  paymentInProgress: z.boolean().optional(), checkoutUrl: z.string().nullable().optional(),
})
export const IniciarPagoCuentaVpsInputSchema = IniciarPagoCuentaInputSchema.extend({ language: LanguageSchema.default("es") })
export const VerReciboDigitalVpsOutputSchema = VerReciboDigitalOutputSchema.extend({
  restaurantName: z.string(), locationName: z.string(), brandColor: z.string(), delivery: MessageStatusSchema.or(z.literal("none")), acceptedDigital: z.boolean(),
})
export const PartesPagoMesaInputSchema = z.strictObject({ slug: SlugSchema, locationId: DocIdSchema, tableId: DocIdSchema, token: LinkTokenSchema })
export const VerPartesPagoMesaOutputSchema = z.object({
  restaurantName: z.string(), locationName: z.string(), brandColor: z.string(),
  billId: DocIdSchema, revision: PosRevisionSchema, totalCents: AmountCentsSchema,
  parts: z.array(z.object({ id: DocIdSchema, label: z.string(), amountCents: AmountCentsSchema })),
})
export const ElegirPartePagoMesaInputSchema = PartesPagoMesaInputSchema.extend({ partId: DocIdSchema, billId: DocIdSchema, expectedRevision: PosRevisionSchema, requestId: DocIdSchema })
export const ElegirPartePagoMesaOutputSchema = CrearEnlaceCobroOutputSchema
