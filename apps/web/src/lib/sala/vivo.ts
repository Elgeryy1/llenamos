"use client"
/**
 * Lecturas de sala, cocina y carta en modo VPS: instantáneas en vivo de la API (`useLiveQuery` por
 * SSE) en lugar de escuchar Firestore. Cada gancho devuelve el mismo `Live<T>` que el modo demo.
 */
import { CocinaLineasVivasSchema, SALA_LIVE, SalaCartaVivaSchema, SalaServicioVivoSchema, type SalaCartaViva, type SalaServicioVivo, type StationKind } from "@llenamos/core"
import { useMemo } from "react"
import { useLiveQuery } from "@/lib/api/live"
import { operationBackend } from "@/lib/api/operations"
import type { Live } from "@/lib/firebase/live"

export type Alcance = { restaurantId: string; locationId: string }

/** Fijo mientras dura la página: el selector se sustituye al compilar. */
export const enVps: boolean = (() => {
  try { return operationBackend() === "postgres" } catch { return false }
})()

export function useDerivado<T, U>(live: Live<T>, map: (value: T) => U): Live<U> {
  return useMemo(() => (live.status === "ready" ? { status: "ready", data: map(live.data) } : live) as Live<U>, [live]) // eslint-disable-line react-hooks/exhaustive-deps
}
export function useServicioVivo(scope: Alcance | null): Live<SalaServicioVivo> {
  return useLiveQuery(SALA_LIVE.servicio, scope && { restaurantId: scope.restaurantId, locationId: scope.locationId }, SalaServicioVivoSchema)
}
export function useHistorialVivo(scope: Alcance | null): Live<SalaServicioVivo> {
  return useLiveQuery(SALA_LIVE.historial, scope && { restaurantId: scope.restaurantId, locationId: scope.locationId }, SalaServicioVivoSchema)
}
function unir<T extends { id: string }>(vivas: T[], cerradas: T[]) {
  const ids = new Set(vivas.map(v => v.id))
  return [...vivas, ...cerradas.filter(c => !ids.has(c.id))]
}
/**
 * Servicio vivo más lo cerrado en las últimas horas, para reabrir mesas o repasar recogidas. Si el
 * historial falla o tarda, se enseña lo vivo sin esperar: el error del historial no tapa el servicio.
 */
export function useServicioCompleto(scope: Alcance | null): Live<SalaServicioVivo> {
  const vivo = useServicioVivo(scope), historial = useHistorialVivo(scope)
  return useMemo((): Live<SalaServicioVivo> => {
    if (vivo.status !== "ready" || historial.status !== "ready") return vivo
    const v = vivo.data, h = historial.data
    return { status: "ready", data: { sessions: unir(v.sessions, h.sessions), orders: unir(v.orders, h.orders), lines: unir(v.lines, h.lines), tasks: v.tasks, takeaways: unir(v.takeaways, h.takeaways), truncated: v.truncated || h.truncated } }
  }, [vivo, historial])
}
export function useCartaVivaVps(scope: Alcance | null): Live<SalaCartaViva> {
  return useLiveQuery(SALA_LIVE.carta, scope && { restaurantId: scope.restaurantId, locationId: scope.locationId }, SalaCartaVivaSchema)
}
export function useLineasEstacionVps(scope: Alcance | null, stationId: string | null, kind: StationKind) {
  const input = scope && stationId ? { restaurantId: scope.restaurantId, locationId: scope.locationId, stationId, kind } : null
  return useLiveQuery(SALA_LIVE.estacion, input, CocinaLineasVivasSchema)
}
export function alcanceDe(base: string | null): Alcance | null {
  const match = base ? /^restaurants\/([^/]+)\/locations\/([^/]+)$/.exec(base) : null
  return match ? { restaurantId: match[1]!, locationId: match[2]! } : null
}
