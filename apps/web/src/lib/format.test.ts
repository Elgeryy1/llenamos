import { describe, expect, it } from "vitest"
import { firstName, formatRelative, plural } from "./format"

// 9 de noviembre de 2026, 12:00 en Madrid (UTC+1).
const now = new Date("2026-11-09T11:00:00Z")
const ago = (ms: number) => new Date(now.getTime() - ms)
const MIN = 60_000

describe("formatRelative", () => {
  it("dice «ahora mismo» para lo de hace segundos", () => {
    expect(formatRelative(ago(10_000), now)).toBe("ahora mismo")
    // Un reloj algo adelantado en otro dispositivo no debe dar «hace -1 min».
    expect(formatRelative(new Date(now.getTime() + 20_000), now)).toBe("ahora mismo")
  })

  it("cuenta minutos y horas del mismo día", () => {
    expect(formatRelative(ago(5 * MIN), now)).toBe("hace 5 min")
    expect(formatRelative(ago(150 * MIN), now)).toBe("hace 2 h")
  })

  it("usa «ayer» según el día de Madrid", () => {
    // 8 de noviembre a las 22:30 en Madrid.
    expect(formatRelative(new Date("2026-11-08T21:30:00Z"), now)).toBe("ayer a las 22:30")
  })

  it("fechas más antiguas con día y mes, y año si es otro", () => {
    expect(formatRelative(new Date("2026-11-03T13:05:00Z"), now)).toBe("3 nov, 14:05")
    expect(formatRelative(new Date("2025-07-01T08:00:00Z"), now)).toBe("1 jul 2025, 10:00")
  })
})

describe("firstName y plural", () => {
  it("saca el primer nombre", () => {
    expect(firstName("Laia Ferrer")).toBe("Laia")
    expect(firstName("  ")).toBeNull()
    expect(firstName(null)).toBeNull()
  })

  it("concuerda en número", () => {
    expect(plural(1, "mesa", "mesas")).toBe("1 mesa")
    expect(plural(0, "mesa", "mesas")).toBe("0 mesas")
  })
})
