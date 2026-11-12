/**
 * Personal (fase 4): ajustes, fichajes, auditoría de fichajes y cuadrante.
 *
 * Todo se guarda solo desde el servidor. En Firestore las horas son `Timestamp`; en core y en
 * las callables son ms UTC. Las fechas de calendario (`date`, `weekStart`) son la fecha local
 * del restaurante (zona del restaurante) del instante de entrada o de inicio del turno.
 */
import { z } from "zod"
import { DocIdSchema } from "../model"
import { FechaSchema } from "../reservas/tiempo"
import { TimestampSchema } from "../timestamp"

export const MINUTE_MS = 60_000
/** Un fichaje o un turno no dura más de esto (16 horas). */
export const MAX_ENTRY_MINUTES = 16 * 60
export const MAX_BREAKS = 20

export const ROUNDING_STEPS = [0, 5, 10, 15] as const
export const RoundingStepSchema = z.union([z.literal(0), z.literal(5), z.literal(10), z.literal(15)])

export const StaffSettingsSchema = z.object({
  /** Redondeo del total trabajado de cada fichaje, en minutos. 0 = sin redondeo. */
  roundingMinutes: RoundingStepSchema,
  /** `nearest` redondea al más cercano (la mitad hacia arriba); `down` siempre hacia abajo. */
  roundingMode: z.enum(["nearest", "down"]),
  /** true: las pausas cuentan como tiempo trabajado. false (por defecto): se descuentan. */
  breaksPaid: z.boolean(),
  /** Un fichaje abierto más de este tiempo se marca como olvidado. */
  forgottenAfterMinutes: z.number().int().min(240).max(1440),
  /** Puesto de fichaje en una tableta del local (con PIN y sesión de encargado). */
  kioskEnabled: z.boolean(),
  /** Tolerancia al comparar la entrada con el turno planificado. */
  lateToleranceMinutes: z.number().int().min(0).max(60),
  /** Avisos orientativos del cuadrante (no bloquean): descanso entre turnos y horas por semana. */
  minRestMinutes: z.number().int().min(0).max(1440),
  maxWeeklyMinutes: z.number().int().min(0).max(10080),
})
export type StaffSettings = z.infer<typeof StaffSettingsSchema>

/** Valores de partida: sin redondeo, pausas descontadas, 12 h de descanso y 40 h por semana. */
export function defaultStaffSettings(): StaffSettings {
  return {
    roundingMinutes: 0, roundingMode: "nearest", breaksPaid: false, forgottenAfterMinutes: 720,
    kioskEnabled: false, lateToleranceMinutes: 10, minRestMinutes: 720, maxWeeklyMinutes: 2400,
  }
}

/** Instantes de un fichaje, en ms UTC truncados al minuto por el servidor. */
export const BreakSchema = z.object({ startAt: TimestampSchema, endAt: TimestampSchema.nullable() })
export type EntryBreak = z.infer<typeof BreakSchema>

export const TIME_ENTRY_STATUSES = ["open", "closed", "voided"] as const
export type TimeEntryStatus = (typeof TIME_ENTRY_STATUSES)[number]
export const CLOCK_SOURCES = ["self", "kiosk", "manager"] as const
export type ClockSource = (typeof CLOCK_SOURCES)[number]

export const TimeEntrySchema = z.object({
  uid: z.string().min(1).max(128),
  /** Fecha local de la entrada. El fichaje pertenece a ese día aunque cruce la medianoche. */
  date: FechaSchema,
  startAt: TimestampSchema,
  endAt: TimestampSchema.nullable(),
  breaks: z.array(BreakSchema).max(MAX_BREAKS),
  status: z.enum(TIME_ENTRY_STATUSES),
  startSource: z.enum(CLOCK_SOURCES),
  endSource: z.enum(CLOCK_SOURCES).nullable(),
  shiftId: DocIdSchema.nullable(),
  /** Lo marca el proceso de revisión al pasar `forgottenAfterMinutes` con el fichaje abierto. */
  forgotten: z.boolean(),
  /** Pendiente de que un encargado lo revise (creado, cerrado o corregido por un encargado). */
  needsReview: z.boolean(),
  /** Derivado por el servidor al cerrar, con el redondeo de ese momento. null mientras está abierto. */
  workedMinutes: z.number().int().min(0).nullable(),
  breakMinutes: z.number().int().min(0),
  note: z.string().trim().max(200).nullable(),
  revision: z.number().int().min(1),
}).superRefine((v, ctx) => {
  if (v.status === "open" && v.endAt !== null) ctx.addIssue({ code: "custom", message: "Un fichaje abierto no tiene salida." })
  if (v.status === "closed" && (v.endAt === null || v.workedMinutes === null)) ctx.addIssue({ code: "custom", message: "Un fichaje cerrado necesita salida y minutos." })
  if (v.endAt !== null && v.endAt < v.startAt) ctx.addIssue({ code: "custom", message: "La salida no puede ser anterior a la entrada." })
})
export type TimeEntry = z.infer<typeof TimeEntrySchema>
export type TimeEntryWithId = TimeEntry & { id: string }

export const TIME_EVENT_KINDS = [
  "clock_in", "break_start", "break_end", "clock_out",
  "manual_create", "correction", "close_forgotten", "void",
] as const
export type TimeEventKind = (typeof TIME_EVENT_KINDS)[number]

/** Foto de los instantes de un fichaje, antes o después de un cambio. */
export const EntrySnapshotSchema = z.object({
  startAt: TimestampSchema, endAt: TimestampSchema.nullable(), breaks: z.array(BreakSchema).max(MAX_BREAKS),
})

/** Auditoría inmutable: cada cambio de un fichaje es un documento nuevo, nunca se edita. */
export const TimeEntryEventSchema = z.object({
  entryId: DocIdSchema,
  uid: z.string().min(1).max(128),
  kind: z.enum(TIME_EVENT_KINDS),
  at: TimestampSchema,
  by: z.string().min(1).max(128),
  source: z.enum(CLOCK_SOURCES),
  reason: z.string().trim().min(1).max(200).nullable(),
  before: EntrySnapshotSchema.nullable(),
  after: EntrySnapshotSchema.nullable(),
}).superRefine((v, ctx) => {
  const needsReason: TimeEventKind[] = ["manual_create", "correction", "close_forgotten", "void"]
  if (needsReason.includes(v.kind) && !v.reason) ctx.addIssue({ code: "custom", message: "Escribe el motivo." })
})
export type TimeEntryEvent = z.infer<typeof TimeEntryEventSchema>

/** PIN del puesto de fichaje: solo servidor, nunca en claro. */
export const PinSchema = z.string().regex(/^\d{4,6}$/, "El PIN lleva de 4 a 6 cifras.")
export const PinRecordSchema = z.object({
  pinHash: z.string().regex(/^[0-9a-f]{64}$/), salt: z.string().regex(/^[0-9a-f]{32}$/),
  failedAttempts: z.number().int().min(0), lockedUntil: TimestampSchema.nullable(),
})
export type PinRecord = z.infer<typeof PinRecordSchema>

export const STAFF_SHIFT_STATUSES = ["draft", "published"] as const
export const StaffShiftEditableSchema = z.object({
  uid: z.string().min(1).max(128),
  startAt: TimestampSchema,
  endAt: TimestampSchema,
  /** Puesto escrito por el encargado: «Sala», «Cocina»… */
  position: z.string().trim().min(1).max(40),
  note: z.string().trim().max(200),
}).superRefine((v, ctx) => {
  if (v.endAt <= v.startAt) ctx.addIssue({ code: "custom", message: "El turno acaba después de empezar." })
  else if ((v.endAt - v.startAt) / MINUTE_MS > MAX_ENTRY_MINUTES) ctx.addIssue({ code: "custom", message: "Un turno no pasa de 16 horas." })
})
export const StaffShiftSchema = StaffShiftEditableSchema.and(z.object({
  date: FechaSchema,
  /** Lunes de la semana a la que pertenece, por la fecha de inicio. */
  weekStart: FechaSchema,
  status: z.enum(STAFF_SHIFT_STATUSES),
  publishedAt: TimestampSchema.nullable(),
  revision: z.number().int().min(1),
}))
export type StaffShift = z.infer<typeof StaffShiftSchema>
export type StaffShiftWithId = StaffShift & { id: string }

type Convert<H> = (ms: number) => H
export function timeEntryForWrite<H>(v: TimeEntry, convert: Convert<H>) {
  return {
    ...v, startAt: convert(v.startAt), endAt: v.endAt === null ? null : convert(v.endAt),
    breaks: v.breaks.map((b) => ({ startAt: convert(b.startAt), endAt: b.endAt === null ? null : convert(b.endAt) })),
  }
}
function snapshotForWrite<H>(s: z.infer<typeof EntrySnapshotSchema> | null, convert: Convert<H>) {
  if (!s) return null
  return { startAt: convert(s.startAt), endAt: s.endAt === null ? null : convert(s.endAt),
    breaks: s.breaks.map((b) => ({ startAt: convert(b.startAt), endAt: b.endAt === null ? null : convert(b.endAt) })) }
}
export function timeEntryEventForWrite<H>(v: TimeEntryEvent, convert: Convert<H>) {
  return { ...v, at: convert(v.at), before: snapshotForWrite(v.before, convert), after: snapshotForWrite(v.after, convert) }
}
export function staffShiftForWrite<H>(v: StaffShift, convert: Convert<H>) {
  return { ...v, startAt: convert(v.startAt), endAt: convert(v.endAt), publishedAt: v.publishedAt === null ? null : convert(v.publishedAt) }
}
export function pinRecordForWrite<H>(v: PinRecord, convert: Convert<H>) {
  return { ...v, lockedUntil: v.lockedUntil === null ? null : convert(v.lockedUntil) }
}
