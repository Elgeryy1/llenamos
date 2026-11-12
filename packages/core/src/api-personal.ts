/**
 * Callables de personal (fase 4): fichaje, horas y cuadrante. Región europe-west1.
 *
 * Entradas estrictas e instantes en ms UTC. **Fichar nunca recibe una hora**: el servidor usa su
 * reloj (truncado al minuto). Solo un encargado puede crear o corregir horas, con motivo. El
 * autor sale de Auth, jamás de la entrada. Toda mutación lleva `requestId` y repetirla con la
 * misma entrada devuelve el resultado original (por ejemplo, un «entrada» repetido por mala
 * cobertura no da «ya tienes el fichaje abierto»). Este archivo no importa `api.ts`.
 */
import { z } from "zod"
import { DocIdSchema } from "./model"
import { FechaSchema } from "./reservas/tiempo"
import { MillisSchema } from "./timestamp"
import type { Module } from "./modules"
import type { Permission } from "./roles"
import { CLOCK_ACTIONS } from "./personal/fichaje"
import { MAX_BREAKS, MAX_ENTRY_MINUTES, MINUTE_MS, PinSchema, StaffSettingsSchema, TimeEntrySchema, TimeEntryEventSchema } from "./personal/modelo"

const Scope = { restaurantId: DocIdSchema, locationId: DocIdSchema }
const Mutation = { ...Scope, requestId: DocIdSchema }
const Ok = z.literal(true)
const Uid = z.string().min(1).max(128)
const Reason = z.string().trim().min(1, "Escribe el motivo.").max(200)
const Revision = z.number().int().min(1)
const BreakInput = z.strictObject({ startAt: MillisSchema, endAt: MillisSchema.nullable() })
const ClockState = z.enum(["out", "working", "on_break"])

export const ShiftInputSchema = z.strictObject({
  uid: Uid, startAt: MillisSchema, endAt: MillisSchema,
  position: z.string().trim().min(1).max(40), note: z.string().trim().max(200).default(""),
}).superRefine((v, ctx) => {
  if (v.endAt <= v.startAt) ctx.addIssue({ code: "custom", message: "El turno acaba después de empezar." })
  else if ((v.endAt - v.startAt) / MINUTE_MS > MAX_ENTRY_MINUTES) ctx.addIssue({ code: "custom", message: "Un turno no pasa de 16 horas." })
})

export const ScheduleWarningSchema = z.object({
  kind: z.enum(["overlap", "short_rest", "weekly_hours"]), uid: Uid, shiftIds: z.array(DocIdSchema), message: z.string(),
})
export const HoursRowSchema = z.object({
  uid: Uid, minutes: z.number().int().min(0), entries: z.number().int().min(0), openEntries: z.number().int().min(0),
  forgottenEntries: z.number().int().min(0), provisionalMinutes: z.number().int().min(0),
  byDate: z.record(FechaSchema, z.number().int().min(0)),
})

export const GuardarConfiguracionPersonalInputSchema = z.strictObject({ ...Mutation, settings: StaffSettingsSchema })
export const GuardarConfiguracionPersonalOutputSchema = z.object({ ok: Ok })

export const FicharInputSchema = z.strictObject({ ...Mutation, action: z.enum(CLOCK_ACTIONS), note: z.string().trim().max(200).nullable().default(null) })
export const FicharOutputSchema = z.object({ entryId: DocIdSchema, state: ClockState, at: MillisSchema, workedMinutes: z.number().int().min(0).nullable() })

/** Fichar a otra persona desde la tableta del local: sesión de encargado y PIN de esa persona. */
export const FicharEnPuestoInputSchema = z.strictObject({ ...Mutation, uid: Uid, pin: PinSchema, action: z.enum(CLOCK_ACTIONS) })
export const FicharEnPuestoOutputSchema = FicharOutputSchema
export const GuardarPinFichajeInputSchema = z.strictObject({ ...Mutation, uid: Uid, pin: PinSchema.nullable() })
export const GuardarPinFichajeOutputSchema = z.object({ ok: Ok })

export const CrearFichajeManualInputSchema = z.strictObject({
  ...Mutation, uid: Uid, startAt: MillisSchema, endAt: MillisSchema, breaks: z.array(BreakInput.extend({ endAt: MillisSchema })).max(MAX_BREAKS), reason: Reason,
})
export const CrearFichajeManualOutputSchema = z.object({ entryId: DocIdSchema, workedMinutes: z.number().int().min(0) })
export const CorregirFichajeInputSchema = z.strictObject({
  ...Mutation, entryId: DocIdSchema, expectedRevision: Revision, startAt: MillisSchema, endAt: MillisSchema,
  breaks: z.array(BreakInput.extend({ endAt: MillisSchema })).max(MAX_BREAKS), reason: Reason,
})
export const CorregirFichajeOutputSchema = z.object({ revision: Revision, workedMinutes: z.number().int().min(0) })
/** Cierra un fichaje olvidado a la hora indicada; una pausa abierta se cierra a esa misma hora. */
export const CerrarFichajeOlvidadoInputSchema = z.strictObject({ ...Mutation, entryId: DocIdSchema, expectedRevision: Revision, endAt: MillisSchema, reason: Reason })
export const CerrarFichajeOlvidadoOutputSchema = CorregirFichajeOutputSchema
export const AnularFichajeInputSchema = z.strictObject({ ...Mutation, entryId: DocIdSchema, expectedRevision: Revision, reason: Reason })
export const AnularFichajeOutputSchema = z.object({ ok: Ok })

export const InformeHorasInputSchema = z.strictObject({ ...Scope, from: FechaSchema, to: FechaSchema, uid: Uid.nullable() }).refine((v) => v.from <= v.to, "El periodo está al revés.")
export const InformeHorasOutputSchema = z.object({ rows: z.array(HoursRowSchema) })

/**
 * Exportación del registro de jornada de una persona (DECISIONES 2026-11-12). Con `uid` null es el propio; el de otra
 * persona lo pide un encargado a petición del trabajador. Incluye lo que el servidor conserva, anonimizado pasados
 * `FICHAJES_RETENCION_ANIOS`. Si no cabe entero, falla: nunca entrega un recorte.
 */
export const FICHAJES_RETENCION_ANIOS = 4
export const ExportarMisFichajesInputSchema = z.strictObject({ ...Scope, uid: Uid.nullable() })
export const ExportarMisFichajesOutputSchema = z.object({
  uid: Uid, generatedAt: MillisSchema, retentionYears: z.literal(FICHAJES_RETENCION_ANIOS),
  entries: z.array(TimeEntrySchema.extend({ id: DocIdSchema })),
  events: z.array(TimeEntryEventSchema.extend({ id: DocIdSchema })),
})

export const GuardarTurnoInputSchema = z.strictObject({ ...Mutation, shiftId: DocIdSchema.nullable(), expectedRevision: Revision.nullable(), shift: ShiftInputSchema })
export const GuardarTurnoOutputSchema = z.object({ shiftId: DocIdSchema, revision: Revision, warnings: z.array(ScheduleWarningSchema) })
export const BorrarTurnoInputSchema = z.strictObject({ ...Mutation, shiftId: DocIdSchema, expectedRevision: Revision })
export const BorrarTurnoOutputSchema = z.object({ ok: Ok })
export const PublicarCuadranteInputSchema = z.strictObject({ ...Mutation, weekStart: FechaSchema, publish: z.boolean() })
export const PublicarCuadranteOutputSchema = z.object({ shifts: z.number().int().min(0), warnings: z.array(ScheduleWarningSchema) })
export const CopiarSemanaCuadranteInputSchema = z.strictObject({ ...Mutation, fromWeekStart: FechaSchema, toWeekStart: FechaSchema }).refine((v) => v.fromWeekStart !== v.toWeekStart, "Elige otra semana de destino.")
export const CopiarSemanaCuadranteOutputSchema = z.object({ copied: z.number().int().min(0), skipped: z.array(z.object({ shiftId: DocIdSchema, reason: z.string() })) })

/** Para el reparto de propinas de la fase 3: minutos fichados dentro de la ventana de esa caja. */
export const HorasParaPropinasInputSchema = z.strictObject({ ...Scope, cashSessionId: DocIdSchema })
export const HorasParaPropinasOutputSchema = z.object({
  hours: z.array(z.object({ uid: Uid, minutes: z.number().int().min(1) })),
  incomplete: z.array(Uid),
  windowStart: MillisSchema, windowEnd: MillisSchema,
})

export const CALLABLES_FASE4_PERSONAL = {
  guardarConfiguracionPersonal: "guardarConfiguracionPersonal",
  fichar: "fichar",
  ficharEnPuesto: "ficharEnPuesto",
  guardarPinFichaje: "guardarPinFichaje",
  crearFichajeManual: "crearFichajeManual",
  corregirFichaje: "corregirFichaje",
  cerrarFichajeOlvidado: "cerrarFichajeOlvidado",
  anularFichaje: "anularFichaje",
  informeHoras: "informeHoras",
  exportarMisFichajes: "exportarMisFichajes",
  guardarTurno: "guardarTurno",
  borrarTurno: "borrarTurno",
  publicarCuadrante: "publicarCuadrante",
  copiarSemanaCuadrante: "copiarSemanaCuadrante",
  horasParaPropinas: "horasParaPropinas",
} as const

export const CALLABLE_SCHEMAS_FASE4_PERSONAL = {
  guardarConfiguracionPersonal: { input: GuardarConfiguracionPersonalInputSchema, output: GuardarConfiguracionPersonalOutputSchema },
  fichar: { input: FicharInputSchema, output: FicharOutputSchema },
  ficharEnPuesto: { input: FicharEnPuestoInputSchema, output: FicharEnPuestoOutputSchema },
  guardarPinFichaje: { input: GuardarPinFichajeInputSchema, output: GuardarPinFichajeOutputSchema },
  crearFichajeManual: { input: CrearFichajeManualInputSchema, output: CrearFichajeManualOutputSchema },
  corregirFichaje: { input: CorregirFichajeInputSchema, output: CorregirFichajeOutputSchema },
  cerrarFichajeOlvidado: { input: CerrarFichajeOlvidadoInputSchema, output: CerrarFichajeOlvidadoOutputSchema },
  anularFichaje: { input: AnularFichajeInputSchema, output: AnularFichajeOutputSchema },
  informeHoras: { input: InformeHorasInputSchema, output: InformeHorasOutputSchema },
  exportarMisFichajes: { input: ExportarMisFichajesInputSchema, output: ExportarMisFichajesOutputSchema },
  guardarTurno: { input: GuardarTurnoInputSchema, output: GuardarTurnoOutputSchema },
  borrarTurno: { input: BorrarTurnoInputSchema, output: BorrarTurnoOutputSchema },
  publicarCuadrante: { input: PublicarCuadranteInputSchema, output: PublicarCuadranteOutputSchema },
  copiarSemanaCuadrante: { input: CopiarSemanaCuadranteInputSchema, output: CopiarSemanaCuadranteOutputSchema },
  horasParaPropinas: { input: HorasParaPropinasInputSchema, output: HorasParaPropinasOutputSchema },
} as const satisfies Record<keyof typeof CALLABLES_FASE4_PERSONAL, { input: z.ZodType; output: z.ZodType }>

/**
 * Permiso y módulos base de cada callable. Además: sesión de Auth, miembro activo y acceso al local.
 * `per_target`: `informeHoras` y `exportarMisFichajes` con el uid propio basta con `fichaje.registrar`; con el de otra
 * persona o sin uid exige `personal.gestionar`.
 */
export const FASE4_PERSONAL_ACCESS: Record<keyof typeof CALLABLES_FASE4_PERSONAL, { permission: Permission | "per_target"; modules: readonly Module[] }> = {
  guardarConfiguracionPersonal: { permission: "personal.gestionar", modules: ["staff"] },
  fichar: { permission: "fichaje.registrar", modules: ["staff"] },
  ficharEnPuesto: { permission: "personal.gestionar", modules: ["staff"] },
  guardarPinFichaje: { permission: "personal.gestionar", modules: ["staff"] },
  crearFichajeManual: { permission: "personal.gestionar", modules: ["staff"] },
  corregirFichaje: { permission: "personal.gestionar", modules: ["staff"] },
  cerrarFichajeOlvidado: { permission: "personal.gestionar", modules: ["staff"] },
  anularFichaje: { permission: "personal.gestionar", modules: ["staff"] },
  informeHoras: { permission: "per_target", modules: ["staff"] },
  exportarMisFichajes: { permission: "per_target", modules: ["staff"] },
  guardarTurno: { permission: "personal.gestionar", modules: ["staff"] },
  borrarTurno: { permission: "personal.gestionar", modules: ["staff"] },
  publicarCuadrante: { permission: "personal.gestionar", modules: ["staff"] },
  copiarSemanaCuadrante: { permission: "personal.gestionar", modules: ["staff"] },
  horasParaPropinas: { permission: "caja.gestionar", modules: ["staff", "pos"] },
}
