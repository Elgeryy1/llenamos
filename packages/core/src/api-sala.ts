/**
 * Entradas y salidas de las callables de la fase 2 (sala y cocina), región europe-west1.
 *
 * Mismas convenciones que `api.ts` (y se registran allí, en `CALLABLES` y
 * `CALLABLE_SCHEMAS`): entradas estrictas, salidas abiertas, instantes en ms UTC, teléfonos
 * normalizados a E.164 y campo trampa `website` en las públicas que envían un formulario.
 * Este archivo no importa `api.ts` (es al revés), para no crear un ciclo.
 *
 * Los pedidos **no** traen precios: traen qué se pide (`OrderLineInput`) y, en los públicos,
 * el total que ha visto el cliente (`expectedTotalCents`). El servidor recalcula con
 * `priceOrder` contra la carta guardada; si algo no vale, responde `status: "rejected"` con
 * los problemas por línea (no es un error: la pantalla los marca).
 */
import { z } from "zod"
import {
  CourseSchema,
  DailyMenuEditableSchema,
  MenuCategorySchema,
  MenuItemEditableSchema,
  PartIdSchema,
  StationSchema,
} from "./carta/modelo"
import { OrderLinesInputSchema, OrderProblemSchema, PublicOrderLinesInputSchema } from "./carta/pedido"
import { PUBLIC_LINE_STATUSES } from "./carta/i18n"
import { menuTextSchema } from "./carta/textos"
import { LinkTokenSchema, ReservationReferenceInputSchema, ReservationReferenceSchema } from "./ids"
import { DocIdSchema, LanguageSchema, SlugSchema } from "./model"
import { PhoneInputSchema } from "./phone"
import { EmailSchema, GuestNameSchema, NotesSchema } from "./reservation-model"
import { FechaSchema, HoraSchema, ZonaHorariaSchema } from "./reservas/tiempo"
import {
  FireModeSchema,
  FloorSettingsSchema,
  FloorTaskStatusSchema,
  LineStatusSchema,
  MAX_SESSION_TABLES,
  OrderStatusSchema,
  TableSessionStatusSchema,
  TakeawayStatusSchema,
} from "./sala/modelo"
import { PICKUP_SLOT_REASONS } from "./sala/para-llevar"
import type { Permission } from "./roles"
import { MessageStatusSchema } from "./message-model"
import { MillisSchema } from "./timestamp"

/* Piezas comunes ------------------------------------------------------------------------- */

const Staff = { restaurantId: DocIdSchema, locationId: DocIdSchema }
const Ok = z.literal(true)
const Reason = z.string().trim().max(200, "Como mucho 200 caracteres.")
const Honeypot = z.string().max(0, "Solicitud no válida.").default("")
const OptionalEmail = z
  .union([z.string().max(320), z.null()])
  .optional()
  .transform((v) => (typeof v === "string" && v.trim() !== "" ? v : null))
  .pipe(EmailSchema.nullable())

function idsUnicos(max: number, min = 1) {
  return z
    .array(DocIdSchema)
    .min(min)
    .max(max)
    .refine((ids) => new Set(ids).size === ids.length, "Hay ids repetidos.")
}

const TableIds = idsUnicos(MAX_SESSION_TABLES)
const OrderProblems = z.array(OrderProblemSchema)

/** Exactamente una de las dos: mesa o para llevar. */
function unDestino(v: { sessionId: string | null; takeawayId: string | null }, ctx: z.RefinementCtx) {
  if ((v.sessionId === null) === (v.takeawayId === null)) {
    ctx.addIssue({ code: "custom", path: ["sessionId"], message: "Indica la mesa o el pedido para llevar (uno de los dos)." })
  }
}

/* Carta (`carta.editar`, `carta.agotar`) --------------------------------------------------- */

export const GuardarCategoriaCartaInputSchema = z.strictObject({
  ...Staff,
  /** null = categoría nueva. */
  categoryId: DocIdSchema.nullable(),
  category: MenuCategorySchema,
})
export const GuardarCategoriaCartaOutputSchema = z.object({ ok: Ok, categoryId: DocIdSchema })

export const GuardarPlatoInputSchema = z.strictObject({
  ...Staff,
  /** null = plato nuevo. */
  itemId: DocIdSchema.nullable(),
  item: MenuItemEditableSchema,
})
export const GuardarPlatoOutputSchema = z.object({
  ok: Ok,
  itemId: DocIdSchema,
  version: z.number().int().min(1),
  /** Si el guardado ha cambiado el precio (y por tanto la versión). */
  priceChanged: z.boolean(),
})

export const GuardarMenuDiaInputSchema = z.strictObject({
  ...Staff,
  dailyMenuId: DocIdSchema.nullable(),
  menu: DailyMenuEditableSchema,
})
export const GuardarMenuDiaOutputSchema = z.object({ ok: Ok, dailyMenuId: DocIdSchema, version: z.number().int().min(1), priceChanged: z.boolean() })

/** Reordenar al arrastrar: posiciones nuevas de categorías y platos (y cambio de categoría). */
export const OrdenarCartaInputSchema = z.strictObject({
  ...Staff,
  categories: z.array(z.strictObject({ id: DocIdSchema, sortOrder: z.number().int() })).max(100).default([]),
  items: z.array(z.strictObject({ id: DocIdSchema, categoryId: DocIdSchema, sortOrder: z.number().int() })).max(500).default([]),
})
export const OrdenarCartaOutputSchema = z.object({ ok: Ok })

export const MarcarAgotadoInputSchema = z.strictObject({
  ...Staff,
  itemId: DocIdSchema,
  /** Un extra concreto del plato; null = el plato entero. */
  optionId: PartIdSchema.nullable().default(null),
  variantId: PartIdSchema.nullable().optional(),
  soldOut: z.boolean(),
}).refine(v => !(v.optionId && v.variantId), "Elige una variante o un extra.")
export const MarcarAgotadoOutputSchema = z.object({ ok: Ok, soldOut: z.boolean() })

/* Ajustes de sala y cocina (`sala.configurar`) ----------------------------------------------- */

export const GuardarEstacionInputSchema = z.strictObject({
  ...Staff,
  stationId: DocIdSchema.nullable(),
  station: StationSchema,
})
export const GuardarEstacionOutputSchema = z.object({ ok: Ok, stationId: DocIdSchema })

export const GuardarConfiguracionSalaInputSchema = z.strictObject({ ...Staff, settings: FloorSettingsSchema })
export const GuardarConfiguracionSalaOutputSchema = z.object({ ok: Ok })

/** Genera (o cambia) el QR. El servidor conserva el secreto para reimpresiones autorizadas. */
export const RegenerarQrMesaInputSchema = z.strictObject({ ...Staff, tableIds: idsUnicos(100) })
export const RegenerarQrMesaOutputSchema = z.object({
  tokens: z.array(z.object({ tableId: DocIdSchema, token: LinkTokenSchema, /** `tableQrPath(...)`. */ path: z.string() })),
})

/** Recuperación sin rotación; importar conserva enlaces antiguos que solo tenían hash. */
export const RecuperarQrMesaInputSchema = z.strictObject({ ...Staff, tableIds: idsUnicos(100) })
export const RecuperarQrMesaOutputSchema = z.object({
  tokens: RegenerarQrMesaOutputSchema.shape.tokens,
  unavailable: z.array(z.object({ tableId: DocIdSchema, reason: z.enum(["missing", "revoked", "legacy"]) })),
})
export const RevocarQrMesaInputSchema = z.strictObject({ ...Staff, tableIds: idsUnicos(100) })
export const RevocarQrMesaOutputSchema = z.object({ ok: Ok })
export const ImportarQrMesaInputSchema = z.strictObject({ ...Staff, tableId: DocIdSchema, token: LinkTokenSchema })
export const ImportarQrMesaOutputSchema = RegenerarQrMesaOutputSchema

/* Mesas (`sala.gestionar`) -------------------------------------------------------------- */

export const AbrirMesaInputSchema = z
  .strictObject({
    ...Staff,
    tableIds: TableIds,
    guests: z.number().int().min(1, "Al menos 1 comensal.").max(200),
    /** Sentar esta reserva (si no lo está) y unir la mesa a ella y a su cliente. */
    reservationId: DocIdSchema.nullable().default(null),
    /** Sin reserva: datos opcionales del cliente para apuntarle el gasto. */
    guest: z.strictObject({ name: GuestNameSchema, phone: PhoneInputSchema }).nullable().default(null),
    /** Camarero responsable; si falta, quien abre. null = nadie. */
    waiterUid: z.string().min(1).max(128).nullable().optional(),
    notes: NotesSchema.default(""),
  })
  .refine((v) => v.reservationId === null || v.guest === null, { message: "Con reserva, el cliente es el de la reserva.", path: ["guest"] })
export const AbrirMesaOutputSchema = z.object({
  sessionId: DocIdSchema,
  label: z.string(),
  /** false si las mesas no están unidas en el plano (se abre igual). */
  joinable: z.boolean(),
  /** Si se ha pasado la reserva a sentada en la misma operación. */
  reservationSeated: z.boolean(),
})

/**
 * Cambiar el estado de una mesa: pedir la cuenta, volver a abierta, cerrar (todo servido o
 * anulado; termina su reserva y apunta el gasto al cliente), reabrir o anular (sin nada pedido).
 */
export const CambiarEstadoMesaInputSchema = z.strictObject({
  ...Staff,
  sessionId: DocIdSchema,
  status: TableSessionStatusSchema.exclude(["merged"]),
  reason: Reason.nullable().optional(),
})
export const CambiarEstadoMesaOutputSchema = z.object({ ok: Ok, status: TableSessionStatusSchema, totalCents: z.number().int().min(0) })

export const EditarMesaInputSchema = z
  .strictObject({
    ...Staff,
    sessionId: DocIdSchema,
    guests: z.number().int().min(1).max(200).optional(),
    waiterUid: z.string().min(1).max(128).nullable().optional(),
    notes: NotesSchema.optional(),
  })
  .refine((v) => v.guests !== undefined || v.waiterUid !== undefined || v.notes !== undefined, "No hay nada que cambiar.")
export const EditarMesaOutputSchema = z.object({ ok: Ok })

export const MoverMesaInputSchema = z.strictObject({ ...Staff, sessionId: DocIdSchema, tableIds: TableIds })
export const MoverMesaOutputSchema = z.object({ ok: Ok, tableIds: z.array(DocIdSchema), label: z.string() })

/** Añadir mesas: las libres se suman; las de otra mesa abierta juntan esa mesa entera aquí. */
export const JuntarMesasInputSchema = z.strictObject({ ...Staff, sessionId: DocIdSchema, tableIds: TableIds })
export const JuntarMesasOutputSchema = z.object({
  ok: Ok,
  tableIds: z.array(DocIdSchema),
  label: z.string(),
  mergedSessionIds: z.array(DocIdSchema),
  joinable: z.boolean(),
})

/** Separar mesas; con `lineIds`, esas mesas abren una mesa nueva con esas líneas. */
export const SepararMesasInputSchema = z.strictObject({
  ...Staff,
  sessionId: DocIdSchema,
  tableIds: TableIds,
  lineIds: idsUnicos(100, 0).default([]),
  /** Comensales de la mesa nueva (si se crea). */
  guests: z.number().int().min(1).max(200).optional(),
})
export const SepararMesasOutputSchema = z.object({
  ok: Ok,
  newSessionId: DocIdSchema.nullable(),
  keepTableIds: z.array(DocIdSchema),
  splitTableIds: z.array(DocIdSchema),
})

/* Comandas y líneas -------------------------------------------------------------------------- */

export const EnviarPedidoInputSchema = z
  .strictObject({
    ...Staff,
    sessionId: DocIdSchema.nullable().default(null),
    takeawayId: DocIdSchema.nullable().default(null),
    requestId: z.string().min(16).max(100).optional(),
    expectedDestination: z.string().max(2000).optional(),
    expectedPrices: z.string().max(100000).optional(),
    lines: OrderLinesInputSchema,
    fire: FireModeSchema.default("auto"),
    note: Reason.default(""),
    /** Si se manda y no coincide con el recalculado, `price_changed`. */
    expectedTotalCents: z.number().int().min(0).nullable().default(null),
  })
  .superRefine(unDestino)

const SentSchema = z.object({
  status: z.literal("sent"),
  orderId: DocIdSchema,
  /** Líneas principales creadas, en el orden de la entrada. */
  lineIds: z.array(DocIdSchema),
  totalCents: z.number().int().min(0),
  /** Total de la mesa (o del para llevar) después del pedido. */
  sessionTotalCents: z.number().int().min(0),
  fired: z.number().int().min(0),
  held: z.number().int().min(0),
})
const RejectedSchema = z.object({ status: z.literal("rejected"), problems: OrderProblems, totalCents: z.number().int().min(0) })

export const EnviarPedidoOutputSchema = z.discriminatedUnion("status", [SentSchema, RejectedSchema])

/** Aceptar o rechazar un pedido desde la mesa o la web (`comandas.tomar`). */
export const DecidirPedidoInputSchema = z.strictObject({
  ...Staff,
  orderId: DocIdSchema,
  decision: z.enum(["accept", "reject"]),
  reason: Reason.nullable().optional(),
  fire: FireModeSchema.default("auto"),
})
export const DecidirPedidoOutputSchema = z.object({ ok: Ok, status: OrderStatusSchema, fired: z.number().int().min(0), held: z.number().int().min(0) })

/** «Marchar»: el pase dado, el siguiente que espera (null) o todo lo que espera ("all"). */
export const MarcharPaseInputSchema = z
  .strictObject({
    ...Staff,
    sessionId: DocIdSchema.nullable().default(null),
    takeawayId: DocIdSchema.nullable().default(null),
    course: z.union([CourseSchema, z.literal("all")]).nullable().default(null),
  })
  .superRefine(unDestino)
export const MarcharPaseOutputSchema = z.object({
  ok: Ok,
  course: z.union([CourseSchema, z.literal("all")]).nullable(),
  lineIds: z.array(DocIdSchema),
})

/**
 * Cambiar el estado de varias líneas a la vez (la cocina termina una comanda, la sala sirve
 * un pase, se anula algo). Todo o nada; las que ya están en ese estado se saltan.
 * Aceptar lo pendiente va por `decidirPedido`, no por aquí.
 */
export const CambiarEstadoLineasInputSchema = z.strictObject({
  ...Staff,
  lineIds: idsUnicos(50),
  status: LineStatusSchema.exclude(["pending"]),
  reason: Reason.nullable().optional(),
})
export const CambiarEstadoLineasOutputSchema = z.object({
  ok: Ok,
  lines: z.array(z.object({ id: DocIdSchema, status: LineStatusSchema })),
  /** Con `autoFireNextCourse`: líneas que han salido solas al servir. */
  firedNext: z.array(DocIdSchema),
})

/* Tareas (`tareas.atender`) ------------------------------------------------------------------ */

export const CrearTareaInputSchema = z.strictObject({
  ...Staff,
  sessionId: DocIdSchema.nullable().default(null),
  tableIds: idsUnicos(MAX_SESSION_TABLES, 0).default([]),
  note: z.string().trim().min(1, "Escribe la tarea.").max(200),
  /** Quien la crea se la queda. */
  claim: z.boolean().default(false),
})
export const CrearTareaOutputSchema = z.object({ taskId: DocIdSchema })

export const CambiarEstadoTareaInputSchema = z.strictObject({
  ...Staff,
  taskId: DocIdSchema,
  action: z.enum(["claim", "release", "done", "cancel"]),
  expectedLineIds: idsUnicos(100, 0).optional(),
})
export const CambiarEstadoTareaOutputSchema = z.discriminatedUnion("result", [
  z.object({ result: z.literal("ok"), status: FloorTaskStatusSchema, claimedBy: z.string().nullable(), claimedByName: z.string().nullable() }),
  /** Otra persona la cogió antes: la pantalla dice «va Lucía». */
  z.object({ result: z.literal("taken"), claimedBy: z.string(), claimedByName: z.string().nullable() }),
])

/* Mesa pública (QR o NFC) --------------------------------------------------------------------- */

/** El QR lleva el token de **esa** mesa: sirve solo para ella. */
const TableLink = { slug: SlugSchema, locationId: DocIdSchema, tableId: DocIdSchema, token: LinkTokenSchema }

const PublicText = menuTextSchema(80)

export const PublicLineComponentSchema = z.object({
  name: PublicText,
  variant: PublicText.nullable(),
  modifiers: z.array(PublicText),
  status: z.enum(PUBLIC_LINE_STATUSES),
})

/** Una línea tal como la ve el cliente: sin estación, tiempos ni notas del personal. */
export const PublicOrderLineSchema = z.object({
  id: DocIdSchema,
  kind: z.enum(["item", "menu"]),
  name: PublicText,
  variant: PublicText.nullable(),
  modifiers: z.array(PublicText),
  components: z.array(PublicLineComponentSchema),
  quantity: z.number().int().min(1),
  /** Con los suplementos de un menú. */
  totalCents: z.number().int().min(0),
  status: z.enum(PUBLIC_LINE_STATUSES),
})
export type PublicOrderLine = z.infer<typeof PublicOrderLineSchema>

export const VerMesaPublicaInputSchema = z.strictObject(TableLink)
export const VerMesaPublicaOutputSchema = z.object({
  restaurantName: z.string(),
  locationName: z.string(),
  tableName: z.string(),
  /** Para escuchar la carta: `publicMenus/{publicMenuId}`. */
  publicMenuId: z.string(),
  /** Hay mesa abierta y el pedido desde la mesa está encendido. */
  canOrder: z.boolean(),
  destination: z.string().optional(),
  requireApproval: z.boolean(),
  callWaiter: z.boolean(),
  requestBill: z.boolean(),
  canViewPayment: z.boolean().optional(),
  /** null = la mesa no está abierta (se ve la carta y se puede llamar al camarero). */
  session: z
    .object({
      sessionId: DocIdSchema,
      status: TableSessionStatusSchema,
      guests: z.number().int(),
      totalCents: z.number().int().min(0),
      lines: z.array(PublicOrderLineSchema),
    })
    .nullable(),
})

export const PedirDesdeMesaInputSchema = z.strictObject({
  ...TableLink,
  /** La mesa abierta que devolvió `verMesaPublica`: si se ha cerrado o movido, no vale. */
  sessionId: DocIdSchema,
  requestId: z.string().min(16).max(100).optional(),
  expectedDestination: z.string().max(2000).optional(),
    expectedPrices: z.string().max(100000).optional(),
  lines: PublicOrderLinesInputSchema,
  expectedTotalCents: z.number().int().min(0),
  language: LanguageSchema,
  note: Reason.default(""),
  website: Honeypot,
})
export const PedirDesdeMesaOutputSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("sent"), orderId: DocIdSchema, totalCents: z.number().int().min(0) }),
  z.object({ status: z.literal("pending_approval"), orderId: DocIdSchema, totalCents: z.number().int().min(0) }),
  RejectedSchema,
])

/** Llamar al camarero (también sin mesa abierta) o pedir la cuenta (con mesa abierta). */
export const AvisarDesdeMesaInputSchema = z.strictObject({
  ...TableLink,
  sessionId: DocIdSchema.nullable().default(null),
  kind: z.enum(["call_waiter", "request_bill"]),
  reason: z.enum(["water", "cutlery", "napkins", "order", "other"]).optional(),
  note: Reason.default(""),
  website: Honeypot,
})
export const AvisarDesdeMesaOutputSchema = z.object({ ok: Ok, taskId: DocIdSchema })

/* Para llevar ------------------------------------------------------------------------------- */

export const ConsultarRecogidaInputSchema = z.strictObject({ slug: SlugSchema, locationId: DocIdSchema, date: FechaSchema })
export const PickupSlotOutputSchema = z.object({
  time: HoraSchema,
  wallDate: FechaSchema,
  startAt: MillisSchema,
  shift: z.string(),
  available: z.boolean(),
  reason: z.enum(PICKUP_SLOT_REASONS).nullable(),
})
export const ConsultarRecogidaOutputSchema = z.object({
  date: FechaSchema,
  timezone: ZonaHorariaSchema,
  /** false si el local no acepta para llevar desde la web (o el módulo está apagado). */
  enabled: z.boolean(),
  slots: z.array(PickupSlotOutputSchema),
})

export const PedirParaLlevarInputSchema = z.strictObject({
  slug: SlugSchema,
  locationId: DocIdSchema,
  date: FechaSchema,
  time: HoraSchema,
  guestName: GuestNameSchema,
  phone: PhoneInputSchema,
  email: OptionalEmail,
  language: LanguageSchema,
  lines: PublicOrderLinesInputSchema,
  expectedTotalCents: z.number().int().min(0),
  notes: NotesSchema.default(""),
  acceptPolicy: z.literal(true, "Tienes que aceptar las condiciones."),
  website: Honeypot,
})
const TakeawayCreated = {
  reference: ReservationReferenceSchema,
  /** Token del enlace de seguimiento. Solo se devuelve aquí. */
  manageToken: LinkTokenSchema,
  pickupAt: MillisSchema,
  totalCents: z.number().int().min(0),
}
export const PedirParaLlevarOutputSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending"), ...TakeawayCreated }),
  z.object({ status: z.literal("accepted"), ...TakeawayCreated }),
  RejectedSchema,
])

export const VerParaLlevarPublicoInputSchema = z.strictObject({ slug: SlugSchema, reference: ReservationReferenceInputSchema, token: LinkTokenSchema })
export const VerParaLlevarPublicoOutputSchema = z.object({
  notifications: z.array(z.object({ channel: z.enum(["email", "whatsapp"]), template: z.enum(["takeaway_accepted", "takeaway_ready"]), status: MessageStatusSchema })).optional(),
  reference: ReservationReferenceSchema,
  status: TakeawayStatusSchema,
  guestName: z.string(),
  pickupAt: MillisSchema,
  timezone: ZonaHorariaSchema,
  locationName: z.string(),
  totalCents: z.number().int().min(0),
  lines: z.array(PublicOrderLineSchema),
})

export const CrearParaLlevarInputSchema = z.strictObject({
  ...Staff,
  date: FechaSchema,
  time: HoraSchema,
  guestName: GuestNameSchema,
  phone: PhoneInputSchema,
  email: OptionalEmail,
  language: LanguageSchema.default("es"),
  source: z.enum(["phone", "walk_in"]),
  lines: OrderLinesInputSchema,
  notes: NotesSchema.default(""),
  fire: FireModeSchema.default("auto"),
})
export const CrearParaLlevarOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("accepted"),
    takeawayId: DocIdSchema,
    orderId: DocIdSchema,
    reference: ReservationReferenceSchema,
    /** Para enviárselo al cliente; el servidor conserva el secreto en una ruta privada. */
    manageToken: LinkTokenSchema,
    pickupAt: MillisSchema,
    totalCents: z.number().int().min(0),
  }),
  RejectedSchema,
])

export const CambiarEstadoParaLlevarInputSchema = z.strictObject({
  ...Staff,
  takeawayId: DocIdSchema,
  status: TakeawayStatusSchema.exclude(["pending"]),
  reason: Reason.nullable().optional(),
})
export const CambiarEstadoParaLlevarOutputSchema = z.object({ ok: Ok, status: TakeawayStatusSchema })

export const ConfiguracionPushInputSchema = z.strictObject(Staff)
export const ConfiguracionPushOutputSchema = z.object({ configured: z.boolean(), publicKey: z.string().nullable(), localCapture: z.boolean(), subscribedEndpoints: z.array(z.string()).default([]) })
export const GuardarSuscripcionPushInputSchema = z.strictObject({
  ...Staff, enabled: z.boolean(), subscription: z.strictObject({
    endpoint: z.string().url().max(2048), keys: z.strictObject({ p256dh: z.string().max(100), auth: z.string().max(40) }),
  }),
})
export const GuardarSuscripcionPushOutputSchema = z.object({ ok: Ok })

/** Contador de producción, con el mismo permiso que agotados. Recuento absoluto de hoy. */
export const GuardarRacionesInputSchema = z.strictObject({
  ...Staff, itemId: DocIdSchema, variantId: PartIdSchema.nullable().default(null),
  remaining: z.number().int().min(0).max(9999).nullable(),
})
export const GuardarRacionesOutputSchema = z.object({ ok: Ok })

/* Tabla ------------------------------------------------------------------------------------ */

/** Nombres de las callables de la fase 2. */
export const CALLABLES_FASE2 = {
  guardarCategoriaCarta: "guardarCategoriaCarta",
  guardarPlato: "guardarPlato",
  guardarMenuDia: "guardarMenuDia",
  ordenarCarta: "ordenarCarta",
  marcarAgotado: "marcarAgotado",
  guardarRaciones: "guardarRaciones",
  configuracionPush: "configuracionPush",
  guardarSuscripcionPush: "guardarSuscripcionPush",
  guardarEstacion: "guardarEstacion",
  guardarConfiguracionSala: "guardarConfiguracionSala",
  recuperarQrMesa: "recuperarQrMesa",
  revocarQrMesa: "revocarQrMesa",
  importarQrMesa: "importarQrMesa",
  regenerarQrMesa: "regenerarQrMesa",
  abrirMesa: "abrirMesa",
  cambiarEstadoMesa: "cambiarEstadoMesa",
  editarMesa: "editarMesa",
  moverMesa: "moverMesa",
  juntarMesas: "juntarMesas",
  separarMesas: "separarMesas",
  enviarPedido: "enviarPedido",
  decidirPedido: "decidirPedido",
  marcharPase: "marcharPase",
  cambiarEstadoLineas: "cambiarEstadoLineas",
  crearTarea: "crearTarea",
  cambiarEstadoTarea: "cambiarEstadoTarea",
  verMesaPublica: "verMesaPublica",
  pedirDesdeMesa: "pedirDesdeMesa",
  avisarDesdeMesa: "avisarDesdeMesa",
  consultarRecogida: "consultarRecogida",
  pedirParaLlevar: "pedirParaLlevar",
  verParaLlevarPublico: "verParaLlevarPublico",
  crearParaLlevar: "crearParaLlevar",
  cambiarEstadoParaLlevar: "cambiarEstadoParaLlevar",
} as const

export const CALLABLE_SCHEMAS_FASE2 = {
  guardarCategoriaCarta: { input: GuardarCategoriaCartaInputSchema, output: GuardarCategoriaCartaOutputSchema },
  guardarPlato: { input: GuardarPlatoInputSchema, output: GuardarPlatoOutputSchema },
  guardarMenuDia: { input: GuardarMenuDiaInputSchema, output: GuardarMenuDiaOutputSchema },
  ordenarCarta: { input: OrdenarCartaInputSchema, output: OrdenarCartaOutputSchema },
  configuracionPush: { input: ConfiguracionPushInputSchema, output: ConfiguracionPushOutputSchema },
  guardarSuscripcionPush: { input: GuardarSuscripcionPushInputSchema, output: GuardarSuscripcionPushOutputSchema },
  guardarRaciones: { input: GuardarRacionesInputSchema, output: GuardarRacionesOutputSchema },
  marcarAgotado: { input: MarcarAgotadoInputSchema, output: MarcarAgotadoOutputSchema },
  guardarEstacion: { input: GuardarEstacionInputSchema, output: GuardarEstacionOutputSchema },
  guardarConfiguracionSala: { input: GuardarConfiguracionSalaInputSchema, output: GuardarConfiguracionSalaOutputSchema },
  recuperarQrMesa: { input: RecuperarQrMesaInputSchema, output: RecuperarQrMesaOutputSchema },
  revocarQrMesa: { input: RevocarQrMesaInputSchema, output: RevocarQrMesaOutputSchema },
  importarQrMesa: { input: ImportarQrMesaInputSchema, output: ImportarQrMesaOutputSchema },
  regenerarQrMesa: { input: RegenerarQrMesaInputSchema, output: RegenerarQrMesaOutputSchema },
  abrirMesa: { input: AbrirMesaInputSchema, output: AbrirMesaOutputSchema },
  cambiarEstadoMesa: { input: CambiarEstadoMesaInputSchema, output: CambiarEstadoMesaOutputSchema },
  editarMesa: { input: EditarMesaInputSchema, output: EditarMesaOutputSchema },
  moverMesa: { input: MoverMesaInputSchema, output: MoverMesaOutputSchema },
  juntarMesas: { input: JuntarMesasInputSchema, output: JuntarMesasOutputSchema },
  separarMesas: { input: SepararMesasInputSchema, output: SepararMesasOutputSchema },
  enviarPedido: { input: EnviarPedidoInputSchema, output: EnviarPedidoOutputSchema },
  decidirPedido: { input: DecidirPedidoInputSchema, output: DecidirPedidoOutputSchema },
  marcharPase: { input: MarcharPaseInputSchema, output: MarcharPaseOutputSchema },
  cambiarEstadoLineas: { input: CambiarEstadoLineasInputSchema, output: CambiarEstadoLineasOutputSchema },
  crearTarea: { input: CrearTareaInputSchema, output: CrearTareaOutputSchema },
  cambiarEstadoTarea: { input: CambiarEstadoTareaInputSchema, output: CambiarEstadoTareaOutputSchema },
  verMesaPublica: { input: VerMesaPublicaInputSchema, output: VerMesaPublicaOutputSchema },
  pedirDesdeMesa: { input: PedirDesdeMesaInputSchema, output: PedirDesdeMesaOutputSchema },
  avisarDesdeMesa: { input: AvisarDesdeMesaInputSchema, output: AvisarDesdeMesaOutputSchema },
  consultarRecogida: { input: ConsultarRecogidaInputSchema, output: ConsultarRecogidaOutputSchema },
  pedirParaLlevar: { input: PedirParaLlevarInputSchema, output: PedirParaLlevarOutputSchema },
  verParaLlevarPublico: { input: VerParaLlevarPublicoInputSchema, output: VerParaLlevarPublicoOutputSchema },
  crearParaLlevar: { input: CrearParaLlevarInputSchema, output: CrearParaLlevarOutputSchema },
  cambiarEstadoParaLlevar: { input: CambiarEstadoParaLlevarInputSchema, output: CambiarEstadoParaLlevarOutputSchema },
} as const satisfies Record<keyof typeof CALLABLES_FASE2, { input: z.ZodType; output: z.ZodType }>

/**
 * Quién puede llamar a cada callable de la fase 2 y con qué módulo. Las funciones lo
 * comprueban así; la interfaz, para enseñar o no el botón. `public` = sin sesión (con
 * enlace o QR). `per_line` = depende de cada línea y del cambio: `lineTransitionPermissions`.
 */
export const FASE2_ACCESS: Record<keyof typeof CALLABLES_FASE2, { permission: Permission | "public" | "per_line"; module: "floor" | "kitchen" }> = {
  guardarCategoriaCarta: { permission: "carta.editar", module: "floor" },
  guardarPlato: { permission: "carta.editar", module: "floor" },
  guardarMenuDia: { permission: "carta.editar", module: "floor" },
  ordenarCarta: { permission: "carta.editar", module: "floor" },
  configuracionPush: { permission: "tareas.atender", module: "floor" },
  guardarSuscripcionPush: { permission: "tareas.atender", module: "floor" },
  guardarRaciones: { permission: "carta.agotar", module: "floor" },
  marcarAgotado: { permission: "carta.agotar", module: "floor" },
  guardarEstacion: { permission: "sala.configurar", module: "kitchen" },
  guardarConfiguracionSala: { permission: "sala.configurar", module: "floor" },
  recuperarQrMesa: { permission: "sala.configurar", module: "floor" },
  revocarQrMesa: { permission: "sala.configurar", module: "floor" },
  importarQrMesa: { permission: "sala.configurar", module: "floor" },
  regenerarQrMesa: { permission: "sala.configurar", module: "floor" },
  abrirMesa: { permission: "sala.gestionar", module: "floor" },
  cambiarEstadoMesa: { permission: "sala.gestionar", module: "floor" },
  editarMesa: { permission: "sala.gestionar", module: "floor" },
  moverMesa: { permission: "sala.gestionar", module: "floor" },
  juntarMesas: { permission: "sala.gestionar", module: "floor" },
  separarMesas: { permission: "sala.gestionar", module: "floor" },
  enviarPedido: { permission: "comandas.tomar", module: "floor" },
  decidirPedido: { permission: "comandas.tomar", module: "floor" },
  marcharPase: { permission: "comandas.tomar", module: "floor" },
  cambiarEstadoLineas: { permission: "per_line", module: "floor" },
  crearTarea: { permission: "tareas.atender", module: "floor" },
  cambiarEstadoTarea: { permission: "tareas.atender", module: "floor" },
  verMesaPublica: { permission: "public", module: "floor" },
  pedirDesdeMesa: { permission: "public", module: "floor" },
  avisarDesdeMesa: { permission: "public", module: "floor" },
  consultarRecogida: { permission: "public", module: "floor" },
  pedirParaLlevar: { permission: "public", module: "floor" },
  verParaLlevarPublico: { permission: "public", module: "floor" },
  crearParaLlevar: { permission: "comandas.tomar", module: "floor" },
  cambiarEstadoParaLlevar: { permission: "comandas.tomar", module: "floor" },
}
