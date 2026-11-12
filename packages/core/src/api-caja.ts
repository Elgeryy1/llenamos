/** Callables de caja: entradas estrictas, sin precios enviados por el cliente. */
import { z } from "zod"
import { DocIdSchema, SlugSchema } from "./model"
import { LinkTokenSchema } from "./ids"
import { MillisSchema } from "./timestamp"
import type { Permission } from "./roles"
import {
  AmountCentsSchema, PosReasonSchema, PosRevisionSchema, PosTargetSchema, BillSchema, BillPartSchema,
  CashSessionSchema, PrinterSchema, PosSettingsSchema, FiscalRecipientSchema, InvoiceSchema,
} from "./caja"
const Scope = { restaurantId: DocIdSchema, locationId: DocIdSchema }
const Mutation = { ...Scope, requestId: DocIdSchema }
const Account = { ...Mutation, billId: DocIdSchema, expectedRevision: PosRevisionSchema }
const Ok = z.literal(true)
const Positive = AmountCentsSchema.refine((v) => v > 0, "El importe debe ser mayor que cero.")
export const PosSplitSpecSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("equal"), parts: z.number().int().min(1).max(200) }),
  z.strictObject({ kind: z.literal("amount"), amountsCents: z.array(AmountCentsSchema).min(1).max(200) }),
  z.strictObject({ kind: z.literal("dishes"), lineIds: z.array(z.array(DocIdSchema).min(1).max(1000)).min(1).max(200) }),
])
export const GuardarConfiguracionCajaInputSchema = z.strictObject({ ...Mutation, settings: PosSettingsSchema })
export const GuardarConfiguracionCajaOutputSchema = z.object({ ok: Ok })
export const AbrirCajaInputSchema = z.strictObject({ ...Mutation, registerId: DocIdSchema, openingCents: AmountCentsSchema })
export const AbrirCajaOutputSchema = z.object({ cashSessionId: DocIdSchema })
export const CerrarCajaInputSchema = z.strictObject({ ...Mutation, cashSessionId: DocIdSchema, countedCents: AmountCentsSchema, reason: PosReasonSchema.nullable() })
export const CerrarCajaOutputSchema = z.object({ ok: Ok, cashSession: CashSessionSchema })
export const RegistrarMovimientoCajaInputSchema = z.strictObject({ ...Mutation, cashSessionId: DocIdSchema, kind: z.enum(["in", "out"]), amountCents: Positive, reason: PosReasonSchema })
export const RegistrarMovimientoCajaOutputSchema = z.object({ movementId: DocIdSchema })
export const AbrirCuentaInputSchema = z.strictObject({ ...Mutation, target: PosTargetSchema })
export const AbrirCuentaOutputSchema = z.object({ billId: DocIdSchema, bill: BillSchema })
export const VerCuentaInputSchema = z.strictObject({ ...Scope, billId: DocIdSchema })
export const VerCuentaOutputSchema = z.object({ bill: BillSchema, parts: z.array(BillPartSchema.extend({ id: DocIdSchema })) })
export const AjustarCuentaInputSchema = z.strictObject({ ...Account, lineId: DocIdSchema, kind: z.enum(["invitation", "void"]), amountCents: Positive, reason: PosReasonSchema })
export const AjustarCuentaOutputSchema = z.object({ ok: Ok, revision: PosRevisionSchema, totalCents: AmountCentsSchema })
export const DividirCuentaInputSchema = z.strictObject({ ...Account, split: PosSplitSpecSchema })
export const DividirCuentaOutputSchema = z.object({ revision: PosRevisionSchema, parts: z.array(BillPartSchema.extend({ id: DocIdSchema })) })
export const PrepararCobroInputSchema = z.strictObject({ ...Account })
export const PrepararCobroOutputSchema = z.object({ ok: Ok, revision: PosRevisionSchema })
export const DesbloquearCuentaInputSchema = z.strictObject({ ...Account, reason: PosReasonSchema })
export const DesbloquearCuentaOutputSchema = z.object({ ok: Ok, revision: PosRevisionSchema })
export const RegistrarCobroInputSchema = z.strictObject({
  ...Account, partId: DocIdSchema, cashSessionId: DocIdSchema,
  method: z.enum(["cash", "card", "deposit"]), amountCents: Positive, tipCents: AmountCentsSchema.default(0),
  tenderedCents: AmountCentsSchema.default(0), terminalReference: z.string().trim().min(1).max(100).nullable().default(null),
}).superRefine((v, ctx) => {
  if (v.method !== "cash" && v.tenderedCents !== 0) ctx.addIssue({ code: "custom", message: "Solo el efectivo lleva entrega." })
  if (v.method === "card" && !v.terminalReference) ctx.addIssue({ code: "custom", message: "Anota la referencia del datáfono." })
  if (v.method === "deposit" && v.tipCents !== 0) ctx.addIssue({ code: "custom", message: "La señal no se usa como propina." })
})
export const RegistrarCobroOutputSchema = z.object({ paymentId: DocIdSchema, changeCents: AmountCentsSchema, dueCents: AmountCentsSchema })
export const DevolverCobroInputSchema = z.strictObject({ ...Mutation, paymentId: DocIdSchema, amountCents: AmountCentsSchema, tipCents: AmountCentsSchema.default(0), reason: PosReasonSchema }).refine((v) => v.amountCents > 0 || v.tipCents > 0, "La devolución necesita un importe.")
export const DevolverCobroOutputSchema = z.object({ refundId: DocIdSchema, status: z.enum(["succeeded", "pending", "not_configured"]) })
export const EmitirFacturaInputSchema = z.strictObject({ ...Account, partId: DocIdSchema, type: z.enum(["F1", "F2"]), recipient: FiscalRecipientSchema.nullable(), qualifiedSimplified: z.boolean().default(false) })
export const EmitirFacturaOutputSchema = z.object({ invoiceId: DocIdSchema, recordId: DocIdSchema, number: z.string(), fiscalStatus: z.enum(["queued", "not_configured"]), warning: z.string().nullable() })
export const RectificarFacturaInputSchema = z.strictObject({
  ...Mutation, invoiceId: DocIdSchema, type: z.enum(["R1", "R2", "R3", "R4", "R5"]), mode: z.enum(["I", "S"]), reason: PosReasonSchema,
  /** Referencias a líneas originales y reducción de su total, nunca un precio libre. */
  reductions: z.array(z.strictObject({ lineIndex: z.number().int().min(0), amountCents: Positive })).min(1).max(1000),
})
export const RectificarFacturaOutputSchema = EmitirFacturaOutputSchema
export const SustituirSimplificadaInputSchema = z.strictObject({ ...Mutation, invoiceId: DocIdSchema, recipient: FiscalRecipientSchema })
export const SustituirSimplificadaOutputSchema = EmitirFacturaOutputSchema
export const AnularRegistroFiscalInputSchema = z.strictObject({ ...Mutation, invoiceId: DocIdSchema, reason: PosReasonSchema })
export const AnularRegistroFiscalOutputSchema = z.object({ recordId: DocIdSchema, fiscalStatus: z.enum(["queued", "not_configured"]) })
export const RepartirPropinasInputSchema = z.strictObject({ ...Mutation, cashSessionId: DocIdSchema, hours: z.array(z.strictObject({ uid: z.string().min(1).max(128), minutes: z.number().int().min(0).max(44640) })).min(1).max(200) })
export const RepartirPropinasOutputSchema = z.object({ distributionId: DocIdSchema, shares: z.array(z.object({ uid: z.string(), minutes: z.number().int(), amountCents: AmountCentsSchema })) })
export const GuardarImpresoraInputSchema = z.strictObject({ ...Mutation, printerId: DocIdSchema.nullable(), printer: PrinterSchema })
export const GuardarImpresoraOutputSchema = z.object({ printerId: DocIdSchema })
export const VincularPuenteInputSchema = z.strictObject({ ...Mutation, bridgeId: DocIdSchema })
export const VincularPuenteOutputSchema = z.object({ token: LinkTokenSchema })
export const SolicitarImpresionInputSchema = z.strictObject({ ...Mutation, printerId: DocIdSchema, kind: z.enum(["prebill", "invoice", "kitchen", "drawer", "test"]), sourceId: DocIdSchema, copy: z.boolean().default(false) })
export const SolicitarImpresionOutputSchema = z.object({ printJobId: DocIdSchema, status: z.enum(["queued", "not_configured"]) })
const Bridge = { ...Scope, bridgeId: DocIdSchema, token: LinkTokenSchema }
export const ReclamarImpresionesInputSchema = z.strictObject({ ...Bridge, limit: z.number().int().min(1).max(20).default(5) })
export const ReclamarImpresionesOutputSchema = z.object({ jobs: z.array(z.object({ id: DocIdSchema, printerId: DocIdSchema, payloadHash: z.string().regex(/^[a-f0-9]{64}$/), payloadBase64: z.string(), leaseToken: LinkTokenSchema, leaseUntil: MillisSchema })) })
export const ConfirmarImpresionInputSchema = z.strictObject({ ...Bridge, printJobId: DocIdSchema, leaseToken: LinkTokenSchema, status: z.enum(["printed", "failed", "uncertain"]), error: z.string().max(300).nullable() })
export const ConfirmarImpresionOutputSchema = z.object({ ok: Ok })
/** Token distinto al QR de mesa: una cuenta y revisión, con caducidad y saldo revalidado. */
export const CrearEnlaceCobroInputSchema = z.strictObject({ ...Account, partId: DocIdSchema })
export const CrearEnlaceCobroOutputSchema = z.object({ checkoutId: DocIdSchema, token: LinkTokenSchema, path: z.string(), expiresAt: MillisSchema })
const Checkout = { slug: SlugSchema, locationId: DocIdSchema, checkoutId: DocIdSchema, token: LinkTokenSchema }
export const PublicBillSchema = z.object({
  restaurantName: z.string(), locationName: z.string(), label: z.string(),
  lines: z.array(z.object({ name: z.string(), amountCents: AmountCentsSchema })),
  amountCents: AmountCentsSchema, expiresAt: MillisSchema,
  status: z.enum(["pending", "paid", "expired", "failed", "reconciliation_required"]),
})
export const VerCobroPublicoInputSchema = z.strictObject(Checkout)
export const VerCobroPublicoOutputSchema = PublicBillSchema
export const IniciarPagoCuentaInputSchema = z.strictObject({ ...Checkout, requestId: DocIdSchema, tipCents: AmountCentsSchema.default(0), recipient: FiscalRecipientSchema.nullable().default(null), acceptDigitalReceipt: z.boolean(), email: z.email().nullable().default(null), website: z.string().max(0).default("") })
export const IniciarPagoCuentaOutputSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), url: z.string().url() }),
  z.object({ status: z.literal("not_configured"), message: z.string() }),
])
const ReceiptLink = { slug: SlugSchema, locationId: DocIdSchema, receiptId: DocIdSchema, token: LinkTokenSchema }
export const CrearReciboDigitalInputSchema = z.strictObject({ ...Mutation, invoiceId: DocIdSchema, email: z.email().nullable(), acceptDigitalReceipt: z.boolean() })
export const CrearReciboDigitalOutputSchema = z.object({ receiptId: DocIdSchema, token: LinkTokenSchema, path: z.string(), delivery: z.enum(["none", "queued", "captured", "not_configured"]) })
export const VerReciboDigitalInputSchema = z.strictObject(ReceiptLink)
export const VerReciboDigitalOutputSchema = z.object({
  invoice: z.object(InvoiceSchema.shape).omit({ billId: true, partId: true, seriesId: true, sequence: true }).extend({ lines: z.array(z.object(InvoiceSchema.shape.lines.element.shape).omit({ sourceLineId: true })) }),
  qrUrl: z.string().nullable(), legend: z.string().nullable(), warning: z.string().nullable(),
})

/** El personal anula un intento de pago móvil vivo (libera la parte) o da por revisada una incidencia de cobro móvil. */
export const CancelarCobroMovilInputSchema = z.strictObject({ ...Mutation, checkoutId: DocIdSchema, reason: PosReasonSchema })
export const CancelarCobroMovilOutputSchema = z.object({ ok: Ok, status: z.enum(["expired", "already_final"]) })
export const ResolverIncidenciaMovilInputSchema = z.strictObject({ ...Mutation, incidentId: DocIdSchema, reason: PosReasonSchema })
export const ResolverIncidenciaMovilOutputSchema = z.object({ ok: Ok })

export const CALLABLES_FASE3 = {
  guardarConfiguracionCaja: "guardarConfiguracionCaja",
  abrirCaja: "abrirCaja",
  cerrarCaja: "cerrarCaja",
  registrarMovimientoCaja: "registrarMovimientoCaja",
  abrirCuenta: "abrirCuenta",
  verCuenta: "verCuenta",
  ajustarCuenta: "ajustarCuenta",
  dividirCuenta: "dividirCuenta",
  prepararCobro: "prepararCobro",
  desbloquearCuenta: "desbloquearCuenta",
  registrarCobro: "registrarCobro",
  devolverCobro: "devolverCobro",
  emitirFactura: "emitirFactura",
  rectificarFactura: "rectificarFactura",
  sustituirSimplificada: "sustituirSimplificada",
  anularRegistroFiscal: "anularRegistroFiscal",
  repartirPropinas: "repartirPropinas",
  guardarImpresora: "guardarImpresora",
  vincularPuente: "vincularPuente",
  solicitarImpresion: "solicitarImpresion",
  reclamarImpresiones: "reclamarImpresiones",
  confirmarImpresion: "confirmarImpresion",
  crearEnlaceCobro: "crearEnlaceCobro",
  verCobroPublico: "verCobroPublico",
  iniciarPagoCuenta: "iniciarPagoCuenta",
  crearReciboDigital: "crearReciboDigital",
  verReciboDigital: "verReciboDigital",
  cancelarCobroMovil: "cancelarCobroMovil",
  resolverIncidenciaMovil: "resolverIncidenciaMovil",
} as const

export const CALLABLE_SCHEMAS_FASE3 = {
  guardarConfiguracionCaja: { input: GuardarConfiguracionCajaInputSchema, output: GuardarConfiguracionCajaOutputSchema },
  abrirCaja: { input: AbrirCajaInputSchema, output: AbrirCajaOutputSchema },
  cerrarCaja: { input: CerrarCajaInputSchema, output: CerrarCajaOutputSchema },
  registrarMovimientoCaja: { input: RegistrarMovimientoCajaInputSchema, output: RegistrarMovimientoCajaOutputSchema },
  abrirCuenta: { input: AbrirCuentaInputSchema, output: AbrirCuentaOutputSchema },
  verCuenta: { input: VerCuentaInputSchema, output: VerCuentaOutputSchema },
  ajustarCuenta: { input: AjustarCuentaInputSchema, output: AjustarCuentaOutputSchema },
  dividirCuenta: { input: DividirCuentaInputSchema, output: DividirCuentaOutputSchema },
  prepararCobro: { input: PrepararCobroInputSchema, output: PrepararCobroOutputSchema },
  desbloquearCuenta: { input: DesbloquearCuentaInputSchema, output: DesbloquearCuentaOutputSchema },
  registrarCobro: { input: RegistrarCobroInputSchema, output: RegistrarCobroOutputSchema },
  devolverCobro: { input: DevolverCobroInputSchema, output: DevolverCobroOutputSchema },
  emitirFactura: { input: EmitirFacturaInputSchema, output: EmitirFacturaOutputSchema },
  rectificarFactura: { input: RectificarFacturaInputSchema, output: RectificarFacturaOutputSchema },
  sustituirSimplificada: { input: SustituirSimplificadaInputSchema, output: SustituirSimplificadaOutputSchema },
  anularRegistroFiscal: { input: AnularRegistroFiscalInputSchema, output: AnularRegistroFiscalOutputSchema },
  repartirPropinas: { input: RepartirPropinasInputSchema, output: RepartirPropinasOutputSchema },
  guardarImpresora: { input: GuardarImpresoraInputSchema, output: GuardarImpresoraOutputSchema },
  vincularPuente: { input: VincularPuenteInputSchema, output: VincularPuenteOutputSchema },
  solicitarImpresion: { input: SolicitarImpresionInputSchema, output: SolicitarImpresionOutputSchema },
  reclamarImpresiones: { input: ReclamarImpresionesInputSchema, output: ReclamarImpresionesOutputSchema },
  confirmarImpresion: { input: ConfirmarImpresionInputSchema, output: ConfirmarImpresionOutputSchema },
  crearEnlaceCobro: { input: CrearEnlaceCobroInputSchema, output: CrearEnlaceCobroOutputSchema },
  verCobroPublico: { input: VerCobroPublicoInputSchema, output: VerCobroPublicoOutputSchema },
  iniciarPagoCuenta: { input: IniciarPagoCuentaInputSchema, output: IniciarPagoCuentaOutputSchema },
  crearReciboDigital: { input: CrearReciboDigitalInputSchema, output: CrearReciboDigitalOutputSchema },
  verReciboDigital: { input: VerReciboDigitalInputSchema, output: VerReciboDigitalOutputSchema },
  cancelarCobroMovil: { input: CancelarCobroMovilInputSchema, output: CancelarCobroMovilOutputSchema },
  resolverIncidenciaMovil: { input: ResolverIncidenciaMovilInputSchema, output: ResolverIncidenciaMovilOutputSchema },
} as const satisfies Record<keyof typeof CALLABLES_FASE3, { input: z.ZodType; output: z.ZodType }>

/** Además: miembro activo, local permitido y comprobaciones transaccionales del contrato. */
export const FASE3_ACCESS: Record<keyof typeof CALLABLES_FASE3, { permission: Permission | "public" | "bridge"; modules: readonly ("pos" | "floor")[] }> = {
  guardarConfiguracionCaja: { permission: "caja.configurar", modules: ["pos"] },
  abrirCaja: { permission: "caja.gestionar", modules: ["pos"] },
  cerrarCaja: { permission: "caja.gestionar", modules: ["pos"] },
  registrarMovimientoCaja: { permission: "caja.gestionar", modules: ["pos"] },
  abrirCuenta: { permission: "caja.cobrar", modules: ["pos", "floor"] },
  verCuenta: { permission: "caja.ver", modules: ["pos", "floor"] },
  ajustarCuenta: { permission: "caja.rectificar", modules: ["pos", "floor"] },
  dividirCuenta: { permission: "caja.cobrar", modules: ["pos", "floor"] },
  prepararCobro: { permission: "caja.cobrar", modules: ["pos", "floor"] },
  desbloquearCuenta: { permission: "caja.rectificar", modules: ["pos", "floor"] },
  registrarCobro: { permission: "caja.cobrar", modules: ["pos", "floor"] },
  devolverCobro: { permission: "caja.rectificar", modules: ["pos"] },
  emitirFactura: { permission: "caja.cobrar", modules: ["pos"] },
  rectificarFactura: { permission: "caja.rectificar", modules: ["pos"] },
  sustituirSimplificada: { permission: "caja.cobrar", modules: ["pos"] },
  anularRegistroFiscal: { permission: "caja.rectificar", modules: ["pos"] },
  repartirPropinas: { permission: "caja.gestionar", modules: ["pos"] },
  guardarImpresora: { permission: "impresion.gestionar", modules: ["pos"] },
  vincularPuente: { permission: "impresion.gestionar", modules: ["pos"] },
  solicitarImpresion: { permission: "caja.cobrar", modules: ["pos"] },
  reclamarImpresiones: { permission: "bridge", modules: ["pos"] },
  confirmarImpresion: { permission: "bridge", modules: ["pos"] },
  crearEnlaceCobro: { permission: "caja.cobrar", modules: ["pos", "floor"] },
  verCobroPublico: { permission: "public", modules: ["pos", "floor"] },
  iniciarPagoCuenta: { permission: "public", modules: ["pos", "floor"] },
  crearReciboDigital: { permission: "caja.cobrar", modules: ["pos"] },
  verReciboDigital: { permission: "public", modules: ["pos"] },
  cancelarCobroMovil: { permission: "caja.rectificar", modules: ["pos", "floor"] },
  resolverIncidenciaMovil: { permission: "caja.gestionar", modules: ["pos"] },
}
