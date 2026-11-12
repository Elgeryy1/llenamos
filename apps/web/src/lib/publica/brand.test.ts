import { describe, expect, it } from "vitest"
import { brandPalette, brandStyle, CANVAS, contrast, DARK_INK, initials } from "./brand"

describe("color de marca", () => {
  it("el ámbar del diseño lleva texto oscuro encima y se lee sobre el fondo", () => {
    const p = brandPalette("#f0a35e")
    expect(p).toEqual({ accent: "#f0a35e", accentInk: DARK_INK, accentText: "#f0a35e" })
    expect(contrast(p.accent, p.accentInk)).toBeGreaterThanOrEqual(4.5)
  })

  it("un color oscuro lleva texto blanco y se aclara para usarlo como texto", () => {
    const p = brandPalette("#1d2a6b")
    expect(p.accentInk).toBe("#ffffff")
    expect(contrast(p.accent, p.accentInk)).toBeGreaterThanOrEqual(4.5)
    expect(p.accentText).not.toBe(p.accent)
    expect(contrast(p.accentText, CANVAS)).toBeGreaterThanOrEqual(4.5)
  })

  it("siempre da contraste suficiente, sea cual sea el color", () => {
    for (const color of ["#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff", "#777777", "#8fc7a0", "#e8857a", "#3b0a45"]) {
      const p = brandPalette(color)
      expect(contrast(p.accent, p.accentInk), color).toBeGreaterThanOrEqual(4.5)
      expect(contrast(p.accentText, CANVAS), color).toBeGreaterThanOrEqual(4.5)
    }
  })

  it("con un color no válido usa el ámbar por defecto", () => {
    expect(brandPalette("rojo").accent).toBe("#f0a35e")
    expect(brandPalette(null).accent).toBe("#f0a35e")
  })

  it("da las variables del tema y las de shadcn", () => {
    expect(brandStyle("#f0a35e")).toMatchObject({ "--brand": "#f0a35e", "--primary": "#f0a35e", "--primary-foreground": DARK_INK })
  })

  it("saca las iniciales sin artículos", () => {
    expect(initials("Taberna Lumbre")).toBe("TL")
    expect(initials("Casa de la Abuela")).toBe("CA")
    expect(initials("Lumbre")).toBe("L")
    expect(initials("  ")).toBe("·")
  })
})
