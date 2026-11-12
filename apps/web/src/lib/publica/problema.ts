/** ¿Se puede reservar en este restaurante desde la web? Si no, por qué. */
import type { PublicRestaurant } from "@llenamos/core"
import type { PublicRestaurantResult } from "./restaurante"

export type Problema =
  | { kind: "not_found" }
  | { kind: "unavailable" }
  | { kind: "invalid"; problems: string[] }
  | { kind: "disabled"; restaurant: PublicRestaurant }

/** ¿Se puede reservar? Si no, por qué. */
export function problemaDe(result: PublicRestaurantResult): Problema | null {
  if (result.status === "not_found") return { kind: "not_found" }
  if (result.status === "unavailable") return { kind: "unavailable" }
  if (result.status === "invalid") return { kind: "invalid", problems: result.problems }
  const r = result.restaurant
  if (!r.bookingEnabled || r.locations.length === 0) return { kind: "disabled", restaurant: r }
  return null
}
