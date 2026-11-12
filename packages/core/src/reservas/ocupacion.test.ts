import { describe, expect, it } from "vitest"
import { MESAS, mesa, MINUTO, reserva, utc } from "./datos-prueba"
import {
  combinacionesDeMesas,
  construirOcupacion,
  encajarSolicitudes,
  intervaloDeReserva,
  opcionesParaGrupo,
  reservasSinMesaEncadenadas,
  seSolapan,
  type Solicitud,
} from "./ocupacion"

const a21 = utc(2026, 11, 10, 20) // 21:00 en Madrid

describe("solapes con margen", () => {
  const cena = { inicio: utc(2026, 11, 10, 19), fin: a21 } // 20:00 a 21:00
  const desde = (min: number) => ({ inicio: a21 + min * MINUTO, fin: a21 + (min + 90) * MINUTO })

  it("sin margen, acabar a las 21:00 y empezar a las 21:00 no choca", () => {
    expect(seSolapan(cena, desde(0), 0)).toBe(false)
    expect(seSolapan(cena, desde(-1), 0)).toBe(true)
  })

  it("con 15 minutos de margen, la mesa queda libre a las 21:15", () => {
    expect(seSolapan(cena, desde(10), 15)).toBe(true)
    expect(seSolapan(cena, desde(14), 15)).toBe(true)
    expect(seSolapan(cena, desde(15), 15)).toBe(false)
    // El margen vale en los dos sentidos.
    expect(seSolapan(desde(15), cena, 15)).toBe(false)
    expect(seSolapan(desde(10), cena, 15)).toBe(true)
  })

  it("una reserva dentro de otra choca", () => {
    expect(seSolapan({ inicio: 0, fin: 100 * MINUTO }, { inicio: 10 * MINUTO, fin: 20 * MINUTO }, 0)).toBe(true)
  })

  it("si el grupo sentado se alarga, la mesa sigue ocupada hasta ahora", () => {
    const r = reserva(a21, { estado: "sentada", duracionMinutos: 90 })
    const ahora = a21 + 120 * MINUTO
    expect(intervaloDeReserva(r, ahora)).toEqual({ inicio: a21, fin: ahora })
    expect(intervaloDeReserva({ ...r, estado: "confirmada" }, ahora)).toEqual({ inicio: a21, fin: a21 + 90 * MINUTO })
  })
})

describe("combinaciones de mesas", () => {
  const claves = (mesas = MESAS, max = 3, perdidas = 0) =>
    combinacionesDeMesas(mesas, max, perdidas).map((o) => `${o.mesaIds.join("+")}:${o.plazas}`)

  it("incluye cada mesa habilitada y sus uniones posibles", () => {
    expect(claves()).toEqual([
      "S1:2", "S2:2", "S3:4", "S4:4", "S5:6", "T1:2", "T2:2", "T3:4",
      "S1+S2:4", "S3+S4:8", "T1+T2:4", "T2+T3:6",
      "T1+T2+T3:8",
    ])
  })

  it("basta con que una de las dos mesas diga que se puede unir", () => {
    // S1 dice que se une con S2; S2 no dice nada.
    expect(claves()).toContain("S1+S2:4")
  })

  it("no une mesas deshabilitadas ni mesas que no están en la cadena", () => {
    const todas = claves()
    expect(todas.some((c) => c.includes("S6"))).toBe(false)
    expect(todas).not.toContain("T1+T3:6")
  })

  it("respeta el máximo de mesas unidas", () => {
    expect(claves(MESAS, 1)).toEqual(["S1:2", "S2:2", "S3:4", "S4:4", "S5:6", "T1:2", "T2:2", "T3:4"])
    expect(claves(MESAS, 2)).not.toContain("T1+T2+T3:8")
  })

  it("descuenta las plazas que se pierden al unir", () => {
    expect(claves(MESAS, 3, 1)).toContain("S1+S2:3")
    expect(claves(MESAS, 3, 1)).toContain("T1+T2+T3:6")
  })

  it("ignora uniones con mesas que no existen o consigo misma", () => {
    expect(claves([mesa("A", 2, { joinableWith: ["A", "fantasma"] })])).toEqual(["A:2"])
  })

  it("ordena las opciones: menos plazas vacías, luego menos mesas, luego el orden del plano", () => {
    const comb = combinacionesDeMesas(MESAS, 3, 0)
    const para4 = opcionesParaGrupo(comb, MESAS, 4).map((o) => o.mesaIds.join("+"))
    expect(para4).toEqual(["S3", "S4", "T3", "S1+S2", "T1+T2", "S5", "T2+T3", "S3+S4", "T1+T2+T3"])
    expect(opcionesParaGrupo(comb, MESAS, 9)).toEqual([])
  })

  it("con zona preferida, primero las de esa zona", () => {
    const comb = combinacionesDeMesas(MESAS, 3, 0)
    const para2 = opcionesParaGrupo(comb, MESAS, 2, "terraza").map((o) => o.mesaIds.join("+"))
    expect(para2.slice(0, 6)).toEqual(["T1", "T2", "T3", "T1+T2", "T2+T3", "T1+T2+T3"])
    expect(para2[6]).toBe("S1")
  })
})

describe("ocupación", () => {
  it("separa reservas con mesa y sin mesa, y deja fuera las que no ocupan", () => {
    const reservas = [
      reserva(a21, { id: "con", mesaIds: ["S1", "S2"] }),
      reserva(a21, { id: "sin" }),
      reserva(a21, { id: "cancelada", estado: "cancelada", mesaIds: ["S3"] }),
      reserva(a21, { id: "noVino", estado: "no_presentada", mesaIds: ["S3"] }),
      reserva(a21, { id: "terminada", estado: "terminada", mesaIds: ["S3"] }),
      reserva(a21, { id: "excluida", mesaIds: ["S4"] }),
    ]
    const o = construirOcupacion(reservas, a21, "excluida")
    expect([...o.porMesa.keys()]).toEqual(["S1", "S2"])
    expect(o.sinMesa.map((s) => s.reserva.id)).toEqual(["sin"])
  })

  it("encadena las reservas sin mesa que se pisan entre sí", () => {
    const o = construirOcupacion(
      [
        reserva(a21, { id: "a" }), // 21:00–22:30
        reserva(a21 + 80 * MINUTO, { id: "b" }), // 22:20, se pisa con a
        reserva(a21 + 180 * MINUTO, { id: "c" }), // 00:00, 10 minutos después de b: solo se pisa por el margen
        reserva(a21 + 400 * MINUTO, { id: "d" }), // lejos
      ],
      0,
    )
    const ids = (margen: number) =>
      reservasSinMesaEncadenadas({ inicio: a21 - 30 * MINUTO, fin: a21 + 10 * MINUTO }, o.sinMesa, margen).map((s) => s.reserva.id)
    expect(ids(0)).toEqual(["a", "b"])
    expect(ids(15)).toEqual(["a", "b", "c"])
  })
})

describe("reparto de varias solicitudes a la vez", () => {
  const intervalo = { inicio: a21, fin: a21 + 90 * MINUTO }
  const mesas = [mesa("P", 4, { joinableWith: ["Q"] }), mesa("Q", 2), mesa("R", 4)]
  const comb = combinacionesDeMesas(mesas, 2, 0)
  const sol = (id: string, comensales: number): Solicitud => ({
    id,
    intervalo,
    comensales,
    opciones: opcionesParaGrupo(comb, mesas, comensales),
  })
  const vacia = { porMesa: new Map() }

  it("encuentra un reparto aunque la opción preferida de uno bloquee al otro", () => {
    // El grupo de 4 prefiere P, pero el de 6 solo cabe en P+Q: el de 4 tiene que ir a R.
    const r = encajarSolicitudes([sol("cuatro", 4), sol("seis", 6)], vacia, 15)
    expect(r.tipo).toBe("encaja")
    if (r.tipo !== "encaja") return
    expect(r.asignacion.get("seis")?.mesaIds).toEqual(["P", "Q"])
    expect(r.asignacion.get("cuatro")?.mesaIds).toEqual(["R"])
  })

  it("dice que no cuando no caben todas", () => {
    expect(encajarSolicitudes([sol("a", 4), sol("b", 4), sol("c", 4)], vacia, 15).tipo).toBe("no_encaja")
    expect(encajarSolicitudes([sol("grande", 10)], vacia, 15).tipo).toBe("no_encaja")
  })

  it("tiene en cuenta las reservas que ya tienen mesa", () => {
    const o = construirOcupacion([reserva(a21, { mesaIds: ["R"] })], 0)
    expect(encajarSolicitudes([sol("cuatro", 4), sol("seis", 6)], o, 15).tipo).toBe("no_encaja")
    expect(encajarSolicitudes([sol("cuatro", 4)], o, 15).tipo).toBe("encaja")
  })

  it("si el reparto es demasiado grande lo dice en vez de inventarse una respuesta", () => {
    expect(encajarSolicitudes([sol("a", 2), sol("b", 2), sol("c", 2), sol("d", 2)], vacia, 15, 3).tipo).toBe("sin_comprobar")
  })
})
