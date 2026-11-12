import type { PoolClient } from 'pg'

/**
 * Gancho de cambios de estado de las líneas de pedido. Sala lo llama al guardar, dentro de la **misma transacción**, con
 * los ids de las líneas nuevas o cuyo estado cambió (ya escritas). Lo usa inventario para descontar y devolver stock.
 * Un fallo del gancho no debe impedir el pedido: quien lo registra se protege (SAVEPOINT) y lo recoge su reconciliación.
 */
/** Lo que sala ya cargó del restaurante (en un pedido público no se puede releer). */
export interface HookRestaurant { plan: unknown; activeModules: unknown; moduleOverrides: unknown; entitlementVersion: number | null; accessValidUntil: number | null; timezone: string }
export type LineStateHook = (client: PoolClient, scope: { restaurantId: string; locationId: string }, lineIds: readonly string[], now: number, restaurant: HookRestaurant) => Promise<void>

const hooks: LineStateHook[] = []
export function registerLineStateHook(hook: LineStateHook): void { if (!hooks.includes(hook)) hooks.push(hook) }
export async function runLineStateHooks(client: PoolClient, scope: { restaurantId: string; locationId: string }, lineIds: readonly string[], now: number, restaurant: HookRestaurant): Promise<void> {
  if (!lineIds.length) return
  for (const hook of hooks) await hook(client, scope, lineIds, now, restaurant)
}
