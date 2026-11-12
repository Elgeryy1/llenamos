"use client"

import type { Role } from "@llenamos/core"
import type { User } from "firebase/auth"
import { createContext, use } from "react"
import type { LocationDoc, MemberDoc, RestaurantDoc, UserRestaurant } from "@/lib/data/parse"

/** Lo que cualquier página del panel sabe de quién está dentro y dónde. */
export interface PanelContextValue {
  user: User
  /** Restaurantes de la persona (de users/{uid}.restaurants). */
  restaurants: UserRestaurant[]
  restaurant: RestaurantDoc
  /** Su ficha en restaurants/{rid}/members/{uid}: de aquí sale el rol que manda. */
  member: MemberDoc
  role: Role
  /** Locales a los que tiene acceso. */
  locations: LocationDoc[]
  /** Local elegido (null si el restaurante aún no tiene ninguno). */
  location: LocationDoc | null
  selectRestaurant: (id: string) => void
  selectLocation: (id: string) => void
}

export const PanelContext = createContext<PanelContextValue | null>(null)

export function usePanel(): PanelContextValue {
  const value = use(PanelContext)
  if (!value) throw new Error("usePanel necesita estar dentro del panel.")
  return value
}
