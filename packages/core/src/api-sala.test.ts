import { describe, expect, it } from "vitest"
import {
  AbrirMesaInputSchema,
  AvisarDesdeMesaInputSchema,
  CALLABLE_SCHEMAS,
  CALLABLE_SCHEMAS_FASE2,
  CALLABLES,
  CALLABLES_FASE2,
  CambiarEstadoLineasInputSchema,
  CambiarEstadoMesaInputSchema,
  CambiarEstadoTareaOutputSchema,
  can,
  EnviarPedidoInputSchema,
  EnviarPedidoOutputSchema,
  FASE2_ACCESS,
  GuardarPlatoInputSchema,
  MarcharPaseInputSchema,
  PedirDesdeMesaInputSchema,
  PedirDesdeMesaOutputSchema,
  PedirParaLlevarInputSchema,
  PERMISSIONS,
  ROLES,
  type CallableInput,
  type Permission,
  type Role,
} from "./index"

const staff = { restaurantId: "demo-lumbre", locationId: "centro" }
const token = "a".repeat(43)
const errores = (r: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }) =>
  r.success ? [] : (r.error?.issues ?? []).map((i) => `${i.path.join(".")}: ${i.message}`)

describe("callables de la fase 2", () => {
  it("están registradas en CALLABLES y CALLABLE_SCHEMAS, y cada una dice quién y con qué módulo", () => {
    for (const n of Object.keys(CALLABLES_FASE2)) {
      expect(CALLABLES[n as keyof typeof CALLABLES]).toBe(n)
      expect(CALLABLE_SCHEMAS[n as keyof typeof CALLABLE_SCHEMAS]).toBe(CALLABLE_SCHEMAS_FASE2[n as keyof typeof CALLABLE_SCHEMAS_FASE2])
    }
    expect(Object.keys(FASE2_ACCESS).sort()).toEqual(Object.keys(CALLABLES_FASE2).sort())
    for (const { permission } of Object.values(FASE2_ACCESS)) {
      if (permission !== "public" && permission !== "per_line") expect(PERMISSIONS).toContain(permission)
    }
  })

  it("enviar un pedido: a una mesa o a un para llevar, nunca a los dos ni a ninguno", () => {
    const lines = [{ kind: "item" as const, itemId: "bravas", quantity: 1 }]
    const ok: CallableInput<"enviarPedido"> = { ...staff, sessionId: "s1", lines }
    expect(EnviarPedidoInputSchema.parse(ok)).toMatchObject({ takeawayId: null, fire: "auto", note: "", expectedTotalCents: null })
    expect(EnviarPedidoInputSchema.safeParse({ ...staff, lines }).success).toBe(false)
    expect(EnviarPedidoInputSchema.safeParse({ ...staff, sessionId: "s1", takeawayId: "t1", lines }).success).toBe(false)
    // Los precios no se mandan: un campo de más en la línea es un error.
    expect(EnviarPedidoInputSchema.safeParse({ ...ok, lines: [{ ...lines[0], unitPriceCents: 1 }] }).success).toBe(false)
    expect(MarcharPaseInputSchema.parse({ ...staff, sessionId: "s1" }).course).toBeNull()
    expect(MarcharPaseInputSchema.parse({ ...staff, takeawayId: "t1", course: "all" }).course).toBe("all")
  })

  it("abrir mesa: o reserva o datos del cliente; el teléfono se normaliza", () => {
    const a = AbrirMesaInputSchema.parse({ ...staff, tableIds: ["S1"], guests: 2, guest: { name: "Ana", phone: "612 34 56 78" } })
    expect(a.guest?.phone).toBe("+34612345678")
    expect(a.reservationId).toBeNull()
    expect(AbrirMesaInputSchema.safeParse({ ...staff, tableIds: ["S1"], guests: 2, reservationId: "r1", guest: { name: "Ana", phone: "612345678" } }).success).toBe(false)
    expect(AbrirMesaInputSchema.safeParse({ ...staff, tableIds: ["S1", "S1"], guests: 2 }).success).toBe(false)
    expect(AbrirMesaInputSchema.safeParse({ ...staff, tableIds: [], guests: 2 }).success).toBe(false)
    // «merged» no se pide: lo pone juntarMesas.
    expect(CambiarEstadoMesaInputSchema.safeParse({ ...staff, sessionId: "s1", status: "merged" }).success).toBe(false)
    // Aceptar lo pendiente va por decidirPedido.
    expect(CambiarEstadoLineasInputSchema.safeParse({ ...staff, lineIds: ["l1"], status: "pending" }).success).toBe(false)
  })

  it("guardar un plato valida la ficha entera", () => {
    const item = { categoryId: "compartir", name: { es: "Bravas" }, sortOrder: 1, priceCents: 650, course: "first" }
    expect(GuardarPlatoInputSchema.safeParse({ ...staff, itemId: null, item }).success).toBe(true)
    // El servidor pone la versión y el agotado: no se mandan.
    expect(GuardarPlatoInputSchema.safeParse({ ...staff, itemId: null, item: { ...item, version: 3 } }).success).toBe(true)
    expect(GuardarPlatoInputSchema.parse({ ...staff, itemId: null, item: { ...item, version: 3 } }).item).not.toHaveProperty("version")
  })

  it("desde la mesa: con el token de la mesa, el total visto y el campo trampa vacío", () => {
    const base: CallableInput<"pedirDesdeMesa"> = {
      slug: "demo-lumbre",
      locationId: "centro",
      tableId: "S3",
      token,
      sessionId: "s1",
      lines: [{ kind: "item", itemId: "bravas", quantity: 1 }],
      expectedTotalCents: 650,
      language: "ca",
      website: "",
    }
    expect(PedirDesdeMesaInputSchema.safeParse(base).success).toBe(true)
    expect(errores(PedirDesdeMesaInputSchema.safeParse({ ...base, website: "x" }))).toEqual(["website: Solicitud no válida."])
    expect(PedirDesdeMesaInputSchema.safeParse({ ...base, token: "corto" }).success).toBe(false)
    expect(PedirDesdeMesaInputSchema.safeParse({ ...base, lines: [{ kind: "item", itemId: "bravas", quantity: 1, course: "second" }] }).success).toBe(false)
    const { expectedTotalCents: _e, ...sinTotal } = base
    expect(PedirDesdeMesaInputSchema.safeParse(sinTotal).success).toBe(false)
    expect(AvisarDesdeMesaInputSchema.parse({ slug: "demo-lumbre", locationId: "centro", tableId: "S3", token, kind: "call_waiter" }).sessionId).toBeNull()
  })

  it("para llevar desde la web pide aceptar las condiciones", () => {
    const base = {
      slug: "demo-lumbre",
      locationId: "centro",
      date: "2026-11-10",
      time: "21:30",
      guestName: "Ana",
      phone: "612345678",
      email: "",
      language: "es",
      lines: [{ kind: "item", itemId: "bravas", quantity: 1 }],
      expectedTotalCents: 650,
      acceptPolicy: true,
    }
    expect(PedirParaLlevarInputSchema.parse(base)).toMatchObject({ email: null, phone: "+34612345678", notes: "", website: "" })
    expect(PedirParaLlevarInputSchema.safeParse({ ...base, acceptPolicy: false }).success).toBe(false)
  })

  it("las salidas se distinguen por su estado", () => {
    expect(EnviarPedidoOutputSchema.parse({ status: "rejected", problems: [{ line: 0, selection: null, code: "item_sold_out", ref: "tarta" }], totalCents: 0 }).status).toBe("rejected")
    expect(PedirDesdeMesaOutputSchema.safeParse({ status: "pending_approval", orderId: "o1", totalCents: 650 }).success).toBe(true)
    expect(CambiarEstadoTareaOutputSchema.parse({ result: "taken", claimedBy: "lucia", claimedByName: "Lucía Ferrer" }).result).toBe("taken")
  })
})

describe("permisos de la fase 2", () => {
  // La tabla de ARQUITECTURA.md («Fase 2 · Sala y cocina»), tal cual.
  const TABLA: Array<[Permission, Role[]]> = [
    ["carta.editar", ["owner", "manager"]],
    ["carta.agotar", ["owner", "manager", "waiter", "kitchen", "bar"]],
    ["comandas.tomar", ["owner", "manager", "waiter"]],
    ["comandas.anular", ["owner", "manager"]],
    ["sala.gestionar", ["owner", "manager", "waiter"]],
    ["sala.configurar", ["owner", "manager"]],
    ["tareas.atender", ["owner", "manager", "waiter"]],
    ["cocina.ver", ["owner", "manager", "kitchen"]],
    ["cocina.preparar", ["owner", "manager", "kitchen"]],
    ["barra.ver", ["owner", "manager", "bar"]],
    ["barra.preparar", ["owner", "manager", "bar"]],
  ]
  for (const [permiso, roles] of TABLA) {
    it(`${permiso}: ${roles.join(", ")}`, () => {
      for (const rol of ROLES) expect(can(rol, permiso), `${rol} · ${permiso}`).toBe(roles.includes(rol))
    })
  }

  it("cocina y barra siguen sin ver reservas, clientes ni comandas de la sala", () => {
    for (const rol of ["kitchen", "bar"] as const) {
      for (const p of ["reservas.ver", "clientes.ver", "comandas.tomar", "tareas.atender", "sala.gestionar"] as const) expect(can(rol, p)).toBe(false)
    }
    expect(can("kitchen", "barra.preparar")).toBe(false)
    expect(can("bar", "cocina.preparar")).toBe(false)
  })
})
