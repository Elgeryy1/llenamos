import { describe, it, expect, vi } from "vitest"
import { CALLABLE_SCHEMAS, MODULES } from "@llenamos/core"
import { Intencion, permitido, mensajeError } from "./api"
import { apiFixture, CLIENTE_FIXTURE } from "./fixtures"
import { centimos, nuevaPromocion } from "./presentacion"

describe("contrato y permisos de fidelización", () => {
  it("el camarero opera en caja y da altas, pero no configura", () => {
    const acceso = { role: "waiter" as const, modules: MODULES }
    for (const nombre of ["altaFidelizacion", "canjearPuntos", "anularCanje", "aplicarPromocion", "quitarPromocion", "darSelloRepite"] as const) expect(permitido(acceso, nombre)).toBe(true)
    for (const nombre of ["guardarConfiguracionFidelizacion", "guardarPremio", "guardarPromocion", "guardarAjustesRepite", "informeRepite", "ajustarPuntos"] as const) expect(permitido(acceso, nombre)).toBe(false)
  })
  it("cocina y barra no leen puntos ni aplican promociones", () => {
    for (const role of ["kitchen", "bar"] as const) for (const nombre of ["verCuentaFidelizacion", "aplicarPromocion", "guardarPremio"] as const) expect(permitido({ role, modules: MODULES }, nombre)).toBe(false)
  })
  it("requiere todos los módulos de la callable sin heredar por rol", () => {
    expect(permitido({ role: "owner", modules: ["loyalty"] }, "canjearPuntos")).toBe(false)
    expect(permitido({ role: "owner", modules: ["pos"] }, "aplicarPromocion")).toBe(false)
    expect(permitido({ role: "manager", modules: ["repite"] }, "guardarAjustesRepite")).toBe(true)
    expect(permitido({ role: "owner", modules: MODULES }, "vincularRepite")).toBe(false)
  })
  it("reutiliza el identificador para recuperar una operación sin respuesta", () => {
    const id = vi.fn().mockReturnValueOnce("id-a").mockReturnValueOnce("id-b")
    const intencion = new Intencion(id)
    expect(intencion.id("aplicarPromocion", { revision: 1 })).toBe("id-a")
    expect(intencion.id("aplicarPromocion", { revision: 1 })).toBe("id-a")
    intencion.cerrar()
    expect(intencion.id("aplicarPromocion", { revision: 1 })).toBe("id-b")
  })
  it("no permite enviar importes ni autor al aplicar un descuento", () => {
    const datos = { restaurantId: "r", locationId: "l", requestId: "peticion", billId: "b", expectedBillRevision: 1, promotionId: "p", code: null }
    expect(CALLABLE_SCHEMAS.aplicarPromocion.input.safeParse(datos).success).toBe(true)
    expect(CALLABLE_SCHEMAS.aplicarPromocion.input.safeParse({ ...datos, discountCents: 500 }).success).toBe(false)
  })
  it("conserva los motivos en castellano y explica que el servicio no está disponible", () => {
    expect(mensajeError({ code: "functions/not-found" })).toContain("servicio de fidelización")
    expect(mensajeError(new Error("La cuenta está cerrada."))).toBe("La cuenta está cerrada.")
  })
  it("las fixtures nunca confirman escrituras", async () => {
    await expect(apiFixture("altaFidelizacion", { restaurantId: "r", requestId: "id", customerId: CLIENTE_FIXTURE, acceptedTermsVersion: "1" })).rejects.toThrow("No se ha guardado nada")
    const r = await apiFixture("verCuentaFidelizacion", { restaurantId: "r", customerId: CLIENTE_FIXTURE })
    expect(r.available).toBe(180)
  })
  it("convierte euros sin perder céntimos y conserva franjas nocturnas del contrato", () => {
    expect(centimos("12,09")).toBe(1209)
    expect(() => centimos("12,099")).toThrow()
    const p = nuevaPromocion()
    expect(CALLABLE_SCHEMAS.guardarPromocion.input.safeParse({ restaurantId: "r", requestId: "id", promotionId: null, expectedRevision: null, promotion: { ...p, weekdays: [4], timeWindows: [{ from: "22:00", to: "02:00" }] } }).success).toBe(true)
  })
})
