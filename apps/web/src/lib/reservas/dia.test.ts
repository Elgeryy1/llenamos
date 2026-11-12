import { describe, expect, it } from "vitest"
import { belongsToDay, coversBySlot, currentShiftIndex, dayQueryWindow, groupByShift, halfHourOf, localDate, shiftForStart, summarize } from "./dia"
import { at, config, reservation, TZ } from "./fixtures"

// 2026-11-10 es martes: comida 13:00–15:30 y cena 20:00–22:30. El lunes 9 está cerrado.
const TUE = "2026-11-10"

describe("ventana del día", () => {
  it("va de las 00:00 del día a las 00:00 de dos días después, en hora de Madrid", () => {
    const w = dayQueryWindow(TUE, TZ)
    expect(new Date(w.from).toISOString()).toBe("2026-11-09T23:00:00.000Z")
    expect(new Date(w.to).toISOString()).toBe("2026-11-11T23:00:00.000Z")
  })

  it("la fecha del local sale del instante, no del reloj del ordenador", () => {
    expect(localDate(Date.parse("2026-11-09T23:30:00Z"), TZ)).toBe("2026-11-10")
  })
})

describe("turno de cada reserva", () => {
  const c = config()

  it("cae en comida o en cena según la hora de llegada", () => {
    expect(shiftForStart(at(TUE, "13:30"), c, TUE)?.name).toBe("Comida")
    expect(shiftForStart(at(TUE, "22:30"), c, TUE)?.name).toBe("Cena")
  })

  it("una reserva fuera de horario del mismo día va a «fuera de turno»", () => {
    expect(shiftForStart(at(TUE, "17:00"), c, TUE)?.index).toBe(-1)
  })

  it("las del día siguiente no son de este día", () => {
    expect(shiftForStart(at("2026-11-11", "13:00"), c, TUE)).toBeNull()
    expect(belongsToDay(at("2026-11-11", "01:00"), c, TUE)).toBe(false)
  })

  it("un turno que cruza la medianoche se queda las llegadas de madrugada", () => {
    const noche = config({
      semana: { ...c.semana, mar: [{ nombre: "Noche", desde: "22:00", ultimaEntrada: "01:30" }], mie: [{ nombre: "Noche", desde: "22:00", ultimaEntrada: "01:30" }] },
    })
    expect(shiftForStart(at("2026-11-11", "00:45"), noche, TUE)?.name).toBe("Noche")
    // Y el miércoles no la cuenta como suya.
    expect(shiftForStart(at("2026-11-11", "00:45"), noche, "2026-11-11")).toBeNull()
  })
})

describe("agrupar por turno y media hora", () => {
  const c = config()
  const list = [
    reservation({ startAt: at(TUE, "21:15"), partySize: 4 }),
    reservation({ startAt: at(TUE, "13:00"), partySize: 2 }),
    reservation({ startAt: at(TUE, "21:00"), partySize: 3, status: "cancelled" }),
    reservation({ startAt: at(TUE, "20:00"), partySize: 6, status: "seated" }),
    reservation({ startAt: at(TUE, "17:00"), partySize: 2 }),
    reservation({ startAt: at("2026-11-11", "13:00"), partySize: 8 }),
  ]
  const groups = groupByShift(list, c, TUE)

  it("ordena comida, cena y fuera de turno, y deja fuera las de otro día", () => {
    expect(groups.map((g) => g.shift.name)).toEqual(["Comida", "Cena", "Fuera de turno"])
    expect(groups.flatMap((g) => g.reservations)).toHaveLength(5)
  })

  it("los cubiertos no cuentan canceladas", () => {
    const cena = groups[1]!
    expect(cena.covers).toBe(10)
    expect(cena.slots.map((s) => [s.label, s.covers])).toEqual([
      ["20:00", 6],
      ["21:00", 4],
    ])
  })

  it("puede enseñar los turnos vacíos", () => {
    expect(groupByShift([], c, TUE, { includeEmpty: true }).map((g) => g.shift.name)).toEqual(["Comida", "Cena"])
  })

  it("en un día cerrado todo es fuera de turno", () => {
    const g = groupByShift([reservation({ startAt: at("2026-11-09", "13:00") })], c, "2026-11-09")
    expect(g.map((x) => x.shift.index)).toEqual([-1])
  })

  it("la barra de ocupación tiene una franja por media hora del turno", () => {
    const bars = coversBySlot(groups[1]!, c, TUE)
    expect(bars.map((b) => b.label)).toEqual(["20:00", "20:30", "21:00", "21:30", "22:00", "22:30"])
    expect(bars.map((b) => b.covers)).toEqual([6, 0, 4, 0, 0, 0])
  })

  it("media hora de llegada", () => {
    expect(halfHourOf(at(TUE, "20:44"), TZ)).toBe("20:30")
  })
})

describe("turno que toca ahora", () => {
  const c = config()
  it("por la mañana, la comida; por la tarde, la cena", () => {
    expect(currentShiftIndex(c, TUE, at(TUE, "10:00"))).toBe(0)
    expect(currentShiftIndex(c, TUE, at(TUE, "18:30"))).toBe(1)
    expect(currentShiftIndex(c, TUE, at(TUE, "23:30"))).toBe(1)
  })
  it("un día cerrado no tiene turno", () => {
    expect(currentShiftIndex(c, "2026-11-09", at("2026-11-09", "13:00"))).toBeNull()
  })
})

describe("resumen del día", () => {
  it("cuenta cubiertos, sentados, por llegar, sin mesa y señales", () => {
    const s = summarize([
      reservation({ partySize: 2, status: "seated", tableIds: ["S1"] }),
      reservation({ partySize: 4, status: "confirmed" }),
      reservation({ partySize: 3, status: "pending", tableIds: ["S2"], deposit: { status: "paid", amountCents: 3000, checkoutSessionId: null } }),
      reservation({ partySize: 5, status: "cancelled" }),
      reservation({ partySize: 2, status: "finished", tableIds: ["S3"] }),
    ])
    expect(s).toEqual({ covers: 11, seated: 2, toArrive: 7, finished: 2, withoutTable: 1, pending: 1, depositsPaidCents: 3000, reservations: 4 })
  })
})
