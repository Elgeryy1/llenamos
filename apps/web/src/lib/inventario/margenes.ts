"use client"

import type { CallableOutput } from "@llenamos/core"
import { useEffect, useState } from "react"
import { llamarCore } from "@/lib/data/callables"
import type { Live } from "@/lib/api/live"
import type { Alcance } from "./acciones"

export type Margenes = CallableOutput<"margenPlatos">

/**
 * Pide al servidor el margen de los platos (histórico del periodo y teórico de hoy). El cálculo
 * es de la callable `margenPlatos`: aquí solo se pide, se espera y se vuelve a pedir a mano.
 */
export function useMargenes(alcance: Alcance | null, from: string, to: string): { live: Live<Margenes>; recargar: () => void } {
  const [intento, setIntento] = useState(0)
  const [estado, setEstado] = useState<{ clave: string; live: Live<Margenes> } | null>(null)
  const restaurantId = alcance?.restaurantId
  const locationId = alcance?.locationId
  const clave = restaurantId && locationId ? `${restaurantId}/${locationId}/${from}/${to}/${intento}` : null

  useEffect(() => {
    if (!clave || !restaurantId || !locationId) return
    let vivo = true
    llamarCore("margenPlatos", { restaurantId, locationId, from, to }).then(
      (data) => vivo && setEstado({ clave, live: { status: "ready", data } }),
      (error) => vivo && setEstado({ clave, live: { status: "error", error } }),
    )
    return () => {
      vivo = false
    }
  }, [clave, restaurantId, locationId, from, to])

  return { live: estado && estado.clave === clave ? estado.live : { status: "loading" }, recargar: () => setIntento((n) => n + 1) }
}
