import { describe, expect, it } from "vitest"
import { proponerMesas, type EntradaAsignacion, type PeticionMesa } from "./asignacion"
import { config, MESAS, mesa, reserva, utc } from "./datos-prueba"
import type { ReservaOcupacion } from "./reserva"
import { horaAMinutos, instanteDeHoraLocal } from "./tiempo"

const MARTES = "2026-11-10"
const AHORA = utc(2026, 11, 1, 10)

function madrid(fecha: string, hora: string): number {
  const t = instanteDeHoraLocal(fecha, horaAMinutos(hora), "Europe/Madrid")
  if (t === null) throw new Error(`La hora ${hora} no existe el ${fecha}.`)
  return t
}

function proponer(peticion: Partial<PeticionMesa> = {}, cambios: Partial<EntradaAsignacion> = {}) {
  return proponerMesas({
    config: config(),
    mesas: MESAS,
    reservas: [],
    ahora: AHORA,
    peticion: { inicio: madrid(MARTES, "21:00"), comensales: 4, ...peticion },
    ...cambios,
  })
}

/** Reserva de 90 minutos a las 20:30 en una mesa. */
const en = (mesaId: string, cambios: Partial<ReservaOcupacion> = {}) =>
  reserva(madrid(MARTES, "20:30"), { id: `ocupa-${mesaId}`, mesaIds: [mesaId], ...cambios })

describe("asignación de mesa", () => {
  it("propone la mesa sola en la que no sobra ninguna plaza", () => {
    const r = proponer()
    expect(r.propuestas.map((p) => p.mesaIds.join("+"))).toEqual(["S3", "S4", "T3"])
    expect(r.totalOpciones).toBe(9)
    expect(r.duracionMinutos).toBe(105)
    expect(r.propuestas[0]).toEqual({
      mesaIds: ["S3"],
      nombres: ["S3"],
      plazas: 4,
      sobran: 0,
      unidas: false,
      enZonaPreferida: null,
      explicacion: "Mesa S3: 4 plazas para 4; no sobra ninguna.",
    })
    expect(r.resumen).toBe("Se propone la mesa S3: es la opción libre en la que sobran menos plazas. Hay 8 alternativas.")
  })

  it("explica que las mesas deshabilitadas no se usan", () => {
    expect(proponer().descartes).toEqual([
      { mesaIds: ["S6"], nombres: ["S6"], motivo: "deshabilitada", explicacion: "Mesa S6: está deshabilitada.", reservaIds: [] },
    ])
  })

  it("si las mesas de 4 están ocupadas, junta dos de 2 antes que dejar vacía media mesa de 6", () => {
    const r = proponer({}, { reservas: [en("S3"), en("S4"), en("T3")] })
    expect(r.propuestas.map((p) => p.mesaIds.join("+"))).toEqual(["S1+S2", "T1+T2", "S5"])
    expect(r.propuestas[0]?.explicacion).toBe(
      "Mesas S1 + S2 unidas: 4 plazas (2 + 2) para 4; no sobra ninguna. Se unen porque así sobran menos plazas que en la mesa S5 sola (sobran 2).",
    )
    expect(r.propuestas[2]?.explicacion).toBe("Mesa S5: 6 plazas para 4; sobran 2.")
    const ocupada = r.descartes.find((d) => d.mesaIds[0] === "S3")
    expect(ocupada).toEqual({
      mesaIds: ["S3"],
      nombres: ["S3"],
      motivo: "ocupada",
      explicacion: "Mesa S3: ocupada por otra reserva de 20:30 a 22:00, más 15 minutos de margen.",
      reservaIds: ["ocupa-S3"],
    })
  })

  it("si ninguna mesa sola tiene sitio, lo dice al juntar", () => {
    const r = proponer({ comensales: 6 }, { reservas: [en("S5", { comensales: 6 })] })
    expect(r.propuestas.map((p) => p.mesaIds.join("+"))).toEqual(["T2+T3", "S3+S4", "T1+T2+T3"])
    expect(r.propuestas[0]?.explicacion).toBe(
      "Mesas T2 + T3 unidas: 6 plazas (2 + 4) para 6; no sobra ninguna. Se unen porque ninguna mesa sola libre tiene sitio para 6.",
    )
  })

  it("explica qué mesas son demasiado pequeñas aunque se unan", () => {
    const r = proponer({ comensales: 6 }, { reservas: [en("S5", { comensales: 6 })] })
    const pequenas = r.descartes.filter((d) => d.motivo === "pequena")
    expect(pequenas.map((d) => d.explicacion)).toEqual([
      "Mesa S1: tiene 2 plazas y el grupo es de 6; ni uniéndola a sus mesas libres hay sitio.",
      "Mesa S2: tiene 2 plazas y el grupo es de 6; ni uniéndola a sus mesas libres hay sitio.",
    ])
    const sueltas = proponerMesas({
      config: config(),
      mesas: [mesa("A", 2), mesa("B", 6)],
      reservas: [],
      ahora: AHORA,
      peticion: { inicio: madrid(MARTES, "21:00"), comensales: 4 },
    })
    expect(sueltas.descartes.map((d) => d.explicacion)).toEqual(["Mesa A: tiene 2 plazas y el grupo es de 4; no se puede unir con otras."])
  })

  it("descuenta las plazas que se pierden al unir", () => {
    const r = proponer({ comensales: 7 }, { config: config({ plazasPerdidasPorUnion: 1 }) })
    expect(r.propuestas).toHaveLength(1)
    expect(r.propuestas[0]?.explicacion).toBe(
      "Mesas S3 + S4 unidas: 7 plazas (4 + 4, menos 1 al unirlas) para 7; no sobra ninguna. Se unen porque ninguna mesa sola libre tiene sitio para 7.",
    )
  })

  it("respeta la zona pedida y avisa cuando no puede", () => {
    const terraza = proponer({ comensales: 2, zonaPreferida: "terraza" })
    expect(terraza.propuestas[0]).toMatchObject({ mesaIds: ["T1"], enZonaPreferida: true })
    expect(terraza.propuestas[0]?.explicacion).toBe("Mesa T1: 2 plazas para 2; no sobra ninguna. Está en la zona pedida.")
    expect(terraza.resumen).toContain("dentro de la zona pedida")

    const llena = proponer({ comensales: 2, zonaPreferida: "terraza" }, { reservas: [en("T1"), en("T2"), en("T3")] })
    expect(llena.propuestas[0]).toMatchObject({ mesaIds: ["S1"], enZonaPreferida: false })
    expect(llena.propuestas[0]?.explicacion).toContain("No está en la zona pedida")
  })

  it("no propone una mesa que dejaría sin sitio a reservas que aún no tienen mesa", () => {
    // Dos reservas de 4 sin mesa a las 22:00. Z está ocupada desde las 22:30, así que solo pueden ir a X e Y.
    // El grupo nuevo llega a las 20:15 y se va a las 22:00: si coge X o Y, una de las dos se queda sin sitio.
    const mesas = [mesa("X", 4), mesa("Y", 4), mesa("Z", 6)]
    const reservas = [
      reserva(madrid(MARTES, "22:30"), { id: "f", mesaIds: ["Z"], comensales: 6 }),
      reserva(madrid(MARTES, "22:00"), { id: "r1", comensales: 4, duracionMinutos: 105 }),
      reserva(madrid(MARTES, "22:00"), { id: "r2", comensales: 4, duracionMinutos: 105 }),
    ]
    const r = proponer({ inicio: madrid(MARTES, "20:15") }, { mesas, reservas })
    expect(r.propuestas.map((p) => p.mesaIds[0])).toEqual(["Z"])
    expect(r.totalOpciones).toBe(1)
    const dejarian = r.descartes.filter((d) => d.motivo === "dejaria_sin_mesa")
    expect(dejarian.map((d) => d.mesaIds[0])).toEqual(["X", "Y"])
    expect(dejarian[0]?.reservaIds).toEqual(["r1", "r2"])
    expect(dejarian[0]?.explicacion).toBe("Mesa X: libre, pero dejaría sin sitio a reservas que todavía no tienen mesa.")
  })

  it("al buscar mesa para una reserva que ya existe no compite consigo misma", () => {
    const propia = reserva(madrid(MARTES, "21:00"), { id: "propia", comensales: 4 })
    const mesas = [mesa("M", 4)]
    const conId = proponer({ reservaId: "propia" }, { mesas, reservas: [propia] })
    expect(conId.propuestas.map((p) => p.mesaIds[0])).toEqual(["M"])
    const sinId = proponer({}, { mesas, reservas: [propia] })
    expect(sinId.propuestas).toEqual([])
  })

  it("dice claramente cuando no hay nada", () => {
    expect(proponer({ comensales: 9 }).resumen).toBe("Ninguna mesa ni combinación de mesas tiene sitio para 9.")
    const todas = ["S1", "S2", "S3", "S4", "S5", "T1", "T2", "T3"].map((id) => en(id))
    const r = proponer({ comensales: 2 }, { reservas: todas })
    expect(r.propuestas).toEqual([])
    expect(r.resumen).toBe("No queda mesa libre para 2 a las 21:00.")
  })

  it("se puede pedir más o menos propuestas", () => {
    expect(proponer({}, { limite: 1 }).propuestas).toHaveLength(1)
    expect(proponer({}, { limite: 20 }).propuestas).toHaveLength(9)
  })

  it("las horas de las explicaciones salen en hora local aunque haya cambio de hora", () => {
    // 01:30 de invierno + 90 minutos = 04:00 de verano.
    const mesas = [mesa("M", 2), mesa("N", 2)]
    const reservas = [reserva(madrid("2026-03-29", "01:30"), { mesaIds: ["M"], duracionMinutos: 90 })]
    const r = proponerMesas({
      config: config({ margenMinutos: 0 }),
      mesas,
      reservas,
      ahora: utc(2026, 3, 1, 10),
      peticion: { inicio: madrid("2026-03-29", "03:00"), comensales: 2 },
    })
    expect(r.descartes[0]?.explicacion).toBe("Mesa M: ocupada por otra reserva de 01:30 a 04:00.")
    expect(r.propuestas.map((p) => p.mesaIds[0])).toEqual(["N"])
  })

  it("las mismas entradas dan siempre la misma propuesta", () => {
    const reservas = [en("S3"), en("T3")]
    expect(proponer({}, { reservas })).toEqual(proponer({}, { reservas }))
  })
})
