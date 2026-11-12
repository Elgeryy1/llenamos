import { describe, expect, it } from "vitest"
import { defaultReservationSettings } from "../adapters"
import { instanteDeHoraLocal } from "../reservas/tiempo"
import { tableOrderingAllowed } from "./horario"

const at = (date: string, minutes: number) => instanteDeHoraLocal(date, minutes, "Europe/Madrid")!
describe("pedidos de mesas abiertas según el horario", () => {
  it("conserva el permiso anterior cuando el ajuste falta y respeta cierres al desactivarlo", () => {
    const config = defaultReservationSettings()
    config.week.mon = [{ name: "Comida", from: "13:00", lastEntry: "16:00" }]
    expect(tableOrderingAllowed({}, config, at("2026-11-09", 600))).toBe(true)
    expect(tableOrderingAllowed({ allowOrdersOutsideHours: false }, config, at("2026-11-09", 779))).toBe(false)
    expect(tableOrderingAllowed({ allowOrdersOutsideHours: false }, config, at("2026-11-09", 780))).toBe(true)
    expect(tableOrderingAllowed({ allowOrdersOutsideHours: false }, config, at("2026-11-09", 960) + 59999)).toBe(true)
    expect(tableOrderingAllowed({ allowOrdersOutsideHours: false }, config, at("2026-11-09", 961))).toBe(false)
    config.exceptions = [{ type: "closed", date: "2026-11-09" }]
    expect(tableOrderingAllowed({ allowOrdersOutsideHours: false }, config, at("2026-11-09", 840))).toBe(false)
  })
  it("mantiene el turno del día anterior al cruzar medianoche", () => {
    const config = defaultReservationSettings()
    config.week.mon = [{ name: "Cena", from: "21:00", lastEntry: "01:00" }]
    config.week.tue = []
    expect(tableOrderingAllowed({ allowOrdersOutsideHours: false }, config, at("2026-11-10", 30))).toBe(true)
    expect(tableOrderingAllowed({ allowOrdersOutsideHours: false }, config, at("2026-11-10", 61))).toBe(false)
  })
})
