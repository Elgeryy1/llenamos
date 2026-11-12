/**
 * Lecturas en vivo de personal en modo VPS: nombre, entrada y salida. Las comparten la API y la web
 * (`useLiveQuery`), igual que las callables. Siempre acotadas por fecha, estado, semana o id.
 */
import { z } from "zod"
import { DocIdSchema } from "../model"
import { FechaSchema } from "../reservas/tiempo"
import { StaffSettingsSchema, StaffShiftSchema, TimeEntryEventSchema, TimeEntrySchema } from "./modelo"

export const PERSONAL_LIVE = {
  fichajes: "personalFichajes",
  abiertos: "personalFichajesAbiertos",
  turnos: "personalTurnos",
  eventos: "personalEventosFichaje",
  ajustes: "personalAjustes",
} as const

const Scope = z.strictObject({ restaurantId: DocIdSchema, locationId: DocIdSchema })
const withId = <S extends z.ZodType>(schema: S) => z.intersection(schema, z.object({ id: DocIdSchema }))
const Entry = withId(TimeEntrySchema)

/** Fichajes por fecha de entrada; periodo de 93 días como máximo. Los de otra persona o los de todos, solo para quien gestiona. */
export const PersonalFichajesInputSchema = Scope.extend({
  from: FechaSchema, to: FechaSchema, uid: z.string().min(1).max(128).nullable().default(null), max: z.number().int().min(1).max(5000).default(2000),
})
export const PersonalFichajesOutputSchema = z.object({ entries: z.array(Entry) })
export const PersonalAbiertosOutputSchema = z.object({ entries: z.array(Entry) })
export const PersonalTurnosInputSchema = Scope.extend({ weekStart: FechaSchema, onlyPublished: z.boolean().default(false) })
export const PersonalTurnosOutputSchema = z.object({ shifts: z.array(withId(StaffShiftSchema)) })
export const PersonalEventosInputSchema = Scope.extend({ entryId: DocIdSchema })
export const PersonalEventosOutputSchema = z.object({ events: z.array(withId(TimeEntryEventSchema)) })
export const PersonalAjustesOutputSchema = z.object({ settings: StaffSettingsSchema })
export { Scope as PersonalScopeSchema }
