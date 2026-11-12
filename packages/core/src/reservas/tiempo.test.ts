import { describe, expect, it } from "vitest"
import { utc } from "./datos-prueba"
import {
  desfaseMinutos,
  diaSemana,
  esFechaValida,
  esZonaHorariaValida,
  FechaSchema,
  horaAMinutos,
  horaLocal,
  HoraSchema,
  instanteDeHoraLocal,
  instantesDeHoraLocal,
  minutosAHora,
  sumarDias,
} from "./tiempo"

const MADRID = "Europe/Madrid"

describe("fechas de calendario", () => {
  it("sabe el día de la semana", () => {
    expect(diaSemana("2026-11-09")).toBe("lun")
    expect(diaSemana("2026-11-15")).toBe("dom")
    expect(diaSemana("2026-03-29")).toBe("dom")
    expect(diaSemana("2026-10-25")).toBe("dom")
    expect(diaSemana("2028-02-29")).toBe("mar")
  })

  it("suma días cruzando meses, años y bisiestos", () => {
    expect(sumarDias("2026-11-09", 1)).toBe("2026-11-10")
    expect(sumarDias("2026-12-31", 1)).toBe("2027-01-01")
    expect(sumarDias("2028-02-28", 1)).toBe("2028-02-29")
    expect(sumarDias("2027-02-28", 1)).toBe("2027-03-01")
    expect(sumarDias("2026-03-01", -1)).toBe("2026-02-28")
    // El día del cambio de hora es un día de calendario normal.
    expect(sumarDias("2026-03-28", 1)).toBe("2026-03-29")
  })

  it("valida fechas que existen", () => {
    expect(esFechaValida("2026-02-28")).toBe(true)
    expect(esFechaValida("2026-02-29")).toBe(false)
    expect(esFechaValida("2028-02-29")).toBe(true)
    expect(esFechaValida("2026-13-01")).toBe(false)
    expect(esFechaValida("9-11-2026")).toBe(false)
    expect(FechaSchema.safeParse("2026-04-31").success).toBe(false)
    expect(FechaSchema.safeParse("2026-04-30").success).toBe(true)
    expect(() => sumarDias("ayer", 1)).toThrow()
  })

  it("convierte horas en minutos y al revés", () => {
    expect(horaAMinutos("00:00")).toBe(0)
    expect(horaAMinutos("13:30")).toBe(810)
    expect(horaAMinutos("23:59")).toBe(1439)
    expect(minutosAHora(810)).toBe("13:30")
    expect(minutosAHora(5)).toBe("00:05")
    expect(() => horaAMinutos("24:00")).toThrow()
    expect(() => minutosAHora(1440)).toThrow()
    expect(HoraSchema.safeParse("9:30").success).toBe(false)
    expect(HoraSchema.safeParse("09:30").success).toBe(true)
  })
})

describe("zona horaria", () => {
  it("reconoce zonas válidas y rechaza las inventadas", () => {
    expect(esZonaHorariaValida("Europe/Madrid")).toBe(true)
    expect(esZonaHorariaValida("Atlantic/Canary")).toBe(true)
    expect(esZonaHorariaValida("Marte/Olimpo")).toBe(false)
  })

  it("Madrid va una hora por delante de UTC en invierno y dos en verano", () => {
    expect(desfaseMinutos(utc(2026, 11, 10, 12), MADRID)).toBe(60)
    expect(desfaseMinutos(utc(2026, 7, 14, 12), MADRID)).toBe(120)
    expect(desfaseMinutos(utc(2026, 7, 14, 12), "Atlantic/Canary")).toBe(60)
  })

  it("lee la hora local de un instante", () => {
    expect(horaLocal(utc(2026, 11, 10, 19, 30), MADRID)).toEqual({ fecha: "2026-11-10", minutos: 1230, hora: "20:30" })
    expect(horaLocal(utc(2026, 7, 14, 22, 15), MADRID)).toEqual({ fecha: "2026-07-15", minutos: 15, hora: "00:15" })
    expect(horaLocal(utc(2026, 11, 10, 23, 0), MADRID).fecha).toBe("2026-11-11")
  })

  it("convierte una hora local normal en un solo instante", () => {
    expect(instantesDeHoraLocal("2026-11-10", horaAMinutos("20:00"), MADRID)).toEqual([utc(2026, 11, 10, 19)])
    expect(instanteDeHoraLocal("2026-07-14", horaAMinutos("20:00"), MADRID)).toBe(utc(2026, 7, 14, 18))
  })
})

describe("cambios de hora en Madrid", () => {
  it("último domingo de marzo: de 02:00 se salta a 03:00 y esa hora no existe", () => {
    expect(instantesDeHoraLocal("2026-03-29", horaAMinutos("01:59"), MADRID)).toEqual([utc(2026, 3, 29, 0, 59)])
    for (const h of ["02:00", "02:15", "02:30", "02:45", "02:59"]) {
      expect(instantesDeHoraLocal("2026-03-29", horaAMinutos(h), MADRID)).toEqual([])
      expect(instanteDeHoraLocal("2026-03-29", horaAMinutos(h), MADRID)).toBeNull()
    }
    expect(instantesDeHoraLocal("2026-03-29", horaAMinutos("03:00"), MADRID)).toEqual([utc(2026, 3, 29, 1)])
    // El mismo día, a mediodía, ya es horario de verano.
    expect(instanteDeHoraLocal("2026-03-29", horaAMinutos("13:00"), MADRID)).toBe(utc(2026, 3, 29, 11))
  })

  it("último domingo de octubre: de 03:00 se vuelve a 02:00 y esa hora ocurre dos veces", () => {
    expect(instantesDeHoraLocal("2026-10-25", horaAMinutos("01:59"), MADRID)).toEqual([utc(2026, 10, 24, 23, 59)])
    expect(instantesDeHoraLocal("2026-10-25", horaAMinutos("02:30"), MADRID)).toEqual([
      utc(2026, 10, 25, 0, 30),
      utc(2026, 10, 25, 1, 30),
    ])
    // Se toma la primera vez.
    expect(instanteDeHoraLocal("2026-10-25", horaAMinutos("02:30"), MADRID)).toBe(utc(2026, 10, 25, 0, 30))
    expect(instantesDeHoraLocal("2026-10-25", horaAMinutos("03:00"), MADRID)).toEqual([utc(2026, 10, 25, 2)])
    expect(instanteDeHoraLocal("2026-10-25", horaAMinutos("13:00"), MADRID)).toBe(utc(2026, 10, 25, 12))
  })

  it("las dos 02:30 de octubre se leen igual en el reloj", () => {
    expect(horaLocal(utc(2026, 10, 25, 0, 30), MADRID).hora).toBe("02:30")
    expect(horaLocal(utc(2026, 10, 25, 1, 30), MADRID).hora).toBe("02:30")
  })

  it("funciona igual en otras zonas (Nueva York cambia el segundo domingo de marzo)", () => {
    expect(instantesDeHoraLocal("2026-03-08", horaAMinutos("02:30"), "America/New_York")).toEqual([])
    expect(instanteDeHoraLocal("2026-03-08", horaAMinutos("03:00"), "America/New_York")).toBe(utc(2026, 3, 8, 7))
  })
})
