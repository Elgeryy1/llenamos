import { describe, expect, it } from "vitest"
import {
  diaLargo, diaMes, duracion, fechasEntre, horasMinutos, instantesDeFormulario, moverAncla, normalizarHora,
  periodoDe, rangoTexto, secuenciaDeHoras, agruparMotivos, turnoDeFormulario, turnosPorCelda, horaTexto, formularioDeFichaje,
} from "./modelo"

describe("textos", () => {
  it("duración y horas", () => {
    expect(duracion(0)).toBe("0 min")
    expect(duracion(45)).toBe("45 min")
    expect(duracion(120)).toBe("2 h")
    expect(duracion(450)).toBe("7 h 30 min")
    expect(horasMinutos(450)).toBe("7:30")
    expect(horasMinutos(65)).toBe("1:05")
  })
  it("fechas en castellano", () => {
    expect(diaLargo("2026-11-09")).toBe("lunes 9 de noviembre")
    expect(diaMes("2026-11-09")).toBe("lun 9 nov")
    expect(rangoTexto("2026-11-09", "2026-11-15")).toBe("9 al 15 de noviembre")
    expect(rangoTexto("2026-10-26", "2026-11-01")).toBe("26 de octubre al 1 de noviembre")
  })
})

describe("periodos", () => {
  it("semana de lunes a domingo y mes natural", () => {
    expect(periodoDe("semana", "2026-11-11")).toEqual({ from: "2026-11-09", to: "2026-11-15" })
    expect(periodoDe("mes", "2026-11-11")).toEqual({ from: "2026-11-01", to: "2026-11-30" })
    expect(periodoDe("mes", "2026-12-20")).toEqual({ from: "2026-12-01", to: "2026-12-31" })
    expect(periodoDe("mes", "2028-02-10").to).toBe("2028-02-29")
  })
  it("mover periodos", () => {
    expect(moverAncla("semana", "2026-11-09", -1)).toBe("2026-11-02")
    expect(moverAncla("mes", "2026-11-11", 1)).toBe("2026-12-01")
    expect(moverAncla("mes", "2026-01-11", -1)).toBe("2025-12-31")
  })
  it("fechas entre", () => {
    expect(fechasEntre("2026-11-29", "2026-12-02")).toEqual(["2026-11-29", "2026-11-30", "2026-12-01", "2026-12-02"])
  })
})

describe("horas escritas", () => {
  it("normaliza", () => {
    expect(normalizarHora("9:30")).toBe("09:30")
    expect(normalizarHora("0930")).toBe("09:30")
    expect(normalizarHora("930")).toBe("09:30")
    expect(normalizarHora("9")).toBe("09:00")
    expect(normalizarHora("24:00")).toBeNull()
    expect(normalizarHora("12:61")).toBeNull()
    expect(normalizarHora("abc")).toBeNull()
  })
  it("la salida de madrugada es del día siguiente", () => {
    const r = instantesDeFormulario({ fecha: "2026-11-09", entrada: "20:00", salida: "02:10", pausas: [{ inicio: "22:30", fin: "23:00" }] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(horaTexto(r.startAt)).toBe("20:00")
    expect(r.endAt - r.startAt).toBe((6 * 60 + 10) * 60_000)
    expect(r.breaks[0]!.endAt - r.breaks[0]!.startAt).toBe(30 * 60_000)
  })
  it("una pausa pasada la medianoche también", () => {
    const r = instantesDeFormulario({ fecha: "2026-11-09", entrada: "21:00", salida: "03:00", pausas: [{ inicio: "00:15", fin: "00:45" }] })
    expect(r.ok && r.breaks[0]!.startAt > r.startAt).toBe(true)
  })
  it("avisa con la hora mal escrita y con la salida igual a la entrada", () => {
    expect(instantesDeFormulario({ fecha: "2026-11-09", entrada: "25:00", salida: "10:00", pausas: [] })).toMatchObject({ ok: false })
    const r = instantesDeFormulario({ fecha: "2026-11-09", entrada: "10:00", salida: "10:00", pausas: [] })
    expect(r).toMatchObject({ ok: false, message: "La salida tiene que ser después de la entrada." })
  })
  it("el cambio de hora de marzo no tiene las 02:30", () => {
    expect(secuenciaDeHoras("2027-03-28", ["02:30"])).toMatchObject({ ok: false })
  })
  it("el retraso de octubre: una noche de 22:00 a 06:00 son 9 horas reales", () => {
    const r = instantesDeFormulario({ fecha: "2026-10-24", entrada: "22:00", salida: "06:00", pausas: [] })
    expect(r.ok && (r.endAt - r.startAt) / 3_600_000).toBe(9)
    const r2 = instantesDeFormulario({ fecha: "2026-10-25", entrada: "01:00", salida: "04:00", pausas: [] })
    expect(r2.ok && (r2.endAt - r2.startAt) / 3_600_000).toBe(4)
  })
  it("ida y vuelta con un fichaje existente", () => {
    const base = instantesDeFormulario({ fecha: "2026-11-09", entrada: "13:00", salida: "17:30", pausas: [{ inicio: "16:00", fin: "16:30" }] })
    if (!base.ok) throw new Error("no debería fallar")
    const form = formularioDeFichaje({ date: "2026-11-09", startAt: base.startAt, endAt: base.endAt, breaks: base.breaks })
    expect(form).toEqual({ fecha: "2026-11-09", entrada: "13:00", salida: "17:30", pausas: [{ inicio: "16:00", fin: "16:30" }] })
  })
})

describe("cuadrante", () => {
  it("turnos de una noche que cruza medianoche", () => {
    expect(turnoDeFormulario("2026-11-09", "20:00", "02:00")).toMatchObject({ ok: true })
    expect(turnoDeFormulario("2026-11-09", "08:00", "08:00")).toMatchObject({ ok: false })
    expect(turnoDeFormulario("2026-11-09", "06:00", "23:00")).toMatchObject({ ok: false, message: "Un turno no pasa de 16 horas." })
  })
  it("agrupa por persona y día, ordenado", () => {
    const m = turnosPorCelda([
      { uid: "a", date: "2026-11-09", startAt: 20 }, { uid: "a", date: "2026-11-09", startAt: 10 }, { uid: "b", date: "2026-11-09", startAt: 5 },
    ])
    expect(m.get("a|2026-11-09")!.map((t) => t.startAt)).toEqual([10, 20])
    expect(m.get("b|2026-11-09")).toHaveLength(1)
  })
})

describe("motivos repetidos", () => {
  it("agrupa con su cuenta", () => {
    expect(agruparMotivos(["Se pisa.", "Se pisa.", "Otra cosa."])).toEqual(["Se pisa (2 turnos).", "Otra cosa."])
    expect(agruparMotivos([])).toEqual([])
  })
})
