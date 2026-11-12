"use client"

import { LocationSchema, MemberSchema, RestaurantSchema, RoleSchema } from "@llenamos/core"
import type { User } from "firebase/auth"
import { useEffect, useMemo, useState } from "react"
import { z } from "zod"
import { useLiveQuery, type Live } from "./live"
import { ApiCallError, getIdentityResource, type OperationOptions } from "./transport"

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const MembershipSchema = z.object({
  restaurantId: id, role: RoleSchema, locationIds: z.array(id),
  name: z.string().min(2).max(80), slug: z.string().min(1),
})
const SessionSchema = z.discriminatedUnion("access", [
  z.object({ uid: z.string().min(1), access: z.literal("platform"), memberships: z.array(MembershipSchema).max(0) }),
  z.object({ uid: z.string().min(1), access: z.literal("restaurant"), memberships: z.array(MembershipSchema).max(100) }),
])
const ContextSchema = z.object({
  restaurant: RestaurantSchema.extend({ id }), member: MemberSchema,
  locations: z.array(LocationSchema.extend({ id })),
})
export type ApiSession = z.infer<typeof SessionSchema>
export type RestaurantContext = z.infer<typeof ContextSchema>
type ReadOptions = Omit<OperationOptions, "authentication">

function invalidResponse(): ApiCallError { return new ApiCallError("internal", "La respuesta de acceso del servidor no es válida.") }

export async function readSession(uid: string, options: ReadOptions = {}): Promise<ApiSession> {
  const result = SessionSchema.safeParse(await getIdentityResource("/api/v1/session", options))
  if (!result.success || result.data.uid !== uid) throw invalidResponse()
  const ids = result.data.memberships.map(m => m.restaurantId)
  if (new Set(ids).size !== ids.length) throw invalidResponse()
  return result.data
}

/** Coherencia del contexto con quien lo pide: UID, restaurante, ficha activa y locales asignados. */
function checkedContext(value: unknown, uid: string, restaurantId: string): RestaurantContext {
  const result = ContextSchema.safeParse(value)
  if (!result.success) throw invalidResponse()
  const { restaurant, member, locations } = result.data
  if (restaurant.id !== restaurantId || member.uid !== uid || !member.active ||
    new Set(locations.map(l => l.id)).size !== locations.length ||
    (member.locationIds.length > 0 && locations.some(l => !member.locationIds.includes(l.id)))) throw invalidResponse()
  return result.data
}

export async function readRestaurantContext(uid: string, restaurantId: string, options: ReadOptions = {}): Promise<RestaurantContext> {
  if (!id.safeParse(restaurantId).success) throw new ApiCallError("invalid-argument", "El restaurante no es válido.")
  return checkedContext(await getIdentityResource(`/api/v1/restaurants/${restaurantId}/context`, options), uid, restaurantId)
}

/** La clave forma parte del estado: no se renderizan datos de una cuenta/local anterior. */
function useIdentityRead<T>(user: User, restaurantId: string | null | undefined, read: (uid: string, options: ReadOptions, rid?: string) => Promise<T>): Live<T> {
  const key = restaurantId === null ? null : `${user.uid}:${restaurantId ?? "session"}`
  const [stored, setStored] = useState<{ key: string | null; user: User | null; value: Live<T> }>({ key: null, user: null, value: { status: "loading" } })
  useEffect(() => {
    if (key === null) return
    const controller = new AbortController()
    const options: ReadOptions = { signal: controller.signal, getToken: () => user.getIdToken() }
    void read(user.uid, options, restaurantId ?? undefined).then(
      data => { if (!controller.signal.aborted) setStored({ key, user, value: { status: "ready", data } }) },
      error => { if (!controller.signal.aborted) setStored({ key, user, value: { status: "error", error } }) },
    )
    return () => controller.abort()
  }, [key, user, restaurantId, read])
  return key !== null && stored.key === key && stored.user === user ? stored.value : { status: "loading" }
}

/** Contexto en vivo: cambios de ajustes, equipo y plan llegan sin recargar; perder el acceso cierra el flujo. */
export function useApiRestaurantContext(user: User, rid: string | null): Live<RestaurantContext> {
  const live = useLiveQuery("contextoRestaurante", rid === null ? null : { restaurantId: rid }, ContextSchema)
  return useMemo<Live<RestaurantContext>>(() => {
    if (live.status !== "ready" || rid === null) return live
    try { return { status: "ready", data: checkedContext(live.data, user.uid, rid) } }
    catch (error) { return { status: "error", error } }
  }, [live, user.uid, rid])
}
export function useApiSession(user: User): Live<ApiSession> { return useIdentityRead(user, undefined, readSession) }
