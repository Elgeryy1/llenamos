import { describe, expect, it } from "vitest"
import { defaultMarketingSettings } from "@llenamos/core"
import { leerAjustesMarketing } from "./datos"

describe("ajustes de marketing guardados por el servidor", () => {
  it("lee los campos del contrato aunque Firestore incluya autor y fechas", () => {
    const settings = defaultMarketingSettings("Lumbre")
    expect(leerAjustesMarketing({ ...settings, updatedBy: "owner", createdAt: { seconds: 1 }, updatedAt: { seconds: 2 } })).toEqual(settings)
  })
  it("sigue rechazando ajustes que incumplen los límites del contrato", () => {
    expect(() => leerAjustesMarketing({ ...defaultMarketingSettings("Lumbre"), minHoursBetween: 0 })).toThrow()
  })
})
