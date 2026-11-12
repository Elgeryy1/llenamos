import { describe, expect, it } from "vitest"
import {
  AjustarCuentaInputSchema, AplicarPromocionInputSchema, BillAdjustmentSchema, CALLABLES, CALLABLES_FASE5, CALLABLE_SCHEMAS, CALLABLE_SCHEMAS_FASE5,
  CanjearPuntosInputSchema, DarseDeBajaInputSchema, DarSelloRepiteInputSchema, ExportarAnalisisInputSchema, FASE5_ACCESS, LanzarCampanaInputSchema,
  MESSAGE_TEMPLATES, MODULES, MODULE_LABEL, MessageRequestSchema, PanelAnalisisInputSchema, PERMISSIONS, PHASE5_PLAN_PROPOSAL, ROLES,
  activeModulesFor, can, hasModule, netBillLines, provisionalPlanCatalog, renderMessage, type Permission, type Role,
} from "./index"

const rm = { restaurantId: "r1", requestId: "req1" }
const m = { ...rm, locationId: "l1" }

describe("módulos de la fase 5", () => {
  it("loyalty, marketing y analytics son módulos con nombre; el plan completo los trae y los demás no", () => {
    for (const mod of ["loyalty", "marketing", "analytics"] as const) {
      expect(MODULES).toContain(mod)
      expect(MODULE_LABEL[mod]).toMatch(/^[A-ZÁÉÍÓÚ][a-záéíóúñ ]+/)
      expect(activeModulesFor("completo")).toContain(mod)
      expect(activeModulesFor("sala")).not.toContain(mod)
      expect(activeModulesFor("reservas")).not.toContain(mod)
    }
    // Un restaurante migrado con proyección explícita no hereda módulos nuevos.
    expect(hasModule({ entitlementVersion: 1, activeModules: ["reservations", "pos"] }, "analytics")).toBe(false)
    expect(hasModule({ plan: "reservas", moduleOverrides: { analytics: true } }, "analytics")).toBe(true)
  })
  it("la propuesta de planes es provisional, deja Repite aparte y no toca el catálogo de la fase 6", () => {
    expect(PHASE5_PLAN_PROPOSAL.provisional).toBe(true)
    for (const plan of ["barra", "sala", "grupo"] as const) expect(PHASE5_PLAN_PROPOSAL[plan]).not.toContain("repite")
    expect(PHASE5_PLAN_PROPOSAL.aparte).toEqual(["repite"])
    for (const p of provisionalPlanCatalog()) for (const mod of ["loyalty", "marketing", "analytics", "repite"] as const) expect(p.modules).not.toContain(mod)
  })
})

describe("permisos de la fase 5", () => {
  // La tabla de ARQUITECTURA.md, tal cual.
  const TABLA: Array<[Permission[], Role[]]> = [
    [["fidelizacion.ver", "fidelizacion.operar", "promociones.aplicar"], ["owner", "manager", "waiter"]],
    [["fidelizacion.gestionar", "promociones.gestionar", "campanas.gestionar", "analisis.ver", "analisis.configurar"], ["owner", "manager"]],
    [["campanas.lanzar"], ["owner"]],
  ]
  for (const [permisos, roles] of TABLA) {
    for (const permiso of permisos) {
      it(`${permiso}: ${roles.join(", ")}`, () => {
        expect(PERMISSIONS).toContain(permiso)
        for (const rol of ROLES) expect(can(rol, permiso), `${rol} · ${permiso}`).toBe(roles.includes(rol))
      })
    }
  }
  it("los permisos de antes no cambian", () => {
    expect(can("manager", "planes.gestionar")).toBe(false)
    expect(can("manager", "propietarios.gestionar")).toBe(false)
    expect(can("manager", "costes.ver")).toBe(true)
    expect(can("waiter", "caja.cobrar")).toBe(true)
    expect(can("kitchen", "inventario.mermar")).toBe(true)
    expect(can("waiter", "clientes.ver")).toBe(true)
  })
})

describe("callables de la fase 5", () => {
  it("están registradas con esquema y política de acceso", () => {
    expect(Object.keys(CALLABLES_FASE5)).toHaveLength(39)
    expect(Object.keys(FASE5_ACCESS).sort()).toEqual(Object.keys(CALLABLES_FASE5).sort())
    for (const n of Object.keys(CALLABLES_FASE5) as (keyof typeof CALLABLES_FASE5)[]) {
      expect(CALLABLES[n]).toBe(n)
      expect(CALLABLE_SCHEMAS[n]).toBe(CALLABLE_SCHEMAS_FASE5[n])
      const a = FASE5_ACCESS[n]
      for (const mod of a.modules) expect(MODULES).toContain(mod)
      if (a.permission !== "logiqd" && a.permission !== "public") expect(PERMISSIONS).toContain(a.permission)
      if (a.permission !== "logiqd" && a.permission !== "public") expect(a.modules.length).toBeGreaterThan(0)
    }
  })
  it("darse de baja es pública y no depende del módulo; vincular Repite es de LogiQD", () => {
    expect(FASE5_ACCESS.darseDeBaja).toEqual({ permission: "public", modules: [] })
    expect(FASE5_ACCESS.vincularRepite.permission).toBe("logiqd")
    expect(FASE5_ACCESS.lanzarCampana.permission).toBe("campanas.lanzar")
    expect(FASE5_ACCESS.canjearPuntos.modules).toEqual(["loyalty", "pos"])
  })
  it("los procesos no son callables", () => {
    for (const p of ["acumularPuntos", "caducarPuntos", "procesarCampanas", "procesarRepite", "agregarDiaAnalisis", "enviarResumenDiario", "evaluarAutomatizaciones"]) {
      expect(Object.keys(CALLABLES_FASE5)).not.toContain(p)
    }
  })
  it("ninguna entrada admite importes, saldos, autor ni estados", () => {
    const canje = { ...m, customerId: "0123456789abcdef0123", rewardId: "p1", billId: "b1", expectedBillRevision: 3 }
    expect(CanjearPuntosInputSchema.safeParse(canje).success).toBe(true)
    for (const extra of [{ discountCents: 500 }, { points: 10 }, { by: "x" }, { balance: 9 }]) expect(CanjearPuntosInputSchema.safeParse({ ...canje, ...extra }).success).toBe(false)
    const aplicar = { ...m, billId: "b1", expectedBillRevision: 1, promotionId: "p1", code: "otono" }
    expect(AplicarPromocionInputSchema.parse(aplicar).code).toBe("OTONO")
    expect(AplicarPromocionInputSchema.safeParse({ ...aplicar, discountCents: 100 }).success).toBe(false)
    expect(LanzarCampanaInputSchema.safeParse({ ...rm, campaignId: "c1", expectedRevision: 1, at: null, recipients: ["+34600000000"] }).success).toBe(false)
  })
  it("periodos acotados y sello manual con visita", () => {
    expect(PanelAnalisisInputSchema.safeParse({ restaurantId: "r1", from: "2026-01-01", to: "2026-12-31", locationIds: null }).success).toBe(true)
    expect(PanelAnalisisInputSchema.safeParse({ restaurantId: "r1", from: "2026-01-01", to: "2027-01-02", locationIds: null }).success).toBe(false)
    expect(PanelAnalisisInputSchema.safeParse({ restaurantId: "r1", from: "2026-02-01", to: "2026-01-01", locationIds: null }).success).toBe(false)
    expect(ExportarAnalisisInputSchema.safeParse({ restaurantId: "r1", from: "2026-01-01", to: "2026-04-02", locationIds: null, kind: "dishes" }).success).toBe(true)
    expect(ExportarAnalisisInputSchema.safeParse({ restaurantId: "r1", from: "2026-01-01", to: "2026-04-03", locationIds: null, kind: "dishes" }).success).toBe(false)
    expect(DarSelloRepiteInputSchema.safeParse({ ...m, customerId: "0123456789abcdef0123", reservationId: null, sessionId: null }).success).toBe(false)
    expect(DarseDeBajaInputSchema.safeParse({ slug: "lumbre", token: "x".repeat(43), website: "robot" }).success).toBe(false)
  })
})

describe("ampliaciones aditivas de fases anteriores", () => {
  it("la caja admite descuentos del servidor sin abrirlos al ajuste manual", () => {
    const adj = { id: "promo.p1.l1", lineId: "l1", kind: "discount", amountCents: 300, reason: "Promoción", at: 1, by: "u1", promotionId: "p1" }
    expect(BillAdjustmentSchema.safeParse(adj).success).toBe(true)
    const manual = { restaurantId: "r1", locationId: "l1", requestId: "q", billId: "b", expectedRevision: 1, lineId: "l1", kind: "invitation", amountCents: 1, reason: "x" }
    expect(AjustarCuentaInputSchema.safeParse(manual).success).toBe(true)
    expect(AjustarCuentaInputSchema.safeParse({ ...manual, kind: "discount" }).success).toBe(false)
    const lines = netBillLines([{ lineId: "l1", parentLineId: null, name: "Paella", quantity: 1, grossCents: 1000, taxRate: 10, guest: null }], [BillAdjustmentSchema.parse(adj)])
    expect(lines[0]?.grossCents).toBe(700)
  })
  it("mensajes de campaña con propósito y plantillas nuevas que llevan la baja", () => {
    expect(MESSAGE_TEMPLATES).toContain("marketing_campaign")
    expect(MESSAGE_TEMPLATES).toContain("daily_summary")
    const req = MessageRequestSchema.parse({ channel: "email", to: "ana@correo.test", template: "marketing_campaign", language: "es", data: {}, reservationId: null, waitlistId: null, sendAt: 1, purpose: "marketing_email", customerId: "c1", campaignId: "k1" })
    expect(req.purpose).toBe("marketing_email")
    const r = renderMessage({ template: "marketing_campaign", language: "es", channel: "whatsapp", data: { title: "Noche de vermú", body: "Este jueves", guestName: "Ana", unsubscribeUrl: "https://x.test/baja" } })
    expect(r.body).toContain("Noche de vermú")
    expect(r.body).toContain("date de baja aquí: https://x.test/baja")
    expect(r.subject).toBeNull()
    const d = renderMessage({ template: "daily_summary", language: "ca", channel: "email", data: { restaurantName: "Lumbre", summaryText: "Vendes: 10 €" } })
    expect(d.subject).toBe("Resum del dia · Lumbre")
    expect(d.body).toContain("Vendes: 10 €")
  })
})
