import { describe, expect, it } from "vitest"
import {
  applyClockAction, breakIntervals, checkPin, clockState, copyWeek, defaultStaffSettings, entryMinutes, findForgottenEntries,
  findShiftConflicts, hoursReport, instanteDeHoraLocal, minutesByLocalDay, newPinRecord, pinHash, plannedMinutesByUid, planVsReal,
  roundMinutes, scheduleWarnings, shiftPlacement, StaffSettingsSchema, StaffShiftEditableSchema, staffShiftForWrite, suggestedCloseAt,
  tipHoursForWindow, truncateToMinute, validateEntryTimes, weekDates, weekStartOf, timeEntryForWrite, TimeEntrySchema, TimeEntryEventSchema,
  PIN_LOCK_MS, PIN_MAX_ATTEMPTS, MINUTE_MS,
  type EntryLike, type EntryTimes, type StaffShiftWithId,
} from "../index"

const ZONA = "Europe/Madrid"
const h = (fecha: string, hora: string) => {
  const [hh, mm] = hora.split(":").map(Number)
  return instanteDeHoraLocal(fecha, (hh ?? 0) * 60 + (mm ?? 0), ZONA)!
}
const settings = (cambios: Partial<ReturnType<typeof defaultStaffSettings>> = {}) => ({ ...defaultStaffSettings(), ...cambios })
const entry = (uid: string, times: EntryTimes, extra: Partial<EntryLike> = {}): EntryLike => ({
  uid, date: "2026-11-09", startAt: times.startAt, endAt: times.endAt, breaks: [...times.breaks], status: times.endAt === null ? "open" : "closed",
  forgotten: false, workedMinutes: times.endAt === null ? null : entryMinutes(times, settings()).roundedMinutes, ...extra,
})

describe("fichar: estados y acciones", () => {
  const t0 = h("2026-11-09", "09:00")
  it("entrada, pausa, vuelta y salida, con el reloj truncado al minuto", () => {
    const dentro = applyClockAction(null, "in", t0 + 45_000)
    expect(dentro).toMatchObject({ ok: true, event: "clock_in", state: "working", at: t0 })
    if (!dentro.ok) return
    const pausa = applyClockAction({ ...dentro.times, forgotten: false }, "break_start", t0 + 3 * 60 * MINUTE_MS + 10_000)
    expect(pausa).toMatchObject({ ok: true, state: "on_break" })
    if (!pausa.ok) return
    const vuelta = applyClockAction({ ...pausa.times, forgotten: false }, "break_end", t0 + 3 * 60 * MINUTE_MS + 30 * MINUTE_MS)
    expect(vuelta).toMatchObject({ ok: true, state: "working" })
    if (!vuelta.ok) return
    const fuera = applyClockAction({ ...vuelta.times, forgotten: false }, "out", t0 + 8 * 60 * MINUTE_MS)
    expect(fuera).toMatchObject({ ok: true, event: "clock_out", state: "out" })
    if (!fuera.ok) return
    expect(entryMinutes(fuera.times, settings())).toEqual({ grossMinutes: 480, breakMinutes: 30, workedMinutes: 450, roundedMinutes: 450 })
  })
  it("rechaza lo que no toca y explica por qué", () => {
    const abierto = { startAt: t0, endAt: null, breaks: [], forgotten: false }
    expect(applyClockAction(abierto, "in", t0 + MINUTE_MS)).toMatchObject({ ok: false, code: "already_open" })
    expect(applyClockAction(null, "out", t0)).toMatchObject({ ok: false, code: "not_open" })
    expect(applyClockAction(null, "break_start", t0)).toMatchObject({ ok: false, code: "not_open" })
    expect(applyClockAction(abierto, "break_end", t0 + MINUTE_MS)).toMatchObject({ ok: false, code: "not_on_break" })
    const enPausa = { ...abierto, breaks: [{ startAt: t0 + MINUTE_MS, endAt: null }] }
    expect(applyClockAction(enPausa, "break_start", t0 + 2 * MINUTE_MS)).toMatchObject({ ok: false, code: "already_on_break" })
    expect(clockState({ status: "open", breaks: enPausa.breaks })).toBe("on_break")
    expect(clockState(null)).toBe("out")
  })
  it("salir con una pausa abierta la cierra a la misma hora", () => {
    const enPausa = { startAt: t0, endAt: null, breaks: [{ startAt: t0 + 60 * MINUTE_MS, endAt: null }], forgotten: false }
    const r = applyClockAction(enPausa, "out", t0 + 90 * MINUTE_MS)
    expect(r.ok && r.times.breaks[0]).toEqual({ startAt: t0 + 60 * MINUTE_MS, endAt: t0 + 90 * MINUTE_MS })
  })
  it("un fichaje olvidado no se cierra fichando", () => {
    const olvidado = { startAt: t0, endAt: null, breaks: [], forgotten: true }
    for (const a of ["out", "break_start", "in"] as const) expect(applyClockAction(olvidado, a, t0 + 20 * 60 * MINUTE_MS)).toMatchObject({ ok: false, code: "forgotten" })
  })
  it("el límite de pausas se respeta", () => {
    const muchas = { startAt: t0, endAt: null, breaks: Array.from({ length: 20 }, (_, i) => ({ startAt: t0 + i * 2 * MINUTE_MS, endAt: t0 + (i * 2 + 1) * MINUTE_MS })), forgotten: false }
    expect(applyClockAction(muchas, "break_start", t0 + 100 * MINUTE_MS)).toMatchObject({ ok: false, code: "too_many_breaks" })
  })
})

describe("horas: pausas, redondeo y medianoche", () => {
  it("las pausas solapadas o fuera del fichaje se recortan una vez", () => {
    const t0 = h("2026-11-09", "10:00")
    const t: EntryTimes = { startAt: t0, endAt: t0 + 240 * MINUTE_MS, breaks: [
      { startAt: t0 - 30 * MINUTE_MS, endAt: t0 + 10 * MINUTE_MS }, { startAt: t0 + 5 * MINUTE_MS, endAt: t0 + 20 * MINUTE_MS }, { startAt: t0 + 230 * MINUTE_MS, endAt: t0 + 400 * MINUTE_MS },
    ] }
    expect(breakIntervals(t, t0 + 999 * MINUTE_MS)).toEqual([[t0, t0 + 20 * MINUTE_MS], [t0 + 230 * MINUTE_MS, t0 + 240 * MINUTE_MS]])
    expect(entryMinutes(t, settings())).toMatchObject({ grossMinutes: 240, breakMinutes: 30, workedMinutes: 210 })
    expect(entryMinutes(t, settings({ breaksPaid: true }))).toMatchObject({ breakMinutes: 30, workedMinutes: 240 })
  })
  it("redondea al más cercano o hacia abajo y nunca pasa de lo permitido", () => {
    expect(roundMinutes(452, 15, "nearest")).toBe(450)
    expect(roundMinutes(458, 15, "nearest")).toBe(465)
    expect(roundMinutes(457, 15, "nearest")).toBe(450)
    expect(roundMinutes(467, 15, "nearest")).toBe(465)
    expect(roundMinutes(459, 15, "down")).toBe(450)
    expect(roundMinutes(7, 5, "nearest")).toBe(5)
    expect(roundMinutes(8, 10, "nearest")).toBe(10)
    expect(roundMinutes(13, 0, "nearest")).toBe(13)
    expect(() => roundMinutes(-1, 5, "down")).toThrow()
    const t0 = h("2026-11-09", "09:00")
    expect(entryMinutes({ startAt: t0, endAt: t0 + 452 * MINUTE_MS, breaks: [] }, settings({ roundingMinutes: 15 })).roundedMinutes).toBe(450)
  })
  it("un fichaje abierto necesita hasta cuándo contar", () => {
    const t0 = h("2026-11-09", "09:00")
    expect(() => entryMinutes({ startAt: t0, endAt: null, breaks: [] }, settings())).toThrow()
    expect(entryMinutes({ startAt: t0, endAt: null, breaks: [] }, settings(), t0 + 60 * MINUTE_MS).workedMinutes).toBe(60)
  })
  it("21:00 a 02:00 con pausa cuenta en dos días y la suma cuadra", () => {
    const t: EntryTimes = { startAt: h("2026-11-09", "21:00"), endAt: h("2026-11-10", "02:00"), breaks: [{ startAt: h("2026-11-09", "23:40"), endAt: h("2026-11-10", "00:20") }] }
    const total = entryMinutes(t, settings())
    expect(total).toMatchObject({ grossMinutes: 300, breakMinutes: 40, workedMinutes: 260 })
    // Hasta las 23:40 son 160 min el día 9; de 00:20 a 02:00 son 100 min el día 10.
    expect(minutesByLocalDay(t, settings(), ZONA)).toEqual({ "2026-11-09": 160, "2026-11-10": 100 })
  })
  it("con redondeo el reparto por día sigue sumando el total redondeado", () => {
    const t: EntryTimes = { startAt: h("2026-11-09", "21:07"), endAt: h("2026-11-10", "01:58"), breaks: [] }
    const s = settings({ roundingMinutes: 15, roundingMode: "nearest" })
    const total = entryMinutes(t, s).roundedMinutes
    const dias = minutesByLocalDay(t, s, ZONA)
    expect(Object.values(dias).reduce((a, b) => a + b, 0)).toBe(total)
    expect(Object.keys(dias)).toEqual(["2026-11-09", "2026-11-10"])
  })
  it("el cambio de hora de octubre añade una hora real y el de marzo la quita", () => {
    const otono: EntryTimes = { startAt: h("2026-10-24", "22:00"), endAt: h("2026-10-25", "06:00"), breaks: [] }
    expect(entryMinutes(otono, settings()).workedMinutes).toBe(9 * 60)
    expect(minutesByLocalDay(otono, settings(), ZONA)).toEqual({ "2026-10-24": 120, "2026-10-25": 420 })
    const primavera: EntryTimes = { startAt: h("2027-03-27", "22:00"), endAt: h("2027-03-28", "06:00"), breaks: [] }
    expect(entryMinutes(primavera, settings()).workedMinutes).toBe(7 * 60)
    expect(minutesByLocalDay(primavera, settings(), ZONA)).toEqual({ "2027-03-27": 120, "2027-03-28": 300 })
  })
  it("trunca al minuto, también con instantes negativos", () => {
    expect(truncateToMinute(61_999)).toBe(60_000)
    expect(truncateToMinute(60_000)).toBe(60_000)
    expect(truncateToMinute(-1)).toBe(-60_000)
  })
})

describe("informe de horas", () => {
  const cerrado = (uid: string, ini: string, fin: string, fecha = "2026-11-09") => entry(uid, { startAt: h(fecha, ini), endAt: h(fecha, fin), breaks: [] }, { date: fecha })
  it("suma por persona y día, ignora anulados y cuenta abiertos y olvidados aparte", () => {
    const nocturno = entry("ana", { startAt: h("2026-11-09", "21:00"), endAt: h("2026-11-10", "02:00"), breaks: [] })
    const lista: EntryLike[] = [
      cerrado("ana", "09:00", "13:00", "2026-11-10"), nocturno, cerrado("bea", "10:00", "11:30"),
      { ...cerrado("bea", "12:00", "13:00"), status: "voided" },
      entry("bea", { startAt: h("2026-11-10", "17:00"), endAt: null, breaks: [] }, { date: "2026-11-10" }),
      entry("bea", { startAt: h("2026-11-08", "08:00"), endAt: null, breaks: [] }, { date: "2026-11-08", forgotten: true }),
    ]
    const rows = hoursReport(lista, { from: "2026-11-09", to: "2026-11-10", timezone: ZONA, settings: settings(), now: h("2026-11-10", "18:00") })
    expect(rows.map((r) => r.uid)).toEqual(["ana", "bea"])
    expect(rows[0]).toMatchObject({ uid: "ana", minutes: 300 + 240, entries: 2, byDate: { "2026-11-09": 180, "2026-11-10": 120 + 240 } })
    expect(rows[1]).toMatchObject({ uid: "bea", minutes: 90, entries: 1, openEntries: 1, forgottenEntries: 0, provisionalMinutes: 60 })
    const solo9 = hoursReport(lista, { from: "2026-11-09", to: "2026-11-09", timezone: ZONA, settings: settings(), now: h("2026-11-10", "18:00") })
    expect(solo9.find((r) => r.uid === "ana")?.minutes).toBe(180)
    const viejo = hoursReport(lista, { from: "2026-11-08", to: "2026-11-08", timezone: ZONA, settings: settings(), now: h("2026-11-10", "18:00") })
    expect(viejo).toEqual([expect.objectContaining({ uid: "bea", minutes: 0, openEntries: 1, forgottenEntries: 1, provisionalMinutes: 0 })])
  })
  it("marca como olvidados los abiertos pasados de límite, una sola vez", () => {
    const base = { status: "open" as const, forgotten: false }
    const lista = [
      { id: "a", ...base, startAt: h("2026-11-09", "09:00") },
      { id: "b", ...base, startAt: h("2026-11-09", "22:00") },
      { id: "c", ...base, forgotten: true, startAt: h("2026-11-08", "09:00") },
      { id: "d", status: "closed" as const, forgotten: false, startAt: h("2026-11-08", "09:00") },
    ]
    expect(findForgottenEntries(lista, h("2026-11-10", "00:00"), settings())).toEqual(["a"])
    expect(findForgottenEntries(lista, h("2026-11-10", "08:00"), settings({ forgottenAfterMinutes: 1440 }))).toEqual([])
  })
  it("sugiere cerrar a la hora del turno solo si acaba después de la entrada", () => {
    expect(suggestedCloseAt({ startAt: 1000 * MINUTE_MS }, { startAt: 900 * MINUTE_MS, endAt: 1300 * MINUTE_MS })).toBe(1300 * MINUTE_MS)
    expect(suggestedCloseAt({ startAt: 1400 * MINUTE_MS }, { startAt: 900 * MINUTE_MS, endAt: 1300 * MINUTE_MS })).toBeNull()
    expect(suggestedCloseAt({ startAt: 1 }, null)).toBeNull()
  })
})

describe("horas para repartir propinas", () => {
  const caja = { startAt: h("2026-11-09", "12:00"), endAt: h("2026-11-09", "23:00") }
  it("cuenta lo trabajado dentro de la caja, sin pausas, ordenado y sin ceros", () => {
    const lista: EntryLike[] = [
      entry("zoe", { startAt: h("2026-11-09", "11:00"), endAt: h("2026-11-09", "15:00"), breaks: [{ startAt: h("2026-11-09", "12:30"), endAt: h("2026-11-09", "13:00") }] }),
      entry("ana", { startAt: h("2026-11-09", "18:00"), endAt: h("2026-11-10", "01:00"), breaks: [] }),
      entry("luz", { startAt: h("2026-11-09", "23:00"), endAt: h("2026-11-10", "01:00"), breaks: [] }),
      entry("ana", { startAt: h("2026-11-09", "08:00"), endAt: h("2026-11-09", "11:59"), breaks: [] }),
    ]
    expect(tipHoursForWindow(lista, caja, settings())).toEqual({ hours: [{ uid: "ana", minutes: 300 }, { uid: "zoe", minutes: 150 }], incomplete: [] })
    expect(tipHoursForWindow(lista, caja, settings({ breaksPaid: true })).hours.find((x) => x.uid === "zoe")?.minutes).toBe(180)
  })
  it("un fichaje abierto cuenta hasta cerrar la caja y uno olvidado deja a la persona como incompleta", () => {
    const lista: EntryLike[] = [
      entry("ana", { startAt: h("2026-11-09", "20:00"), endAt: null, breaks: [] }),
      entry("bea", { startAt: h("2026-11-09", "13:00"), endAt: null, breaks: [] }, { forgotten: true }),
      { ...entry("cai", { startAt: h("2026-11-09", "13:00"), endAt: h("2026-11-09", "14:00"), breaks: [] }), status: "voided" },
    ]
    expect(tipHoursForWindow(lista, caja, settings())).toEqual({ hours: [{ uid: "ana", minutes: 180 }], incomplete: ["bea"] })
    expect(() => tipHoursForWindow([], { startAt: 10, endAt: 5 }, settings())).toThrow()
  })
})

describe("validación de lo que escribe un encargado", () => {
  const now = h("2026-11-09", "20:00")
  const t = (ini: string, fin: string | null, breaks: EntryTimes["breaks"] = []): EntryTimes => ({ startAt: h("2026-11-09", ini), endAt: fin === null ? null : h("2026-11-09", fin), breaks })
  const codigos = (x: EntryTimes, others: Parameters<typeof validateEntryTimes>[1]["others"] = []) => validateEntryTimes(x, { now, others }).map((i) => i.code)
  it("acepta un fichaje normal con pausa", () => {
    expect(codigos(t("09:00", "17:00", [{ startAt: h("2026-11-09", "13:00"), endAt: h("2026-11-09", "13:30") }]))).toEqual([])
  })
  it("detecta futuro, orden, duración, pausas mal puestas y solapes con otros fichajes", () => {
    expect(codigos(t("09:00", "21:00"))).toContain("future")
    expect(codigos({ startAt: h("2026-11-09", "10:00"), endAt: h("2026-11-09", "09:00"), breaks: [] })).toContain("order")
    expect(codigos({ startAt: h("2026-11-08", "01:00"), endAt: h("2026-11-08", "20:00"), breaks: [] })).toContain("too_long")
    expect(codigos(t("09:00", "17:00", [{ startAt: h("2026-11-09", "08:00"), endAt: h("2026-11-09", "08:30") }]))).toContain("break_outside")
    expect(codigos(t("09:00", "17:00", [{ startAt: h("2026-11-09", "12:00"), endAt: h("2026-11-09", "13:00") }, { startAt: h("2026-11-09", "12:30"), endAt: h("2026-11-09", "14:00") }]))).toContain("break_overlap")
    expect(codigos(t("09:00", "17:00", [{ startAt: h("2026-11-09", "12:00"), endAt: h("2026-11-09", "11:00") }]))).toContain("break_order")
    const otro = { startAt: h("2026-11-09", "16:00"), endAt: h("2026-11-09", "18:00"), status: "closed" as const }
    expect(codigos(t("09:00", "17:00"), [otro])).toContain("overlaps_entry")
    expect(codigos(t("09:00", "17:00"), [{ ...otro, status: "voided" }])).toEqual([])
    expect(codigos(t("17:00", "19:00"), [{ startAt: h("2026-11-09", "18:00"), endAt: null, status: "open" }])).toContain("overlaps_entry")
    expect(codigos(t("08:00", "09:00"), [otro])).toEqual([])
  })
})

describe("PIN del puesto", () => {
  const salt = "0123456789abcdef0123456789abcdef"
  it("la huella depende de la persona, la sal y el PIN", () => {
    expect(pinHash("1234", "ana", salt)).toMatch(/^[0-9a-f]{64}$/)
    expect(pinHash("1234", "ana", salt)).not.toBe(pinHash("1234", "bea", salt))
    expect(pinHash("1234", "ana", salt)).not.toBe(pinHash("1235", "ana", salt))
    expect(pinHash("1234", "ana", salt)).not.toBe(pinHash("1234", "ana", "f".repeat(32)))
  })
  it("acierta, falla, avisa de los intentos y se bloquea cinco minutos", () => {
    let r = newPinRecord("1234", "ana", salt)
    const ahora = 1_000_000
    expect(checkPin(r, "1234", "ana", ahora)).toMatchObject({ ok: true })
    for (let i = 1; i < PIN_MAX_ATTEMPTS; i++) {
      const c = checkPin(r, "0000", "ana", ahora)
      expect(c).toMatchObject({ ok: false, reason: "wrong", attemptsLeft: PIN_MAX_ATTEMPTS - i })
      r = c.record
    }
    const ultimo = checkPin(r, "0000", "ana", ahora)
    expect(ultimo).toMatchObject({ ok: false, reason: "locked", lockedUntil: ahora + PIN_LOCK_MS })
    r = ultimo.record
    expect(checkPin(r, "1234", "ana", ahora + 1000)).toMatchObject({ ok: false, reason: "locked" })
    const luego = checkPin(r, "1234", "ana", ahora + PIN_LOCK_MS)
    expect(luego).toMatchObject({ ok: true })
    expect(luego.record).toMatchObject({ failedAttempts: 0, lockedUntil: null })
    expect(checkPin(r, "1234", "bea", ahora + PIN_LOCK_MS)).toMatchObject({ ok: false, reason: "wrong" })
  })
})

describe("cuadrante", () => {
  let n = 0
  const turno = (uid: string, fecha: string, ini: string, fin: string, finFecha = fecha, extra: Partial<StaffShiftWithId> = {}): StaffShiftWithId => {
    const startAt = h(fecha, ini)
    return { id: `t${++n}`, uid, startAt, endAt: h(finFecha, fin), position: "Sala", note: "", ...shiftPlacement(startAt, ZONA), status: "draft", publishedAt: null, revision: 1, ...extra }
  }
  it("la semana empieza en lunes y un turno pertenece al día en que empieza", () => {
    expect(weekStartOf("2026-11-09")).toBe("2026-11-09")
    expect(weekStartOf("2026-11-15")).toBe("2026-11-09")
    expect(weekStartOf("2026-11-16")).toBe("2026-11-16")
    expect(weekDates("2026-11-09")).toHaveLength(7)
    expect(() => weekDates("2026-11-10")).toThrow()
    expect(shiftPlacement(h("2026-11-15", "23:00"), ZONA)).toEqual({ date: "2026-11-15", weekStart: "2026-11-09" })
    expect(shiftPlacement(h("2026-11-16", "00:30"), ZONA)).toEqual({ date: "2026-11-16", weekStart: "2026-11-16" })
  })
  it("el turno se valida: acaba después, máximo 16 horas", () => {
    const base = { uid: "ana", position: "Sala", note: "" }
    expect(StaffShiftEditableSchema.safeParse({ ...base, startAt: 1000, endAt: 1000 }).success).toBe(false)
    expect(StaffShiftEditableSchema.safeParse({ ...base, startAt: 0, endAt: 17 * 60 * MINUTE_MS }).success).toBe(false)
    expect(StaffShiftEditableSchema.safeParse({ ...base, startAt: 0, endAt: 16 * 60 * MINUTE_MS }).success).toBe(true)
  })
  it("detecta turnos que se pisan de la misma persona y deja pasar al resto", () => {
    const a = turno("ana", "2026-11-09", "12:00", "16:00")
    const b = turno("bea", "2026-11-09", "12:00", "16:00")
    expect(findShiftConflicts([a, b], { uid: "ana", startAt: h("2026-11-09", "15:00"), endAt: h("2026-11-09", "20:00") })).toEqual([a.id])
    expect(findShiftConflicts([a, b], { uid: "ana", startAt: h("2026-11-09", "16:00"), endAt: h("2026-11-09", "20:00") })).toEqual([])
    expect(findShiftConflicts([a], { id: a.id, uid: "ana", startAt: h("2026-11-09", "13:00"), endAt: h("2026-11-09", "14:00") })).toEqual([])
  })
  it("avisa de descanso corto y de horas semanales, sin bloquear", () => {
    const lista = [
      turno("ana", "2026-11-09", "20:00", "02:00", "2026-11-10"),
      turno("ana", "2026-11-10", "10:00", "14:00"),
      turno("ana", "2026-11-12", "10:00", "22:00"),
      turno("ana", "2026-11-13", "10:00", "22:00"),
      turno("ana", "2026-11-14", "10:00", "22:00"),
      turno("bea", "2026-11-09", "10:00", "14:00"),
    ]
    const avisos = scheduleWarnings(lista, { minRestMinutes: 720, maxWeeklyMinutes: 2400 })
    expect(avisos.map((a) => a.kind)).toEqual(["short_rest", "weekly_hours"])
    expect(avisos[0]).toMatchObject({ uid: "ana", shiftIds: [lista[0]!.id, lista[1]!.id] })
    expect(scheduleWarnings(lista, { minRestMinutes: 0, maxWeeklyMinutes: 10080 })).toEqual([])
    const pisados = [turno("ana", "2026-11-09", "10:00", "14:00"), turno("ana", "2026-11-09", "13:00", "18:00")]
    expect(scheduleWarnings(pisados, { minRestMinutes: 0, maxWeeklyMinutes: 10080 }).map((a) => a.kind)).toEqual(["overlap"])
  })
  it("planificado por persona", () => {
    expect(plannedMinutesByUid([turno("ana", "2026-11-09", "10:00", "14:30"), turno("ana", "2026-11-10", "10:00", "11:00"), turno("bea", "2026-11-09", "10:00", "12:00")])).toEqual({ ana: 330, bea: 120 })
  })
  it("copia una semana manteniendo la hora de pared, también a través del cambio de hora", () => {
    const origen = [turno("ana", "2026-10-19", "21:00", "02:00", "2026-10-20"), turno("bea", "2026-10-25", "10:00", "14:00")]
    const { copied, skipped } = copyWeek(origen, "2026-10-19", "2026-10-26", ZONA)
    expect(skipped).toEqual([])
    expect(copied[0]).toMatchObject({ uid: "ana", startAt: h("2026-10-26", "21:00"), endAt: h("2026-10-27", "02:00") })
    expect(copied[1]).toMatchObject({ uid: "bea", startAt: h("2026-11-01", "10:00"), endAt: h("2026-11-01", "14:00") })
    // 21:00 del lunes 26 ya es hora de invierno: el turno de 5 h dura lo mismo en reloj de pared.
    expect((copied[0]!.endAt - copied[0]!.startAt) / MINUTE_MS).toBe(300)
  })
  it("no copia un turno cuya hora no existe en el destino (adelanto de hora)", () => {
    const lunes = turno("ana", "2027-03-15", "10:00", "14:00")
    const cierreSabado = turno("ana", "2027-03-20", "22:00", "02:30", "2027-03-21")
    const madrugadaDomingo = turno("bea", "2027-03-21", "02:30", "05:00")
    const viernesNoche = turno("cai", "2027-03-19", "22:00", "02:00", "2027-03-20")
    // En destino el domingo 28 de marzo salta de las 02:00 a las 03:00: las 02:30 no existen.
    const { copied, skipped } = copyWeek([lunes, cierreSabado, madrugadaDomingo, viernesNoche], "2027-03-15", "2027-03-22", ZONA)
    expect(copied.map((c) => c.uid)).toEqual(["ana", "cai"])
    expect(skipped.map((x) => x.shiftId)).toEqual([cierreSabado.id, madrugadaDomingo.id])
    expect(copied[1]).toMatchObject({ startAt: h("2027-03-26", "22:00"), endAt: h("2027-03-27", "02:00") })
  })
  it("compara lo planificado con lo fichado", () => {
    const s = settings({ lateToleranceMinutes: 10 })
    const lista = [
      turno("ana", "2026-11-09", "12:00", "16:00"), turno("bea", "2026-11-09", "12:00", "16:00"),
      turno("cai", "2026-11-09", "12:00", "16:00"), turno("dan", "2026-11-09", "20:00", "23:00"),
    ]
    const fichajes = [
      { id: "e1", uid: "ana", startAt: h("2026-11-09", "11:55"), status: "closed" as const, workedMinutes: 245 },
      { id: "e2", uid: "bea", startAt: h("2026-11-09", "12:25"), status: "open" as const, workedMinutes: null },
      { id: "e3", uid: "cai", startAt: h("2026-11-09", "12:00"), status: "voided" as const, workedMinutes: 240 },
    ]
    const r = planVsReal(lista, fichajes, s, h("2026-11-09", "13:00"))
    expect(r.map((x) => [x.uid, x.status, x.lateMinutes])).toEqual([["ana", "on_time", 0], ["bea", "late", 25], ["cai", "absent", 0], ["dan", "upcoming", 0]])
    expect(r[0]).toMatchObject({ entryId: "e1", plannedMinutes: 240, workedMinutes: 245 })
  })
})

describe("documentos", () => {
  it("los ajustes por defecto son válidos y los redondeos admitidos son los del contrato", () => {
    expect(StaffSettingsSchema.safeParse(defaultStaffSettings()).success).toBe(true)
    expect(StaffSettingsSchema.safeParse({ ...defaultStaffSettings(), roundingMinutes: 7 }).success).toBe(false)
    expect(StaffSettingsSchema.safeParse({ ...defaultStaffSettings(), forgottenAfterMinutes: 30 }).success).toBe(false)
  })
  it("un fichaje abierto no tiene salida y uno cerrado necesita minutos", () => {
    const base = { uid: "ana", date: "2026-11-09", startAt: 1000, breaks: [], startSource: "self", endSource: null, shiftId: null, forgotten: false, needsReview: false, breakMinutes: 0, note: null, revision: 1 }
    expect(TimeEntrySchema.safeParse({ ...base, endAt: null, status: "open", workedMinutes: null }).success).toBe(true)
    expect(TimeEntrySchema.safeParse({ ...base, endAt: 5000, status: "open", workedMinutes: null }).success).toBe(false)
    expect(TimeEntrySchema.safeParse({ ...base, endAt: 5000, status: "closed", workedMinutes: null }).success).toBe(false)
    expect(TimeEntrySchema.safeParse({ ...base, endAt: 500, status: "closed", workedMinutes: 0 }).success).toBe(false)
    expect(TimeEntrySchema.safeParse({ ...base, endAt: 5000, status: "closed", workedMinutes: 1 }).success).toBe(true)
  })
  it("las correcciones de un encargado exigen motivo en la auditoría", () => {
    const base = { entryId: "e1", uid: "ana", at: 1000, by: "enc", source: "manager", before: null, after: null }
    expect(TimeEntryEventSchema.safeParse({ ...base, kind: "correction", reason: null }).success).toBe(false)
    expect(TimeEntryEventSchema.safeParse({ ...base, kind: "correction", reason: "Se le olvidó fichar" }).success).toBe(true)
    expect(TimeEntryEventSchema.safeParse({ ...base, kind: "clock_in", reason: null }).success).toBe(true)
  })
  it("los adaptadores de escritura convierten las horas con el conversor recibido", () => {
    const aTs = (ms: number) => ({ ts: ms })
    const e = timeEntryForWrite({ uid: "a", date: "2026-11-09", startAt: 1, endAt: null, breaks: [{ startAt: 2, endAt: 3 }], status: "open", startSource: "self", endSource: null, shiftId: null, forgotten: false, needsReview: false, workedMinutes: null, breakMinutes: 0, note: null, revision: 1 }, aTs)
    expect(e).toMatchObject({ startAt: { ts: 1 }, endAt: null, breaks: [{ startAt: { ts: 2 }, endAt: { ts: 3 } }] })
    expect(staffShiftForWrite({ uid: "a", startAt: 1, endAt: 2, position: "Sala", note: "", date: "2026-11-09", weekStart: "2026-11-09", status: "draft", publishedAt: null, revision: 1 }, aTs)).toMatchObject({ startAt: { ts: 1 }, endAt: { ts: 2 }, publishedAt: null })
  })
})
