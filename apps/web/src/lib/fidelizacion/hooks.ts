"use client"

import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react"
import type { CallableInput, CallableOutput } from "@llenamos/core"
import type { Live } from "@/lib/api/live"
import { Intencion, llamarFidelizacion, mensajeError, type ApiFidelizacion, type Nombre } from "./api"

type Mutacion<N extends Nombre> = Omit<CallableInput<N>, "requestId">
export function useOperacion(api: ApiFidelizacion = llamarFidelizacion) {
  const intencion = useRef(new Intencion())
  const bloqueo = useRef(false)
  const [busy, setBusy] = useState(false)
  const [mensaje, setMensaje] = useState<string | null>(null)
  const ejecutar = async <N extends Nombre>(nombre: N, datos: Mutacion<N>): Promise<CallableOutput<N> | null> => {
    if (bloqueo.current) return null
    bloqueo.current = true
    setBusy(true)
    setMensaje(null)
    try {
      const resultado = await api(nombre, { ...datos, requestId: intencion.current.id(nombre, datos) } as CallableInput<N>)
      intencion.current.cerrar()
      return resultado
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : ""
      if (["functions/invalid-argument", "functions/permission-denied", "functions/failed-precondition", "functions/already-exists", "functions/not-found", "functions/unauthenticated"].includes(code) || (error instanceof Error && error.name === "ZodError")) intencion.current.cerrar()
      setMensaje(mensajeError(error))
      return null
    } finally {
      bloqueo.current = false
      setBusy(false)
    }
  }
  return { ejecutar, busy, mensaje }
}

/** Cancela respuestas antiguas al cambiar cliente, cuenta o restaurante. */
export function useConsulta<N extends Nombre>(nombre: N, entrada: CallableInput<N> | null, api: ApiFidelizacion = llamarFidelizacion) {
  const clave = entrada === null ? null : JSON.stringify([nombre, entrada])
  const [revision, actualizar] = useState(0)
  const [estado, guardar] = useState<{ clave: string; revision: number; live: Live<CallableOutput<N>> } | null>(null)
  const consultar = useEffectEvent(() => api(nombre, entrada!))
  useEffect(() => {
    if (clave === null) return
    let vigente = true
    consultar().then((data) => {
      if (vigente) guardar({ clave, revision, live: { status: "ready", data } })
    }, (error: unknown) => {
      if (vigente) guardar({ clave, revision, live: { status: "error", error } })
    })
    return () => { vigente = false }
  }, [clave, revision, api])
  const recargar = useCallback(() => actualizar((n) => n + 1), [])
  const live: Live<CallableOutput<N>> = estado?.clave === clave && estado?.revision === revision ? estado.live : { status: "loading" }
  return { live, recargar }
}
