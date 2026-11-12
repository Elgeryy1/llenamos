import { describe, it, expect } from "vitest"
import { sha256Hex } from "@llenamos/core"
import { qrMatrix, qrSvg } from "./qr"
describe("QR local de mesa", () => {
  // Vectores contrastados con node-qrcode, versión 10, modo byte, corrección L y máscara 0.
  it.each([
    [
      "https://lumbre.test/m/taberna-lumbre/centro/S1?t=" + "a".repeat(43),
      "8d7fae3259d6fddd51587238bfd160f44914781559788b286467d96f06028157",
    ],
    [
      "https://lumbre.test/mesa?nombre=José",
      "bdc47db23d147c1ef90cc8b9162b76d2e43cc37b5b5dedf3ce29e9582bb95bc5",
    ],
  ])("coincide con una matriz independiente", (value, hash) => {
    const matrix = qrMatrix(value)
    expect(matrix).toHaveLength(57)
    expect(sha256Hex(matrix.flat().map(Number).join(""))).toBe(hash)
  })
  it("limita bytes, también con unicode, antes de generar un código ilegible", () => {
    expect(() => qrMatrix("a".repeat(271))).not.toThrow()
    expect(() => qrMatrix("a".repeat(272))).toThrow("largo")
    expect(() => qrMatrix("é".repeat(136))).toThrow("largo")
  })
  it("incluye margen blanco y no introduce el texto del enlace como marcado", () => {
    const svg = qrSvg("<script>alert(1)</script>")
    expect(svg).toContain('viewBox="0 0 65 65"')
    expect(svg).not.toContain("<script>")
  })
})

it("la placa conserva el QR e impide marcado en nombres", async () => {
  const { qrPlateSvg } = await import("./qr")
  const plate = qrPlateSvg("http://local.test/mesa?t=abc", "S1 <script>", "Lumbre & cocina")
  expect(plate).toContain("Llenamos · by LogiQD")
  expect(plate).toContain("S1 &lt;script&gt;")
  expect(plate).toContain("Lumbre &amp; cocina")
  expect(plate).not.toContain("<script>")
})
