import { describe, expect, it } from "vitest"
import { matchesCustomer } from "./clientes"

describe("buscar clientes", () => {
  const c = { name: "Núria Bosch", phone: "+34612345678", email: "nuria@example.com" }
  it("por nombre, correo o teléfono", () => {
    expect(matchesCustomer(c, "nuria b")).toBe(true)
    expect(matchesCustomer(c, "example")).toBe(true)
    expect(matchesCustomer(c, "345 678")).toBe(true)
    expect(matchesCustomer(c, "0034 612 345 678")).toBe(true)
    expect(matchesCustomer(c, "marta")).toBe(false)
    expect(matchesCustomer(c, "")).toBe(true)
  })
})
