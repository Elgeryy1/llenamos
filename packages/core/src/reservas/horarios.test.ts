import { describe, expect, it } from "vitest"
import { config, MINUTO, utc } from "./datos-prueba"
import {
  ConfiguracionReservasSchema,
  configuracionReservasInicial,
  cruzaMedianoche,
  duracionParaGrupo,
  franjasDelDia,
  turnosDelDia,
  TurnosDelDiaSchema,
  type Turno,
} from "./horarios"

const noche = (ultimaEntrada: string): Turno => ({ nombre: "Noche", desde: "22:00", ultimaEntrada })

describe("configuración", () => {
  it("la configuración inicial es válida", () => {
    expect(ConfiguracionReservasSchema.safeParse(configuracionReservasInicial()).success).toBe(true)
  })

  it("rechaza turnos que se pisan, también si uno cruza la medianoche", () => {
    expect(
      TurnosDelDiaSchema.safeParse([
        { nombre: "Comida", desde: "13:00", ultimaEntrada: "15:30" },
        { nombre: "Merienda", desde: "15:30", ultimaEntrada: "17:00" },
      ]).success,
    ).toBe(false)
    expect(
      TurnosDelDiaSchema.safeParse([
        { nombre: "Comida", desde: "13:00", ultimaEntrada: "15:30" },
        { nombre: "Cena", desde: "20:00", ultimaEntrada: "23:00" },
      ]).success,
    ).toBe(true)
    expect(
      TurnosDelDiaSchema.safeParse([
        { nombre: "Cena", desde: "20:00", ultimaEntrada: "23:00" },
        noche("01:00"),
      ]).success,
    ).toBe(false)
  })

  it("rechaza datos mal escritos", () => {
    const base = configuracionReservasInicial()
    const mal = (cambios: object) => ConfiguracionReservasSchema.safeParse({ ...base, ...cambios }).success
    expect(mal({ zonaHoraria: "Marte/Olimpo" })).toBe(false)
    expect(mal({ duracion: undefined, excepciones: "no" })).toBe(false)
    expect(mal({ pasoMinutos: 7 })).toBe(false)
    expect(mal({ comensalesMin: 10, comensalesMax: 4 })).toBe(false)
    expect(
      mal({
        excepciones: [
          { tipo: "cerrado", fecha: "2026-12-25" },
          { tipo: "cerrado", fecha: "2026-12-25" },
        ],
      }),
    ).toBe(false)
    expect(mal({ excepciones: [{ tipo: "horario", fecha: "2026-12-24", turnos: [] }] })).toBe(false)
    expect(mal({ cierres: [{ desde: "2026-08-31", hasta: "2026-08-01" }] })).toBe(false)
    expect(
      mal({
        duracion: {
          porDefectoMinutos: 120,
          tramos: [
            { hastaComensales: 4, minutos: 90 },
            { hastaComensales: 2, minutos: 60 },
          ],
        },
      }),
    ).toBe(false)
    expect(mal({ semana: { ...base.semana, lun: [{ nombre: "Cena", desde: "25:00", ultimaEntrada: "23:00" }] } })).toBe(false)
  })

  it("sabe si un turno cruza la medianoche", () => {
    expect(cruzaMedianoche(noche("01:00"))).toBe(true)
    expect(cruzaMedianoche({ desde: "20:00", ultimaEntrada: "22:30" })).toBe(false)
  })
})

describe("duración según el tamaño del grupo", () => {
  it("usa el primer tramo en el que cabe y, si no, la duración por defecto", () => {
    const c = config()
    expect(duracionParaGrupo(c, 1)).toBe(90)
    expect(duracionParaGrupo(c, 2)).toBe(90)
    expect(duracionParaGrupo(c, 3)).toBe(105)
    expect(duracionParaGrupo(c, 6)).toBe(120)
    expect(duracionParaGrupo(c, 7)).toBe(150)
    expect(duracionParaGrupo(config({ duracion: { porDefectoMinutos: 100, tramos: [] } }), 4)).toBe(100)
  })
})

describe("qué turnos hay cada día", () => {
  it("un día normal tiene sus turnos de la semana", () => {
    const dia = turnosDelDia(config(), "2026-11-10")
    expect(dia).toMatchObject({ abierto: true, origen: "semana", motivo: null })
    expect(dia.turnos.map((t) => t.nombre)).toEqual(["Comida", "Cena"])
  })

  it("un día sin turnos está cerrado", () => {
    expect(turnosDelDia(config(), "2026-11-09")).toMatchObject({ abierto: false, origen: "semana", motivo: "Cerrado los lunes." })
    expect(franjasDelDia(config(), "2026-11-09")).toEqual([])
  })

  it("una excepción cierra un día concreto", () => {
    const c = config({ excepciones: [{ tipo: "cerrado", fecha: "2026-12-25", motivo: "Navidad" }] })
    expect(turnosDelDia(c, "2026-12-25")).toMatchObject({ abierto: false, origen: "excepcion", motivo: "Navidad" })
    expect(turnosDelDia(c, "2026-12-24").abierto).toBe(true)
  })

  it("una excepción abre un día que normalmente cierra, con su propio horario", () => {
    const c = config({
      excepciones: [{ tipo: "horario", fecha: "2026-12-07", turnos: [{ nombre: "Puente", desde: "12:00", ultimaEntrada: "16:00" }] }],
    })
    const dia = turnosDelDia(c, "2026-12-07")
    expect(dia).toMatchObject({ abierto: true, origen: "excepcion" })
    expect(franjasDelDia(c, "2026-12-07")).toHaveLength(17)
  })

  it("un cierre por periodo cierra todos sus días, incluidos los extremos", () => {
    const c = config({ cierres: [{ desde: "2026-08-01", hasta: "2026-08-15", motivo: "Vacaciones" }] })
    expect(turnosDelDia(c, "2026-07-31").abierto).toBe(true)
    expect(turnosDelDia(c, "2026-08-01")).toMatchObject({ abierto: false, origen: "cierre", motivo: "Vacaciones" })
    expect(turnosDelDia(c, "2026-08-15").abierto).toBe(false)
    expect(turnosDelDia(c, "2026-08-18").abierto).toBe(true)
  })

  it("la excepción de una fecha gana al cierre por periodo", () => {
    const c = config({
      cierres: [{ desde: "2026-08-01", hasta: "2026-08-15" }],
      excepciones: [{ tipo: "horario", fecha: "2026-08-08", turnos: [{ nombre: "Cena", desde: "20:00", ultimaEntrada: "22:00" }] }],
    })
    expect(turnosDelDia(c, "2026-08-08")).toMatchObject({ abierto: true, origen: "excepcion" })
    expect(turnosDelDia(c, "2026-08-09").abierto).toBe(false)
  })
})

describe("franjas de un día", () => {
  it("salen cada 15 minutos de la primera a la última entrada, incluidas", () => {
    const franjas = franjasDelDia(config(), "2026-11-10")
    expect(franjas).toHaveLength(22)
    expect(franjas[0]).toMatchObject({ hora: "13:00", turno: "Comida", inicio: utc(2026, 11, 10, 12), fechaServicio: "2026-11-10" })
    expect(franjas.at(-1)).toMatchObject({ hora: "22:30", turno: "Cena", inicio: utc(2026, 11, 10, 21, 30) })
    expect(franjas.filter((f) => f.turno === "Comida").map((f) => f.hora)).toEqual([
      "13:00", "13:15", "13:30", "13:45", "14:00", "14:15", "14:30", "14:45", "15:00", "15:15", "15:30",
    ])
  })

  it("respeta otros saltos", () => {
    expect(franjasDelDia(config({ pasoMinutos: 30 }), "2026-11-10")).toHaveLength(12)
  })

  it("en verano la misma hora es otro instante", () => {
    expect(franjasDelDia(config(), "2026-07-14")[0]?.inicio).toBe(utc(2026, 7, 14, 11))
  })

  it("un turno que cruza la medianoche sigue en el día siguiente pero pertenece al día en que empieza", () => {
    const c = config({ semana: { ...config().semana, sab: [noche("01:00")] } })
    const franjas = franjasDelDia(c, "2026-11-14")
    expect(franjas).toHaveLength(13)
    expect(franjas.at(-1)).toMatchObject({ fecha: "2026-11-15", hora: "01:00", fechaServicio: "2026-11-14", inicio: utc(2026, 11, 15, 0) })
    // El domingo solo tiene su comida: las horas de la noche del sábado no aparecen.
    expect(franjasDelDia(c, "2026-11-15").every((f) => f.turno === "Comida")).toBe(true)
  })

  it("el sábado antes del adelanto de marzo no ofrece las horas que no existen", () => {
    const c = config({ semana: { ...config().semana, sab: [noche("03:30")] } })
    const franjas = franjasDelDia(c, "2026-03-28")
    const horas = franjas.map((f) => f.hora)
    expect(horas.some((h) => h.startsWith("02:"))).toBe(false)
    expect(franjas).toHaveLength(23 - 4)
    const ultimaDeInvierno = franjas.find((f) => f.hora === "01:45")
    const primeraDeVerano = franjas.find((f) => f.hora === "03:00")
    expect(ultimaDeInvierno?.inicio).toBe(utc(2026, 3, 29, 0, 45))
    expect(primeraDeVerano?.inicio).toBe(utc(2026, 3, 29, 1))
    // En el reloj pasan 75 minutos, pero en realidad solo 15.
    expect((primeraDeVerano?.inicio ?? 0) - (ultimaDeInvierno?.inicio ?? 0)).toBe(15 * MINUTO)
  })

  it("el sábado antes del retraso de octubre ofrece cada hora una sola vez y en orden", () => {
    const c = config({ semana: { ...config().semana, sab: [noche("03:30")] } })
    const franjas = franjasDelDia(c, "2026-10-24")
    const horas = franjas.map((f) => f.hora)
    expect(franjas).toHaveLength(23)
    expect(new Set(horas).size).toBe(horas.length)
    expect(franjas.find((f) => f.hora === "02:45")?.inicio).toBe(utc(2026, 10, 25, 0, 45))
    expect(franjas.find((f) => f.hora === "03:00")?.inicio).toBe(utc(2026, 10, 25, 2))
    for (let i = 1; i < franjas.length; i++) {
      expect((franjas[i]?.inicio ?? 0) > (franjas[i - 1]?.inicio ?? 0)).toBe(true)
    }
  })

  it("el domingo del cambio la comida va en la hora nueva", () => {
    expect(franjasDelDia(config(), "2026-03-29")[0]?.inicio).toBe(utc(2026, 3, 29, 11))
    expect(franjasDelDia(config(), "2026-10-25")[0]?.inicio).toBe(utc(2026, 10, 25, 12))
  })
})
