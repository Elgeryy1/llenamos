import { describe, expect, it } from "vitest"
import { at, TZ } from "./fixtures"
import { dateToFecha, duration, euros, fechaToDate, longDate, prettyPhone, relativeDay, shortDate, timeOf } from "./formato"

describe("formato", () => {
  it("hora y día en la zona del local", () => {
    expect(timeOf(at("2026-11-10", "21:05"), TZ)).toBe("21:05")
    expect(longDate("2026-11-10")).toBe("martes 10 de noviembre")
    expect(shortDate(at("2026-11-10", "21:05"), TZ)).toBe("10 nov")
    expect(shortDate(at("2025-03-02", "13:00"), TZ, "2026-11-10")).toBe("2 mar 2025")
  })

  it("hoy, mañana y ayer", () => {
    expect(relativeDay("2026-11-10", "2026-11-10")).toBe("hoy")
    expect(relativeDay("2026-11-11", "2026-11-10")).toBe("mañana")
    expect(relativeDay("2026-11-09", "2026-11-10")).toBe("ayer")
    expect(relativeDay("2026-11-14", "2026-11-10")).toBe("el sábado 14 de noviembre")
  })

  it("el día del calendario ida y vuelta", () => {
    expect(dateToFecha(fechaToDate("2026-03-29"))).toBe("2026-03-29")
  })

  it("importes, teléfonos y duraciones", () => {
    expect(euros(3000).replace(/\s/g, " ")).toBe("30 €")
    expect(euros(1250).replace(/\s/g, " ")).toBe("12,50 €")
    expect(prettyPhone("+34612345678")).toBe("+34 612 34 56 78")
    expect(prettyPhone("+447700900123")).toBe("+447700900123")
    expect(duration(90)).toBe("1 h 30")
    expect(duration(45)).toBe("45 min")
  })
})
