import { describe, expect, it } from "vitest"
import { derivaDePrecio, pendienteDePedido, precioPorUnidad, resumenPedidos } from "./modelo"

const linea = (ordered: number, received: number, price: number) => ({ lineId: "a", supplierItemId: "s", ingredientId: "i", name: "x", baseQuantity: 1000, priceCents: price, orderedFormats: ordered, receivedFormats: received })

describe("modelo de compras", () => {
  it("cuenta lo pendiente sin dejar que lo recibido de más reste", () => {
    expect(pendienteDePedido({ lines: [linea(2, 1, 3000), linea(1, 3, 500)] })).toEqual({ formats: 1, cents: 3000 })
  })
  it("resume solo lo que se espera", () => {
    const r = resumenPedidos([
      { status: "draft", lines: [linea(1, 0, 100)] },
      { status: "sent", lines: [linea(2, 0, 1000)] },
      { status: "partially_received", lines: [linea(2, 1, 1000)] },
      { status: "received", lines: [linea(2, 2, 1000)] },
    ])
    expect(r).toEqual({ borradores: 1, porRecibir: 2, enParte: 1, pendienteCents: 3000 })
  })
  it("da el precio por kilo, litro o unidad", () => {
    expect(precioPorUnidad(3400, 2000, "g")).toMatch(/^17,00\s€ por kg$/)
    expect(precioPorUnidad(2800, 5000, "ml")).toMatch(/^5,60\s€ por l$/)
    expect(precioPorUnidad(1200, 12, "u")).toMatch(/^1,00\s€ por ud$/)
  })
  it("avisa de la deriva del último precio sobre el de lista", () => {
    expect(derivaDePrecio({ priceCents: 3000, lastPriceCents: null })).toBeNull()
    expect(derivaDePrecio({ priceCents: 3000, lastPriceCents: 3000 })).toBeNull()
    expect(derivaDePrecio({ priceCents: 3000, lastPriceCents: 3100 })).toBe(333)
    expect(derivaDePrecio({ priceCents: 3000, lastPriceCents: 2900 })).toBe(-333)
  })
})
