import { describe, it, expect } from "vitest"
import { centsFromEuros, editableItem } from "./forms"
import { validatePhoto } from "./photos"
import { demoMenu } from "@llenamos/core"
describe("Edición de la carta", () => {
  it("convierte euros sin perder precisión en céntimos", () => {
    expect(centsFromEuros("12,34")).toBe(1234)
    expect(centsFromEuros("0.29")).toBe(29)
    expect(centsFromEuros("100000")).toBe(10_000_000)
  })
  it.each(["-1", "1.234", "abc", "100000.01", "", "Infinity"])("rechaza un precio no válido %s", (raw) =>
    expect(() => centsFromEuros(raw)).toThrow(),
  )
  it("no permite editar la versión ni el agotado con guardarPlato", () => {
    const item = editableItem(demoMenu().items.cana)
    expect(item).not.toHaveProperty("version")
    expect(item).not.toHaveProperty("soldOut")
  })
  it("valida formato y límite de las fotos antes de subir", () => {
    expect(() => validatePhoto({ type: "image/webp", size: 5 * 1024 * 1024 })).not.toThrow()
    expect(() => validatePhoto({ type: "image/svg+xml", size: 100 })).toThrow("JPG")
    expect(() => validatePhoto({ type: "image/jpeg", size: 5 * 1024 * 1024 + 1 })).toThrow("5 MiB")
  })
})
