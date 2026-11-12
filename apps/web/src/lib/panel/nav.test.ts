import { activeModulesFor, restaurantModules } from "@llenamos/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { isNavActive, navForRole, navItem, PANEL_NAV, safeNextPath } from "./nav"

const sections = (role: Parameters<typeof navForRole>[0], modules?: Parameters<typeof navForRole>[1]) =>
  navForRole(role, modules).map((i) => i.section)

const TODO = [
  "inicio",
  "reservas",
  "sala",
  "lista-espera",
  "clientes",
  "comandero",
  "comandas",
  "para-llevar",
  "disponibilidad",
  "caja",
  "cocina",
  "barra",
  "fichaje",
  "inventario",
  "fidelizacion",
  "campanas",
  "analisis",
  "carta",
  "configuracion-sala",
  "impresoras",
  "personal",
  "escandallos",
  "compras",
  "plano",
  "horarios",
  "mensajes",
  "compartir",
  "equipo",
  "actividad",
  "planes",
  "integraciones",
  "privacidad",
  "importar",
  "ajustes",
]
// Personal e inventario (fase 4) van con sus módulos staff e inventory.
const FASE4 = ["fichaje", "inventario", "personal", "escandallos", "compras"]
// El plan reservas no trae nada de sala ni de cocina.
const SALA_Y_COCINA = ["sala", "comandero", "comandas", "para-llevar", "disponibilidad", "cocina", "barra", "carta", "configuracion-sala"]
const SOLO_RESERVAS = TODO.filter((s) => !SALA_Y_COCINA.includes(s) && !["caja", "impresoras", "fidelizacion", "campanas", "analisis", ...FASE4].includes(s))
const DIA_CAMARERO = ["inicio", "reservas", "sala", "lista-espera", "clientes", "comandero", "comandas", "para-llevar", "disponibilidad", "caja", "fichaje"]

describe("navForRole", () => {
  it("owner y manager ven todo", () => {
    expect(sections("owner")).toEqual(TODO)
    expect(sections("manager")).toEqual(TODO)
  })

  it("el camarero ve el día (reservas, sala, lista de espera y clientes) pero no importa", () => {
    expect(sections("waiter")).toEqual(DIA_CAMARERO)
  })

  it("cocina y barra ven el inicio, la disponibilidad, su pantalla, el fichaje y las existencias", () => {
    expect(sections("kitchen")).toEqual(["inicio", "disponibilidad", "cocina", "fichaje", "inventario"])
    expect(sections("bar")).toEqual(["inicio", "disponibilidad", "barra", "fichaje", "inventario"])
  })

  it("el plan y las integraciones no dependen de los módulos: un acceso vencido las conserva", () => {
    expect(sections("owner", [])).toEqual(["inicio", "plano", "equipo", "actividad", "planes", "integraciones", "privacidad", "ajustes"])
    expect(sections("waiter")).not.toContain("planes")
    expect(sections("kitchen")).not.toContain("integraciones")
  })

  it("sin rol no hay navegación", () => {
    expect(navForRole(null)).toEqual([])
  })
})

describe("menú por módulos", () => {
  it("la fase 5 exige gestión y sus módulos, también cuando solo está Repite", () => {
    for (const role of ["owner", "manager"] as const) {
      expect(sections(role, activeModulesFor("completo"))).toEqual(expect.arrayContaining(["fidelizacion", "campanas", "analisis"]))
      expect(sections(role, activeModulesFor("sala"))).not.toEqual(expect.arrayContaining(["fidelizacion"]))
      for (const section of ["fidelizacion", "campanas", "analisis"]) expect(sections(role, activeModulesFor("sala"))).not.toContain(section)
    }
    expect(sections("owner", ["repite"])).toContain("fidelizacion")
    expect(navForRole("owner", ["repite"]).find((item) => item.section === "fidelizacion")?.href).toBe("/panel/fidelizacion/repite")
    for (const role of ["waiter", "kitchen", "bar"] as const) for (const section of ["fidelizacion", "campanas", "analisis"]) expect(sections(role)).not.toContain(section)
    expect(navItem("campanas")).toMatchObject({ permission: "campanas.gestionar", module: "marketing" })
    expect(navItem("analisis")).toMatchObject({ permission: "analisis.ver", module: "analytics" })
  })
  it("sin el módulo de reservas desaparecen el día, horarios, mensajes, compartir e importar", () => {
    const sinReservas = activeModulesFor("sala", { reservations: false })
    expect(sections("owner", sinReservas)).toEqual(["inicio", ...SALA_Y_COCINA, "plano", "equipo", "actividad", "planes", "integraciones", "privacidad", "ajustes"])
  })

  it("el plan reservas no muestra ninguna entrada de sala o cocina", () => {
    expect(sections("manager", activeModulesFor("reservas"))).toEqual(SOLO_RESERVAS)
  })

  it("un restaurante sin plan se trata como completo", () => {
    expect(sections("owner", restaurantModules({}))).toEqual(TODO)
  })

  it("el módulo no da permisos: el camarero sigue sin ver la configuración", () => {
    expect(sections("waiter", activeModulesFor("completo"))).toEqual(DIA_CAMARERO)
    expect(sections("waiter", activeModulesFor("sala", { reservations: false }))).toEqual(["inicio", "sala", "comandero", "comandas", "para-llevar", "disponibilidad"])
  })

  it("cada página de configuración pide su permiso y su módulo", () => {
    expect(navItem("impresoras")).toMatchObject({ permission: "impresion.gestionar", module: "pos" })
    expect(navItem("caja")).toMatchObject({ permission: "caja.ver", module: "pos" })
    expect(navItem("sala")).toMatchObject({ permission: "sala.ver", module: "floor" })
    expect(navItem("disponibilidad")).toMatchObject({ permission: "carta.agotar", module: "floor" })
    expect(navItem("plano")).toMatchObject({ permission: "plano.editar", module: null })
    expect(navItem("horarios")).toMatchObject({ permission: "reservas.configurar", module: "reservations" })
    expect(navItem("mensajes")).toMatchObject({ permission: "mensajes.ver", module: "reservations" })
    expect(navItem("compartir")).toMatchObject({ permission: "reservas.configurar", module: "reservations" })
    expect(navItem("reservas")).toMatchObject({ permission: "reservas.ver", module: "reservations" })
    expect(navItem("lista-espera")).toMatchObject({ permission: "reservas.ver", module: "reservations" })
    expect(navItem("clientes")).toMatchObject({ permission: "clientes.ver", module: "reservations" })
    expect(navItem("planes")).toMatchObject({ permission: "planes.ver", module: null, href: "/panel/planes" })
    expect(navItem("integraciones")).toMatchObject({ permission: "integraciones.gestionar", module: null, href: "/panel/integraciones" })
    expect(navItem("privacidad")).toMatchObject({ permission: "privacidad.gestionar", module: null, href: "/panel/privacidad" })
    expect(navItem("importar")).toMatchObject({ permission: "reservas.importar", module: "reservations" })
    expect(navItem("fichaje")).toMatchObject({ permission: "fichaje.registrar", module: "staff" })
    expect(navItem("personal")).toMatchObject({ permission: "personal.gestionar", module: "staff" })
    expect(navItem("inventario")).toMatchObject({ permission: "inventario.ver", module: "inventory" })
    expect(navItem("escandallos")).toMatchObject({ permission: "costes.ver", module: "inventory" })
    expect(navItem("compras")).toMatchObject({ permission: "compras.gestionar", module: "inventory" })
    expect(new Set(PANEL_NAV.map((i) => i.href)).size).toBe(PANEL_NAV.length)
  })
})

describe("isNavActive", () => {
  it("inicio solo está activo en /panel", () => {
    expect(isNavActive("/panel", "/panel")).toBe(true)
    expect(isNavActive("/panel/", "/panel")).toBe(true)
    expect(isNavActive("/panel/sala", "/panel")).toBe(false)
  })

  it("las secciones también se activan en sus subpáginas", () => {
    expect(isNavActive("/panel/equipo", "/panel/equipo")).toBe(true)
    expect(isNavActive("/panel/equipo/abc", "/panel/equipo")).toBe(true)
    expect(isNavActive("/panel/equipos", "/panel/equipo")).toBe(false)
  })
})

describe("safeNextPath", () => {
  it("solo vuelve a páginas del panel", () => {
    expect(safeNextPath("/panel/sala")).toBe("/panel/sala")
    expect(safeNextPath(null)).toBe("/panel")
    expect(safeNextPath("https://malo.example")).toBe("/panel")
    expect(safeNextPath("//malo.example/panel")).toBe("/panel")
    expect(safeNextPath("/entrar")).toBe("/panel")
    expect(safeNextPath("/logiqd")).toBe("/logiqd")
    expect(safeNextPath("/logiqdx")).toBe("/panel")
    expect(safeNextPath("/panel?x=1")).toBe("/panel?x=1")
    expect(safeNextPath("/panel\\..\\x")).toBe("/panel")
  })
})

describe("registro de actividad en el VPS", () => {
  afterEach(() => vi.unstubAllEnvs())
  it("el menú no ofrece Actividad cuando no hay registro común en SQL, y sí en la demo", () => {
    expect(sections("owner")).toContain("actividad")
    vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "postgres")
    expect(sections("owner")).not.toContain("actividad")
    expect(sections("manager")).not.toContain("actividad")
  })
})
