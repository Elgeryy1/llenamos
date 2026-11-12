export type Scope = { restaurantId: string; locationId: string }
export type ConId<T> = T & { id: string }
export type Lectura<T> =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; data: T[]; fresh: boolean }
export function ruta(s: Scope) {
  return `restaurants/${s.restaurantId}/locations/${s.locationId}`
}
