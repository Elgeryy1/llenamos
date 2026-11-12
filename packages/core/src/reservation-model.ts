/**
 * Documentos de reservas en Firestore (fase 1), con los nombres en inglés.
 *
 * restaurants/{rid}
 *   customers/{cid}                       ficha de cliente (cid = customerIdFor(rid, phone))
 *   locations/{lid}
 *     reservations/{id}                   reservas (solo servidor)
 *     waitlist/{wid}                      lista de espera (solo servidor)
 * publicRestaurants/{slug}                lo que ve la web pública (solo servidor; lo lee cualquiera)
 *
 * Las horas llegan como `Timestamp` y los esquemas las devuelven en ms (`TimestampSchema`).
 * Para escribir, las funciones `xxxForWrite` convierten los ms con el conversor que se les
 * pase (por ejemplo, `Timestamp.fromMillis`). `createdAt` y `updatedAt` no forman parte de
 * los esquemas: los pone el servidor y se ignoran al leer, como en el resto del modelo.
 */
import { z } from "zod"
import { CustomerIdSchema, ReservationReferenceSchema, TokenHashSchema } from "./ids"
import { DocIdSchema, HexColorSchema, LanguageSchema } from "./model"
import { PhoneE164Schema } from "./phone"
import { DepositPolicySchema } from "./reservation-settings"
import { FechaSchema, HoraSchema, ZonaHorariaSchema } from "./reservas/tiempo"
import { TimestampSchema } from "./timestamp"

/* Estados y orígenes ---------------------------------------------------- */

export const RESERVATION_STATUSES = ["pending", "confirmed", "seated", "finished", "cancelled", "no_show"] as const
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number]
export const ReservationStatusSchema = z.enum(RESERVATION_STATUSES)

/** En castellano y en minúscula, para la interfaz: «no presentada». */
export const RESERVATION_STATUS_LABEL: Record<ReservationStatus, string> = {
  pending: "pendiente",
  confirmed: "confirmada",
  seated: "sentada",
  finished: "terminada",
  cancelled: "cancelada",
  no_show: "no presentada",
}

export const RESERVATION_SOURCES = ["web", "widget", "phone", "walk_in", "import", "waitlist"] as const
export type ReservationSource = (typeof RESERVATION_SOURCES)[number]
export const ReservationSourceSchema = z.enum(RESERVATION_SOURCES)

export const RESERVATION_SOURCE_LABEL: Record<ReservationSource, string> = {
  web: "web",
  widget: "widget",
  phone: "teléfono",
  walk_in: "en el local",
  import: "importada",
  waitlist: "lista de espera",
}

/* Campos comunes -------------------------------------------------------- */

export const GuestNameSchema = z.string().trim().min(1, "Escribe el nombre.").max(80, "El nombre es demasiado largo.")
export const EmailSchema = z.string().trim().toLowerCase().max(254).email("Ese correo no parece válido.")
export const PartySizeSchema = z.number().int("Número de comensales no válido.").min(1, "Al menos 1 comensal.").max(200, "Como mucho 200 comensales.")
export const NotesSchema = z.string().max(500, "Como mucho 500 caracteres.")

/* Señal de una reserva -------------------------------------------------- */

export const DEPOSIT_STATUSES = ["none", "required", "not_configured", "paid", "refunded", "failed"] as const
export type DepositStatus = (typeof DEPOSIT_STATUSES)[number]
export const DepositStatusSchema = z.enum(DEPOSIT_STATUSES)

/**
 * Estado de la señal de una reserva.
 * - none: no se pide.
 * - required: se pide y falta pagarla.
 * - not_configured: se pide, pero Stripe no está configurado (la web lo dice).
 * - paid, refunded, failed: lo que dice Stripe.
 */
export const DepositSchema = z.object({
  status: DepositStatusSchema,
  /** Total en céntimos (por persona × comensales). 0 si no se pide. */
  amountCents: z.number().int().min(0),
  checkoutSessionId: z.string().max(200).nullable(),
})
export type Deposit = z.infer<typeof DepositSchema>

/* Reserva ---------------------------------------------------------------- */

export const StatusChangeSchema = z.object({
  from: ReservationStatusSchema,
  to: ReservationStatusSchema,
  /** ms UTC. */
  at: TimestampSchema,
  /** uid de quien lo cambió, o null si fue el cliente o el sistema. */
  by: z.string().nullable(),
  reason: z.string().max(200).nullable(),
})
export type StatusChange = z.infer<typeof StatusChangeSchema>

export const ReservationSchema = z.object({
  guestName: GuestNameSchema,
  phone: PhoneE164Schema,
  email: EmailSchema.nullable(),
  language: LanguageSchema,
  partySize: PartySizeSchema,
  /** Instante de llegada (ms UTC). */
  startAt: TimestampSchema,
  durationMinutes: z.number().int().min(15).max(24 * 60),
  status: ReservationStatusSchema,
  /** Mesas asignadas. Vacío = sin mesa. */
  tableIds: z.array(DocIdSchema).max(6),
  /** Lo que propuso el motor al crearla (sugerencia, no asignación). */
  suggestedTableIds: z.array(DocIdSchema).max(6),
  suggestionReason: z.string().max(500).nullable(),
  source: ReservationSourceSchema,
  /** Notas del personal. */
  notes: NotesSchema,
  /** Lo que escribió el cliente al reservar. */
  guestNotes: NotesSchema,
  customerId: CustomerIdSchema,
  /** 6 caracteres, único por restaurante. */
  reference: ReservationReferenceSchema,
  /** sha256Hex del token del enlace de gestión. El token solo va en el enlace. */
  manageTokenHash: TokenHashSchema,
  deposit: DepositSchema,
  history: z.array(StatusChangeSchema),
  /** uid de quien la creó, o null si la hizo el cliente. */
  createdBy: z.string().nullable(),
})
export type Reservation = z.infer<typeof ReservationSchema>

/** Una reserva con el id de su documento. */
export type ReservationWithId = Reservation & { id: string }

/* Cliente ---------------------------------------------------------------- */

export const TagSchema = z.string().trim().min(1).max(30)

/** Lo que el personal con `clientes.editar` puede cambiar desde el navegador. */
export const CustomerEditableSchema = z.object({
  notes: z.string().max(1000, "Como mucho 1000 caracteres."),
  allergies: z.string().max(500, "Como mucho 500 caracteres."),
  tags: z.array(TagSchema).max(20, "Como mucho 20 etiquetas."),
})
export type CustomerEditable = z.infer<typeof CustomerEditableSchema>

export const CustomerSchema = CustomerEditableSchema.extend({
  name: GuestNameSchema,
  phone: PhoneE164Schema,
  email: EmailSchema.nullable(),
  language: LanguageSchema,
  /** Estadísticas: solo las escribe el servidor. */
  visits: z.number().int().min(0),
  noShows: z.number().int().min(0),
  cancellations: z.number().int().min(0),
  lastVisitAt: TimestampSchema.nullable(),
  /**
   * Fase 2: gasto acumulado en céntimos (suma de las mesas cerradas unidas a este cliente).
   * Solo servidor; si falta, es 0.
   */
  spentCents: z.number().int().min(0).optional(),
  /** uid del último editor desde el navegador. */
  updatedBy: z.string().optional(),
})
export type Customer = z.infer<typeof CustomerSchema>

/* Lista de espera -------------------------------------------------------- */

export const WAITLIST_STATUSES = ["waiting", "offered", "booked", "expired", "cancelled"] as const
export type WaitlistStatus = (typeof WAITLIST_STATUSES)[number]
export const WaitlistStatusSchema = z.enum(WAITLIST_STATUSES)

export const WAITLIST_STATUS_LABEL: Record<WaitlistStatus, string> = {
  waiting: "esperando",
  offered: "oferta enviada",
  booked: "reservada",
  expired: "caducada",
  cancelled: "cancelada",
}

export const WAITLIST_SOURCES = ["web", "widget", "staff"] as const
export const WaitlistSourceSchema = z.enum(WAITLIST_SOURCES)
export type WaitlistSource = z.infer<typeof WaitlistSourceSchema>

export const WaitlistOfferSchema = z.object({
  /** Hora ofrecida (ms UTC). */
  startAt: TimestampSchema,
  /** Hasta cuándo se guarda el hueco (ms UTC). */
  expiresAt: TimestampSchema,
  /** sha256Hex del token del enlace de la oferta. */
  tokenHash: TokenHashSchema,
})
export type WaitlistOffer = z.infer<typeof WaitlistOfferSchema>

/**
 * Entrada en la lista de espera: quiere mesa el día `date` entre `from` y `to` (horas de
 * pared del local, incluidas). Si `to` es menor que `from`, el tramo cruza la medianoche,
 * igual que los turnos.
 */
export const WaitlistEntrySchema = z.object({
  guestName: GuestNameSchema,
  phone: PhoneE164Schema,
  email: EmailSchema.nullable(),
  language: LanguageSchema,
  partySize: PartySizeSchema,
  date: FechaSchema,
  from: HoraSchema,
  to: HoraSchema,
  status: WaitlistStatusSchema,
  offer: WaitlistOfferSchema.nullable(),
  customerId: CustomerIdSchema,
  source: WaitlistSourceSchema,
})
export type WaitlistEntry = z.infer<typeof WaitlistEntrySchema>

/* Restaurante público ---------------------------------------------------- */

export const PublicLocationSchema = z.object({
  id: DocIdSchema,
  name: z.string().max(80),
  address: z.string().max(200),
  city: z.string().max(80),
  phone: z.string().max(30),
})
export type PublicLocation = z.infer<typeof PublicLocationSchema>

/** Por qué no se puede reservar desde la web (null si se puede). */
export const BOOKING_DISABLED_REASONS = ["module_off", "public_booking_off"] as const
export const BookingDisabledReasonSchema = z.enum(BOOKING_DISABLED_REASONS)
export type BookingDisabledReason = z.infer<typeof BookingDisabledReasonSchema>

/**
 * `publicRestaurants/{slug}`: lo mínimo para pintar la página de reservas, sin datos
 * privados. Lo mantiene un disparador a partir del restaurante, sus locales y la
 * configuración de reservas.
 */
export const PublicRestaurantSchema = z.object({
  restaurantId: DocIdSchema,
  name: z.string().max(80),
  brandColor: HexColorSchema,
  locale: LanguageSchema,
  /** Para pintar el calendario en la hora del local. */
  timezone: ZonaHorariaSchema,
  /** true solo si el módulo `reservations` está activo y `publicBooking` encendido. */
  bookingEnabled: z.boolean(),
  /** Si `bookingEnabled` es false, por qué, para decirlo claro en la página. */
  bookingDisabledReason: BookingDisabledReasonSchema.nullable(),
  locations: z.array(PublicLocationSchema),
  minPartySize: z.number().int().min(1),
  maxPartySize: z.number().int().min(1),
  maxAdvanceDays: z.number().int().min(1),
  deposit: DepositPolicySchema,
  cancellationFreeUntilHours: z.number().int().min(0),
})
export type PublicRestaurant = z.infer<typeof PublicRestaurantSchema>

/* Escritura -------------------------------------------------------------- */

/** Cambia el tipo de los campos de hora: de ms a lo que devuelva el conversor (p. ej. `Timestamp`). */
type ConHoras<T, K extends keyof T, H> = Omit<T, K> & { [P in K]: null extends T[P] ? H | null : H }

export type ReservationWrite<H> = Omit<ConHoras<Reservation, "startAt", H>, "history"> & {
  history: Array<ConHoras<StatusChange, "at", H>>
}

/** La reserva lista para `tx.set`, con las horas convertidas por `toTimestamp`. */
export function reservationForWrite<H>(reservation: Reservation, toTimestamp: (ms: number) => H): ReservationWrite<H> {
  return {
    ...reservation,
    startAt: toTimestamp(reservation.startAt),
    history: reservation.history.map((h) => ({ ...h, at: toTimestamp(h.at) })),
  }
}

export type CustomerWrite<H> = ConHoras<Customer, "lastVisitAt", H>

export function customerForWrite<H>(customer: Customer, toTimestamp: (ms: number) => H): CustomerWrite<H> {
  return { ...customer, lastVisitAt: customer.lastVisitAt === null ? null : toTimestamp(customer.lastVisitAt) }
}

export type WaitlistEntryWrite<H> = Omit<WaitlistEntry, "offer"> & {
  offer: ConHoras<WaitlistOffer, "startAt" | "expiresAt", H> | null
}

export function waitlistEntryForWrite<H>(entry: WaitlistEntry, toTimestamp: (ms: number) => H): WaitlistEntryWrite<H> {
  const { offer } = entry
  return {
    ...entry,
    offer: offer === null ? null : { ...offer, startAt: toTimestamp(offer.startAt), expiresAt: toTimestamp(offer.expiresAt) },
  }
}
