import { safeNextPath } from "@/lib/panel/nav"

/** La entrada elegida en la presentación no concede ningún permiso. */
export function loginDestination(claims: Record<string, unknown>, requested: string | null): string {
  if (claims.logiqd === true) return "/logiqd"
  return restaurantDestination(requested)
}

/** Solo conserva tareas del panel; nunca concede entrada a administración. */
export function restaurantDestination(requested: string | null): string {
  const path = safeNextPath(requested)
  return path === "/logiqd" || path.startsWith("/logiqd/") || path.startsWith("/logiqd?") ? "/panel" : path
}
