import { describe, expect, it } from "vitest"
import { assignableRoles, can, formatMoney, parseMoney, ROLES, slugify, splitEvenly } from "./index"

describe("dinero", () => {
  it("formatea en euros con formato español", () => {
    expect(formatMoney(123456).replace(/\s/g, " ")).toBe("1234,56 €")
    expect(formatMoney(5).replace(/\s/g, " ")).toBe("0,05 €")
  })

  it("entiende importes escritos a mano", () => {
    expect(parseMoney("12")).toBe(1200)
    expect(parseMoney("12,5")).toBe(1250)
    expect(parseMoney("12.50")).toBe(1250)
    expect(parseMoney("1.234,56 €")).toBe(123456)
    expect(parseMoney("-3,10")).toBe(-310)
    expect(parseMoney("doce")).toBeNull()
    expect(parseMoney("1,234")).toBeNull()
    expect(parseMoney("")).toBeNull()
  })

  it("reparte sin perder ni inventar céntimos", () => {
    expect(splitEvenly(1000, 3)).toEqual([334, 333, 333])
    expect(splitEvenly(1001, 2)).toEqual([501, 500])
    for (const [total, n] of [[9999, 7], [1, 4], [-1000, 3]] as const) {
      expect(splitEvenly(total, n).reduce((a, b) => a + b, 0)).toBe(total)
    }
    expect(() => splitEvenly(100, 0)).toThrow()
  })
})

describe("roles", () => {
  it("el propietario puede todo", () => {
    expect(can("owner", "propietarios.gestionar")).toBe(true)
    expect(can("owner", "cocina.ver")).toBe(true)
  })

  it("el encargado no puede gestionar propietarios", () => {
    expect(can("manager", "propietarios.gestionar")).toBe(false)
    expect(can("manager", "equipo.gestionar")).toBe(true)
  })

  it("cocina y barra solo ven su pantalla", () => {
    expect(can("kitchen", "cocina.ver")).toBe(true)
    expect(can("kitchen", "sala.ver")).toBe(false)
    expect(can("bar", "barra.ver")).toBe(true)
    expect(can("bar", "ajustes.gestionar")).toBe(false)
  })

  it("sin rol no hay permisos", () => {
    expect(can(null, "sala.ver")).toBe(false)
  })

  it("nadie da más poder del que tiene", () => {
    expect(assignableRoles("owner")).toEqual([...ROLES])
    expect(assignableRoles("manager")).not.toContain("owner")
    expect(assignableRoles("waiter")).toEqual([])
  })
})

describe("slugify", () => {
  it("quita tildes y espacios", () => {
    expect(slugify("Taberna Lumbre")).toBe("taberna-lumbre")
    expect(slugify("  Cañas & Tapas Ñu  ")).toBe("canas-tapas-nu")
  })
})
