import { describe, expect, it } from "vitest"
import { cambioBp, eurosParaCampo, parseEuros, variacionTexto } from "./dinero"

describe("dinero de compras", () => {
  it("lee importes con coma o punto y rechaza lo dudoso", () => {
    expect(parseEuros("12,5")).toBe(1250)
    expect(parseEuros("12.50")).toBe(1250)
    expect(parseEuros(" 3 € ")).toBe(300)
    expect(parseEuros("0,05")).toBe(5)
    expect(parseEuros("1,234")).toBeNull()
    expect(parseEuros("-3")).toBeNull()
    expect(parseEuros("")).toBeNull()
    expect(parseEuros("dos")).toBeNull()
  })
  it("escribe el campo con dos decimales", () => {
    expect(eurosParaCampo(1250)).toBe("12,50")
    expect(eurosParaCampo(5)).toBe("0,05")
  })
  it("cuenta la variación en puntos básicos y la enseña", () => {
    expect(cambioBp(3000, 3100)).toBe(333)
    expect(cambioBp(3000, 2900)).toBe(-333)
    expect(cambioBp(0, 100)).toBe(10_000)
    expect(variacionTexto(333)).toBe("+3,33 %")
    expect(variacionTexto(-500)).toBe("-5 %")
    expect(variacionTexto(310)).toBe("+3,1 %")
    expect(variacionTexto(0)).toBe("0 %")
  })
})
