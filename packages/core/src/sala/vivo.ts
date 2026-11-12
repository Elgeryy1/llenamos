/**
 * Lecturas en vivo de sala y cocina contra la API del VPS. La API (`apps/api/src/modules/sala/live.ts`)
 * y la web (`lib/sala/vivo.ts`) comparten estos contratos; lo vivo es acotado: mesas abiertas, sus
 * líneas, tareas activas y recogidas vigentes. El histórico no viaja aquí.
 */
import { z } from "zod"
import { DocIdSchema } from "../model"
import { DailyMenuSchema, MenuCategorySchema, MenuItemSchema, StationSchema, STATION_KINDS } from "../carta/modelo"
import { FloorSettingsSchema, FloorTaskSchema, OrderLineSchema, OrderSchema, TableSessionSchema, TakeawaySchema } from "./modelo"

const withId = <T extends z.ZodType>(schema: T) => schema.and(z.object({ id: z.string() }))

export const SalaAlcanceSchema = z.strictObject({ restaurantId: DocIdSchema, locationId: DocIdSchema })
export const SalaServicioVivoSchema = z.object({
  sessions: z.array(withId(TableSessionSchema)),
  orders: z.array(withId(OrderSchema)),
  lines: z.array(withId(OrderLineSchema)),
  tasks: z.array(withId(FloorTaskSchema)),
  takeaways: z.array(withId(TakeawaySchema)),
  /** true si algún límite recortó la foto (hay más de lo que se envía). */
  truncated: z.boolean(),
})
export const SalaCartaVivaSchema = z.object({
  categories: z.array(withId(MenuCategorySchema)),
  items: z.array(withId(MenuItemSchema)),
  menus: z.array(withId(DailyMenuSchema)),
  stations: z.array(withId(StationSchema)),
  settings: FloorSettingsSchema,
  /** false = el local aún no ha guardado ajustes y se enseñan los de fábrica. */
  settingsSaved: z.boolean(),
})
export const CocinaLineasInputSchema = SalaAlcanceSchema.extend({ stationId: DocIdSchema, kind: z.enum(STATION_KINDS) })
export const CocinaLineasVivasSchema = z.object({ lines: z.array(withId(OrderLineSchema)) })
export type SalaServicioVivo = z.infer<typeof SalaServicioVivoSchema>
export type SalaCartaViva = z.infer<typeof SalaCartaVivaSchema>

/** Nombres de las lecturas en vivo registradas por el módulo de sala en la API. */
/** Mesas y recogidas cerradas de las últimas horas, con sus líneas, para reabrir o consultar (misma forma que el servicio). */
export const SALA_HISTORIAL_HORAS = 18
export const SALA_LIVE = { servicio: "salaServicio", historial: "salaHistorial", carta: "salaCarta", estacion: "cocinaLineas" } as const
