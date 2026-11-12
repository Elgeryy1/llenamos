import { describe, expect, it } from "vitest"
import { validarEntradaCore } from "./callables"
import { parseTags, validateCustomerEdit } from "./clientes"

describe("ficha de cliente", () => {
  it("etiquetas separadas por comas, sin repetir ni espacios de más", () => {
    expect(parseTags("habitual,  sin gluten , Habitual,\nterraza,")).toEqual(["habitual", "sin gluten", "terraza"])
  })

  it("valida notas, alergias y etiquetas con el esquema de core", () => {
    expect(validateCustomerEdit({ notes: " Ventana ", allergies: "frutos secos", tags: "vip" })).toEqual({
      ok: true,
      value: { notes: "Ventana", allergies: "frutos secos", tags: ["vip"] },
    })
    const bad = validateCustomerEdit({ notes: "x".repeat(1001), allergies: "", tags: "y".repeat(31) })
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.errors.notes).toBe("Como mucho 1000 caracteres.")
      expect(bad.errors.tags).toBe("Cada etiqueta, como mucho 30 caracteres.")
    }
  })
})

describe("entradas de las callables", () => {
  const base = { restaurantId: "demo-lumbre", locationId: "centro" }

  it("crearReserva normaliza el teléfono y pone los valores por defecto", () => {
    const v = validarEntradaCore("crearReserva", { ...base, date: "2026-11-10", time: "21:00", partySize: 2, guestName: "Ana", phone: "612 34 56 78", email: "", source: "phone" })
    expect(v).toMatchObject({ phone: "+34612345678", email: null, status: "confirmed", tableIds: [], skipWebLimits: true, language: "es" })
  })

  it("rechaza un campo de más o un teléfono imposible", () => {
    expect(() => validarEntradaCore("cambiarEstadoReserva", { ...base, reservationId: "r1", status: "seated", extra: 1 } as never)).toThrow()
    expect(() => validarEntradaCore("crearReserva", { ...base, date: "2026-11-10", time: "21:00", partySize: 2, guestName: "Ana", phone: "12", source: "phone" })).toThrow()
  })
})
