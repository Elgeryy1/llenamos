import { describe, expect, it } from "vitest"
import { CALLABLES, CALLABLE_SCHEMAS, CALLABLES_FASE3, CALLABLE_SCHEMAS_FASE3, FASE3_ACCESS,
  PERMISSIONS, ROLES, can, RegistrarCobroInputSchema, AjustarCuentaInputSchema,
  IniciarPagoCuentaInputSchema, ReclamarImpresionesInputSchema, EmitirFacturaInputSchema,
} from "./index"
const scope = { restaurantId: "r1", locationId: "l1", requestId: "req1", billId: "b1", expectedRevision: 1 }
describe("API y permisos de caja", () => {
  it("registra todos los nombres, esquemas y políticas de acceso", () => {
    expect(Object.keys(CALLABLES_FASE3)).toHaveLength(29)
    expect(Object.keys(FASE3_ACCESS)).toEqual(Object.keys(CALLABLES_FASE3))
    for (const n of Object.keys(CALLABLES_FASE3) as (keyof typeof CALLABLES_FASE3)[]) {
      expect(CALLABLES[n]).toBe(n)
      expect(CALLABLE_SCHEMAS[n]).toBe(CALLABLE_SCHEMAS_FASE3[n])
      expect(FASE3_ACCESS[n].modules).toContain("pos")
      const p = FASE3_ACCESS[n].permission
      if (p !== "bridge" && p !== "public") expect(PERMISSIONS).toContain(p)
    }
  })
  for (const permission of ["caja.ver", "caja.cobrar", "caja.gestionar", "caja.rectificar", "caja.configurar", "impresion.gestionar"] as const) {
    it(`concede ${permission} según la tabla del contrato`, () => {
      for (const role of ROLES) expect(can(role, permission)).toBe(role === "owner" || role === "manager" || (role === "waiter" && ["caja.ver", "caja.cobrar"].includes(permission)))
    })
  }
  it("rechaza precios, autor, estados fiscales y revisiones manipulados", () => {
    const input = { ...scope, partId: "p1", cashSessionId: "c1", method: "cash", amountCents: 100, tenderedCents: 200 }
    expect(RegistrarCobroInputSchema.parse(input).tipCents).toBe(0)
    for (const extra of [{ priceCents: 1 }, { by: "owner" }, { status: "succeeded" }, { expectedRevision: 0 }, { method: "stripe" }, { amountCents: 0.5 }]) expect(RegistrarCobroInputSchema.safeParse({ ...input, ...extra }).success).toBe(false)
    expect(RegistrarCobroInputSchema.safeParse({ ...input, method: "card", tenderedCents: 0, terminalReference: null }).success).toBe(false)
    expect(AjustarCuentaInputSchema.safeParse({ ...scope, lineId: "l1", kind: "void", amountCents: 10, reason: " " }).success).toBe(false)
    expect(EmitirFacturaInputSchema.safeParse({ ...scope, partId: "p1", type: "F2", recipient: null, totalCents: 1 }).success).toBe(false)
  })
  it("pago móvil y puente exigen sus tokens sin permitir elegir importes ni payload", () => {
    const checkout = { slug: "prueba", locationId: "l1", checkoutId: "c1", token: "a".repeat(43), requestId: "req1", acceptDigitalReceipt: true }
    expect(IniciarPagoCuentaInputSchema.parse(checkout).tipCents).toBe(0)
    expect(IniciarPagoCuentaInputSchema.safeParse({ ...checkout, amountCents: 1 }).success).toBe(false)
    expect(IniciarPagoCuentaInputSchema.safeParse({ ...checkout, website: "robot" }).success).toBe(false)
    expect(IniciarPagoCuentaInputSchema.safeParse({ ...checkout, token: "corto" }).success).toBe(false)
    expect(ReclamarImpresionesInputSchema.safeParse({ restaurantId: "r1", locationId: "l1", bridgeId: "p1", token: "a".repeat(43) }).success).toBe(true)
  })
})
