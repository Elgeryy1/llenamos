"use client"

import type { AvailabilityOutput } from "@llenamos/core"
import { useCallback, useEffect, useState } from "react"
import type { FirebaseSettings } from "@/lib/firebase/config"
import { callPublic } from "@/lib/publica/callables"
import { availabilityKey } from "@/lib/publica/reserva"

export type Disponibilidad =
  | { status: "loading" }
  | { status: "ok"; data: AvailabilityOutput }
  | { status: "error"; error: unknown }

type Entry = { status: "ok"; data: AvailabilityOutput } | { status: "error"; error: unknown }

/**
 * Horas libres de un día con `consultarDisponibilidad`. Cada combinación de local, día y
 * personas se pide una vez; `recargar` la vuelve a pedir (por ejemplo, si una hora se ocupa).
 */
export function useDisponibilidad(
  settings: FirebaseSettings | null,
  slug: string,
  locationId: string,
  date: string,
  partySize: number,
): { state: Disponibilidad; recargar: () => void } {
  const key = availabilityKey(locationId, date, partySize)
  const [entries, setEntries] = useState<Record<string, Entry>>({})
  const [version, setVersion] = useState(0)
  const entry = entries[key]
  const needsFetch = entry === undefined

  useEffect(() => {
    if (!needsFetch) return
    const controller = new AbortController()
    callPublic(settings, "consultarDisponibilidad", { slug, locationId, date, partySize }, { signal: controller.signal })
      .then((data) => setEntries((prev) => ({ ...prev, [key]: { status: "ok", data } })))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setEntries((prev) => ({ ...prev, [key]: { status: "error", error } }))
      })
    return () => controller.abort()
  }, [needsFetch, settings, slug, locationId, date, partySize, key, version])

  const recargar = useCallback(() => {
    setEntries((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
    setVersion((v) => v + 1)
  }, [key])

  return { state: entry ?? { status: "loading" }, recargar }
}
