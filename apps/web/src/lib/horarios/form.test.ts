import { defaultReservationSettings } from "@llenamos/core"
import { describe, expect, it } from "vitest"
import {
  addClosure,
  addException,
  addShift,
  addTier,
  centsFromInput,
  centsToInput,
  copyDay,
  errorsUnder,
  formatMinutes,
  intFromInput,
  normalizeTimeInput,
  optionalIntFromInput,
  previewSlots,
  removeShift,
  removeTier,
  sameSettings,
  saveInput,
  sectionOf,
  shiftLimitFromInput,
  switchExceptionType,
  updateClosure,
  updateShift,
  updateTier,
  validateSettings,
  weekdayOf,
  weekSummary,
  WEEKDAY_LABELS,
  type Settings,
} from "./form"

const base = defaultReservationSettings()

describe("días", () => {
  it("lunes primero y en castellano", () => {
    expect(WEEKDAY_LABELS[0]).toEqual(["mon", "lunes"])
    expect(WEEKDAY_LABELS[6]).toEqual(["sun", "domingo"])
  })

  it("día de la semana de una fecha", () => {
    expect(weekdayOf("2026-11-09")).toBe("mon")
    expect(weekdayOf("2026-11-15")).toBe("sun")
  })
})

describe("validación con el esquema de core", () => {
  it("la configuración inicial es válida", () => {
    expect(validateSettings(base)).toMatchObject({ ok: true, errors: {} })
  })

  it("los mensajes propios del esquema ganan", () => {
    const s = updateShift(base, "tue", 0, { from: "25:00" })
    expect(validateSettings(s).errors["week.tue.0.from"]).toBe("Usa una hora como 13:30.")
  })

  it("turnos que se pisan, en el día que toca", () => {
    const s = updateShift(base, "wed", 1, { from: "14:00" })
    const r = validateSettings(s)
    expect(r.ok).toBe(false)
    expect(errorsUnder(r.errors, "week.wed")).toEqual(["El turno «Cena» se pisa con «Comida»."])
    expect(errorsUnder(r.errors, "week.tue")).toEqual([])
  })

  it("números vacíos o fuera de rango, en castellano", () => {
    const r = validateSettings({ ...base, bufferMinutes: Number.NaN, maxAdvanceDays: 0, maxJoinedTables: 9 })
    expect(r.errors.bufferMinutes).toBe("Escribe un número.")
    expect(r.errors.maxAdvanceDays).toBe("Como mínimo 1.")
    expect(r.errors.maxJoinedTables).toBe("Como mucho 6.")
  })

  it("mínimo de comensales mayor que el máximo", () => {
    const r = validateSettings({ ...base, minPartySize: 10, maxPartySize: 4 })
    expect(r.errors.maxPartySize).toBe("El máximo de comensales es menor que el mínimo.")
  })

  it("señal activada sin importe", () => {
    const r = validateSettings({ ...base, deposit: { mode: "perPerson", amountCents: 0, fromPartySize: 6 } })
    expect(r.errors["deposit.amountCents"]).toBe("Pon el importe de la señal por persona.")
  })

  it("enlace de reseñas que no es https", () => {
    const r = validateSettings({ ...base, reviews: { enabled: true, googleReviewUrl: "http://g.page/x" } })
    expect(r.errors["reviews.googleReviewUrl"]).toBe("El enlace de reseñas debe empezar por https://.")
  })

  it("nombra la sección de cada error", () => {
    expect(sectionOf("week.fri.0.from")).toBe("Horario del viernes")
    expect(sectionOf("deposit.amountCents")).toBe("Señal")
    expect(sectionOf("otro")).toBe("Configuración")
  })

  it("prepara la entrada de la callable", () => {
    expect(saveInput("demo-lumbre", "centro", base)).toMatchObject({ restaurantId: "demo-lumbre", locationId: "centro" })
    expect(() => saveInput("demo-lumbre", "centro", { ...base, stepMinutes: 7 })).toThrow()
  })
})

describe("números escritos a mano", () => {
  it("enteros", () => {
    expect(intFromInput(" 12 ")).toBe(12)
    expect(intFromInput("1,5")).toBeNaN()
    expect(intFromInput("")).toBeNaN()
    expect(optionalIntFromInput("")).toBeNull()
    expect(optionalIntFromInput("40")).toBe(40)
    expect(shiftLimitFromInput("")).toBeUndefined()
  })

  it("horas de 24 horas escritas a mano", () => {
    expect(normalizeTimeInput("930")).toBe("09:30")
    expect(normalizeTimeInput("9:30")).toBe("09:30")
    expect(normalizeTimeInput("9.30")).toBe("09:30")
    expect(normalizeTimeInput("21h")).toBe("21h")
    expect(normalizeTimeInput("21")).toBe("21:00")
    expect(normalizeTimeInput("2130")).toBe("21:30")
    expect(normalizeTimeInput("25:00")).toBe("25:00")
    expect(normalizeTimeInput("")).toBe("")
  })

  it("euros y céntimos", () => {
    expect(centsFromInput("12,50")).toBe(1250)
    expect(centsFromInput("10")).toBe(1000)
    expect(centsFromInput("abc")).toBeNaN()
    expect(centsFromInput("-3")).toBeNaN()
    expect(centsToInput(1250)).toBe("12,50")
  })

  it("minutos legibles", () => {
    expect(formatMinutes(90)).toBe("1 h 30 min")
    expect(formatMinutes(120)).toBe("2 h")
    expect(formatMinutes(45)).toBe("45 min")
  })
})

describe("turnos", () => {
  it("añade comida, luego cena y luego uno genérico", () => {
    let s: Settings = { ...base, week: { ...base.week, mon: [] } }
    s = addShift(s, "mon")
    expect(s.week.mon.map((x) => x.name)).toEqual(["Comida"])
    s = addShift(s, "mon")
    expect(s.week.mon.map((x) => x.name)).toEqual(["Comida", "Cena"])
    s = addShift(s, "mon")
    expect(s.week.mon[2]?.name).toBe("Turno 3")
  })

  it("quita los límites vacíos del turno (Firestore no admite undefined)", () => {
    const con = updateShift(base, "tue", 0, { maxGuestsPerSlot: 20 })
    expect(con.week.tue[0]).toEqual({ name: "Comida", from: "13:00", lastEntry: "15:30", maxGuestsPerSlot: 20 })
    const sin = updateShift(con, "tue", 0, { maxGuestsPerSlot: undefined })
    expect(sin.week.tue[0]).toEqual({ name: "Comida", from: "13:00", lastEntry: "15:30" })
    expect("maxGuestsPerSlot" in sin.week.tue[0]!).toBe(false)
  })

  it("borra un turno", () => {
    expect(removeShift(base, "tue", 1).week.tue.map((x) => x.name)).toEqual(["Comida"])
  })

  it("copia un día a otros sin compartir objetos", () => {
    const s = copyDay(base, "sun", ["mon", "tue"])
    expect(s.week.mon).toEqual(base.week.sun)
    expect(s.week.tue).toEqual(base.week.sun)
    expect(s.week.mon[0]).not.toBe(base.week.sun[0])
  })
})

describe("días especiales, cierres y duración", () => {
  it("excepciones ordenadas por fecha y con su tipo", () => {
    let s = addException(base, "2026-12-31", "hours")
    s = addException(s, "2026-12-25", "closed")
    expect(s.exceptions.map((e) => [e.date, e.type])).toEqual([
      ["2026-12-25", "closed"],
      ["2026-12-31", "hours"],
    ])
    expect(validateSettings(s).ok).toBe(true)
  })

  it("dos excepciones el mismo día dan error", () => {
    const s = addException(addException(base, "2026-12-25", "closed"), "2026-12-25", "closed")
    expect(validateSettings(s).errors["exceptions.1.date"]).toBe("Hay dos excepciones para el 2026-12-25.")
  })

  it("cambia el tipo conservando el motivo", () => {
    const e = switchExceptionType({ type: "closed", date: "2026-12-24", reason: "Nochebuena" })
    expect(e).toMatchObject({ type: "hours", date: "2026-12-24", reason: "Nochebuena" })
    expect(switchExceptionType(e)).toEqual({ type: "closed", date: "2026-12-24", reason: "Nochebuena" })
  })

  it("cierres: el final no puede ir antes que el principio y el motivo vacío se quita", () => {
    let s = addClosure(base, "2027-08-01", "2027-08-15")
    s = updateClosure(s, 0, { reason: "  " })
    expect(s.closures[0]).toEqual({ from: "2027-08-01", to: "2027-08-15" })
    s = updateClosure(s, 0, { to: "2027-07-01" })
    expect(validateSettings(s).errors["closures.0.to"]).toBe("El cierre termina antes de empezar.")
  })

  it("tramos de duración de menos a más", () => {
    let s = addTier(base)
    expect(s.duration.tiers.at(-1)).toEqual({ upToGuests: 8, minutes: 120 })
    expect(validateSettings(s).ok).toBe(true)
    s = updateTier(s, 3, { upToGuests: 3 })
    expect(validateSettings(s).errors["duration.tiers.3"]).toBe("Los tramos de duración deben ir de menos a más comensales.")
    expect(removeTier(s, 3).duration.tiers).toHaveLength(3)
  })
})

describe("resumen y vista previa", () => {
  it("resume la semana", () => {
    expect(weekSummary(base)).toBe("Abre 6 días · 11 turnos a la semana")
  })

  it("horas que se ofrecerían un martes con el motor", () => {
    const p = previewSlots(base, "2026-11-10")
    expect(p?.map((t) => t.turno)).toEqual(["Comida", "Cena"])
    expect(p?.[0]?.horas.slice(0, 3)).toEqual(["13:00", "13:15", "13:30"])
    expect(p?.[0]?.horas.at(-1)).toBe("15:30")
  })

  it("el lunes cerrado no ofrece horas; un borrador roto no da vista previa", () => {
    expect(previewSlots(base, "2026-11-09")).toEqual([])
    expect(previewSlots({ ...base, stepMinutes: 7 }, "2026-11-10")).toBeNull()
  })

  it("sabe si hay cambios sin guardar", () => {
    expect(sameSettings(base, defaultReservationSettings())).toBe(true)
    expect(sameSettings(base, { ...base, bufferMinutes: 20 })).toBe(false)
    expect(sameSettings(base, { ...base, bufferMinutes: Number.NaN })).toBe(false)
  })
})
