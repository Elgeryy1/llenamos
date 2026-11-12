import { z } from "zod"
import { useLiveQuery as useApiLive } from "@/lib/api/live"
import type { Live } from "@/lib/firebase/live"

/**
 * Selector de compilación: con `postgres` las lecturas salen de la API del VPS y nunca de Firestore.
 * Es una constante de la compilación, así que la rama de un gancho no cambia entre renderizados.
 */
export const isVpsBackend = (): boolean => process.env.NEXT_PUBLIC_DATA_BACKEND === "postgres"

/**
 * El registro general de actividad solo existe en la demo: en el VPS cada módulo guarda el suyo y no hay un
 * registro común en SQL. Las pantallas que lo ofrecen (menú, tarjeta de Inicio) se ocultan en vez de enseñar un error.
 */
export const activityAvailable = (): boolean => process.env.NEXT_PUBLIC_DATA_BACKEND !== "postgres"

/** Transforma el dato de una lectura en vivo sin tocar su estado de carga o error. */
export function mapLive<A, B>(live: Live<A>, map: (data: A) => B): Live<B> {
  return live.status === "ready" ? { status: "ready", data: map(live.data) } : live
}

/** Lectura en vivo de la API; con `input` null no escucha nada (el gancho de Firestore equivalente tampoco). */
export function useVpsLive<S extends z.ZodType>(name: string, input: unknown | null, schema: S): Live<z.output<S>> {
  return useApiLive(name, isVpsBackend() ? input : null, schema as z.ZodType<z.output<S>>)
}
