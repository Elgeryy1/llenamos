/**
 * Entradas y salidas de las callables (región europe-west1).
 *
 * La web valida con el mismo esquema antes de llamar y la función lo vuelve a validar
 * al recibir: así las dos dicen lo mismo. Las entradas son estrictas (un campo de más es
 * un error). Las salidas no: si una función añade un campo, la web vieja no se rompe.
 *
 * Convenciones:
 * - `date` es el **día de servicio** (`AAAA-MM-DD`) y `time` la hora de pared de la franja
 *   (`HH:MM`), tal como la devuelve `consultarDisponibilidad`. Con los dos, la función
 *   encuentra el instante con `slotStartAt` (también en turnos que cruzan la medianoche y
 *   en los cambios de hora).
 * - Los instantes de salida van en ms UTC (`startAt`).
 * - Los teléfonos de entrada se escriben como quiera la persona: se normalizan a E.164.
 * - Las públicas que envían un formulario llevan el campo trampa `website`, que debe ir
 *   vacío (si un robot lo rellena, la validación falla).
 * - `z.input<typeof XxxInputSchema>` es lo que se envía; `z.output` lo que recibe la función ya validado.
 */
import { z } from "zod"
import { LinkTokenSchema, ReservationReferenceInputSchema, ReservationReferenceSchema } from "./ids"
import { DocIdSchema, LanguageSchema, SlugSchema } from "./model"
import { ModuleOverridesSchema, ModuleSchema, PlanSchema } from "./modules"
import { PhoneInputSchema } from "./phone"
import {
  DepositSchema,
  EmailSchema,
  GuestNameSchema,
  NotesSchema,
  PartySizeSchema,
  RESERVATION_STATUSES,
  ReservationStatusSchema,
  WaitlistStatusSchema,
  type ReservationStatus,
} from "./reservation-model"
import { ReservationSettingsSchema } from "./reservation-settings"
import { esFechaValida, FechaSchema, HoraSchema, ZonaHorariaSchema } from "./reservas/tiempo"
import { MillisSchema } from "./timestamp"
import { CALLABLE_SCHEMAS_RESERVAS_VPS, CALLABLES_RESERVAS_VPS } from "./api-reservas-vps"
import { CALLABLE_SCHEMAS_PROVEEDORES_VPS, CALLABLES_PROVEEDORES_VPS } from "./api-proveedores-vps"
import { CALLABLE_SCHEMAS_FASE2, CALLABLES_FASE2 } from "./api-sala"
import { CALLABLE_SCHEMAS_FASE3, CALLABLES_FASE3 } from "./api-caja"
import { CALLABLE_SCHEMAS_FASE6, CALLABLES_FASE6 } from "./api-plataforma"
import { CALLABLE_SCHEMAS_FASE4, CALLABLES_FASE4 } from "./api-fase4"
import { CALLABLE_SCHEMAS_FASE5, CALLABLES_FASE5 } from "./api-fase5"
import { ReservationAttributionInputSchema } from "./marketing/origen"
import { PublicMarketingOptInSchema } from "./marketing/campanas"

/** Región de todas las callables. */
export const CALLABLE_REGION = "europe-west1"

/** Nombres de las callables, para no escribirlos a mano en la web ni en las funciones. */
export const CALLABLES = {
  // Fase 0 (sus esquemas siguen en functions/).
  crearRestaurante: "crearRestaurante",
  invitarMiembro: "invitarMiembro",
  aceptarInvitacion: "aceptarInvitacion",
  cambiarRolMiembro: "cambiarRolMiembro",
  desactivarMiembro: "desactivarMiembro",
  // Fase 1 · reservas (R1).
  consultarDisponibilidad: "consultarDisponibilidad",
  crearReservaPublica: "crearReservaPublica",
  verReservaPublica: "verReservaPublica",
  gestionarReservaPublica: "gestionarReservaPublica",
  crearReserva: "crearReserva",
  cambiarEstadoReserva: "cambiarEstadoReserva",
  asignarMesas: "asignarMesas",
  moverReserva: "moverReserva",
  proponerMesasReserva: "proponerMesasReserva",
  guardarConfiguracionReservas: "guardarConfiguracionReservas",
  importarReservas: "importarReservas",
  cambiarPlan: "cambiarPlan",
  // Fase 1 · mensajes, lista de espera y señal (R2).
  apuntarseListaEspera: "apuntarseListaEspera",
  aceptarOfertaListaEspera: "aceptarOfertaListaEspera",
  iniciarPagoSenal: "iniciarPagoSenal",
  procesarMensajesPendientes: "procesarMensajesPendientes",
  // Fase 2 · sala y cocina (esquemas en api-sala.ts).
  // Reservas en el VPS: plano y clientes como comandos (sin escrituras directas).
  ...CALLABLES_RESERVAS_VPS,
  ...CALLABLES_PROVEEDORES_VPS,
  ...CALLABLES_FASE2,
  ...CALLABLES_FASE3,
  ...CALLABLES_FASE4,
  ...CALLABLES_FASE5,
  ...CALLABLES_FASE6,
} as const
export type CallableName = keyof typeof CALLABLES

/* Piezas comunes ---------------------------------------------------------- */

/** Campo trampa de los formularios públicos: tiene que llegar vacío. */
export const HoneypotSchema = z.string().max(0, "Solicitud no válida.").default("")

/** Correo opcional de un formulario: vacío o ausente = null. */
export const OptionalEmailInputSchema = z
  .union([z.string().max(320), z.null()])
  .optional()
  .transform((v) => (typeof v === "string" && v.trim() !== "" ? v : null))
  .pipe(EmailSchema.nullable())

const ShortReasonSchema = z.string().trim().max(200, "Como mucho 200 caracteres.")

const TableIdsSchema = z
  .array(DocIdSchema)
  .max(6, "Como mucho 6 mesas.")
  .refine((ids) => new Set(ids).size === ids.length, "Hay mesas repetidas.")

const StaffLocationSchema = { restaurantId: DocIdSchema, locationId: DocIdSchema }

const PublicDepositSchema = DepositSchema.pick({ status: true, amountCents: true })

const OkSchema = z.literal(true)

/* consultarDisponibilidad (pública) ----------------------------------------- */

export const ConsultarDisponibilidadInputSchema = z.strictObject({
  slug: SlugSchema,
  locationId: DocIdSchema,
  date: FechaSchema,
  partySize: PartySizeSchema,
})

/** Por qué una franja no está libre (los mismos motivos que el motor, en inglés). */
export const SLOT_REASONS = ["min_notice", "max_advance", "slot_capacity", "shift_capacity", "no_table"] as const
export const SlotReasonSchema = z.enum(SLOT_REASONS)
export type SlotReason = z.infer<typeof SlotReasonSchema>

export const AvailabilitySlotSchema = z.object({
  /** Hora de pared de la franja: lo que se manda luego como `time`. */
  time: HoraSchema,
  /** Fecha de pared (el día siguiente si el turno cruza la medianoche). */
  wallDate: FechaSchema,
  startAt: MillisSchema,
  shift: z.string(),
  available: z.boolean(),
  reason: SlotReasonSchema.nullable(),
})
export type AvailabilitySlot = z.infer<typeof AvailabilitySlotSchema>

export const AVAILABILITY_STATUSES = ["open", "closed", "party_size_not_allowed"] as const

export const ConsultarDisponibilidadOutputSchema = z.object({
  date: FechaSchema,
  partySize: z.number().int(),
  durationMinutes: z.number().int(),
  timezone: ZonaHorariaSchema,
  status: z.enum(AVAILABILITY_STATUSES),
  /** Explicación en castellano del motor (cerrado, grupo no admitido), o null. */
  message: z.string().nullable(),
  slots: z.array(AvailabilitySlotSchema),
  /** Si se puede ofrecer apuntarse a la lista de espera. */
  waitlistEnabled: z.boolean(),
})
export type AvailabilityOutput = z.infer<typeof ConsultarDisponibilidadOutputSchema>

/* crearReservaPublica (pública) --------------------------------------------- */

export const CrearReservaPublicaInputSchema = z.strictObject({
  slug: SlugSchema,
  locationId: DocIdSchema,
  date: FechaSchema,
  time: HoraSchema,
  partySize: PartySizeSchema,
  guestName: GuestNameSchema,
  phone: PhoneInputSchema,
  email: OptionalEmailInputSchema,
  language: LanguageSchema,
  guestNotes: NotesSchema.default(""),
  /** Ha aceptado la política de reservas y cancelación. */
  acceptPolicy: z.literal(true, "Tienes que aceptar la política de reservas."),
  source: z.enum(["web", "widget"]).default("web"),
  website: HoneypotSchema,
  /**
   * Fase 5 (ampliación aditiva, opcional): de dónde viene la reserva (utm, referente, campaña).
   * El servidor la limpia con `classifyOrigin` y la guarda en `reservationOrigins`.
   */
  attribution: ReservationAttributionInputSchema.optional(),
  /** Fase 5 (opcional): casillas de permiso de marketing, desmarcadas por defecto. */
  marketingOptIn: PublicMarketingOptInSchema.optional(),
})

export const CrearReservaPublicaOutputSchema = z.object({
  reference: ReservationReferenceSchema,
  status: ReservationStatusSchema,
  /** Token del enlace de gestión. Solo se devuelve aquí; no se guarda. */
  manageToken: LinkTokenSchema,
  startAt: MillisSchema,
  deposit: PublicDepositSchema,
})

/* verReservaPublica y gestionarReservaPublica (con el enlace) ---------------- */

const PublicLinkSchema = {
  slug: SlugSchema,
  reference: ReservationReferenceInputSchema,
  token: LinkTokenSchema,
}

export const VerReservaPublicaInputSchema = z.strictObject(PublicLinkSchema)

/** Lo que ve el cliente de su reserva, sin datos del personal. */
export const PublicReservationViewSchema = z.object({
  reference: ReservationReferenceSchema,
  status: ReservationStatusSchema,
  guestName: z.string(),
  partySize: z.number().int(),
  startAt: MillisSchema,
  durationMinutes: z.number().int(),
  timezone: ZonaHorariaSchema,
  locationId: DocIdSchema,
  locationName: z.string(),
  guestNotes: z.string(),
  deposit: PublicDepositSchema,
  /** Hasta cuándo se cancela gratis (ms UTC), o null si siempre. */
  freeCancellationUntil: MillisSchema.nullable(),
  canConfirm: z.boolean(),
  canCancel: z.boolean(),
})
export type PublicReservationView = z.infer<typeof PublicReservationViewSchema>

export const VerReservaPublicaOutputSchema = PublicReservationViewSchema

export const GestionarReservaPublicaInputSchema = z.strictObject({
  ...PublicLinkSchema,
  action: z.enum(["confirm", "cancel"]),
  reason: ShortReasonSchema.optional(),
  website: HoneypotSchema,
})

export const GestionarReservaPublicaOutputSchema = PublicReservationViewSchema

/* crearReserva (personal) ---------------------------------------------------- */

export const CrearReservaInputSchema = z.strictObject({
  ...StaffLocationSchema,
  date: FechaSchema,
  time: HoraSchema,
  partySize: PartySizeSchema,
  guestName: GuestNameSchema,
  phone: PhoneInputSchema,
  email: OptionalEmailInputSchema,
  language: LanguageSchema.default("es"),
  source: z.enum(["phone", "walk_in"]),
  /** Una reserva en el local puede entrar ya sentada. */
  status: z.enum(["pending", "confirmed", "seated"]).default("confirmed"),
  notes: NotesSchema.default(""),
  guestNotes: NotesSchema.default(""),
  /** Mesas elegidas por el personal; vacío = sin mesa (se guarda la propuesta del motor). */
  tableIds: TableIdsSchema.default([]),
  /** Duración a medida; si falta, la de los tramos. */
  durationMinutes: z.number().int().min(15).max(24 * 60).optional(),
  /** El personal se salta la antelación y el tamaño de grupo de la web. */
  skipWebLimits: z.boolean().default(true),
})

export const CrearReservaOutputSchema = z.object({
  reservationId: DocIdSchema,
  reference: ReservationReferenceSchema,
  status: ReservationStatusSchema,
  startAt: MillisSchema,
  tableIds: z.array(DocIdSchema),
  suggestedTableIds: z.array(DocIdSchema),
})

/* cambiarEstadoReserva, asignarMesas, moverReserva (personal) ---------------- */

const StaffReservationSchema = { ...StaffLocationSchema, reservationId: DocIdSchema }

export const CambiarEstadoReservaInputSchema = z.strictObject({
  ...StaffReservationSchema,
  status: ReservationStatusSchema,
  reason: ShortReasonSchema.nullable().optional(),
})

export const CambiarEstadoReservaOutputSchema = z.object({ ok: OkSchema, status: ReservationStatusSchema })

export const AsignarMesasInputSchema = z.strictObject({
  ...StaffReservationSchema,
  /** Vacío = quitar la mesa. */
  tableIds: TableIdsSchema,
})

export const AsignarMesasOutputSchema = z.object({ ok: OkSchema, tableIds: z.array(DocIdSchema) })

export const MoverReservaInputSchema = z.strictObject({
  ...StaffReservationSchema,
  date: FechaSchema,
  time: HoraSchema,
  partySize: PartySizeSchema.optional(),
  durationMinutes: z.number().int().min(15).max(24 * 60).optional(),
  /** Mesas nuevas. Si falta, se conservan si siguen libres y si no se quitan. */
  tableIds: TableIdsSchema.optional(),
})

export const MoverReservaOutputSchema = z.object({
  ok: OkSchema,
  startAt: MillisSchema,
  durationMinutes: z.number().int(),
  tableIds: z.array(DocIdSchema),
})

/* proponerMesasReserva (personal) --------------------------------------------- */

/**
 * Para una reserva que existe (`reservationId`) o para una que se está creando
 * (`date`, `time` y `partySize`). Si llegan las dos cosas, lo explícito cambia la reserva
 * (por ejemplo, ver mesas para otra hora antes de moverla).
 */
export const ProponerMesasReservaInputSchema = z
  .strictObject({
    ...StaffLocationSchema,
    reservationId: DocIdSchema.optional(),
    date: FechaSchema.optional(),
    time: HoraSchema.optional(),
    partySize: PartySizeSchema.optional(),
    durationMinutes: z.number().int().min(15).max(24 * 60).optional(),
    preferredAreaId: DocIdSchema.nullable().optional(),
    limit: z.number().int().min(1).max(10).default(3),
  })
  .superRefine((v, ctx) => {
    if (v.reservationId) return
    for (const campo of ["date", "time", "partySize"] as const) {
      if (v[campo] === undefined) {
        ctx.addIssue({ code: "custom", path: [campo], message: "Sin reserva, hacen falta fecha, hora y comensales." })
      }
    }
  })

export const DISCARD_REASONS = ["disabled", "occupied", "too_small", "would_leave_without_table", "not_checked"] as const
export const DiscardReasonSchema = z.enum(DISCARD_REASONS)
export type DiscardReason = z.infer<typeof DiscardReasonSchema>

export const TableProposalSchema = z.object({
  tableIds: z.array(DocIdSchema),
  tableNames: z.array(z.string()),
  seats: z.number().int(),
  /** Plazas que sobran. */
  spare: z.number().int(),
  /** Si son varias mesas juntas. */
  joined: z.boolean(),
  /** null si no se pidió zona. */
  inPreferredArea: z.boolean().nullable(),
  /** Explicación en castellano para el encargado. */
  explanation: z.string(),
})
export type TableProposal = z.infer<typeof TableProposalSchema>

export const TableDiscardSchema = z.object({
  tableIds: z.array(DocIdSchema),
  tableNames: z.array(z.string()),
  reason: DiscardReasonSchema,
  explanation: z.string(),
  /** Reservas con las que choca o a las que dejaría sin sitio. */
  reservationIds: z.array(DocIdSchema),
})
export type TableDiscard = z.infer<typeof TableDiscardSchema>

export const ProponerMesasReservaOutputSchema = z.object({
  startAt: MillisSchema,
  partySize: z.number().int(),
  durationMinutes: z.number().int(),
  /** De mejor a peor; la primera es la recomendada. */
  proposals: z.array(TableProposalSchema),
  totalOptions: z.number().int(),
  discards: z.array(TableDiscardSchema),
  /** Una frase para el encargado. */
  summary: z.string(),
})
export type TableProposals = z.infer<typeof ProponerMesasReservaOutputSchema>

/* guardarConfiguracionReservas (personal) ------------------------------------- */

export const GuardarConfiguracionReservasInputSchema = z.strictObject({
  ...StaffLocationSchema,
  settings: ReservationSettingsSchema,
})

export const GuardarConfiguracionReservasOutputSchema = z.object({ ok: OkSchema })

/* importarReservas (personal) ------------------------------------------------- */

export const IMPORT_MAX_ROWS = 500

/**
 * Una fila tal cual sale de la hoja de cálculo (columnas ya renombradas a los campos de
 * `ImportRowSchema`). Se valida fila a fila con `ImportRowSchema` para poder devolver
 * los errores de cada una sin rechazar el resto.
 */
export const ImportRowRawSchema = z
  .record(z.string().max(40), z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]))
  .refine((fila) => Object.keys(fila).length <= 30, "Demasiadas columnas.")

export const ImportarReservasInputSchema = z.strictObject({
  ...StaffLocationSchema,
  rows: z.array(ImportRowRawSchema).min(1, "No hay filas.").max(IMPORT_MAX_ROWS, `Como mucho ${IMPORT_MAX_ROWS} filas.`),
  /** Solo comprobar, sin crear nada. */
  dryRun: z.boolean().default(false),
})

/** Valores de una celda: texto (o número, que se pasa a texto). Vacío = ausente. */
const celda = z
  .union([z.string(), z.number(), z.boolean(), z.null()])
  .optional()
  .transform((v) => (v === null || v === undefined ? undefined : String(v).trim() || undefined))

/** «2026-11-09», «9/11/2026» o «09-11-2026» → «2026-11-09». */
export function normalizeImportDate(raw: string): string | null {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw)
  const es = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(raw)
  const partes = iso ? [iso[1], iso[2], iso[3]] : es ? [es[3], es[2], es[1]] : null
  if (!partes) return null
  const [a, m, d] = partes
  const fecha = `${a}-${(m ?? "").padStart(2, "0")}-${(d ?? "").padStart(2, "0")}`
  return esFechaValida(fecha) ? fecha : null
}

/** «9:30», «09:30» o «09:30:00» → «09:30». */
export function normalizeImportTime(raw: string): string | null {
  const m = /^(\d{1,2})[:.h](\d{2})(?::\d{2})?$/.exec(raw)
  if (!m) return null
  const hora = `${(m[1] ?? "").padStart(2, "0")}:${m[2]}`
  return HoraSchema.safeParse(hora).success ? hora : null
}

/** Estados que se aceptan al importar: los del contrato o en castellano. */
const ESTADO_IMPORTADO: Record<string, ReservationStatus> = {
  pendiente: "pending",
  confirmada: "confirmed",
  sentada: "seated",
  terminada: "finished",
  cancelada: "cancelled",
  "no presentada": "no_show",
  no_presentada: "no_show",
}

export function normalizeImportStatus(raw: string): ReservationStatus | null {
  const t = raw.trim().toLowerCase()
  if ((RESERVATION_STATUSES as readonly string[]).includes(t)) return t as ReservationStatus
  return ESTADO_IMPORTADO[t] ?? null
}

const obligatorio = (mensaje: string) => celda.pipe(z.string(mensaje))

function convertir<T>(normalizar: (raw: string) => T | null, mensaje: string) {
  return (raw: string, ctx: z.RefinementCtx): T => {
    const valor = normalizar(raw)
    if (valor === null) {
      ctx.addIssue({ code: "custom", message: mensaje })
      return z.NEVER
    }
    return valor
  }
}

const entero = (mensaje: string) =>
  z.string().regex(/^\d+$/, mensaje).transform(Number)

/** Una fila ya validada: lo que la función convierte en reserva (`source: "import"`). */
export const ImportRowSchema = z.object({
  guestName: obligatorio("Falta el nombre.").pipe(GuestNameSchema),
  phone: obligatorio("Falta el teléfono.").pipe(PhoneInputSchema),
  email: celda.transform((v) => v ?? null).pipe(EmailSchema.nullable()),
  date: obligatorio("Falta la fecha.").transform(convertir(normalizeImportDate, "Fecha no válida: usa 2026-11-09 o 9/11/2026.")),
  time: obligatorio("Falta la hora.").transform(convertir(normalizeImportTime, "Hora no válida: usa 13:30.")),
  partySize: obligatorio("Faltan los comensales.").pipe(entero("Comensales no válidos.")).pipe(PartySizeSchema),
  durationMinutes: celda.pipe(entero("Duración no válida: escribe los minutos.").pipe(z.number().int().min(15).max(24 * 60)).optional()),
  status: celda
    .transform((v, ctx) => (v === undefined ? "confirmed" : convertir(normalizeImportStatus, `Estado no válido: ${v}.`)(v, ctx)))
    .pipe(ReservationStatusSchema),
  language: celda.transform((v) => v?.toLowerCase() ?? "es").pipe(LanguageSchema),
  notes: celda.transform((v) => v ?? "").pipe(NotesSchema),
  /** Nombres de mesa separados por «+» o comas («S1+S2»). La función los busca en el plano. */
  tables: celda.transform((v) => (v ? v.split(/[+,]/).map((t) => t.trim()).filter(Boolean) : [])).pipe(z.array(z.string().max(20)).max(6)),
})
export type ImportRow = z.infer<typeof ImportRowSchema>

export const ImportRowErrorSchema = z.object({
  /** Posición de la fila en `rows`, empezando por 0. */
  row: z.number().int().min(0),
  /** Campo con el error, o null si es de la fila entera (por ejemplo, sin mesa libre). */
  field: z.string().nullable(),
  message: z.string(),
})
export type ImportRowError = z.infer<typeof ImportRowErrorSchema>

/** Valida una fila y devuelve la fila limpia o sus errores (uno por campo). */
export function parseImportRow(raw: unknown, row: number): { ok: true; value: ImportRow } | { ok: false; errors: ImportRowError[] } {
  const r = ImportRowSchema.safeParse(raw)
  if (r.success) return { ok: true, value: r.data }
  const vistos = new Set<string>()
  const errors: ImportRowError[] = []
  for (const issue of r.error.issues) {
    const field = typeof issue.path[0] === "string" ? issue.path[0] : null
    const clave = field ?? ""
    if (vistos.has(clave)) continue
    vistos.add(clave)
    errors.push({ row, field, message: issue.message })
  }
  return { ok: false, errors }
}

export const ImportarReservasOutputSchema = z.object({
  /** Reservas creadas (0 si `dryRun`). */
  created: z.number().int().min(0),
  reservationIds: z.array(DocIdSchema),
  errors: z.array(ImportRowErrorSchema),
})

/* cambiarPlan (equipo de LogiQD) ---------------------------------------------- */

export const CambiarPlanInputSchema = z.strictObject({
  restaurantId: DocIdSchema,
  plan: PlanSchema,
  moduleOverrides: ModuleOverridesSchema.default({}),
})

export const CambiarPlanOutputSchema = z.object({
  ok: OkSchema,
  plan: PlanSchema,
  activeModules: z.array(ModuleSchema),
})

/* Lista de espera (pública) ---------------------------------------------------- */

export const ApuntarseListaEsperaInputSchema = z.strictObject({
  slug: SlugSchema,
  locationId: DocIdSchema,
  date: FechaSchema,
  /** Tramo en el que le vendría bien llegar (horas de pared, incluidas). */
  from: HoraSchema,
  to: HoraSchema,
  partySize: PartySizeSchema,
  guestName: GuestNameSchema,
  phone: PhoneInputSchema,
  email: OptionalEmailInputSchema,
  language: LanguageSchema,
  source: z.enum(["web", "widget"]).default("web"),
  website: HoneypotSchema,
})

export const ApuntarseListaEsperaOutputSchema = z.object({
  waitlistId: DocIdSchema,
  status: WaitlistStatusSchema,
})

export const AceptarOfertaListaEsperaInputSchema = z.strictObject({
  slug: SlugSchema,
  waitlistId: DocIdSchema,
  token: LinkTokenSchema,
  website: HoneypotSchema,
})

/** Igual que al crear una reserva pública: la oferta aceptada se convierte en reserva. */
export const AceptarOfertaListaEsperaOutputSchema = CrearReservaPublicaOutputSchema

/* iniciarPagoSenal (con el enlace) ---------------------------------------------- */

export const IniciarPagoSenalInputSchema = z.strictObject(PublicLinkSchema)

export const IniciarPagoSenalOutputSchema = z.discriminatedUnion("status", [
  /** Abrir esta página de Stripe Checkout. */
  z.object({ status: z.literal("redirect"), url: z.string().regex(/^https:\/\/\S+$/) }),
  /** Se pide señal pero Stripe no está configurado: la web lo explica. */
  z.object({ status: z.literal("not_configured"), message: z.string() }),
  z.object({ status: z.literal("not_required") }),
  z.object({ status: z.literal("already_paid") }),
])

/* procesarMensajesPendientes (personal o equipo de LogiQD) ----------------------- */

export const ProcesarMensajesPendientesInputSchema = z.strictObject({
  /** Obligatorio para el personal (`mensajes.ver`); sin él, el equipo de LogiQD procesa todos. */
  restaurantId: DocIdSchema.optional(),
  limit: z.number().int().min(1).max(500).default(100),
})

export const ProcesarMensajesPendientesOutputSchema = z.object({
  processed: z.number().int().min(0),
  sent: z.number().int().min(0),
  captured: z.number().int().min(0),
  notConfigured: z.number().int().min(0),
  failed: z.number().int().min(0),
})

/* Tabla de esquemas -------------------------------------------------------------- */

/** Entrada y salida de cada callable de las fases 1 y 2, por nombre. */
export const CALLABLE_SCHEMAS = {
  consultarDisponibilidad: { input: ConsultarDisponibilidadInputSchema, output: ConsultarDisponibilidadOutputSchema },
  crearReservaPublica: { input: CrearReservaPublicaInputSchema, output: CrearReservaPublicaOutputSchema },
  verReservaPublica: { input: VerReservaPublicaInputSchema, output: VerReservaPublicaOutputSchema },
  gestionarReservaPublica: { input: GestionarReservaPublicaInputSchema, output: GestionarReservaPublicaOutputSchema },
  crearReserva: { input: CrearReservaInputSchema, output: CrearReservaOutputSchema },
  cambiarEstadoReserva: { input: CambiarEstadoReservaInputSchema, output: CambiarEstadoReservaOutputSchema },
  asignarMesas: { input: AsignarMesasInputSchema, output: AsignarMesasOutputSchema },
  moverReserva: { input: MoverReservaInputSchema, output: MoverReservaOutputSchema },
  proponerMesasReserva: { input: ProponerMesasReservaInputSchema, output: ProponerMesasReservaOutputSchema },
  guardarConfiguracionReservas: { input: GuardarConfiguracionReservasInputSchema, output: GuardarConfiguracionReservasOutputSchema },
  importarReservas: { input: ImportarReservasInputSchema, output: ImportarReservasOutputSchema },
  cambiarPlan: { input: CambiarPlanInputSchema, output: CambiarPlanOutputSchema },
  apuntarseListaEspera: { input: ApuntarseListaEsperaInputSchema, output: ApuntarseListaEsperaOutputSchema },
  aceptarOfertaListaEspera: { input: AceptarOfertaListaEsperaInputSchema, output: AceptarOfertaListaEsperaOutputSchema },
  iniciarPagoSenal: { input: IniciarPagoSenalInputSchema, output: IniciarPagoSenalOutputSchema },
  procesarMensajesPendientes: { input: ProcesarMensajesPendientesInputSchema, output: ProcesarMensajesPendientesOutputSchema },
  ...CALLABLE_SCHEMAS_RESERVAS_VPS,
  ...CALLABLE_SCHEMAS_PROVEEDORES_VPS,
  ...CALLABLE_SCHEMAS_FASE2,
  ...CALLABLE_SCHEMAS_FASE3,
  ...CALLABLE_SCHEMAS_FASE4,
  ...CALLABLE_SCHEMAS_FASE5,
  ...CALLABLE_SCHEMAS_FASE6,
} as const satisfies Partial<Record<CallableName, { input: z.ZodType; output: z.ZodType }>>

export type CallableWithSchema = keyof typeof CALLABLE_SCHEMAS
/** Lo que se envía a la callable (antes de validar: con valores por defecto opcionales). */
export type CallableInput<N extends CallableWithSchema> = z.input<(typeof CALLABLE_SCHEMAS)[N]["input"]>
/** Lo que recibe la función ya validado. */
export type CallableParsedInput<N extends CallableWithSchema> = z.output<(typeof CALLABLE_SCHEMAS)[N]["input"]>
/** Lo que devuelve la callable. */
export type CallableOutput<N extends CallableWithSchema> = z.output<(typeof CALLABLE_SCHEMAS)[N]["output"]>
