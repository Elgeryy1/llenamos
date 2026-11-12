import { describe, expect, it } from "vitest"
import {
  activeModulesFor,
  can,
  hasModule,
  isModule,
  MODULE_LABEL,
  MODULES,
  PERMISSIONS,
  PLAN_LABEL,
  PLAN_MODULES,
  PLANS,
  restaurantModules,
  RestaurantSchema,
  ROLES,
  type Permission,
  type Role,
} from "./index"

describe("módulos y planes", () => {
  it("cada módulo y cada plan tiene nombre en castellano", () => {
    expect(MODULES).toEqual(["reservations", "floor", "kitchen", "pos", "repite", "staff", "inventory", "loyalty", "marketing", "analytics"])
    expect(PLANS).toEqual(["reservas", "sala", "completo"])
    expect(MODULE_LABEL.floor).toBe("Sala y comandero")
    expect(Object.keys(PLAN_LABEL)).toEqual([...PLANS])
  })

  it("los planes traen los módulos del contrato", () => {
    expect(activeModulesFor("reservas")).toEqual(["reservations"])
    expect(activeModulesFor("sala")).toEqual(["reservations", "floor", "kitchen"])
    expect(activeModulesFor("completo")).toEqual([...MODULES])
    expect(PLAN_MODULES.completo).toEqual(MODULES)
  })

  it("las excepciones encienden o apagan un módulo aparte del plan", () => {
    expect(activeModulesFor("reservas", { repite: true })).toEqual(["reservations", "repite"])
    expect(activeModulesFor("sala", { kitchen: false, pos: true })).toEqual(["reservations", "floor", "pos"])
    expect(activeModulesFor("completo", { repite: false })).toEqual(["reservations", "floor", "kitchen", "pos", "staff", "inventory", "loyalty", "marketing", "analytics"])
    // El orden siempre es el de MODULES, sin repetidos.
    expect(activeModulesFor("reservas", { pos: true, floor: true, reservations: true })).toEqual(["reservations", "floor", "pos"])
  })

  it("sin plan, el restaurante se trata como completo", () => {
    expect(restaurantModules({})).toEqual([...MODULES])
    expect(hasModule({}, "repite")).toBe(true)
    expect(hasModule({ plan: null }, "pos")).toBe(true)
  })

  it("con plan manda activeModules, y si falta se calcula", () => {
    expect(hasModule({ plan: "reservas", activeModules: ["reservations"] }, "floor")).toBe(false)
    expect(hasModule({ plan: "reservas", activeModules: ["reservations"] }, "reservations")).toBe(true)
    // activeModules es lo que comprueban las reglas: si dice otra cosa que el plan, gana.
    expect(hasModule({ plan: "reservas", activeModules: ["reservations", "pos"] }, "pos")).toBe(true)
    expect(hasModule({ plan: "sala", moduleOverrides: { floor: false } }, "floor")).toBe(false)
    expect(hasModule({ plan: "sala" }, "kitchen")).toBe(true)
  })

  it("reconoce los nombres de módulo", () => {
    expect(isModule("floor")).toBe(true)
    expect(isModule("sala")).toBe(false)
  })

  it("el restaurante admite los campos nuevos y sigue leyendo los viejos", () => {
    const viejo = { name: "Taberna Lumbre", slug: "demo-lumbre", brandColor: "#f0a35e", currency: "EUR", timezone: "Europe/Madrid", locale: "es", isDemo: true }
    expect(RestaurantSchema.parse(viejo).plan).toBeUndefined()
    const nuevo = RestaurantSchema.parse({ ...viejo, plan: "sala", moduleOverrides: { repite: true }, activeModules: activeModulesFor("sala", { repite: true }) })
    expect(nuevo.activeModules).toEqual(["reservations", "floor", "kitchen", "repite"])
    // hasModule acepta el documento leído tal cual.
    expect(hasModule(nuevo, "repite")).toBe(true)
    expect(hasModule(nuevo, "pos")).toBe(false)
    expect(hasModule(RestaurantSchema.parse(viejo), "pos")).toBe(true)
    expect(RestaurantSchema.safeParse({ ...viejo, plan: "oro" }).success).toBe(false)
    expect(RestaurantSchema.safeParse({ ...viejo, moduleOverrides: { cafe: true } }).success).toBe(false)
    expect(RestaurantSchema.safeParse({ ...viejo, activeModules: ["cafe"] }).success).toBe(false)
  })
})

describe("permisos de la fase 1", () => {
  // La tabla de ARQUITECTURA.md, tal cual.
  const TABLA: Array<[Permission[], Role[]]> = [
    [["reservas.ver", "reservas.gestionar"], ["owner", "manager", "waiter"]],
    [["reservas.configurar"], ["owner", "manager"]],
    [["plano.editar"], ["owner", "manager"]],
    [["clientes.ver", "clientes.editar"], ["owner", "manager", "waiter"]],
    [["mensajes.ver"], ["owner", "manager"]],
    [["reservas.importar"], ["owner", "manager"]],
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
    expect(can("waiter", "sala.ver")).toBe(true)
    expect(can("waiter", "ajustes.gestionar")).toBe(false)
    expect(can("manager", "propietarios.gestionar")).toBe(false)
    expect(can("kitchen", "cocina.ver")).toBe(true)
    expect(can("bar", "barra.ver")).toBe(true)
    expect(ROLES.filter((r) => can(r, "actividad.ver"))).toEqual(["owner", "manager"])
  })

  it("cocina y barra no ven reservas ni clientes", () => {
    for (const rol of ["kitchen", "bar"] as const) {
      for (const p of ["reservas.ver", "clientes.ver", "mensajes.ver", "plano.editar"] as const) expect(can(rol, p)).toBe(false)
    }
  })
})
