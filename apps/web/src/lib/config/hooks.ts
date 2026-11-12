"use client"

/** Datos en directo de las páginas de configuración (horarios, mensajes, compartir). */
import { defaultReservationSettings, MessageRowSchema, PublicRestaurantSchema, ReservationSettingsSchema, type PublicRestaurant } from "@llenamos/core"
import { useEffect, useMemo, useState } from "react"
import { DataShapeError } from "@/lib/data/parse"
import { useDemoDoc, useDemoQuery } from "@/lib/data/demo-live"
import { parsePublicRestaurant } from "@/lib/compartir/enlaces"
import { z } from "zod"
import { useLiveQuery as useApiLiveQuery, type Live } from "@/lib/api/live"
import { postOperation } from "@/lib/api/transport"
import type { Settings } from "@/lib/horarios/form"
import { parseMessage, type MessageDoc } from "@/lib/mensajes/bandeja"

export interface SettingsDoc {
  settings: Settings
  /** false = el local aún no ha guardado su configuración y se enseñan los valores iniciales. */
  saved: boolean
}

export function parseSettingsDoc(path: string, data: unknown): SettingsDoc {
  if (data === undefined) return { settings: defaultReservationSettings(), saved: false }
  const r = ReservationSettingsSchema.safeParse(data)
  if (!r.success) throw new DataShapeError(path, [...new Set(r.error.issues.map((i) => i.path.join(".") || "documento"))])
  return { settings: r.data, saved: true }
}

/** Con PostgreSQL no se toca Firestore: la elección es del build, no de un fallo en tiempo de ejecución. */
const vps = () => process.env.NEXT_PUBLIC_DATA_BACKEND === "postgres"
const SettingsDocSchema = z.object({ settings: ReservationSettingsSchema, saved: z.boolean() })
const MessageListSchema = z.object({ messages: z.array(MessageRowSchema.and(z.object({ id: z.string().min(1) }))) })

/** `restaurants/{rid}/locations/{lid}/settings/reservations`, en directo. En el VPS es la lectura `ajustesReservas`. */
export function useReservationSettings(restaurantId: string, locationId: string | null): Live<SettingsDoc> {
  const path = locationId ? `restaurants/${restaurantId}/locations/${locationId}/settings/reservations` : null
  const demo = useDemoDoc(vps() ? null : path, (_id, data) => parseSettingsDoc(path ?? "settings/reservations", data))
  const api = useApiLiveQuery("ajustesReservas", vps() && locationId ? { restaurantId, locationId } : null, SettingsDocSchema)
  return vps() ? api : demo
}

/** Últimos mensajes del restaurante (por hora de envío), en directo. En el VPS: lectura `mensajesRecientes`. */
export function useMessages(restaurantId: string, max: number, enabled = true): Live<MessageDoc[]> {
  const path = `restaurants/${restaurantId}/messages`
  const demo = useDemoQuery(enabled && !vps() ? { path, orderBy: ["sendAt", "desc"], limit: max } : null, parseMessage)
  const api = useApiLiveQuery("mensajesRecientes", enabled && vps() ? { restaurantId, limit: max } : null, MessageListSchema)
  // Memoizado: un objeto nuevo en cada render haría recalcular a la bandeja todo lo que depende de él.
  const fromApi = useMemo<Live<MessageDoc[]>>(() => (api.status === "ready" ? { status: "ready", data: api.data.messages as MessageDoc[] } : api), [api])
  return vps() ? fromApi : demo
}

/**
 * `publicRestaurants/{slug}`: lo que ve la página pública. En el VPS lo calcula la API desde SQL
 * (`verRestaurantePublico`, sin identidad); un restaurante que no existe es un error, no una ficha vacía.
 */
export function usePublicRestaurant(slug: string): Live<PublicRestaurant | null> {
  const demo = useDemoDoc(vps() ? null : `publicRestaurants/${slug}`, (_id, data) => parsePublicRestaurant(slug, data))
  const [state, setState] = useState<{ slug: string; live: Live<PublicRestaurant | null> } | null>(null)
  useEffect(() => {
    if (!vps()) return
    const controller = new AbortController()
    postOperation("verRestaurantePublico", { slug }, { authentication: "none", signal: controller.signal })
      .then((result) => ({ status: "ready", data: PublicRestaurantSchema.parse(result) }) as const)
      .catch((error: unknown) => ({ status: "error", error }) as const)
      .then((live) => { if (!controller.signal.aborted) setState({ slug, live }) })
    return () => controller.abort()
  }, [slug])
  if (!vps()) return demo
  return state?.slug === slug ? state.live : { status: "loading" }
}
