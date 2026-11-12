import { describe, expect, it } from "vitest"
import {
  applyStatusChange,
  asignacionToOutput,
  calcularDisponibilidad,
  canTransition,
  checkTransition,
  configuracionReservasInicial,
  ConfiguracionReservasSchema,
  configuracionToSettings,
  ConsultarDisponibilidadOutputSchema,
  countsForCapacity,
  customerIdFor,
  cuentaParaCapacidad,
  defaultReservationPolicies,
  defaultReservationSettings,
  disponibilidadToOutput,
  ESTADOS_RESERVA,
  estadoToStatus,
  instanteDeHoraLocal,
  horaAMinutos,
  nextStatuses,
  occupiesTable,
  ocupaMesa,
  proponerMesas,
  ProponerMesasReservaOutputSchema,
  RESERVATION_STATUSES,
  RESERVATION_TRANSITIONS,
  ReservationSchema,
  ReservationSettingsSchema,
  reservationsToOcupacion,
  reservationToOcupacion,
  settingsPolicies,
  settingsToConfiguracion,
  sha256Hex,
  slotStartAt,
  statusToEstado,
  TableSchema,
  tableToMesa,
  type ConfiguracionReservas,
  type Reservation,
  type ReservaOcupacion,
  type ReservationStatus,
} from "./index"
import { config, MESAS, MINUTO, reserva, utc } from "./reservas/datos-prueba"

const MARTES = "2026-11-10"
const AHORA = utc(2026, 11, 1, 10)

function madrid(fecha: string, hora: string): number {
  const t = instanteDeHoraLocal(fecha, horaAMinutos(hora), "Europe/Madrid")
  if (t === null) throw new Error(`La hora ${hora} no existe el ${fecha}.`)
  return t
}

/** Imita un Timestamp de Firestore. */
const ts = (ms: number) => ({ seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1e6, toMillis: () => ms })

/** Documento de reserva tal como estaría en Firestore (con Timestamp), a partir de una reserva del motor. */
function documento(r: ReservaOcupacion): Record<string, unknown> {
  return {
    guestName: `Cliente ${r.id}`,
    phone: "+34612345678",
    email: null,
    language: "es",
    partySize: r.comensales,
    startAt: ts(r.inicio),
    durationMinutes: r.duracionMinutos,
    status: estadoToStatus(r.estado),
    tableIds: [...r.mesaIds],
    suggestedTableIds: [],
    suggestionReason: null,
    source: "phone",
    notes: "",
    guestNotes: "",
    customerId: customerIdFor("demo-lumbre", "+34612345678"),
    reference: "K7M2QX",
    manageTokenHash: sha256Hex("token"),
    deposit: { status: "none", amountCents: 0, checkoutSessionId: null },
    history: [],
    createdBy: "uid-marta",
    // Campos del servidor que el esquema ignora.
    createdAt: ts(AHORA),
    updatedAt: ts(AHORA),
  }
}

/** Reservas del motor → documentos → esquema → motor otra vez. */
function porDocumentos(reservas: readonly ReservaOcupacion[]): ReservaOcupacion[] {
  return reservationsToOcupacion(reservas.map((r) => ({ id: r.id, ...ReservationSchema.parse(documento(r)) })))
}

/** Configuración con todo lo que se puede escribir: turnos con límites, que cruzan la medianoche, excepciones y cierres. */
function configCompleta(): ConfiguracionReservas {
  const base = configuracionReservasInicial("Europe/Madrid")
  return {
    ...base,
    pasoMinutos: 30,
    semana: {
      ...base.semana,
      vie: [
        { nombre: "Comida", desde: "13:00", ultimaEntrada: "15:30", maxComensalesPorFranja: 10 },
        { nombre: "Cena", desde: "20:00", ultimaEntrada: "00:30", maxComensalesTurno: 60 },
      ],
    },
    excepciones: [
      { tipo: "cerrado", fecha: "2026-12-25", motivo: "Navidad" },
      { tipo: "cerrado", fecha: "2026-12-26" },
      { tipo: "horario", fecha: "2026-12-31", turnos: [{ nombre: "Nochevieja", desde: "21:00", ultimaEntrada: "22:00" }], motivo: "Cena especial" },
    ],
    cierres: [
      { desde: "2027-08-01", hasta: "2027-08-15", motivo: "Vacaciones" },
      { desde: "2027-02-01", hasta: "2027-02-03" },
    ],
    maxComensalesPorFranja: 20,
    plazasPerdidasPorUnion: 1,
  }
}

describe("configuración guardada ↔ motor", () => {
  it("sin documento: los horarios de partida y las políticas apagadas", () => {
    const s = defaultReservationSettings()
    expect(ReservationSettingsSchema.parse(s)).toEqual(s)
    expect(settingsToConfiguracion(s)).toEqual(configuracionReservasInicial("Europe/Madrid"))
    expect(settingsPolicies(s)).toEqual(defaultReservationPolicies())
    expect(s.publicBooking).toBe(false)
    expect(s.autoConfirm).toBe(false)
    expect(s.deposit.mode).toBe("none")
    expect(s.reminders.dayBefore).toBe(false)
    expect(s.reviews.enabled).toBe(false)
    expect(s.waitlist.enabled).toBe(false)
    expect(s.week.mon).toEqual([])
    expect(s.week.sun).toEqual([{ name: "Comida", from: "13:00", lastEntry: "15:30" }])
    expect(defaultReservationSettings("Atlantic/Canary").timezone).toBe("Atlantic/Canary")
  })

  it("ida y vuelta sin perder nada, y las dos formas son válidas", () => {
    const original = configCompleta()
    expect(ConfiguracionReservasSchema.safeParse(original).success).toBe(true)
    const politicas = { ...defaultReservationPolicies(), publicBooking: true, deposit: { mode: "perPerson" as const, amountCents: 1000, fromPartySize: 6 } }
    const settings = configuracionToSettings(original, politicas)
    expect(ReservationSettingsSchema.parse(settings)).toEqual(settings)
    expect(settingsToConfiguracion(settings)).toEqual(original)
    expect(settingsPolicies(settings)).toEqual(politicas)
    expect(configuracionToSettings(settingsToConfiguracion(settings), settingsPolicies(settings))).toEqual(settings)
  })

  it("no escribe undefined (Firestore no lo admite)", () => {
    const settings = configuracionToSettings(configCompleta())
    const conUndefined = (v: unknown): boolean =>
      v === undefined || (typeof v === "object" && v !== null && Object.values(v).some(conUndefined))
    expect(conUndefined(settings)).toBe(false)
    expect(conUndefined(settingsToConfiguracion(settings))).toBe(false)
    expect(settings.exceptions[1]).toEqual({ type: "closed", date: "2026-12-26" })
    expect(settings.week.fri[0]).toEqual({ name: "Comida", from: "13:00", lastEntry: "15:30", maxGuestsPerSlot: 10 })
  })

  it("valida igual que el motor, con los campos en inglés", () => {
    const base = defaultReservationSettings()
    const errores = (cambios: Record<string, unknown>) => {
      const r = ReservationSettingsSchema.safeParse({ ...base, ...cambios })
      return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)
    }
    expect(errores({ week: { ...base.week, tue: [{ name: "A", from: "13:00", lastEntry: "15:00" }, { name: "B", from: "14:00", lastEntry: "16:00" }] } })).toEqual([
      "week.tue.1: El turno «B» se pisa con «A».",
    ])
    expect(errores({ minPartySize: 8, maxPartySize: 4 })).toEqual(["maxPartySize: El máximo de comensales es menor que el mínimo."])
    expect(errores({ exceptions: [{ type: "closed", date: "2026-12-25" }, { type: "closed", date: "2026-12-25" }] })).toEqual([
      "exceptions.1.date: Hay dos excepciones para el 2026-12-25.",
    ])
    expect(errores({ duration: { defaultMinutes: 120, tiers: [{ upToGuests: 4, minutes: 90 }, { upToGuests: 2, minutes: 60 }] } })).toEqual([
      "duration.tiers.1: Los tramos de duración deben ir de menos a más comensales.",
    ])
    expect(errores({ exceptions: [{ type: "hours", date: "2026-12-31", shifts: [] }] })[0]).toMatch(/al menos un turno/)
    expect(errores({ closures: [{ from: "2027-08-15", to: "2027-08-01" }] })).toEqual(["closures.0.to: El cierre termina antes de empezar."])
    expect(errores({ stepMinutes: 7 })).toEqual(["stepMinutes: Usa 5, 10, 15, 20, 30 o 60 minutos."])
    expect(errores({ timezone: "Europe/Atlantida" })).toEqual(["timezone: Zona horaria desconocida."])
    expect(errores({ deposit: { mode: "perPerson", amountCents: 0, fromPartySize: 1 } })).toEqual(["deposit.amountCents: Pon el importe de la señal por persona."])
    expect(errores({ reviews: { enabled: true, googleReviewUrl: "http://g.page/r/x" } })).toEqual([
      "reviews.googleReviewUrl: El enlace de reseñas debe empezar por https://.",
    ])
    expect(errores({ reminders: { dayBefore: true, hour: "25:00" } })).toEqual(["reminders.hour: Usa una hora como 13:30."])
    expect(errores({ reviews: { enabled: true, googleReviewUrl: "https://g.page/r/lumbre/review" } })).toEqual([])
  })
})

describe("estados en inglés ↔ castellano", () => {
  it("cada estado tiene su pareja y vuelve igual", () => {
    expect(RESERVATION_STATUSES.map(statusToEstado)).toEqual([...ESTADOS_RESERVA])
    for (const s of RESERVATION_STATUSES) expect(estadoToStatus(statusToEstado(s))).toBe(s)
  })

  it("las transiciones son las del contrato", () => {
    expect(RESERVATION_TRANSITIONS).toEqual({
      pending: ["confirmed", "seated", "cancelled", "no_show"],
      confirmed: ["seated", "cancelled", "no_show"],
      seated: ["finished"],
      finished: [],
      cancelled: [],
      no_show: ["seated"],
    })
  })

  it("canTransition usa las reglas del motor, también la hora del no presentado", () => {
    const inicio = madrid(MARTES, "21:00")
    expect(canTransition("confirmed", "seated", inicio, inicio - 60 * MINUTO)).toBe(true)
    expect(canTransition("confirmed", "no_show", inicio, inicio - MINUTO)).toBe(false)
    expect(canTransition("confirmed", "no_show", inicio, inicio)).toBe(true)
    expect(canTransition("finished", "seated", inicio, inicio)).toBe(false)
    expect(canTransition("no_show", "seated", inicio, inicio + 30 * MINUTO)).toBe(true)
    expect(checkTransition("confirmed", "no_show", inicio, inicio - MINUTO)).toEqual({ ok: false, reason: "Todavía no ha llegado la hora de la reserva." })
    expect(checkTransition("cancelled", "confirmed", inicio, inicio)).toEqual({ ok: false, reason: "Una reserva cancelada ya no se puede cambiar." })
    expect(checkTransition("seated", "cancelled", inicio, inicio)).toEqual({ ok: false, reason: "No se puede pasar de sentada a cancelada." })
    expect(checkTransition("pending", "pending", inicio, inicio)).toEqual({ ok: false, reason: "La reserva ya está pendiente." })
  })

  it("nextStatuses da los botones de cada momento", () => {
    const inicio = madrid(MARTES, "21:00")
    expect(nextStatuses("confirmed", inicio, inicio - MINUTO)).toEqual(["seated", "cancelled"])
    expect(nextStatuses("confirmed", inicio, inicio + MINUTO)).toEqual(["seated", "cancelled", "no_show"])
    expect(nextStatuses("cancelled", inicio, inicio)).toEqual([])
  })

  it("ocupar mesa y contar para la capacidad, igual que el motor", () => {
    for (const s of RESERVATION_STATUSES) {
      expect(occupiesTable(s)).toBe(ocupaMesa(statusToEstado(s)))
      expect(countsForCapacity(s)).toBe(cuentaParaCapacidad(statusToEstado(s)))
    }
  })

  it("applyStatusChange apunta el cambio en el historial sin tocar el original", () => {
    const r = { status: "confirmed" as ReservationStatus, startAt: madrid(MARTES, "21:00"), history: [] as Reservation["history"] }
    const ahora = madrid(MARTES, "21:05")
    const hecho = applyStatusChange(r, "seated", { nowMs: ahora, by: "uid-diego" })
    expect(hecho).toEqual({
      ok: true,
      change: { from: "confirmed", to: "seated", at: ahora, by: "uid-diego", reason: null },
      reservation: { ...r, status: "seated", history: [{ from: "confirmed", to: "seated", at: ahora, by: "uid-diego", reason: null }] },
    })
    expect(r.status).toBe("confirmed")
    expect(applyStatusChange(r, "finished", { nowMs: ahora })).toEqual({ ok: false, reason: "No se puede pasar de confirmada a terminada." })
  })
})

describe("el motor da lo mismo leyendo documentos", () => {
  const RESERVAS: ReservaOcupacion[] = [
    reserva(madrid(MARTES, "20:30"), { id: "a", mesaIds: ["S3"], comensales: 4, duracionMinutos: 105 }),
    reserva(madrid(MARTES, "21:00"), { id: "b", mesaIds: ["S5"], comensales: 6, estado: "sentada", duracionMinutos: 120 }),
    reserva(madrid(MARTES, "21:00"), { id: "c", comensales: 4, estado: "pendiente" }),
    reserva(madrid(MARTES, "21:15"), { id: "d", mesaIds: ["T3"], comensales: 3, estado: "cancelada" }),
    reserva(madrid(MARTES, "13:30"), { id: "e", mesaIds: ["S1"], comensales: 2, estado: "terminada" }),
    reserva(madrid(MARTES, "20:00"), { id: "f", mesaIds: ["S1", "S2"], comensales: 4, estado: "no_presentada" }),
  ]

  it("una reserva guardada se lee como la del motor", () => {
    const [a] = RESERVAS
    if (!a) throw new Error("falta a")
    const doc = ReservationSchema.parse(documento(a))
    expect(doc.startAt).toBe(a.inicio)
    expect(reservationToOcupacion("a", doc)).toEqual(a)
    expect(porDocumentos(RESERVAS)).toEqual(RESERVAS)
  })

  it("las mesas guardadas se leen como las del motor", () => {
    const docs = MESAS.map((m, i) => ({
      id: m.id,
      data: TableSchema.parse({ name: m.name, areaId: m.areaId, seats: m.seats, shape: "rect", x: i * 10, y: 0, w: 8, h: 8, joinableWith: m.joinableWith, enabled: m.enabled }),
    }))
    expect(docs.map((d) => tableToMesa(d.id, d.data))).toEqual(MESAS)
  })

  it("disponibilidad", () => {
    const cfg = config({ maxComensalesPorFranja: 10 })
    const settings = ReservationSettingsSchema.parse(configuracionToSettings(cfg))
    for (const comensales of [2, 4, 6, 8]) {
      const conMotor = calcularDisponibilidad({ config: cfg, fecha: MARTES, comensales, mesas: MESAS, reservas: RESERVAS, ahora: AHORA })
      const conDocumentos = calcularDisponibilidad({
        config: settingsToConfiguracion(settings),
        fecha: MARTES,
        comensales,
        mesas: MESAS,
        reservas: porDocumentos(RESERVAS),
        ahora: AHORA,
      })
      expect(conDocumentos).toEqual(conMotor)
      // Que la prueba no sea trivial: hay franjas libres y ocupadas.
      if (comensales === 4) {
        expect(conMotor.franjas.some((f) => f.disponible)).toBe(true)
        expect(conMotor.franjas.some((f) => !f.disponible)).toBe(true)
      }
    }
  })

  it("propuestas de mesa", () => {
    const cfg = config()
    const settings = ReservationSettingsSchema.parse(configuracionToSettings(cfg))
    for (const [hora, comensales, zona] of [["21:00", 4, null], ["21:30", 2, "terraza"], ["20:45", 6, null]] as const) {
      const peticion = { inicio: madrid(MARTES, hora), comensales, zonaPreferida: zona }
      const conMotor = proponerMesas({ config: cfg, mesas: MESAS, reservas: RESERVAS, ahora: AHORA, peticion })
      const conDocumentos = proponerMesas({
        config: settingsToConfiguracion(settings),
        mesas: MESAS,
        reservas: porDocumentos(RESERVAS),
        ahora: AHORA,
        peticion,
      })
      expect(conDocumentos).toEqual(conMotor)
      expect(ProponerMesasReservaOutputSchema.parse(asignacionToOutput(conDocumentos))).toEqual(asignacionToOutput(conMotor))
    }
  })
})

describe("franjas a partir de fecha y hora", () => {
  it("una hora normal del turno", () => {
    const cfg = config()
    expect(slotStartAt(cfg, MARTES, "21:00")).toEqual({ startAt: madrid(MARTES, "21:00"), inShift: true })
  })

  it("de madrugada en un turno que cruza la medianoche cae en el día siguiente", () => {
    const cfg = configCompleta()
    // 2026-11-13 es viernes; la cena llega hasta las 00:30 del sábado.
    expect(slotStartAt(cfg, "2026-11-13", "00:30")).toEqual({ startAt: madrid("2026-11-14", "00:30"), inShift: true })
  })

  it("fuera de turno, la hora de ese día (solo para el personal)", () => {
    const cfg = config()
    expect(slotStartAt(cfg, MARTES, "17:10")).toEqual({ startAt: madrid(MARTES, "17:10"), inShift: false })
  })

  it("en los cambios de hora", () => {
    const cfg = config({
      semana: { ...config().semana, dom: [{ nombre: "Noche", desde: "01:30", ultimaEntrada: "03:30" }] },
    })
    // Octubre: las 02:30 ocurren dos veces y se toma la primera (UTC+2).
    expect(slotStartAt(cfg, "2026-10-25", "02:30")).toEqual({ startAt: utc(2026, 10, 25, 0, 30), inShift: true })
    // Marzo: las 02:30 no existen.
    expect(slotStartAt(cfg, "2027-03-28", "02:30")).toBeNull()
  })
})

describe("salida pública de disponibilidad", () => {
  it("no enseña cuántos comensales hay y valida con el esquema de salida", () => {
    const cfg = config()
    const d = calcularDisponibilidad({ config: cfg, fecha: MARTES, comensales: 4, mesas: MESAS, reservas: [reserva(madrid(MARTES, "21:00"), { comensales: 6 })], ahora: AHORA })
    const salida = ConsultarDisponibilidadOutputSchema.parse(disponibilidadToOutput(d, { timezone: cfg.zonaHoraria, waitlistEnabled: true }))
    expect(JSON.stringify(salida)).not.toContain("comensalesEnFranja")
    expect(salida.status).toBe("open")
    expect(salida.slots[0]).toEqual({ time: "13:00", wallDate: MARTES, startAt: madrid(MARTES, "13:00"), shift: "Comida", available: true, reason: null })
    const cerrado = calcularDisponibilidad({ config: cfg, fecha: "2026-11-09", comensales: 2, mesas: MESAS, reservas: [], ahora: AHORA })
    expect(disponibilidadToOutput(cerrado, { timezone: "Europe/Madrid", waitlistEnabled: false })).toMatchObject({
      status: "closed",
      message: "Cerrado los lunes.",
      slots: [],
    })
    const lejos = calcularDisponibilidad({ config: cfg, fecha: "2027-06-01", comensales: 2, mesas: MESAS, reservas: [], ahora: AHORA })
    expect(disponibilidadToOutput(lejos, { timezone: "Europe/Madrid", waitlistEnabled: false }).slots[0]?.reason).toBe("max_advance")
  })
})
