import { describe, expect, it } from "vitest"
import { loginDestination } from "./login-destination"

describe("destino según identidad autenticada", () => {
  it("LogiQD va a la administración aunque solicite el panel operativo", () => { expect(loginDestination({ logiqd: true }, "/panel/caja")).toBe("/logiqd") })
  it("elegir LogiQD no concede su rol", () => {
    expect(loginDestination({}, "/logiqd")).toBe("/panel")
    expect(loginDestination({ logiqd: "true" }, "/logiqd?restaurante=otro")).toBe("/panel")
  })
  it("conserva la tarea del trabajador y rechaza redirecciones externas", () => {
    expect(loginDestination({}, "/panel/cocina")).toBe("/panel/cocina")
    expect(loginDestination({}, "https://otro.test")).toBe("/panel")
  })
})
