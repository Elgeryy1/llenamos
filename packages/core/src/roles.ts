/**
 * Roles y permisos.
 *
 * Los permisos se comprueban en tres sitios: la interfaz oculta lo que no toca,
 * las funciones del servidor lo vuelven a comprobar y las reglas de Firestore lo
 * comprueban otra vez. Esta tabla es la fuente de verdad de los dos primeros;
 * las reglas (firebase/firestore.rules) deben decir lo mismo y hay pruebas que lo vigilan.
 */

export const ROLES = ["owner", "manager", "waiter", "kitchen", "bar"] as const
export type Role = (typeof ROLES)[number]

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Propietario",
  manager: "Encargado",
  waiter: "Camarero",
  kitchen: "Cocina",
  bar: "Barra",
}

export const PERMISSIONS = [
  "sala.ver",
  "reservas.ver",
  "reservas.gestionar",
  "reservas.configurar",
  "reservas.importar",
  "plano.editar",
  "clientes.ver",
  "clientes.editar",
  "mensajes.ver",
  "cocina.ver",
  "barra.ver",
  "carta.editar",
  "carta.agotar",
  "comandas.tomar",
  "comandas.anular",
  "sala.gestionar",
  "sala.configurar",
  "tareas.atender",
  "cocina.preparar",
  "barra.preparar",
  "caja.ver",
  "caja.cobrar",
  "caja.gestionar",
  "caja.rectificar",
  "caja.configurar",
  "impresion.gestionar",
  "equipo.ver",
  "equipo.gestionar",
  "propietarios.gestionar",
  "ajustes.gestionar",
  "actividad.ver",
  "planes.ver",
  "planes.gestionar",
  "integraciones.gestionar",
  "privacidad.gestionar",
  "fichaje.registrar",
  "cuadrante.ver",
  "personal.gestionar",
  "inventario.ver",
  "inventario.mermar",
  "inventario.gestionar",
  "costes.ver",
  "escandallos.editar",
  "compras.gestionar",
  "fidelizacion.ver",
  "fidelizacion.operar",
  "fidelizacion.gestionar",
  "promociones.aplicar",
  "promociones.gestionar",
  "campanas.gestionar",
  "campanas.lanzar",
  "analisis.ver",
  "analisis.configurar",
] as const
export type Permission = (typeof PERMISSIONS)[number]

/**
 * Qué deja hacer cada permiso de reservas (fase 1):
 * - reservas.ver / reservas.gestionar: ver el día y crear, mover, sentar o cancelar reservas.
 * - reservas.configurar: horarios, turnos y políticas (`guardarConfiguracionReservas`).
 * - reservas.importar: importar reservas desde una hoja de cálculo.
 * - plano.editar: mesas y zonas del plano.
 * - clientes.ver / clientes.editar: fichas de cliente; editar solo notas, alergias y etiquetas.
 * - mensajes.ver: bandeja de mensajes enviados, capturados o fallidos.
 *
 * Sala y cocina (fase 2):
 * - carta.editar: categorías, platos, precios, fotos y menús del día.
 * - carta.agotar: marcar un plato o un extra como agotado (también la cocina y la barra).
 * - comandas.tomar: tomar nota, enviar, aceptar lo pedido desde la mesa, marchar pases, servir
 *   y anular lo que aún no ha llegado a cocina. También los pedidos para llevar.
 * - comandas.anular: anular lo que ya está en cocina o servido, con motivo.
 * - sala.gestionar: abrir, mover, juntar, separar y cerrar mesas.
 * - sala.configurar: ajustes de sala y cocina (QR, pases, tiempos, para llevar), estaciones y
 *   códigos QR de las mesas.
 * - tareas.atender: ver las tareas de sala, cogerlas («voy yo»), soltarlas y hacerlas.
 * - cocina.preparar / barra.preparar: empezar, terminar y deshacer en una estación de cocina o
 *   de barra (según `station.kind`).
 * - cocina.ver / barra.ver: ver las pantallas de cocina o de barra.
 *
 * Caja (fase 3): caja.ver y caja.cobrar también para camareros. Solo owner/manager
 * gestionan aperturas, arqueos y propinas (caja.gestionar), correcciones y devoluciones
 * (caja.rectificar), configuración fiscal (caja.configurar) y puentes/impresoras
 * (impresion.gestionar). Todos requieren los módulos y el acceso al local del contrato.
 *
 * Personal e inventario (fase 4): todos fichan y ven su cuadrante publicado (fichaje.registrar,
 * cuadrante.ver). Solo owner/manager gestionan personal (personal.gestionar: cuadrante, horas del
 * equipo, correcciones, fichajes olvidados, puesto de fichaje y PIN), costes y escandallos
 * (costes.ver, escandallos.editar), existencias (inventario.gestionar: ingredientes, ajustes,
 * recuentos) y compras (compras.gestionar). Cocina y barra ven existencias y avisos
 * (inventario.ver) y registran merma con motivo (inventario.mermar), sin ver costes. Todos
 * requieren su módulo (`staff` o `inventory`) y el acceso al local.
 *
 * Plataforma (fase 6): owner/manager ven planes y gestionan integraciones/privacidad;
 * contratar o cancelar exige owner. El claim logiqd no es un permiso de esta matriz.
 *
 * Clientes, marketing y análisis (fase 5): el camarero ve los puntos y la tarjeta Repite de un
 * cliente (fidelizacion.ver), lo da de alta, canjea premios y da un sello a mano
 * (fidelizacion.operar) y aplica promociones a una cuenta (promociones.aplicar); el servidor
 * valida siempre condiciones, cupos y saldo. Solo owner/manager configuran el programa, ajustan
 * puntos y ven informes de Repite (fidelizacion.gestionar), crean promociones
 * (promociones.gestionar), segmentos y campañas (campanas.gestionar), ven el panel de análisis
 * (analisis.ver) y configuran resumen diario, previsión y automatizaciones (analisis.configurar).
 * Lanzar una campaña (campanas.lanzar) envía mensajes que cuestan dinero: solo owner.
 * Cocina y barra no reciben ninguno.
 */

const MATRIX: Record<Role, readonly Permission[]> = {
  owner: PERMISSIONS,
  manager: PERMISSIONS.filter((p) => p !== "propietarios.gestionar" && p !== "planes.gestionar" && p !== "campanas.lanzar"),
  waiter: [
    "sala.ver",
    "reservas.ver",
    "reservas.gestionar",
    "clientes.ver",
    "clientes.editar",
    "carta.agotar",
    "comandas.tomar",
    "sala.gestionar",
    "tareas.atender",
    "caja.ver",
    "caja.cobrar",
    "fichaje.registrar",
    "cuadrante.ver",
    "fidelizacion.ver",
    "fidelizacion.operar",
    "promociones.aplicar",
  ],
  kitchen: [
    "cocina.ver", "cocina.preparar", "carta.agotar",
    "fichaje.registrar", "cuadrante.ver", "inventario.ver", "inventario.mermar",
  ],
  bar: [
    "barra.ver", "barra.preparar", "carta.agotar",
    "fichaje.registrar", "cuadrante.ver", "inventario.ver", "inventario.mermar",
  ],
}

export function can(role: Role | null | undefined, permission: Permission): boolean {
  if (!role) return false
  return MATRIX[role].includes(permission)
}

/** Roles que un rol puede dar a otra persona. Nadie se da más poder del que tiene. */
export function assignableRoles(by: Role): Role[] {
  if (by === "owner") return [...ROLES]
  if (by === "manager") return ["manager", "waiter", "kitchen", "bar"]
  return []
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value)
}
