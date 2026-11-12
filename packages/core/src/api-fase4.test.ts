import { describe, expect, it } from "vitest"
import {
  AjustarStockInputSchema, CALLABLES, CALLABLES_FASE4, CALLABLE_SCHEMAS, CALLABLE_SCHEMAS_FASE4, CorregirFichajeInputSchema,
  CopiarSemanaCuadranteInputSchema, FASE4_ACCESS, FicharInputSchema, FicharEnPuestoInputSchema, GuardarIngredienteInputSchema,
  GuardarPedidoProveedorInputSchema, GuardarTurnoInputSchema, InformeHorasInputSchema, MODULES, PERMISSIONS, RecibirPedidoProveedorInputSchema,
  RegistrarMermaInputSchema, ROLES, activeModulesFor, can, hasModule, tipHoursForWindow,
  RepartirPropinasInputSchema, HorasParaPropinasOutputSchema, distributeTips, type Permission, type Role,
} from "./index"

const m = { restaurantId: "r1", locationId: "l1", requestId: "req1" }

describe("módulos y permisos de la fase 4", () => {
  it("staff e inventory son módulos; el plan completo los trae y los demás no", () => {
    expect(MODULES).toContain("staff")
    expect(MODULES).toContain("inventory")
    expect(activeModulesFor("completo")).toEqual([...MODULES])
    expect(activeModulesFor("sala")).not.toContain("staff")
    expect(activeModulesFor("reservas")).not.toContain("inventory")
    expect(hasModule({ plan: "sala", moduleOverrides: { staff: true } }, "staff")).toBe(true)
    // Un restaurante migrado con proyección explícita no hereda módulos nuevos.
    expect(hasModule({ entitlementVersion: 1, activeModules: ["reservations", "pos"] }, "inventory")).toBe(false)
  })

  // La tabla de ARQUITECTURA.md, tal cual.
  const TABLA: Array<[Permission[], Role[]]> = [
    [["fichaje.registrar", "cuadrante.ver"], ["owner", "manager", "waiter", "kitchen", "bar"]],
    [["personal.gestionar"], ["owner", "manager"]],
    [["inventario.ver", "inventario.mermar"], ["owner", "manager", "kitchen", "bar"]],
    [["inventario.gestionar", "costes.ver", "escandallos.editar", "compras.gestionar"], ["owner", "manager"]],
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
    expect(can("waiter", "caja.cobrar")).toBe(true)
    expect(can("waiter", "caja.gestionar")).toBe(false)
    expect(can("kitchen", "cocina.preparar")).toBe(true)
    expect(can("manager", "propietarios.gestionar")).toBe(false)
    expect(can("manager", "planes.gestionar")).toBe(false)
  })
})

describe("callables de la fase 4", () => {
  it("están registradas con esquema y política de acceso", () => {
    expect(Object.keys(CALLABLES_FASE4)).toHaveLength(32)
    expect(Object.keys(FASE4_ACCESS).sort()).toEqual(Object.keys(CALLABLES_FASE4).sort())
    for (const n of Object.keys(CALLABLES_FASE4) as (keyof typeof CALLABLES_FASE4)[]) {
      expect(CALLABLES[n]).toBe(n)
      expect(CALLABLE_SCHEMAS[n]).toBe(CALLABLE_SCHEMAS_FASE4[n])
      const a = FASE4_ACCESS[n]
      expect(a.modules.length).toBeGreaterThan(0)
      for (const mod of a.modules) expect(MODULES).toContain(mod)
      if (a.permission !== "per_target") expect(PERMISSIONS).toContain(a.permission)
    }
  })
  it("el descuento al vender no es una callable: lo hace el proceso del servidor", () => {
    expect(Object.keys(CALLABLES_FASE4)).not.toContain("consumirPorLinea")
  })
  it("fichar no admite hora, autor ni estado enviados por el cliente", () => {
    expect(FicharInputSchema.parse({ ...m, action: "in" }).note).toBeNull()
    for (const extra of [{ at: 1 }, { startAt: 1 }, { uid: "otra" }, { by: "x" }, { status: "closed" }, { action: "fuera" }]) {
      expect(FicharInputSchema.safeParse({ ...m, action: "in", ...extra }).success).toBe(false)
    }
    expect(FicharInputSchema.safeParse({ restaurantId: "r1", locationId: "l1", action: "in" }).success).toBe(false)
    expect(FicharEnPuestoInputSchema.safeParse({ ...m, uid: "ana", pin: "1234", action: "out" }).success).toBe(true)
    expect(FicharEnPuestoInputSchema.safeParse({ ...m, uid: "ana", pin: "12", action: "out" }).success).toBe(false)
    expect(FicharEnPuestoInputSchema.safeParse({ ...m, uid: "ana", pin: "1234x", action: "out" }).success).toBe(false)
  })
  it("las correcciones piden revisión, motivo y pausas cerradas", () => {
    const ok = { ...m, entryId: "e1", expectedRevision: 1, startAt: 1000, endAt: 5000, breaks: [{ startAt: 2000, endAt: 3000 }], reason: "Olvidó fichar" }
    expect(CorregirFichajeInputSchema.safeParse(ok).success).toBe(true)
    expect(CorregirFichajeInputSchema.safeParse({ ...ok, reason: " " }).success).toBe(false)
    expect(CorregirFichajeInputSchema.safeParse({ ...ok, expectedRevision: 0 }).success).toBe(false)
    expect(CorregirFichajeInputSchema.safeParse({ ...ok, breaks: [{ startAt: 2000, endAt: null }] }).success).toBe(false)
    expect(CorregirFichajeInputSchema.safeParse({ ...ok, workedMinutes: 10 }).success).toBe(false)
    expect(CorregirFichajeInputSchema.safeParse({ ...ok, breaks: Array.from({ length: 21 }, () => ({ startAt: 2000, endAt: 3000 })) }).success).toBe(false)
  })
  it("el informe y el cuadrante validan periodos y turnos", () => {
    expect(InformeHorasInputSchema.safeParse({ restaurantId: "r1", locationId: "l1", from: "2026-11-01", to: "2026-11-30", uid: null }).success).toBe(true)
    expect(InformeHorasInputSchema.safeParse({ restaurantId: "r1", locationId: "l1", from: "2026-11-30", to: "2026-11-01", uid: null }).success).toBe(false)
    expect(InformeHorasInputSchema.safeParse({ restaurantId: "r1", locationId: "l1", from: "2026-02-30", to: "2026-03-01", uid: null }).success).toBe(false)
    const turno = { uid: "ana", startAt: 0, endAt: 4 * 3_600_000, position: "Sala" }
    expect(GuardarTurnoInputSchema.safeParse({ ...m, shiftId: null, expectedRevision: null, shift: turno }).success).toBe(true)
    expect(GuardarTurnoInputSchema.safeParse({ ...m, shiftId: null, expectedRevision: null, shift: { ...turno, endAt: 0 } }).success).toBe(false)
    expect(GuardarTurnoInputSchema.safeParse({ ...m, shiftId: null, expectedRevision: null, shift: { ...turno, status: "published" } }).success).toBe(false)
    expect(CopiarSemanaCuadranteInputSchema.safeParse({ ...m, fromWeekStart: "2026-11-09", toWeekStart: "2026-11-09" }).success).toBe(false)
  })
  it("las existencias, la merma y los ajustes no admiten decimales ni costes del cliente", () => {
    expect(RegistrarMermaInputSchema.safeParse({ ...m, ingredientId: "harina", quantity: 250, wasteReason: "expired" }).success).toBe(true)
    for (const extra of [{ quantity: 1.5 }, { quantity: 0 }, { valueCents: 10 }, { wasteReason: "robo" }]) {
      expect(RegistrarMermaInputSchema.safeParse({ ...m, ingredientId: "harina", quantity: 250, wasteReason: "expired", ...extra }).success).toBe(false)
    }
    expect(AjustarStockInputSchema.safeParse({ ...m, ingredientId: "h", kind: "adjustment", quantity: -20, reason: "Se cayó" }).success).toBe(true)
    expect(AjustarStockInputSchema.safeParse({ ...m, ingredientId: "h", kind: "adjustment", quantity: 0, reason: "x" }).success).toBe(false)
    expect(AjustarStockInputSchema.safeParse({ ...m, ingredientId: "h", kind: "supplier_return", quantity: -5, reason: "x" }).success).toBe(false)
    expect(AjustarStockInputSchema.safeParse({ ...m, ingredientId: "h", kind: "adjustment", quantity: 5, reason: "" }).success).toBe(false)
    const ing = { name: "Harina", unit: "g", category: null, minQuantity: 1000, targetQuantity: null, active: true }
    expect(GuardarIngredienteInputSchema.safeParse({ ...m, ingredientId: null, expectedRevision: null, ingredient: ing, opening: { quantity: 5000, valueCents: 450 } }).success).toBe(true)
    expect(GuardarIngredienteInputSchema.safeParse({ ...m, ingredientId: "x", expectedRevision: 1, ingredient: ing, opening: { quantity: 5000, valueCents: 450 } }).success).toBe(false)
    expect(GuardarIngredienteInputSchema.safeParse({ ...m, ingredientId: "x", expectedRevision: null, ingredient: ing }).success).toBe(false)
  })
  it("los pedidos y las recepciones no traen precios inventados ni dejan repetir formatos", () => {
    const lineas = [{ supplierItemId: "i1", formats: 2 }, { supplierItemId: "i2", formats: 1 }]
    const base = { ...m, orderId: null, expectedRevision: null, supplierId: "s1", lines: lineas, expectedOn: "2026-11-12" }
    expect(GuardarPedidoProveedorInputSchema.parse(base).notes).toBe("")
    expect(GuardarPedidoProveedorInputSchema.safeParse({ ...base, lines: [lineas[0], lineas[0]] }).success).toBe(false)
    expect(GuardarPedidoProveedorInputSchema.safeParse({ ...base, lines: [{ supplierItemId: "i1", formats: 1, priceCents: 5 }] }).success).toBe(false)
    expect(GuardarPedidoProveedorInputSchema.safeParse({ ...base, lines: [{ supplierItemId: "i1", formats: 1.5 }] }).success).toBe(false)
    expect(GuardarPedidoProveedorInputSchema.safeParse({ ...base, orderId: "p1" }).success).toBe(false)
    const rec = { ...m, supplierId: "s1", purchaseOrderId: "p1", expectedRevision: 2, lines: [{ supplierItemId: "i1", receivedFormats: 3, priceCents: 2500 }] }
    expect(RecibirPedidoProveedorInputSchema.safeParse(rec).success).toBe(true)
    expect(RecibirPedidoProveedorInputSchema.safeParse({ ...rec, expectedRevision: null }).success).toBe(false)
    expect(RecibirPedidoProveedorInputSchema.safeParse({ ...rec, purchaseOrderId: null, expectedRevision: null }).success).toBe(true)
    expect(RecibirPedidoProveedorInputSchema.safeParse({ ...rec, lines: [{ supplierItemId: "i1", receivedFormats: 3, priceCents: 25.5 }] }).success).toBe(false)
  })
})

describe("propinas por horas fichadas (fase 3)", () => {
  it("las horas del fichaje entran tal cual en repartirPropinas y en distributeTips", () => {
    const caja = { startAt: 0, endAt: 600 * 60_000 }
    const ficha = (uid: string, ini: number, fin: number) => ({ uid, date: "2026-11-09", startAt: ini * 60_000, endAt: fin * 60_000, breaks: [], status: "closed" as const, forgotten: false, workedMinutes: fin - ini })
    const { hours, incomplete } = tipHoursForWindow([ficha("bea", 0, 300), ficha("ana", 300, 600), ficha("ana", 0, 0)], caja, { breaksPaid: false })
    expect(incomplete).toEqual([])
    expect(hours).toEqual([{ uid: "ana", minutes: 300 }, { uid: "bea", minutes: 300 }])
    expect(HorasParaPropinasOutputSchema.parse({ hours, incomplete, windowStart: 0, windowEnd: 1 }).hours).toHaveLength(2)
    expect(RepartirPropinasInputSchema.safeParse({ ...m, cashSessionId: "c1", hours }).success).toBe(true)
    expect(distributeTips(1001, hours).map((x) => x.amountCents)).toEqual([501, 500])
  })
})
