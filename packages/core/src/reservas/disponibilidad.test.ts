import { describe, expect, it } from "vitest"
import { config, MESAS, mesa, reserva, utc } from "./datos-prueba"
import { calcularDisponibilidad, horasDisponibles, type EntradaDisponibilidad } from "./disponibilidad"
import type { Turno } from "./horarios"
import { horaAMinutos, instanteDeHoraLocal } from "./tiempo"

const MARTES = "2026-11-10"
const AHORA = utc(2026, 11, 1, 10)

/** Instante de una hora de pared en Madrid. */
function madrid(fecha: string, hora: string): number {
  const t = instanteDeHoraLocal(fecha, horaAMinutos(hora), "Europe/Madrid")
  if (t === null) throw new Error(`La hora ${hora} no existe el ${fecha}.`)
  return t
}

function disponibilidad(cambios: Partial<EntradaDisponibilidad> = {}) {
  return calcularDisponibilidad({
    config: config(),
    fecha: MARTES,
    comensales: 2,
    mesas: MESAS,
    reservas: [],
    ahora: AHORA,
    ...cambios,
  })
}

const libres = (cambios: Partial<EntradaDisponibilidad> = {}) => horasDisponibles(disponibilidad(cambios))
const motivoDe = (d: ReturnType<typeof disponibilidad>, hora: string) => d.franjas.find((f) => f.hora === hora)?.motivo

const CENA = ["20:00", "20:15", "20:30", "20:45", "21:00", "21:15", "21:30", "21:45", "22:00", "22:15", "22:30"]
const COMIDA = ["13:00", "13:15", "13:30", "13:45", "14:00", "14:15", "14:30", "14:45", "15:00", "15:15", "15:30"]

describe("disponibilidad: el día", () => {
  it("un día normal sin reservas tiene todas las horas libres", () => {
    const d = disponibilidad()
    expect(d).toMatchObject({ estado: "abierto", mensaje: null, duracionMinutos: 90, comensales: 2 })
    expect(horasDisponibles(d)).toEqual([...COMIDA, ...CENA])
  })

  it("un día cerrado no tiene horas y dice por qué", () => {
    expect(disponibilidad({ fecha: "2026-11-09" })).toMatchObject({ estado: "cerrado", mensaje: "Cerrado los lunes.", franjas: [] })
    const navidad = config({ excepciones: [{ tipo: "cerrado", fecha: "2026-12-25", motivo: "Navidad" }] })
    expect(disponibilidad({ config: navidad, fecha: "2026-12-25" })).toMatchObject({ estado: "cerrado", mensaje: "Navidad" })
    const vacaciones = config({ cierres: [{ desde: "2026-11-09", hasta: "2026-11-12" }] })
    expect(disponibilidad({ config: vacaciones })).toMatchObject({ estado: "cerrado", mensaje: "Cerrado por vacaciones." })
  })

  it("un día con horario especial ofrece solo ese horario", () => {
    const c = config({
      excepciones: [{ tipo: "horario", fecha: MARTES, turnos: [{ nombre: "Nochebuena", desde: "19:00", ultimaEntrada: "20:00" }] }],
    })
    expect(libres({ config: c })).toEqual(["19:00", "19:15", "19:30", "19:45", "20:00"])
  })
})

describe("disponibilidad: el tamaño del grupo", () => {
  it("rechaza grupos fuera de lo que se acepta en la web", () => {
    expect(disponibilidad({ comensales: 13 })).toMatchObject({
      estado: "grupo_no_admitido",
      mensaje: "Para grupos de más de 12, llama al restaurante.",
      franjas: [],
    })
    expect(disponibilidad({ config: config({ comensalesMin: 2 }), comensales: 1 })).toMatchObject({
      estado: "grupo_no_admitido",
      mensaje: "El mínimo para reservar es de 2 comensales.",
    })
  })

  it("un grupo que no cabe en ninguna mesa ni combinación no tiene horas, ni siquiera para el personal", () => {
    // La mayor opción es de 8 (S3+S4 o T1+T2+T3).
    expect(disponibilidad({ comensales: 9 })).toMatchObject({
      estado: "grupo_no_admitido",
      mensaje: "Ninguna mesa ni combinación de mesas tiene sitio para 9.",
    })
    expect(disponibilidad({ comensales: 9, ignorarLimitesPublicos: true }).estado).toBe("grupo_no_admitido")
    expect(disponibilidad({ comensales: 8 }).estado).toBe("abierto")
  })

  it("el personal puede reservar grupos que la web no acepta si caben", () => {
    const c = config({ comensalesMax: 4 })
    expect(disponibilidad({ config: c, comensales: 6 }).estado).toBe("grupo_no_admitido")
    expect(disponibilidad({ config: c, comensales: 6, ignorarLimitesPublicos: true }).estado).toBe("abierto")
  })

  it("las mesas deshabilitadas no cuentan", () => {
    const mesas = [mesa("A", 2), mesa("B", 6, { enabled: false })]
    expect(disponibilidad({ mesas, comensales: 5 }).estado).toBe("grupo_no_admitido")
    expect(disponibilidad({ mesas: [mesa("A", 2), mesa("B", 6)], comensales: 5 }).estado).toBe("abierto")
  })

  it("un grupo que solo cabe juntando mesas unibles tiene horas", () => {
    const mesas = [mesa("A", 2, { joinableWith: ["B"] }), mesa("B", 2)]
    expect(libres({ mesas, comensales: 4 })).toHaveLength(22)
    expect(disponibilidad({ mesas: [mesa("A", 2), mesa("B", 2)], comensales: 4 }).estado).toBe("grupo_no_admitido")
    expect(disponibilidad({ mesas: [mesa("A", 2, { joinableWith: ["B"] }), mesa("B", 2, { enabled: false })], comensales: 4 }).estado).toBe(
      "grupo_no_admitido",
    )
  })

  it("la duración depende del grupo, o se puede fijar a mano", () => {
    expect(disponibilidad({ comensales: 4 }).duracionMinutos).toBe(105)
    expect(disponibilidad({ comensales: 4, duracionMinutos: 60 }).duracionMinutos).toBe(60)
    expect(() => disponibilidad({ comensales: 0 })).toThrow()
  })
})

describe("disponibilidad: antelación", () => {
  it("no ofrece horas pasadas ni las que empiezan antes de la antelación mínima", () => {
    const d = disponibilidad({ ahora: madrid(MARTES, "12:30") })
    expect(motivoDe(d, "13:00")).toBe("antelacion_minima")
    expect(motivoDe(d, "13:15")).toBe("antelacion_minima")
    // Justo 60 minutos antes sí vale.
    expect(motivoDe(d, "13:30")).toBeNull()
    expect(motivoDe(disponibilidad({ ahora: madrid(MARTES, "21:00") }), "13:30")).toBe("antelacion_minima")
  })

  it("no deja reservar con demasiada antelación", () => {
    const d = disponibilidad({ ahora: utc(2026, 7, 1, 10) })
    expect(d.franjas.every((f) => f.motivo === "antelacion_maxima")).toBe(true)
  })

  it("el personal se salta la antelación", () => {
    expect(libres({ ahora: madrid(MARTES, "21:00"), ignorarLimitesPublicos: true })).toHaveLength(22)
  })
})

describe("disponibilidad: mesas ocupadas y margen", () => {
  const unaMesa = [mesa("M", 2)]
  // Reserva de 20:30 a 22:00 en la única mesa.
  const ocupada = [reserva(madrid(MARTES, "20:30"), { mesaIds: ["M"], duracionMinutos: 90 })]

  it("con 15 minutos de margen, la mesa vuelve a estar libre a las 22:15", () => {
    const d = disponibilidad({ mesas: unaMesa, reservas: ocupada })
    expect(horasDisponibles(d)).toEqual([...COMIDA, "22:15", "22:30"])
    expect(motivoDe(d, "20:00")).toBe("sin_mesa")
    expect(motivoDe(d, "22:00")).toBe("sin_mesa")
  })

  it("sin margen, la mesa queda libre a las 22:00 en punto", () => {
    expect(libres({ config: config({ margenMinutos: 0 }), mesas: unaMesa, reservas: ocupada })).toEqual([
      ...COMIDA,
      "22:00",
      "22:15",
      "22:30",
    ])
  })

  it("con margen grande tampoco se puede llegar justo antes", () => {
    // Una reserva de 90 minutos a las 18:45 acabaría a las 20:15: choca con la de 20:30 si el margen es de 30.
    const c = config({ margenMinutos: 30, semana: { ...config().semana, mar: [{ nombre: "Tarde", desde: "18:30", ultimaEntrada: "19:00" }] } })
    expect(libres({ config: c, mesas: unaMesa, reservas: ocupada })).toEqual(["18:30"])
  })

  it("las reservas canceladas, no presentadas o terminadas no ocupan mesa", () => {
    for (const estado of ["cancelada", "no_presentada", "terminada"] as const) {
      const r = [reserva(madrid(MARTES, "20:30"), { mesaIds: ["M"], estado })]
      expect(libres({ mesas: unaMesa, reservas: r })).toHaveLength(22)
    }
  })

  it("un grupo sentado que se alarga sigue ocupando la mesa", () => {
    const sentados = [reserva(madrid(MARTES, "13:00"), { mesaIds: ["M"], estado: "sentada", duracionMinutos: 90 })]
    // Debían irse a las 14:30, pero son las 15:00 y siguen ahí: la mesa no está libre hasta las 15:15.
    const d = disponibilidad({ mesas: unaMesa, reservas: sentados, ahora: madrid(MARTES, "15:00"), ignorarLimitesPublicos: true })
    expect(motivoDe(d, "15:00")).toBe("sin_mesa")
    expect(motivoDe(d, "15:15")).toBeNull()
  })

  it("al mover una reserva no choca consigo misma", () => {
    const propia = ocupada[0]
    expect(libres({ mesas: unaMesa, reservas: ocupada, excluirReservaId: propia?.id })).toHaveLength(22)
  })

  it("si queda otra mesa libre, la hora sigue disponible", () => {
    expect(libres({ mesas: [...unaMesa, mesa("N", 2)], reservas: ocupada })).toHaveLength(22)
  })

  it("las reservas de otros días no molestan", () => {
    const otroDia = [reserva(madrid("2026-11-11", "20:30"), { mesaIds: ["M"] })]
    expect(libres({ mesas: unaMesa, reservas: otroDia })).toHaveLength(22)
  })
})

describe("disponibilidad: reservas que todavía no tienen mesa", () => {
  it("cuentan aunque no tengan mesa asignada", () => {
    const r = [reserva(madrid(MARTES, "21:00"), { comensales: 2 })]
    const d = disponibilidad({ mesas: [mesa("M", 4)], reservas: r })
    expect(motivoDe(d, "21:00")).toBe("sin_mesa")
    expect(motivoDe(d, "13:00")).toBeNull()
    expect(motivoDe(disponibilidad({ mesas: [mesa("M", 4), mesa("N", 2)], reservas: r }), "21:00")).toBeNull()
  })

  it("no se vende una mesa que necesita una reserva sin mesa, aunque la nueva cupiera en otra", () => {
    // La reserva sin mesa es de 4 y solo cabe en G. El grupo nuevo de 2 cabe en P o en G: debe ir a P.
    const mesas = [mesa("P", 2), mesa("G", 4)]
    const r = [reserva(madrid(MARTES, "21:00"), { comensales: 4 })]
    expect(motivoDe(disponibilidad({ mesas, reservas: r }), "21:00")).toBeNull()
    // Si P está ocupada, ya no hay sitio para los dos.
    const conP = [...r, reserva(madrid(MARTES, "20:45"), { mesaIds: ["P"] })]
    expect(motivoDe(disponibilidad({ mesas, reservas: conP }), "21:00")).toBe("sin_mesa")
  })

  it("una reserva sin mesa que ya no cabe en ningún sitio no bloquea el resto del día", () => {
    const r = [reserva(madrid(MARTES, "21:00"), { comensales: 10 })]
    expect(libres({ mesas: [mesa("M", 4), mesa("N", 2)], reservas: r })).toHaveLength(22)
  })
})

describe("disponibilidad: capacidad por franja y por turno", () => {
  it("no deja llegar a más comensales de la cuenta en la misma franja", () => {
    const c = config({ maxComensalesPorFranja: 6 })
    const r = [reserva(madrid(MARTES, "21:00"), { comensales: 4, mesaIds: ["S3"] })]
    const d2 = disponibilidad({ config: c, reservas: r, comensales: 2 })
    expect(motivoDe(d2, "21:00")).toBeNull()
    expect(d2.franjas.find((f) => f.hora === "21:00")?.comensalesEnFranja).toBe(4)
    const d3 = disponibilidad({ config: c, reservas: r, comensales: 3 })
    expect(motivoDe(d3, "21:00")).toBe("capacidad_franja")
    expect(motivoDe(d3, "21:15")).toBeNull()
  })

  it("una reserva a una hora suelta cuenta en la franja que la contiene", () => {
    const c = config({ maxComensalesPorFranja: 6 })
    const r = [reserva(madrid(MARTES, "21:10"), { comensales: 4, mesaIds: ["S3"] })]
    expect(motivoDe(disponibilidad({ config: c, reservas: r, comensales: 3 }), "21:00")).toBe("capacidad_franja")
    expect(motivoDe(disponibilidad({ config: c, reservas: r, comensales: 3 }), "21:15")).toBeNull()
  })

  it("las canceladas no cuentan para la capacidad, las terminadas sí", () => {
    const c = config({ maxComensalesPorFranja: 6 })
    const cancelada = [reserva(madrid(MARTES, "21:00"), { comensales: 4, estado: "cancelada" })]
    expect(motivoDe(disponibilidad({ config: c, reservas: cancelada, comensales: 3 }), "21:00")).toBeNull()
    const terminada = [reserva(madrid(MARTES, "13:00"), { comensales: 4, estado: "terminada", mesaIds: ["S3"] })]
    expect(motivoDe(disponibilidad({ config: c, reservas: terminada, comensales: 3 }), "13:00")).toBe("capacidad_franja")
  })

  it("el turno puede tener su propio límite por franja", () => {
    const cena: Turno = { nombre: "Cena", desde: "20:00", ultimaEntrada: "22:30", maxComensalesPorFranja: 2 }
    const c = config({ maxComensalesPorFranja: 20, semana: { ...config().semana, mar: [{ nombre: "Comida", desde: "13:00", ultimaEntrada: "15:30" }, cena] } })
    const d = disponibilidad({ config: c, comensales: 3 })
    expect(d.franjas.filter((f) => f.turno === "Cena").every((f) => f.motivo === "capacidad_franja")).toBe(true)
    expect(d.franjas.filter((f) => f.turno === "Comida").every((f) => f.disponible)).toBe(true)
  })

  it("se puede limitar el total de comensales de un turno", () => {
    const cena: Turno = { nombre: "Cena", desde: "20:00", ultimaEntrada: "22:30", maxComensalesTurno: 10 }
    const c = config({ semana: { ...config().semana, mar: [{ nombre: "Comida", desde: "13:00", ultimaEntrada: "15:30" }, cena] } })
    const r = [
      reserva(madrid(MARTES, "20:00"), { comensales: 4, mesaIds: ["S3"] }),
      reserva(madrid(MARTES, "22:00"), { comensales: 4, mesaIds: ["S4"] }),
      reserva(madrid(MARTES, "13:00"), { comensales: 6, mesaIds: ["S5"] }), // de la comida: no cuenta para la cena
    ]
    const d2 = disponibilidad({ config: c, reservas: r, comensales: 2 })
    expect(d2.franjas.filter((f) => f.turno === "Cena").every((f) => f.disponible)).toBe(true)
    const d3 = disponibilidad({ config: c, reservas: r, comensales: 3 })
    expect(d3.franjas.filter((f) => f.turno === "Cena").every((f) => f.motivo === "capacidad_turno")).toBe(true)
    expect(d3.franjas.filter((f) => f.turno === "Comida").every((f) => f.disponible)).toBe(true)
  })
})

describe("disponibilidad: turnos que cruzan la medianoche y cambios de hora", () => {
  const noche: Turno = { nombre: "Noche", desde: "22:00", ultimaEntrada: "03:30" }
  const conNoche = (margenMinutos = 0) => config({ margenMinutos, semana: { ...config().semana, sab: [noche] } })
  const unaMesa = [mesa("M", 2)]

  it("una reserva de la noche anterior bloquea las primeras horas del día siguiente", () => {
    const c = config({
      margenMinutos: 0,
      semana: { ...config().semana, sab: [noche], dom: [{ nombre: "Madrugada", desde: "00:00", ultimaEntrada: "01:00" }] },
    })
    // El turno del domingo se pisa con el del sábado a propósito: la mesa es la misma.
    const r = [reserva(madrid("2026-11-15", "00:00"), { mesaIds: ["M"], duracionMinutos: 60 })]
    expect(libres({ config: c, fecha: "2026-11-15", mesas: unaMesa, reservas: r })).toEqual(["01:00"])
  })

  it("adelanto de marzo: una reserva de 90 minutos a la 01:30 acaba a las 04:00 de reloj", () => {
    // 01:30 en invierno son las 00:30 UTC; 90 minutos después son las 02:00 UTC, que ya en verano son las 04:00.
    const fecha = "2026-03-28"
    const ahora = utc(2026, 3, 1, 10)
    const r = [reserva(madrid("2026-03-29", "01:30"), { mesaIds: ["M"], duracionMinutos: 90 })]
    const d = disponibilidad({ config: conNoche(), fecha, mesas: unaMesa, reservas: r, ahora })
    // Antes: la de las 00:00 acaba justo a la 01:30. Después: a las 03:00 de reloj la mesa sigue ocupada,
    // aunque contando en el reloj (01:30 + 90 = 03:00) parecería libre.
    expect(horasDisponibles(d)).toEqual(["22:00", "22:15", "22:30", "22:45", "23:00", "23:15", "23:30", "23:45", "00:00"])
    expect(motivoDe(d, "03:00")).toBe("sin_mesa")
    expect(d.franjas.some((f) => f.hora.startsWith("02:"))).toBe(false)
  })

  it("retraso de octubre: una reserva de 60 minutos a las 02:15 deja la mesa libre a las 03:00 de reloj", () => {
    // 02:15 (primera vez) son las 00:15 UTC; acaba a las 01:15 UTC, que son las 02:15 de la segunda vez.
    const fecha = "2026-10-24"
    const ahora = utc(2026, 10, 1, 10)
    const r = [reserva(madrid("2026-10-25", "02:15"), { mesaIds: ["M"], duracionMinutos: 60 })]
    const d = disponibilidad({ config: conNoche(), fecha, mesas: unaMesa, reservas: r, ahora, duracionMinutos: 60 })
    expect(motivoDe(d, "02:45")).toBe("sin_mesa")
    // En el reloj, 02:15 + 60 = 03:15 parecería ocupar las 03:00; en realidad está libre.
    expect(motivoDe(d, "03:00")).toBeNull()
    expect(motivoDe(d, "01:15")).toBeNull()
    expect(motivoDe(d, "01:30")).toBe("sin_mesa")
  })

  it("retraso de octubre: una reserva en la segunda vuelta de las 02:00 cuenta en la franja de las 02:00", () => {
    const fecha = "2026-10-24"
    const ahora = utc(2026, 10, 1, 10)
    const c = config({ maxComensalesPorFranja: 4, semana: { ...config().semana, sab: [noche] } })
    // 02:10 de la segunda vez = 01:10 UTC.
    const r = [reserva(utc(2026, 10, 25, 1, 10), { comensales: 3, mesaIds: ["S3"] })]
    const d = disponibilidad({ config: c, fecha, reservas: r, ahora, comensales: 2 })
    const dos = d.franjas.find((f) => f.hora === "02:00")
    expect(dos?.comensalesEnFranja).toBe(3)
    expect(dos?.motivo).toBe("capacidad_franja")
  })

  it("la antelación se mide en tiempo real, no en el reloj", () => {
    // Son las 01:45 de invierno: la franja de las 03:00 de verano está a 15 minutos, no a 75.
    const fecha = "2026-03-28"
    const c = config({ antelacionMinimaMinutos: 30, semana: { ...config().semana, sab: [noche] } })
    const d = disponibilidad({ config: c, fecha, ahora: madrid("2026-03-29", "01:45") })
    expect(motivoDe(d, "03:00")).toBe("antelacion_minima")
    expect(motivoDe(d, "03:15")).toBeNull()
  })
})

describe("disponibilidad: determinismo", () => {
  it("las mismas entradas dan siempre el mismo resultado", () => {
    const entrada = { reservas: [reserva(madrid(MARTES, "21:00"), { id: "fija", comensales: 4, mesaIds: ["S3"] })], comensales: 4 }
    expect(disponibilidad(entrada)).toEqual(disponibilidad(entrada))
  })
})
