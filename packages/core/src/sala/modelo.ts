/**
 * Sala en servicio (fase 2): mesas abiertas, comandas, líneas, tareas y para llevar.
 *
 * restaurants/{rid}/locations/{lid}
 *   settings/floor            ajustes de sala y cocina (FloorSettings)
 *   tableSessions/{sid}       una mesa abierta: mesas, comensales, reserva, cliente y total
 *   orders/{oid}              una comanda: lo que se pide de una vez (desde el comandero, la mesa o la web)
 *   orderLines/{lineId}       cada plato pedido, con su precio congelado, estación, pase y estado
 *   floorTasks/{tid}          tareas de sala con dueño («voy yo»)
 *   takeaways/{tid}           pedidos para llevar con hora de recogida
 *   tableTokens/{tableId}     hash del código QR de cada mesa (solo servidor; nadie lo lee)
 *
 * Todo lo escribe el servidor. Las horas son `Timestamp` en Firestore y ms UTC aquí; para
 * escribir, las funciones `xxxForWrite` convierten los ms con el conversor que se les pase.
 */
import { z } from "zod"
import { CustomerIdSchema, ReservationReferenceSchema, TokenHashSchema } from "../ids"
import { DocIdSchema, LanguageSchema } from "../model"
import { PhoneE164Schema } from "../phone"
import { EmailSchema, GuestNameSchema, NotesSchema } from "../reservation-model"
import { TimestampSchema } from "../timestamp"
import { CourseSchema, PartIdSchema, PriceCentsSchema, StationKindSchema, TaxRateSchema } from "../carta/modelo"
import { menuTextSchema } from "../carta/textos"

/* Ajustes de sala y cocina (`settings/floor`) --------------------------------------------- */

export const FIRING_MODES = ["by_course", "all_at_once"] as const
export type FiringMode = (typeof FIRING_MODES)[number]

export const FloorSettingsSchema = z.object({
  /** Ausente conserva el comportamiento anterior. */
  allowOrdersOutsideHours: z.boolean().optional(),
  /** Pedido desde la mesa con el QR (o NFC). */
  selfOrder: z.object({
    enabled: z.boolean(),
    /** Lo pedido desde la mesa espera a que un camarero lo acepte antes de ir a cocina. */
    requireApproval: z.boolean(),
    callWaiter: z.boolean(),
    requestBill: z.boolean(),
  }),
  firing: z.object({
    /** by_course: los pases posteriores esperan a «marchar»; all_at_once: todo sale al momento. */
    mode: z.enum(FIRING_MODES),
    /** Al servir todo un pase, marcha solo el siguiente. */
    autoFireNextCourse: z.boolean(),
  }),
  /** Tiempos objetivo en minutos: pasado el tiempo, «se está cayendo» y avisa. */
  targets: z.object({
    /** Preparación de una línea si ni el plato ni su estación dicen otra cosa. */
    defaultPrepMinutes: z.number().int().min(1).max(240),
    /** Un plato listo en el pase sin recoger. */
    pickupMinutes: z.number().int().min(1).max(60),
    callWaiterMinutes: z.number().int().min(1).max(60),
    billMinutes: z.number().int().min(1).max(60),
    approveMinutes: z.number().int().min(1).max(60),
    customMinutes: z.number().int().min(1).max(240),
  }),
  takeaway: z.object({
    enabled: z.boolean(),
    /** Se puede pedir desde la web pública (`/r/{slug}/para-llevar`). */
    publicOrdering: z.boolean(),
    /** Los pedidos de la web entran aceptados; si no, quedan `pending`. */
    autoAccept: z.boolean(),
    stepMinutes: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(20), z.literal(30)]),
    /** Antelación mínima para pedir desde la web. */
    minNoticeMinutes: z.number().int().min(0).max(24 * 60),
    maxOrdersPerSlot: z.number().int().min(1).max(100),
    /** La cocina lo empieza estos minutos antes de la recogida. */
    prepLeadMinutes: z.number().int().min(0).max(240),
  }),
  /** Estación para los platos sin estación; null = sin estación (lo sirve la sala). */
  defaultStationId: DocIdSchema.nullable(),
})
export type FloorSettings = z.infer<typeof FloorSettingsSchema>

/** Sin `settings/floor`: QR y para llevar apagados, pases por turno y tiempos razonables. */
export function defaultFloorSettings(): FloorSettings {
  return {
    selfOrder: { enabled: false, requireApproval: true, callWaiter: true, requestBill: true },
    firing: { mode: "by_course", autoFireNextCourse: false },
    targets: { defaultPrepMinutes: 15, pickupMinutes: 3, callWaiterMinutes: 3, billMinutes: 5, approveMinutes: 3, customMinutes: 10 },
    takeaway: { enabled: false, publicOrdering: false, autoAccept: false, stepMinutes: 15, minNoticeMinutes: 30, maxOrdersPerSlot: 4, prepLeadMinutes: 20 },
    defaultStationId: null,
  }
}

/* Historial común ---------------------------------------------------------------------------- */

function cambioDe<T extends z.ZodType>(estado: T) {
  return z.object({
    from: estado,
    to: estado,
    at: TimestampSchema,
    /** uid de quien lo cambió, o null si fue el cliente o el sistema. */
    by: z.string().nullable(),
    reason: z.string().max(200).nullable(),
  })
}

const ShortTextSchema = z.string().trim().max(200)

/* Mesa abierta (`tableSessions`) ------------------------------------------------------------- */

/**
 * - open: la mesa está ocupada y pidiendo.
 * - bill_requested: ha pedido la cuenta (vuelve a open si pide algo más).
 * - closed: se ha ido; las mesas quedan libres (se puede reabrir si siguen libres).
 * - merged: se juntó con otra (`mergedInto`); sus líneas pasaron a la otra. Final.
 * - cancelled: abierta por error, sin nada pedido. Final.
 */
export const TABLE_SESSION_STATUSES = ["open", "bill_requested", "closed", "merged", "cancelled"] as const
export type TableSessionStatus = (typeof TABLE_SESSION_STATUSES)[number]
export const TableSessionStatusSchema = z.enum(TABLE_SESSION_STATUSES)

export const TABLE_SESSION_STATUS_LABEL: Record<TableSessionStatus, string> = {
  open: "abierta",
  bill_requested: "pide la cuenta",
  closed: "cerrada",
  merged: "juntada con otra",
  cancelled: "anulada",
}

/** Estados en los que la mesa ocupa sus mesas del plano. */
export function sessionIsOpen(status: TableSessionStatus): boolean {
  return status === "open" || status === "bill_requested"
}

export const MAX_SESSION_TABLES = 8

export const TableSessionSchema = z.object({
  status: TableSessionStatusSchema,
  /** Mesas del plano que ocupa (varias si se han juntado). */
  tableIds: z.array(DocIdSchema).min(1).max(MAX_SESSION_TABLES),
  /** Nombres de las mesas para enseñar: «S3+S4». Lo recalcula el servidor al mover o juntar. */
  label: z.string().max(80),
  guests: z.number().int().min(1).max(200),
  /** Reserva sentada en esta mesa, o null (sin reserva). */
  reservationId: DocIdSchema.nullable(),
  /** Cliente al que se apunta el gasto, o null. */
  customerId: CustomerIdSchema.nullable(),
  guestName: z.string().max(80).nullable(),
  /** Camarero responsable, o null. */
  waiterUid: z.string().nullable(),
  waiterName: z.string().max(80).nullable(),
  notes: NotesSchema,
  openedAt: TimestampSchema,
  openedBy: z.string().nullable(),
  closedAt: TimestampSchema.nullable(),
  closedBy: z.string().nullable(),
  billRequestedAt: TimestampSchema.nullable(),
  /** Sesión en la que se juntó (status merged), o null. */
  mergedInto: DocIdSchema.nullable(),
  /** Suma de las líneas no anuladas, en céntimos. Solo servidor (`sessionTotals`). */
  totalCents: z.number().int().min(0),
  /** Platos y menús pedidos (sin contar anulados ni los platos de dentro de un menú). */
  lineCount: z.number().int().min(0),
  /** Líneas aún sin servir (pendientes, en espera, en cocina o listas). */
  unservedCount: z.number().int().min(0),
  history: z.array(cambioDe(TableSessionStatusSchema)),
})
export type TableSession = z.infer<typeof TableSessionSchema>
export type TableSessionWithId = TableSession & { id: string }

/* Comanda (`orders`) ------------------------------------------------------------------------ */

export const ORDER_SOURCES = ["staff", "table", "takeaway_web"] as const
export type OrderSource = (typeof ORDER_SOURCES)[number]
export const OrderSourceSchema = z.enum(ORDER_SOURCES)

/** pending_approval: pedido desde la mesa o la web que espera a un camarero. */
export const ORDER_STATUSES = ["pending_approval", "accepted", "rejected"] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]
export const OrderStatusSchema = z.enum(ORDER_STATUSES)

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  pending_approval: "por aceptar",
  accepted: "aceptada",
  rejected: "rechazada",
}

/** Cómo salen los pases al enviar: auto (por turno), all (todo ya) o hold (todo espera menos la bebida). */
export const FIRE_MODES = ["auto", "all", "hold"] as const
export type FireMode = (typeof FIRE_MODES)[number]
export const FireModeSchema = z.enum(FIRE_MODES)

export const OrderSchema = z.object({
  /** Mesa o para llevar: exactamente uno de los dos. */
  sessionId: DocIdSchema.nullable(),
  takeawayId: DocIdSchema.nullable(),
  source: OrderSourceSchema,
  status: OrderStatusSchema,
  /** Líneas principales (platos y menús), en orden. */
  lineIds: z.array(DocIdSchema).max(50),
  totalCents: z.number().int().min(0),
  note: ShortTextSchema,
  language: LanguageSchema,
  fire: FireModeSchema,
  placedAt: TimestampSchema,
  /** uid de quien la envió, o null si la envió el cliente. */
  createdBy: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: TimestampSchema.nullable(),
  rejectReason: z.string().max(200).nullable(),
})
export type Order = z.infer<typeof OrderSchema>

/* Línea (`orderLines`) ------------------------------------------------------------------------ */

/**
 * Estados de una línea (ver `LINE_TRANSITIONS`):
 * - pending: pedida desde la mesa o la web, falta que la acepte un camarero. La cocina no la ve.
 * - held: en espera de «marchar» (un pase posterior, o para llevar aún pronto).
 * - fired: marchada: la cocina la tiene en pantalla.
 * - preparing: la estación la ha empezado.
 * - ready: lista en el pase, esperando a la sala.
 * - served: en la mesa (o entregada).
 * - cancelled: anulada (con motivo si ya estaba en cocina).
 */
export const LINE_STATUSES = ["pending", "held", "fired", "preparing", "ready", "served", "cancelled"] as const
export type LineStatus = (typeof LINE_STATUSES)[number]
export const LineStatusSchema = z.enum(LINE_STATUSES)

export const LINE_STATUS_LABEL: Record<LineStatus, string> = {
  pending: "por aceptar",
  held: "en espera",
  fired: "marchado",
  preparing: "en preparación",
  ready: "listo",
  served: "servido",
  cancelled: "anulado",
}

/**
 * - item: un plato o bebida (lleva precio, estación y estado).
 * - menu: un menú del día (lleva el precio del menú; sin estación; su estado sale de sus platos).
 * - menu_component: un plato de dentro de un menú (lleva su suplemento, estación y estado).
 */
export const LINE_KINDS = ["item", "menu", "menu_component"] as const
export type LineKind = (typeof LINE_KINDS)[number]
export const LineKindSchema = z.enum(LINE_KINDS)

const SnapshotTextSchema = menuTextSchema(80)

export const LineModifierSchema = z.object({
  groupId: PartIdSchema,
  optionId: PartIdSchema,
  name: SnapshotTextSchema,
  priceCents: PriceCentsSchema,
})

export const OrderLineSchema = z.object({
  /** Datos públicos del envío repetidos por estación, sin contacto ni notas privadas. */
  ticket: z.object({
    reference: z.string().max(12),
    source: OrderSourceSchema,
    note: z.string().max(1201),
    pickupAt: TimestampSchema.nullable(),
    pickupReference: z.string().nullable(),
    guestName: z.string().nullable(),
  }).optional(),
  orderId: DocIdSchema,
  sessionId: DocIdSchema.nullable(),
  takeawayId: DocIdSchema.nullable(),
  /** Para la cocina: «S3+S4» o «Para llevar · Ana · 21:30». Se actualiza al mover o juntar. */
  label: z.string().max(80),
  kind: LineKindSchema,
  /** En menu_component, el id de la línea del menú. */
  parentLineId: DocIdSchema.nullable(),
  /** Orden dentro de la comanda (los platos de un menú van con el número del menú y su posición). */
  position: z.number().int().min(0),
  itemId: DocIdSchema.nullable(),
  dailyMenuId: DocIdSchema.nullable(),
  sectionId: PartIdSchema.nullable(),
  /** Versión del plato o del menú con la que se pidió. */
  version: z.number().int().min(1),
  /** Precio y nombres congelados al pedir: cambiar la carta no los toca. */
  name: SnapshotTextSchema,
  variant: z.object({ id: PartIdSchema, name: SnapshotTextSchema, priceCents: PriceCentsSchema }).nullable(),
  modifiers: z.array(LineModifierSchema).max(30),
  quantity: z.number().int().min(1).max(99),
  /** item: variante o base + extras. menu: precio del menú. menu_component: suplemento + extras. */
  // El precio calculado suma base y extras: puede superar el máximo de un precio individual.
  unitPriceCents: z.number().int().min(0),
  totalCents: z.number().int().min(0),
  /** Congelado por servidor al pedir. Ausente o null solo en historial anterior a caja. */
  taxRate: TaxRateSchema.nullable().optional(),
  notes: z.string().max(140),
  guest: z.number().int().min(1).max(50).nullable(),
  /** Pase (null en la línea del menú). */
  course: CourseSchema.nullable(),
  /** Estación que lo prepara (null = lo sirve la sala, o es la línea del menú). */
  stationId: DocIdSchema.nullable(),
  stationKind: StationKindSchema.nullable(),
  /** Minutos objetivo desde que se marcha hasta que está listo. */
  targetMinutes: z.number().int().min(1).max(240).nullable(),
  status: LineStatusSchema,
  /** Para llevar: cuándo debe marcharse sola (recogida − antelación), o null. */
  fireAt: TimestampSchema.nullable(),
  placedAt: TimestampSchema,
  firedAt: TimestampSchema.nullable(),
  startedAt: TimestampSchema.nullable(),
  readyAt: TimestampSchema.nullable(),
  servedAt: TimestampSchema.nullable(),
  cancelReason: z.string().max(200).nullable(),
  history: z.array(cambioDe(LineStatusSchema)),
  createdBy: z.string().nullable(),
})
export type OrderLine = z.infer<typeof OrderLineSchema>
export type OrderLineWithId = OrderLine & { id: string }

/* Tareas de sala (`floorTasks`) ------------------------------------------------------------------ */

/**
 * - pickup: hay platos listos en el pase de una estación para esta mesa.
 * - call_waiter: la mesa llama al camarero (desde el QR).
 * - bill_request: la mesa pide la cuenta.
 * - approve_order: un pedido desde la mesa o la web espera a que lo acepten.
 * - custom: una tarea escrita por el personal.
 */
export const FLOOR_TASK_TYPES = ["pickup", "call_waiter", "bill_request", "approve_order", "custom"] as const
export type FloorTaskType = (typeof FLOOR_TASK_TYPES)[number]
export const FloorTaskTypeSchema = z.enum(FLOOR_TASK_TYPES)

export const FLOOR_TASK_TYPE_LABEL: Record<FloorTaskType, string> = {
  pickup: "recoger en el pase",
  call_waiter: "llaman al camarero",
  bill_request: "piden la cuenta",
  approve_order: "pedido por aceptar",
  custom: "tarea",
}

export const FLOOR_TASK_STATUSES = ["open", "claimed", "done", "cancelled"] as const
export type FloorTaskStatus = (typeof FLOOR_TASK_STATUSES)[number]
export const FloorTaskStatusSchema = z.enum(FLOOR_TASK_STATUSES)

export const FLOOR_TASK_STATUS_LABEL: Record<FloorTaskStatus, string> = {
  open: "sin dueño",
  claimed: "alguien va",
  done: "hecha",
  cancelled: "anulada",
}

export const FloorTaskSchema = z.object({
  purpose: z.literal("fire_course").optional(),
  type: FloorTaskTypeSchema,
  status: FloorTaskStatusSchema,
  sessionId: DocIdSchema.nullable(),
  takeawayId: DocIdSchema.nullable(),
  tableIds: z.array(DocIdSchema).max(MAX_SESSION_TABLES),
  label: z.string().max(80),
  orderId: DocIdSchema.nullable(),
  stationId: DocIdSchema.nullable(),
  /** pickup: líneas listas que hay que llevar. */
  lineIds: z.array(DocIdSchema).max(100),
  note: ShortTextSchema,
  requests: z.array(z.object({ reason: z.enum(["water", "cutlery", "napkins", "order", "other"]), note: z.string().max(200) })).max(10).optional(),
  /** Clave para no duplicar (`taskDedupeKey`): una sola tarea abierta por clave. null en custom. */
  dedupeKey: z.string().max(200).nullable(),
  /** Veces que se ha pedido lo mismo mientras estaba abierta (llamar tres veces). */
  count: z.number().int().min(1),
  openedAt: TimestampSchema,
  /** Pasada esta hora sin hacer, se está cayendo. */
  dueAt: TimestampSchema,
  createdBy: z.string().nullable(),
  claimedBy: z.string().nullable(),
  claimedByName: z.string().max(80).nullable(),
  claimedAt: TimestampSchema.nullable(),
  doneAt: TimestampSchema.nullable(),
  doneBy: z.string().nullable(),
})
export type FloorTask = z.infer<typeof FloorTaskSchema>
export type FloorTaskWithId = FloorTask & { id: string }

/* Para llevar (`takeaways`) --------------------------------------------------------------------- */

/**
 * - pending: pedido desde la web, falta aceptarlo.
 * - accepted: aceptado; la cocina lo marcha a su hora (`fireAt`).
 * - ready: todo listo para recoger (lo pone el servidor cuando todas las líneas están listas).
 * - picked_up: recogido. Final.
 * - cancelled: anulado o rechazado. Final.
 */
export const TAKEAWAY_STATUSES = ["pending", "accepted", "ready", "picked_up", "cancelled"] as const
export type TakeawayStatus = (typeof TAKEAWAY_STATUSES)[number]
export const TakeawayStatusSchema = z.enum(TAKEAWAY_STATUSES)

export const TAKEAWAY_STATUS_LABEL: Record<TakeawayStatus, string> = {
  pending: "por aceptar",
  accepted: "aceptado",
  ready: "listo para recoger",
  picked_up: "recogido",
  cancelled: "anulado",
}

export const TAKEAWAY_SOURCES = ["phone", "walk_in", "web"] as const
export const TakeawaySourceSchema = z.enum(TAKEAWAY_SOURCES)
export type TakeawaySource = z.infer<typeof TakeawaySourceSchema>

export const TakeawaySchema = z.object({
  guestName: GuestNameSchema,
  phone: PhoneE164Schema,
  email: EmailSchema.nullable(),
  language: LanguageSchema,
  customerId: CustomerIdSchema,
  /** Hora de recogida (ms UTC). */
  pickupAt: TimestampSchema,
  status: TakeawayStatusSchema,
  /** 6 caracteres, único por restaurante (`restaurants/{rid}/takeawayReferences/{ref}`). */
  reference: ReservationReferenceSchema,
  /** sha256Hex del token del enlace de seguimiento. */
  manageTokenHash: TokenHashSchema,
  source: TakeawaySourceSchema,
  notes: NotesSchema,
  totalCents: z.number().int().min(0),
  orderIds: z.array(DocIdSchema).max(20),
  readyAt: TimestampSchema.nullable(),
  pickedUpAt: TimestampSchema.nullable(),
  cancelReason: z.string().max(200).nullable(),
  history: z.array(cambioDe(TakeawayStatusSchema)),
  createdBy: z.string().nullable(),
})
export type Takeaway = z.infer<typeof TakeawaySchema>

/* Código QR de una mesa (`tableTokens/{tableId}`, solo servidor) ----------------------------------- */

export const TableTokenSchema = z.object({
  /** sha256Hex del token que va en el QR. Regenerarlo invalida el QR impreso antes. */
  tokenHash: TokenHashSchema,
  rotatedAt: TimestampSchema,
})
export type TableToken = z.infer<typeof TableTokenSchema>

/** Ruta del QR de una mesa (relativa al origen de la web). También vale para una etiqueta NFC. */
export function tableQrPath(slug: string, locationId: string, tableId: string, token: string): string {
  return `/m/${encodeURIComponent(slug)}/${encodeURIComponent(locationId)}/${encodeURIComponent(tableId)}?t=${encodeURIComponent(token)}`
}

/** Ruta pública para pedir para llevar. */
export function takeawayPath(slug: string, locationId: string): string {
  return `/r/${encodeURIComponent(slug)}/para-llevar?local=${encodeURIComponent(locationId)}`
}

/** Ruta de seguimiento de un pedido para llevar. */
export function takeawayTrackPath(slug: string, reference: string, token: string): string {
  return `/r/${encodeURIComponent(slug)}/para-llevar/${encodeURIComponent(reference)}?t=${encodeURIComponent(token)}`
}

/* Escritura ------------------------------------------------------------------------------------ */

type ConHoras<T, K extends keyof T, H> = Omit<T, K> & { [P in K]: null extends T[P] ? H | null : H }
type ConHistorial<T extends { history: Array<{ at: number }> }, H> = Omit<T, "history"> & {
  history: Array<Omit<T["history"][number], "at"> & { at: H }>
}

function convertir<T extends object, K extends keyof T, H>(doc: T, keys: readonly K[], toTimestamp: (ms: number) => H): ConHoras<T, K, H> {
  const copia = { ...doc } as Record<string, unknown>
  for (const k of keys) {
    const v = doc[k]
    copia[k as string] = v === null ? null : toTimestamp(v as number)
  }
  return copia as ConHoras<T, K, H>
}

function historial<T extends { history: Array<{ at: number }> }, H>(doc: T, toTimestamp: (ms: number) => H): T["history"] {
  return doc.history.map((h) => ({ ...h, at: toTimestamp(h.at) })) as unknown as T["history"]
}

const SESSION_TIMES = ["openedAt", "closedAt", "billRequestedAt"] as const
export type TableSessionWrite<H> = ConHistorial<ConHoras<TableSession, (typeof SESSION_TIMES)[number], H>, H>
export function tableSessionForWrite<H>(s: TableSession, toTimestamp: (ms: number) => H): TableSessionWrite<H> {
  return { ...convertir(s, SESSION_TIMES, toTimestamp), history: historial(s, toTimestamp) } as unknown as TableSessionWrite<H>
}

const ORDER_TIMES = ["placedAt", "decidedAt"] as const
export type OrderWrite<H> = ConHoras<Order, (typeof ORDER_TIMES)[number], H>
export function orderForWrite<H>(o: Order, toTimestamp: (ms: number) => H): OrderWrite<H> {
  return convertir(o, ORDER_TIMES, toTimestamp)
}

const LINE_TIMES = ["fireAt", "placedAt", "firedAt", "startedAt", "readyAt", "servedAt"] as const
export type OrderLineWrite<H> = ConHistorial<ConHoras<OrderLine, (typeof LINE_TIMES)[number], H>, H>
export function orderLineForWrite<H>(l: OrderLine, toTimestamp: (ms: number) => H): OrderLineWrite<H> {
  return { ...convertir(l, LINE_TIMES, toTimestamp), ...(l.ticket ? { ticket: { ...l.ticket, pickupAt: l.ticket.pickupAt === null ? null : toTimestamp(l.ticket.pickupAt) } } : {}), history: historial(l, toTimestamp) } as unknown as OrderLineWrite<H>
}

const TASK_TIMES = ["openedAt", "dueAt", "claimedAt", "doneAt"] as const
export type FloorTaskWrite<H> = ConHoras<FloorTask, (typeof TASK_TIMES)[number], H>
export function floorTaskForWrite<H>(t: FloorTask, toTimestamp: (ms: number) => H): FloorTaskWrite<H> {
  return convertir(t, TASK_TIMES, toTimestamp)
}

const TAKEAWAY_TIMES = ["pickupAt", "readyAt", "pickedUpAt"] as const
export type TakeawayWrite<H> = ConHistorial<ConHoras<Takeaway, (typeof TAKEAWAY_TIMES)[number], H>, H>
export function takeawayForWrite<H>(t: Takeaway, toTimestamp: (ms: number) => H): TakeawayWrite<H> {
  return { ...convertir(t, TAKEAWAY_TIMES, toTimestamp), history: historial(t, toTimestamp) } as unknown as TakeawayWrite<H>
}
