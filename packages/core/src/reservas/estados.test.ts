import { describe, expect, it } from "vitest"
import { utc } from "./datos-prueba"
import {
  cambiarEstado,
  comprobarCambioEstado,
  cuentaParaCapacidad,
  esEstadoFinal,
  ESTADOS_RESERVA,
  ocupaMesa,
  puedeCambiarEstado,
  type EstadoReserva,
} from "./estados"
import { ReservaSchema, type Reserva } from "./reserva"

const PERMITIDAS: Array<[EstadoReserva, EstadoReserva]> = [
  ["pendiente", "confirmada"],
  ["pendiente", "sentada"],
  ["pendiente", "cancelada"],
  ["pendiente", "no_presentada"],
  ["confirmada", "sentada"],
  ["confirmada", "cancelada"],
  ["confirmada", "no_presentada"],
  ["sentada", "terminada"],
  ["no_presentada", "sentada"],
]

const inicio = utc(2026, 11, 10, 20)

const ejemplo: Reserva = {
  nombre: "Marta Puig",
  telefono: "+34 600 000 000",
  email: "marta@example.com",
  comensales: 4,
  inicio,
  duracionMinutos: 105,
  estado: "pendiente",
  mesaIds: [],
  origen: "web",
  notas: "",
  historial: [],
}

describe("estados de una reserva", () => {
  it("solo se permiten las transiciones de la tabla, y ninguna más", () => {
    for (const de of ESTADOS_RESERVA) {
      for (const a of ESTADOS_RESERVA) {
        const esperada = PERMITIDAS.some(([x, y]) => x === de && y === a)
        expect(puedeCambiarEstado(de, a), `${de} → ${a}`).toBe(esperada)
      }
    }
  })

  it("terminada y cancelada son finales", () => {
    expect(ESTADOS_RESERVA.filter(esEstadoFinal)).toEqual(["terminada", "cancelada"])
  })

  it("explica por qué no se puede cambiar", () => {
    const despues = inicio + 60_000
    expect(comprobarCambioEstado({ estado: "terminada", inicio }, "sentada", despues)).toEqual({
      ok: false,
      motivo: "Una reserva terminada ya no se puede cambiar.",
    })
    expect(comprobarCambioEstado({ estado: "cancelada", inicio }, "confirmada", despues).ok).toBe(false)
    expect(comprobarCambioEstado({ estado: "sentada", inicio }, "cancelada", despues)).toEqual({
      ok: false,
      motivo: "No se puede pasar de sentada a cancelada.",
    })
    expect(comprobarCambioEstado({ estado: "confirmada", inicio }, "pendiente", despues).ok).toBe(false)
    expect(comprobarCambioEstado({ estado: "confirmada", inicio }, "confirmada", despues)).toEqual({
      ok: false,
      motivo: "La reserva ya está confirmada.",
    })
    expect(comprobarCambioEstado({ estado: "pendiente", inicio }, "terminada", despues).ok).toBe(false)
  })

  it("no se marca como no presentada antes de su hora", () => {
    expect(comprobarCambioEstado({ estado: "confirmada", inicio }, "no_presentada", inicio - 60_000)).toEqual({
      ok: false,
      motivo: "Todavía no ha llegado la hora de la reserva.",
    })
    expect(comprobarCambioEstado({ estado: "confirmada", inicio }, "no_presentada", inicio)).toEqual({ ok: true })
  })

  it("si llega tarde después de marcarla como no presentada, se puede sentar", () => {
    expect(comprobarCambioEstado({ estado: "no_presentada", inicio }, "sentada", inicio + 40 * 60_000)).toEqual({ ok: true })
    expect(comprobarCambioEstado({ estado: "no_presentada", inicio }, "confirmada", inicio).ok).toBe(false)
  })

  it("cambiar de estado apunta el cambio en el historial sin tocar el original", () => {
    const r1 = cambiarEstado(ejemplo, "confirmada", { ahora: inicio - 3_600_000, por: "uid-encargada" })
    expect(r1.ok).toBe(true)
    if (!r1.ok) return
    expect(ejemplo.estado).toBe("pendiente")
    expect(ejemplo.historial).toEqual([])
    expect(r1.reserva.estado).toBe("confirmada")
    expect(r1.reserva.historial).toEqual([{ de: "pendiente", a: "confirmada", en: inicio - 3_600_000, por: "uid-encargada", motivo: null }])

    const r2 = cambiarEstado(r1.reserva, "cancelada", { ahora: inicio - 60_000, motivo: "Lo pide el cliente" })
    expect(r2.ok && r2.reserva.historial.map((c) => c.a)).toEqual(["confirmada", "cancelada"])
    expect(r2.ok && r2.reserva.historial[1]?.por).toBeNull()
    expect(ReservaSchema.safeParse(r2.ok ? r2.reserva : null).success).toBe(true)

    const r3 = cambiarEstado(ejemplo, "terminada", { ahora: inicio })
    expect(r3).toEqual({ ok: false, motivo: "No se puede pasar de pendiente a terminada." })
  })

  it("qué estados ocupan mesa y cuáles cuentan para la capacidad", () => {
    expect(ESTADOS_RESERVA.filter(ocupaMesa)).toEqual(["pendiente", "confirmada", "sentada"])
    expect(ESTADOS_RESERVA.filter(cuentaParaCapacidad)).toEqual(["pendiente", "confirmada", "sentada", "terminada"])
  })
})

describe("forma de una reserva", () => {
  it("acepta una reserva bien formada", () => {
    expect(ReservaSchema.safeParse(ejemplo).success).toBe(true)
    expect(ReservaSchema.safeParse({ ...ejemplo, email: null, mesaIds: ["S1", "S2"] }).success).toBe(true)
  })

  it("rechaza datos imposibles", () => {
    expect(ReservaSchema.safeParse({ ...ejemplo, comensales: 0 }).success).toBe(false)
    expect(ReservaSchema.safeParse({ ...ejemplo, comensales: 2.5 }).success).toBe(false)
    expect(ReservaSchema.safeParse({ ...ejemplo, duracionMinutos: 5 }).success).toBe(false)
    expect(ReservaSchema.safeParse({ ...ejemplo, estado: "perdida" }).success).toBe(false)
    expect(ReservaSchema.safeParse({ ...ejemplo, email: "no-es-correo" }).success).toBe(false)
    expect(ReservaSchema.safeParse({ ...ejemplo, nombre: "  " }).success).toBe(false)
  })
})
