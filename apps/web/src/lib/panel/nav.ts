/**
 * Navegación del panel. Cada página dice qué permiso y qué módulo hacen falta;
 * quién tiene el permiso lo decide can() de @llenamos/core, la misma tabla que usan
 * funciones y reglas, y los módulos salen de `activeModules` del restaurante
 * (`restaurantModules`). Lo que el plan no incluye no aparece en el menú.
 */
import { activityAvailable } from "@/lib/data/backend"
import { can, MODULES, type Module, type Permission, type Role } from "@llenamos/core"

export type PanelSection =
  | "inicio"
  | "sala"
  | "plano"
  | "horarios"
  | "mensajes"
  | "compartir"
  | "equipo"
  | "actividad"
  | "ajustes"
  // Fase 1 · el día (R3)
  | "reservas"
  | "lista-espera"
  | "clientes"
  | "importar"
  // Fase 2 · sala y cocina
  | "comandero"
  | "comandas"
  | "para-llevar"
  | "cocina"
  | "barra"
  | "disponibilidad"
  | "carta"
  | "configuracion-sala"
  // Fase 3 · caja
  | "caja"
  | "impresoras"
  // Fase 4 · personal, inventario y costes
  | "fichaje"
  | "personal"
  | "inventario"
  | "escandallos"
  | "compras"
  | "fidelizacion"
  | "campanas"
  | "analisis"
  // Fase 6 · plataforma
  | "planes"
  | "integraciones"
  | "privacidad"

/** Grupo de la barra lateral: el trabajo del día y lo que se configura del restaurante. */
export type NavGroup = "servicio" | "restaurante"

export const NAV_GROUP_LABEL: Record<NavGroup, string> = {
  servicio: "Servicio",
  restaurante: "Restaurante",
}

export interface NavItem {
  section: PanelSection
  href: string
  label: string
  group: NavGroup
  /** null = cualquier miembro activo. */
  permission: Permission | null
  /** Módulo que tiene que estar activo; null = siempre (es parte de la base). */
  module: Module | null
  modulesAny?: readonly Module[]
}

export const PANEL_NAV: readonly NavItem[] = [
  { section: "inicio", href: "/panel", label: "Inicio", group: "servicio", permission: null, module: null },
  { section: "reservas", href: "/panel/reservas", label: "Reservas", group: "servicio", permission: "reservas.ver", module: "reservations" },
  { section: "sala", href: "/panel/sala", label: "Sala", group: "servicio", permission: "sala.ver", module: "floor" },
  { section: "lista-espera", href: "/panel/lista-espera", label: "Lista de espera", group: "servicio", permission: "reservas.ver", module: "reservations" },
  { section: "clientes", href: "/panel/clientes", label: "Clientes", group: "servicio", permission: "clientes.ver", module: "reservations" },
  { section: "comandero", href: "/panel/comandero", label: "Comandero", group: "servicio", permission: "comandas.tomar", module: "floor" },
  { section: "comandas", href: "/panel/comandas", label: "Comandas", group: "servicio", permission: "sala.ver", module: "floor" },
  { section: "para-llevar", href: "/panel/para-llevar", label: "Para llevar", group: "servicio", permission: "comandas.tomar", module: "floor" },
  { section: "disponibilidad", href: "/panel/disponibilidad", label: "Disponibilidad", group: "servicio", permission: "carta.agotar", module: "floor" },
  { section: "caja", href: "/panel/caja", label: "Caja", group: "servicio", permission: "caja.ver", module: "pos" },
  // La página comprueba además el módulo floor.
  { section: "cocina", href: "/panel/cocina", label: "Cocina", group: "servicio", permission: "cocina.ver", module: "kitchen" },
  { section: "barra", href: "/panel/barra", label: "Barra", group: "servicio", permission: "barra.ver", module: "kitchen" },
  { section: "fichaje", href: "/panel/fichaje", label: "Fichaje", group: "servicio", permission: "fichaje.registrar", module: "staff" },
  { section: "inventario", href: "/panel/inventario", label: "Inventario", group: "servicio", permission: "inventario.ver", module: "inventory" },
  { section: "fidelizacion", href: "/panel/fidelizacion", label: "Fidelización", group: "restaurante", permission: "fidelizacion.gestionar", module: null, modulesAny: ["loyalty", "repite"] },
  { section: "campanas", href: "/panel/campanas", label: "Campañas", group: "restaurante", permission: "campanas.gestionar", module: "marketing" },
  { section: "analisis", href: "/panel/analisis", label: "Análisis", group: "restaurante", permission: "analisis.ver", module: "analytics" },
  // El plano (zonas y mesas) es parte de la base: lo usan las reservas y la sala.
  { section: "carta", href: "/panel/carta", label: "Carta", group: "restaurante", permission: "carta.editar", module: "floor" },
  { section: "configuracion-sala", href: "/panel/configuracion-sala", label: "Sala y cocina", group: "restaurante", permission: "sala.configurar", module: "floor" },
  { section: "impresoras", href: "/panel/impresoras", label: "Impresoras", group: "restaurante", permission: "impresion.gestionar", module: "pos" },
  { section: "personal", href: "/panel/personal", label: "Personal", group: "restaurante", permission: "personal.gestionar", module: "staff" },
  { section: "escandallos", href: "/panel/escandallos", label: "Escandallos", group: "restaurante", permission: "costes.ver", module: "inventory" },
  { section: "compras", href: "/panel/compras", label: "Compras", group: "restaurante", permission: "compras.gestionar", module: "inventory" },
  { section: "plano", href: "/panel/plano", label: "Plano", group: "restaurante", permission: "plano.editar", module: null },
  { section: "horarios", href: "/panel/horarios", label: "Horarios y reservas", group: "restaurante", permission: "reservas.configurar", module: "reservations" },
  { section: "mensajes", href: "/panel/mensajes", label: "Mensajes", group: "servicio", permission: "mensajes.ver", module: "reservations" },
  { section: "compartir", href: "/panel/compartir", label: "Compartir", group: "restaurante", permission: "reservas.configurar", module: "reservations" },
  { section: "equipo", href: "/panel/equipo", label: "Equipo", group: "restaurante", permission: "equipo.ver", module: null },
  { section: "actividad", href: "/panel/actividad", label: "Actividad", group: "restaurante", permission: "actividad.ver", module: null },
  // Fase 6: la suscripción y las claves de API y webhooks. No dependen de ningún módulo: un acceso vencido las conserva.
  { section: "planes", href: "/panel/planes", label: "Plan y facturación", group: "restaurante", permission: "planes.ver", module: null },
  { section: "integraciones", href: "/panel/integraciones", label: "Integraciones", group: "restaurante", permission: "integraciones.gestionar", module: null },
  { section: "privacidad", href: "/panel/privacidad", label: "Privacidad", group: "restaurante", permission: "privacidad.gestionar", module: null },
  { section: "importar", href: "/panel/importar", label: "Importar reservas", group: "restaurante", permission: "reservas.importar", module: "reservations" },
  { section: "ajustes", href: "/panel/ajustes", label: "Ajustes", group: "restaurante", permission: "ajustes.gestionar", module: null },
]

export function canSee(role: Role | null | undefined, item: Pick<NavItem, "permission">): boolean {
  if (!role) return false
  return item.permission === null || can(role, item.permission)
}

/** ¿Está el módulo de la página entre los activos del restaurante? */
export function moduleOn(item: Pick<NavItem, "module" | "modulesAny">, modules: readonly Module[]): boolean {
  return (item.module === null || modules.includes(item.module)) && (!item.modulesAny || item.modulesAny.some((module) => modules.includes(module)))
}

/**
 * Entradas del menú para un rol y los módulos activos del restaurante
 * (`restaurantModules(restaurant)`). Sin módulos se supone todo activo, como un
 * restaurante sin plan (se trata como `completo`).
 */
export function navForRole(role: Role | null | undefined, modules: readonly Module[] = MODULES): NavItem[] {
  return PANEL_NAV.filter((item) => canSee(role, item) && moduleOn(item, modules) && (item.section !== "actividad" || activityAvailable())).map((item) => item.section === "fidelizacion" && !modules.includes("loyalty") && modules.includes("repite") ? { ...item, href: "/panel/fidelizacion/repite" } : item)
}

/** La entrada del menú de una sección (para que cada página sepa su permiso y su módulo). */
export function navItem(section: PanelSection): NavItem {
  const item = PANEL_NAV.find((i) => i.section === section)
  if (!item) throw new Error(`Sección del panel desconocida: ${section}`)
  return item
}

/** La entrada del menú que corresponde a una ruta (para el título de la cabecera). */
export function navItemFor(pathname: string): NavItem | null {
  return PANEL_NAV.find((item) => isNavActive(pathname, item.href)) ?? null
}

/** ¿Está activo el enlace? Inicio solo en /panel exacto; el resto también en sus subpáginas. */
export function isNavActive(pathname: string, href: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/"
  if (href === "/panel") return path === "/panel"
  return path === href || path.startsWith(`${href}/`)
}

/** Solo se vuelve a páginas del panel (o a /logiqd) después de entrar (nada de redirigir a otra web). */
export function safeNextPath(value: string | null | undefined): string {
  if (!value) return "/panel"
  const inside = (base: string) => value === base || value.startsWith(`${base}/`) || value.startsWith(`${base}?`)
  if (!inside("/panel") && !inside("/logiqd")) return "/panel"
  if (value.startsWith("//") || value.includes("\\")) return "/panel"
  return value
}
