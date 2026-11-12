/**
 * Configuración de reservas de un local, tal como se guarda en
 * `restaurants/{rid}/locations/{lid}/settings/reservations` (solo la escribe el servidor
 * con `guardarConfiguracionReservas`).
 *
 * Es la `ConfiguracionReservas` del motor con los nombres en inglés, más las políticas
 * (reservas por la web, confirmación automática, señal, cancelación, recordatorios,
 * reseñas y lista de espera). Las validaciones son las mismas que las del motor; el
 * motor se usa a través de `settingsToConfiguracion` (adapters.ts).
 */
import { z } from "zod"
import { PASOS_PERMITIDOS, rangoTurno } from "./reservas/horarios"
import { FechaSchema, HoraSchema, ZonaHorariaSchema } from "./reservas/tiempo"

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const
export type Weekday = (typeof WEEKDAYS)[number]

export const ShiftSchema = z.object({
  name: z.string().trim().min(1).max(40),
  /** Primera hora de llegada, "13:00". */
  from: HoraSchema,
  /** Última hora a la que se puede llegar (incluida). Si es menor que `from`, el turno cruza la medianoche. */
  lastEntry: HoraSchema,
  /** Comensales que pueden llegar en una misma franja de este turno. Si falta, el del local. */
  maxGuestsPerSlot: z.number().int().min(1).optional(),
  /** Comensales en todo el turno. Si falta, sin límite. */
  maxGuestsPerShift: z.number().int().min(1).optional(),
})
export type Shift = z.infer<typeof ShiftSchema>

/** Turnos de un día: no se pueden pisar entre sí. */
export const ShiftsSchema = z
  .array(ShiftSchema)
  .max(6)
  .superRefine((shifts, ctx) => {
    const horasBien = (s: Shift) => HoraSchema.safeParse(s.from).success && HoraSchema.safeParse(s.lastEntry).success
    if (!shifts.every(horasBien)) return
    const rangos = shifts.map((s) => rangoTurno({ desde: s.from, ultimaEntrada: s.lastEntry }))
    for (let i = 0; i < rangos.length; i++) {
      for (let j = i + 1; j < rangos.length; j++) {
        const a = rangos[i]
        const b = rangos[j]
        if (a && b && a.desde <= b.ultimaEntrada && b.desde <= a.ultimaEntrada) {
          ctx.addIssue({ code: "custom", path: [j], message: `El turno «${shifts[j]?.name}» se pisa con «${shifts[i]?.name}».` })
        }
      }
    }
  })

export const WeekSchema = z.object({
  mon: ShiftsSchema,
  tue: ShiftsSchema,
  wed: ShiftsSchema,
  thu: ShiftsSchema,
  fri: ShiftsSchema,
  sat: ShiftsSchema,
  sun: ShiftsSchema,
})
export type Week = z.infer<typeof WeekSchema>

const ReasonSchema = z.string().trim().max(120)

export const ExceptionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("closed"), date: FechaSchema, reason: ReasonSchema.optional() }),
  z.object({
    type: z.literal("hours"),
    date: FechaSchema,
    shifts: ShiftsSchema.min(1, "Un horario especial necesita al menos un turno; si no, usa «cerrado»."),
    reason: ReasonSchema.optional(),
  }),
])
export type Exception = z.infer<typeof ExceptionSchema>

export const ClosureSchema = z
  .object({ from: FechaSchema, to: FechaSchema, reason: ReasonSchema.optional() })
  .refine((c) => c.from <= c.to, { message: "El cierre termina antes de empezar.", path: ["to"] })
export type Closure = z.infer<typeof ClosureSchema>

export const DurationTierSchema = z.object({
  /** El tramo vale para grupos de hasta este número de comensales (incluido). */
  upToGuests: z.number().int().min(1),
  minutes: z.number().int().min(15).max(24 * 60),
})

export const DEPOSIT_MODES = ["none", "perPerson"] as const
export const DepositModeSchema = z.enum(DEPOSIT_MODES)
export type DepositMode = z.infer<typeof DepositModeSchema>

/** Señal que pide el local: nada, o un importe por persona a partir de cierto tamaño de grupo. */
export const DepositPolicySchema = z
  .object({
    mode: DepositModeSchema,
    /** Céntimos por persona. */
    amountCents: z.number().int().min(0).max(100_000),
    /** Se pide a partir de este número de comensales (incluido). */
    fromPartySize: z.number().int().min(1).max(200),
  })
  .refine((d) => d.mode === "none" || d.amountCents > 0, {
    message: "Pon el importe de la señal por persona.",
    path: ["amountCents"],
  })
export type DepositPolicy = z.infer<typeof DepositPolicySchema>

/** Céntimos de señal que corresponden a un grupo (0 si no se pide). */
export function depositAmountFor(policy: DepositPolicy, partySize: number): number {
  if (policy.mode === "none" || partySize < policy.fromPartySize) return 0
  return policy.amountCents * partySize
}

export const ReservationSettingsSchema = z
  .object({
    /** Zona horaria del local: "Europe/Madrid". */
    timezone: ZonaHorariaSchema,
    /** Salto entre horas ofrecidas. */
    stepMinutes: z
      .number()
      .int()
      .refine((n) => (PASOS_PERMITIDOS as readonly number[]).includes(n), "Usa 5, 10, 15, 20, 30 o 60 minutos."),
    week: WeekSchema,
    exceptions: z.array(ExceptionSchema).max(400),
    closures: z.array(ClosureSchema).max(100),
    duration: z.object({
      /** Para grupos más grandes que el último tramo. */
      defaultMinutes: z.number().int().min(15).max(24 * 60),
      tiers: z.array(DurationTierSchema).max(20),
    }),
    /** Minutos libres entre dos reservas de la misma mesa. */
    bufferMinutes: z.number().int().min(0).max(240),
    /** Comensales que pueden llegar en una misma franja. null = sin límite. */
    maxGuestsPerSlot: z.number().int().min(1).nullable(),
    /** Tamaño de grupo que se acepta desde la web. */
    minPartySize: z.number().int().min(1),
    maxPartySize: z.number().int().min(1).max(200),
    /** Antelación mínima para reservar desde la web. */
    minNoticeMinutes: z.number().int().min(0).max(7 * 24 * 60),
    /** Antelación máxima para reservar desde la web. */
    maxAdvanceDays: z.number().int().min(1).max(730),
    /** Mesas que se pueden juntar como mucho. 1 = no se juntan. */
    maxJoinedTables: z.number().int().min(1).max(6),
    /** Plazas que se pierden en cada unión de mesas. */
    seatsLostPerJoin: z.number().int().min(0).max(4),

    /* Políticas ------------------------------------------------------------ */

    /** Si se puede reservar desde la página pública y el widget. */
    publicBooking: z.boolean(),
    /** Si las reservas de la web quedan confirmadas solas; si no, quedan `pending`. */
    autoConfirm: z.boolean(),
    deposit: DepositPolicySchema,
    cancellation: z.object({
      /** Se puede cancelar gratis hasta estas horas antes de la reserva. 0 = siempre. */
      freeUntilHours: z.number().int().min(0).max(720),
    }),
    reminders: z.object({
      /** Recordatorio el día antes, a la hora `hour` del local. */
      dayBefore: z.boolean(),
      hour: HoraSchema,
    }),
    reviews: z.object({
      /** Petición de reseña el día siguiente (solo si además hay enlace). */
      enabled: z.boolean(),
      googleReviewUrl: z
        .string()
        .trim()
        .max(500)
        .regex(/^https:\/\/\S+$/, "El enlace de reseñas debe empezar por https://.")
        .nullable(),
    }),
    waitlist: z.object({
      enabled: z.boolean(),
      /** Minutos que se guarda el hueco ofrecido a quien está en la lista de espera. */
      offerMinutes: z.number().int().min(5).max(24 * 60),
    }),
  })
  .superRefine((s, ctx) => {
    // Se ejecuta aunque falten campos (ya tienen su error): se leen con cuidado.
    if (s.minPartySize > s.maxPartySize) {
      ctx.addIssue({ code: "custom", path: ["maxPartySize"], message: "El máximo de comensales es menor que el mínimo." })
    }
    const vistas = new Set<string>()
    const exceptions = Array.isArray(s.exceptions) ? s.exceptions : []
    exceptions.forEach((e, i) => {
      const date = e?.date
      if (typeof date !== "string") return
      if (vistas.has(date)) {
        ctx.addIssue({ code: "custom", path: ["exceptions", i, "date"], message: `Hay dos excepciones para el ${date}.` })
      }
      vistas.add(date)
    })
    const tiers = Array.isArray(s.duration?.tiers) ? s.duration.tiers : []
    for (let i = 1; i < tiers.length; i++) {
      const anterior = tiers[i - 1]
      const actual = tiers[i]
      if (anterior && actual && actual.upToGuests <= anterior.upToGuests) {
        ctx.addIssue({
          code: "custom",
          path: ["duration", "tiers", i],
          message: "Los tramos de duración deben ir de menos a más comensales.",
        })
      }
    }
  })
export type ReservationSettings = z.infer<typeof ReservationSettingsSchema>

/** Las políticas, separadas de los horarios (lo que el motor no usa). */
export type ReservationPolicies = Pick<
  ReservationSettings,
  "publicBooking" | "autoConfirm" | "deposit" | "cancellation" | "reminders" | "reviews" | "waitlist"
>

/**
 * Políticas apagadas: sin reservas por la web, sin confirmación automática, sin señal,
 * cancelación gratis siempre, sin recordatorios, sin reseñas y sin lista de espera.
 * Es lo que vale para un local que todavía no ha guardado su configuración.
 */
export function defaultReservationPolicies(): ReservationPolicies {
  return {
    publicBooking: false,
    autoConfirm: false,
    deposit: { mode: "none", amountCents: 0, fromPartySize: 1 },
    cancellation: { freeUntilHours: 0 },
    reminders: { dayBefore: false, hour: "18:00" },
    reviews: { enabled: false, googleReviewUrl: null },
    waitlist: { enabled: false, offerMinutes: 30 },
  }
}
