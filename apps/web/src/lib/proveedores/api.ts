import type { CallableOutput, RestaurantIntegrationsInput } from "@llenamos/core"
import { llamarCore } from "@/lib/data/callables"
import type { Proveedor } from "./campos"

export type EstadoProveedores = CallableOutput<"verProveedoresRestaurante">

/** Estado de cada proveedor y qué campos hay guardados; nunca los valores. Solo el propietario. */
export function verProveedores(restaurantId: string): Promise<EstadoProveedores> {
  return llamarCore("verProveedoresRestaurante", { restaurantId })
}

/** Guarda lo escrito (campos vacíos conservan lo guardado) quita los proveedores indicados y vacía los campos opcionales indicados. */
export function guardarProveedores(
  restaurantId: string,
  integrations: RestaurantIntegrationsInput,
  remove: Proveedor[] = [],
  clear: Array<{ provider: Proveedor; field: string }> = [],
): Promise<EstadoProveedores> {
  return llamarCore("guardarProveedoresRestaurante", { restaurantId, integrations, remove, clear })
}
