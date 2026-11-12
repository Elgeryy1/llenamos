"use client"

import { useMemo } from "react"
import { operationBackend } from "@/lib/api/operations"
import type { Live } from "@/lib/api/live"

/** ¿Los datos vienen de la API del VPS? Una configuración incorrecta no activa Firestore: se queda en demo. */
export function modoVps(): boolean {
  try {
    return operationBackend() === "postgres"
  } catch {
    return false
  }
}

/** Transforma el dato de una lectura lista; carga y error pasan igual. */
export function mapLive<A, B>(live: Live<A>, f: (a: A) => B): Live<B> {
  if (live.status !== "ready") return live
  try {
    return { status: "ready", data: f(live.data) }
  } catch (error) {
    return { status: "error", error }
  }
}

/** Entrada estable de una lectura en vivo: cambia solo si cambia el contenido, no la identidad del objeto. */
export function useEntrada<T extends object>(activo: boolean, entrada: T | null): T | null {
  const clave = activo && entrada ? JSON.stringify(entrada) : null
  return useMemo(() => (clave ? (JSON.parse(clave) as T) : null), [clave])
}

/** Alcance de un local a partir de la ruta `restaurants/{rid}/locations/{lid}` que usan las pantallas de inventario. */
export function alcanceDeRuta(base: string | null): { restaurantId: string; locationId: string } | null {
  const m = base ? /^restaurants\/([^/]+)\/locations\/([^/]+)$/.exec(base) : null
  return m ? { restaurantId: m[1]!, locationId: m[2]! } : null
}
