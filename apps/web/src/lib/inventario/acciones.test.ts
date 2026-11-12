import { describe, expect, it } from "vitest"
import { IntencionEstable, esDefinitivo } from "./acciones"

describe("intención estable", () => {
  it("repetir lo mismo reutiliza el requestId hasta cerrarla", () => {
    let n = 0
    const i = new IntencionEstable(() => `id-${++n}`)
    const a = i.idPara("registrarMerma", { quantity: 4 })
    expect(i.idPara("registrarMerma", { quantity: 4 })).toBe(a)
    expect(i.idPara("registrarMerma", { quantity: 5 })).not.toBe(a)
    const c = i.idPara("registrarMerma", { quantity: 5 })
    i.cerrar()
    expect(i.idPara("registrarMerma", { quantity: 5 })).not.toBe(c)
  })
})

describe("errores definitivos", () => {
  it("distingue lo que hay que corregir de lo que se puede reintentar", () => {
    expect(esDefinitivo({ code: "functions/failed-precondition" })).toBe(true)
    expect(esDefinitivo({ code: "functions/permission-denied" })).toBe(true)
    expect(esDefinitivo({ code: "functions/unavailable" })).toBe(false)
    expect(esDefinitivo({ code: "functions/internal" })).toBe(false)
    expect(esDefinitivo(new Error("sin red"))).toBe(false)
  })
})
